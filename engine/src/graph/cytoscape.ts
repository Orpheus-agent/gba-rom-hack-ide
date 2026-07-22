/**
 * Cytoscape.js JSON exporter.
 *
 * Per D-0005, the Phase 12 workspace UI uses Cytoscape.js for the
 * relationship-graph surface. Cytoscape consumes an `elements` payload
 * shaped as `{ nodes: [{ data: {...} }], edges: [{ data: {...} }] }`.
 *
 * This serializer produces that shape directly from a RelationshipGraph
 * so the UI can render without an intermediate transform. The PHASE-12
 * UI is deferred to later iterations, but emitting the artifact now lets
 * the smoke run produce a renderable graph artifact that's also useful
 * for any external visualizer (e.g. `cyto.web.app` for one-shot
 * inspection).
 *
 * Pure function: deterministic, no I/O.
 */

import type { RelationshipGraph } from './graph.js';

export interface CytoscapeNodeData {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  readonly provenance: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}

export interface CytoscapeEdgeData {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly kind: string;
  readonly confidence: number;
  readonly provenance: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}

export interface CytoscapeJson {
  readonly format: 'cytoscape-elements-v1';
  readonly elements: {
    readonly nodes: ReadonlyArray<{ readonly data: CytoscapeNodeData }>;
    readonly edges: ReadonlyArray<{ readonly data: CytoscapeEdgeData }>;
  };
}

export function toCytoscapeJson(graph: RelationshipGraph): CytoscapeJson {
  const nodes = graph.allNodes().map((n) => ({
    data: {
      id: n.id,
      kind: n.kind,
      label: n.label ?? n.id,
      provenance: n.provenance,
      ...(n.detail !== undefined ? { detail: n.detail } : {}),
    } as CytoscapeNodeData,
  }));
  const edges = graph.allEdges().map((e) => ({
    data: {
      id: e.id,
      source: e.from,
      target: e.to,
      kind: e.kind,
      confidence: e.confidence,
      provenance: e.provenance,
      ...(e.detail !== undefined ? { detail: e.detail } : {}),
    } as CytoscapeEdgeData,
  }));
  return Object.freeze({
    format: 'cytoscape-elements-v1' as const,
    elements: Object.freeze({
      nodes: Object.freeze(nodes),
      edges: Object.freeze(edges),
    }),
  });
}
