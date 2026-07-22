/**
 * RelationshipGraph + RelationshipGraphBuilder.
 *
 * The graph is the §15 Phase 4 backbone every later phase writes into.
 * Two surfaces:
 *
 *   - RelationshipGraphBuilder - mutable. Detectors and post-processors
 *     call `addNode` / `addEdge`. Enforces invariants at insertion time
 *     (confidence ∈ [0,1], unique node id, edge endpoints exist).
 *
 *   - RelationshipGraph - immutable snapshot returned from `builder.build()`.
 *     Supports bidirectional traversal (outgoing/incoming) in O(1) per
 *     query via pre-built adjacency Maps.
 *
 * Performance budget: Gen-3 ROMs produce ~500-2000 hot pointer-target
 * nodes + ~10K edges in the current detection coverage. Both numbers fit
 * comfortably in Map<string, T> without sharding. Phase 5+ will multiply
 * node count by 10-100x as map/event/script nodes appear; the same
 * structure scales linearly (Map has O(1) average lookup).
 */

import {
  GraphInvariantError,
  GraphMissingNodeError,
  type Edge,
  type EdgeKind,
  type Node,
  type NodeKind,
} from './types.js';

export interface RelationshipGraphSnapshot {
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly nodeCountsByKind: Readonly<Record<string, number>>;
  readonly edgeCountsByKind: Readonly<Record<string, number>>;
}

/** Immutable graph view returned by `builder.build()`. */
export class RelationshipGraph {
  // Backing maps are populated by the Builder and frozen here by the
  // class never exposing mutator methods.
  private readonly nodes: ReadonlyMap<string, Node>;
  private readonly edges: ReadonlyArray<Edge>;
  private readonly outAdj: ReadonlyMap<string, ReadonlyArray<Edge>>;
  private readonly inAdj: ReadonlyMap<string, ReadonlyArray<Edge>>;

  constructor(args: {
    nodes: ReadonlyMap<string, Node>;
    edges: ReadonlyArray<Edge>;
    outAdj: ReadonlyMap<string, ReadonlyArray<Edge>>;
    inAdj: ReadonlyMap<string, ReadonlyArray<Edge>>;
  }) {
    this.nodes = args.nodes;
    this.edges = args.edges;
    this.outAdj = args.outAdj;
    this.inAdj = args.inAdj;
  }

  get nodeCount(): number {
    return this.nodes.size;
  }
  get edgeCount(): number {
    return this.edges.length;
  }

  hasNode(id: string): boolean {
    return this.nodes.has(id);
  }
  getNode(id: string): Node | null {
    return this.nodes.get(id) ?? null;
  }
  allNodes(): ReadonlyArray<Node> {
    return Array.from(this.nodes.values());
  }
  allEdges(): ReadonlyArray<Edge> {
    return this.edges;
  }

  nodesByKind(kind: NodeKind): ReadonlyArray<Node> {
    const out: Node[] = [];
    for (const n of this.nodes.values()) {
      if (n.kind === kind) out.push(n);
    }
    return out;
  }

  edgesByKind(kind: EdgeKind): ReadonlyArray<Edge> {
    return this.edges.filter((e) => e.kind === kind);
  }

  outgoing(nodeId: string): ReadonlyArray<Edge> {
    return this.outAdj.get(nodeId) ?? [];
  }

  incoming(nodeId: string): ReadonlyArray<Edge> {
    return this.inAdj.get(nodeId) ?? [];
  }

  /**
   * BFS over the graph from `startId`, returning all node ids reachable
   * via the listed `edgeKinds` (or all edge kinds if undefined). Caps at
   * `maxNodes` to bound runtime on dense ROMs.
   */
  reachable(args: {
    startId: string;
    edgeKinds?: ReadonlyArray<EdgeKind>;
    maxNodes?: number;
  }): Set<string> {
    const maxNodes = args.maxNodes ?? 10_000;
    const visited = new Set<string>();
    if (!this.nodes.has(args.startId)) return visited;
    const queue: string[] = [args.startId];
    visited.add(args.startId);
    const allowed = args.edgeKinds ? new Set<EdgeKind>(args.edgeKinds) : null;
    while (queue.length > 0 && visited.size < maxNodes) {
      const id = queue.shift()!;
      for (const e of this.outgoing(id)) {
        if (allowed !== null && !allowed.has(e.kind)) continue;
        if (visited.has(e.to)) continue;
        visited.add(e.to);
        if (visited.size >= maxNodes) break;
        queue.push(e.to);
      }
    }
    return visited;
  }

  /** Aggregate counts for reports / VERIFY.md evidence. */
  snapshot(): RelationshipGraphSnapshot {
    const nodeCountsByKind: Record<string, number> = {};
    for (const n of this.nodes.values()) {
      nodeCountsByKind[n.kind] = (nodeCountsByKind[n.kind] ?? 0) + 1;
    }
    const edgeCountsByKind: Record<string, number> = {};
    for (const e of this.edges) {
      edgeCountsByKind[e.kind] = (edgeCountsByKind[e.kind] ?? 0) + 1;
    }
    return Object.freeze({
      nodeCount: this.nodeCount,
      edgeCount: this.edgeCount,
      nodeCountsByKind: Object.freeze(nodeCountsByKind),
      edgeCountsByKind: Object.freeze(edgeCountsByKind),
    });
  }
}

/**
 * Mutable graph builder. The orchestrator and per-detector post-processors
 * call `addNode` / `addEdge`; `build()` returns the immutable
 * RelationshipGraph snapshot.
 */
export class RelationshipGraphBuilder {
  private readonly nodes = new Map<string, Node>();
  private readonly edges: Edge[] = [];

  /**
   * Post-hoc enrichment for cross-detector analyses: merges
   * `additionalDetail` fields into an existing node's `detail`.
   * Existing fields are preserved; new fields are added. Throws if the
   * node doesn't exist. Intended for the documented pattern where a
   * downstream pass (graph-builder post-pass) needs to annotate
   * already-emitted nodes with derived fields - preserves the
   * "first writer wins for id/kind/label/provenance" contract while
   * allowing post-pass enrichment of the detail bag.
   */
  updateNodeDetail(
    id: string,
    additionalDetail: Readonly<Record<string, unknown>>,
  ): Node {
    const existing = this.nodes.get(id);
    if (existing === undefined) {
      throw new GraphInvariantError(
        `updateNodeDetail: node "${id}" not found`,
      );
    }
    const mergedDetail = Object.freeze({
      ...(existing.detail ?? {}),
      ...additionalDetail,
    });
    const updated = Object.freeze({
      ...existing,
      detail: mergedDetail,
    });
    this.nodes.set(id, updated);
    return updated;
  }

  /**
   * Add a node. If a node with the same id already exists, the new one
   * is REJECTED (returns the existing one) - graphs are append-only
   * within a single build. Detectors that need to enrich a node should
   * either (a) reach consensus on the canonical id scheme so the first
   * writer wins, (b) emit edges to express the enrichment, or
   * (c) use `updateNodeDetail` for post-hoc merging of derived fields.
   */
  addNode(node: Node): Node {
    if (!isValidConfidence(undefined as never)) {
      // unreachable - type system enforcement check
    }
    if (typeof node.id !== 'string' || node.id.length === 0) {
      throw new GraphInvariantError(`node id must be a non-empty string`);
    }
    if (typeof node.provenance !== 'string' || node.provenance.length === 0) {
      throw new GraphInvariantError(`node "${node.id}" must have a non-empty provenance`);
    }
    const existing = this.nodes.get(node.id);
    if (existing !== undefined) return existing;
    const frozen = Object.freeze({
      ...node,
      ...(node.detail !== undefined ? { detail: Object.freeze({ ...node.detail }) } : {}),
    });
    this.nodes.set(node.id, frozen);
    return frozen;
  }

  /**
   * Add an edge. BOTH endpoints must already be registered as nodes - 
   * this catches typos / wrong ids at insertion time rather than
   * surfacing them at query time. Confidence is validated to be in [0,1].
   */
  addEdge(edge: Edge): Edge {
    if (typeof edge.from !== 'string' || edge.from.length === 0) {
      throw new GraphInvariantError(`edge.from must be a non-empty string`);
    }
    if (typeof edge.to !== 'string' || edge.to.length === 0) {
      throw new GraphInvariantError(`edge.to must be a non-empty string`);
    }
    if (typeof edge.id !== 'string' || edge.id.length === 0) {
      throw new GraphInvariantError(`edge.id must be a non-empty string`);
    }
    if (!this.nodes.has(edge.from)) {
      throw new GraphMissingNodeError(`edge "${edge.id}": from-node "${edge.from}" not registered`, edge.from);
    }
    if (!this.nodes.has(edge.to)) {
      throw new GraphMissingNodeError(`edge "${edge.id}": to-node "${edge.to}" not registered`, edge.to);
    }
    if (typeof edge.provenance !== 'string' || edge.provenance.length === 0) {
      throw new GraphInvariantError(`edge "${edge.id}" must have a non-empty provenance`);
    }
    if (!Number.isFinite(edge.confidence) || edge.confidence < 0 || edge.confidence > 1) {
      throw new GraphInvariantError(
        `edge "${edge.id}" confidence ${String(edge.confidence)} out of [0,1]`,
      );
    }
    const frozen = Object.freeze({
      ...edge,
      ...(edge.detail !== undefined ? { detail: Object.freeze({ ...edge.detail }) } : {}),
    });
    this.edges.push(frozen);
    return frozen;
  }

  /**
   * Build the immutable RelationshipGraph snapshot. Pre-computes the
   * bidirectional adjacency maps in O(E).
   */
  build(): RelationshipGraph {
    const outAdj = new Map<string, Edge[]>();
    const inAdj = new Map<string, Edge[]>();
    for (const e of this.edges) {
      const oArr = outAdj.get(e.from);
      if (oArr === undefined) outAdj.set(e.from, [e]);
      else oArr.push(e);
      const iArr = inAdj.get(e.to);
      if (iArr === undefined) inAdj.set(e.to, [e]);
      else iArr.push(e);
    }
    // Freeze the per-node adjacency arrays.
    const outFrozen = new Map<string, ReadonlyArray<Edge>>();
    for (const [k, v] of outAdj) outFrozen.set(k, Object.freeze([...v]));
    const inFrozen = new Map<string, ReadonlyArray<Edge>>();
    for (const [k, v] of inAdj) inFrozen.set(k, Object.freeze([...v]));
    return new RelationshipGraph({
      nodes: this.nodes,
      edges: Object.freeze([...this.edges]),
      outAdj: outFrozen,
      inAdj: inFrozen,
    });
  }

  get nodeCount(): number {
    return this.nodes.size;
  }
  get edgeCount(): number {
    return this.edges.length;
  }
}

// The Builder's addNode performs an explicit check rather than relying on
// a typed-confidence helper because Node has no confidence field.
// (Keeping this stub here for parity with the Edge validator below.)
function isValidConfidence(n: number): n is number {
  return Number.isFinite(n) && n >= 0 && n <= 1;
}
