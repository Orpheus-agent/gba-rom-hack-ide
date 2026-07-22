/**
 * Semantic query runner - Phase 11 P11-T1.
 *
 * Dispatches a `SemanticQuery` against a `RelationshipGraph`
 * (post-build immutable snapshot) and returns a typed
 * `SemanticQueryResult`. Pure function - no side effects, no
 * detector contract - fits the Phase-12 search UI layer.
 *
 * The runner's correctness relies on:
 *  - The typed NodeKind/EdgeKind discipline established in P4-T1.
 *  - The detector contributions that have populated those kinds
 *    (P5-T1..P10-T1 each populate one or more kinds).
 *  - PD 1: empty result arrays are LEGITIMATE answers, not failures.
 */

import type { RelationshipGraph } from '../graph/graph.js';
import type { Edge, Node } from '../graph/types.js';
import type { SemanticQuery, SemanticQueryResult } from './queries.js';

/**
 * Run a single semantic query. Returns a typed result; empty
 * matched arrays mean "no matches in this ROM" (a legitimate
 * answer per PD 1, not a failure).
 */
export function runSemanticQuery(
  graph: RelationshipGraph,
  query: SemanticQuery,
): SemanticQueryResult {
  switch (query.kind) {
    case 'find_scripts_writing_flag': {
      // Variable nodes are flag/var entities. Find the variable
      // node with this flagId, then walk incoming sets_flag edges
      // to find scripts that wrote it. Source nodes of those
      // edges are the writers.
      const varNodeId = `variable:0x${query.flagId.toString(16).toUpperCase().padStart(4, '0')}`;
      const varNode = graph.getNode(varNodeId);
      const writers: Node[] = [];
      const writerEdges: Edge[] = [];
      if (varNode !== null) {
        for (const e of graph.incoming(varNodeId)) {
          if (e.kind !== 'sets_flag') continue;
          const srcNode = graph.getNode(e.from);
          if (srcNode !== null) {
            writers.push(srcNode);
            writerEdges.push(e);
          }
        }
      }
      return finalize(query, sortNodes(writers), sortEdges(writerEdges),
        `${writers.length} script(s) write flag 0x${query.flagId.toString(16)}`,
      );
    }

    case 'find_scripts_reading_flag': {
      const varNodeId = `variable:0x${query.flagId.toString(16).toUpperCase().padStart(4, '0')}`;
      const varNode = graph.getNode(varNodeId);
      const readers: Node[] = [];
      const readerEdges: Edge[] = [];
      if (varNode !== null) {
        for (const e of graph.incoming(varNodeId)) {
          if (e.kind !== 'reads_flag' && e.kind !== 'gates_on') continue;
          const srcNode = graph.getNode(e.from);
          if (srcNode !== null) {
            readers.push(srcNode);
            readerEdges.push(e);
          }
        }
      }
      return finalize(query, sortNodes(readers), sortEdges(readerEdges),
        `${readers.length} script(s) read flag 0x${query.flagId.toString(16)}`,
      );
    }

    case 'find_events_in_map': {
      const mapNode = graph.getNode(query.mapNodeId);
      const events: Node[] = [];
      const has: Edge[] = [];
      if (mapNode !== null && mapNode.kind === 'map') {
        for (const e of graph.outgoing(query.mapNodeId)) {
          if (e.kind !== 'has_event') continue;
          const dst = graph.getNode(e.to);
          if (dst !== null) {
            events.push(dst);
            has.push(e);
          }
        }
      }
      return finalize(query, sortNodes(events), sortEdges(has),
        `${events.length} event(s) in map ${query.mapNodeId}`,
      );
    }

    case 'find_maps_warping_to': {
      const dst = graph.getNode(query.destinationMapNodeId);
      const sources: Node[] = [];
      const warpEdges: Edge[] = [];
      if (dst !== null && dst.kind === 'map') {
        // warps come from warp nodes that connect to map via warp_to.
        // From the dst's incoming warp_to edges, the `from` is the
        // warp node; the warp's incoming `has_event` source is the
        // origin map. Walk both hops.
        const warps = graph.incoming(query.destinationMapNodeId)
          .filter((e) => e.kind === 'warp_to');
        for (const we of warps) {
          warpEdges.push(we);
          // Find the origin map: warp ← has_event ← origin_map
          for (const incomingToWarp of graph.incoming(we.from)) {
            if (incomingToWarp.kind !== 'has_event') continue;
            const originMap = graph.getNode(incomingToWarp.from);
            if (originMap !== null && originMap.kind === 'map') {
              sources.push(originMap);
              warpEdges.push(incomingToWarp);
            }
          }
        }
      }
      return finalize(query, dedupAndSortNodes(sources), sortEdges(warpEdges),
        `${dedupAndSortNodes(sources).length} map(s) warp to ${query.destinationMapNodeId}`,
      );
    }

    case 'find_encounter_tables_containing_species': {
      const speciesNodeId = `species:${String(query.speciesIndex)}`;
      const tables: Node[] = [];
      const edgesOut: Edge[] = [];
      const speciesNode = graph.getNode(speciesNodeId);
      if (speciesNode !== null) {
        for (const e of graph.incoming(speciesNodeId)) {
          if (e.kind !== 'encounters_species') continue;
          const tbl = graph.getNode(e.from);
          if (tbl !== null && tbl.kind === 'encounter_table') {
            tables.push(tbl);
            edgesOut.push(e);
          }
        }
      }
      return finalize(query, sortNodes(tables), sortEdges(edgesOut),
        `${tables.length} encounter table(s) include species ${query.speciesIndex}`,
      );
    }

    case 'find_evolution_chain': {
      // Walk evolves_into edges DOWNSTREAM (pre-evos) and UPSTREAM
      // (post-evos) from this species. Return all species in the
      // chain + every evolves_into edge connecting them.
      const startId = `species:${String(query.speciesIndex)}`;
      const chainNodes = new Set<string>();
      const chainEdges = new Set<Edge>();
      if (graph.getNode(startId) !== null) {
        chainNodes.add(startId);
        // Forward BFS (post-evolutions)
        const fwdReachable = graph.reachable({
          startId,
          edgeKinds: ['evolves_into'],
        });
        for (const id of fwdReachable) chainNodes.add(id);
        // Backward - manual walk via incoming evolves_into
        const stack: string[] = [startId];
        while (stack.length > 0) {
          const id = stack.pop()!;
          for (const e of graph.incoming(id)) {
            if (e.kind !== 'evolves_into') continue;
            if (!chainNodes.has(e.from)) {
              chainNodes.add(e.from);
              stack.push(e.from);
            }
          }
        }
        // Collect all evolves_into edges between chain members.
        for (const e of graph.allEdges()) {
          if (e.kind !== 'evolves_into') continue;
          if (chainNodes.has(e.from) && chainNodes.has(e.to)) chainEdges.add(e);
        }
      }
      const nodeList = Array.from(chainNodes)
        .map((id) => graph.getNode(id))
        .filter((n): n is Node => n !== null);
      return finalize(query, sortNodes(nodeList), sortEdges(Array.from(chainEdges)),
        `evolution chain for species ${query.speciesIndex}: ${nodeList.length} species`,
      );
    }

    case 'find_music_tracks_used_by_map': {
      const mapNode = graph.getNode(query.mapNodeId);
      const tracks: Node[] = [];
      const playsEdges: Edge[] = [];
      if (mapNode !== null) {
        for (const e of graph.outgoing(query.mapNodeId)) {
          if (e.kind !== 'plays_music') continue;
          const track = graph.getNode(e.to);
          if (track !== null && track.kind === 'music_track') {
            tracks.push(track);
            playsEdges.push(e);
          }
        }
      }
      return finalize(query, sortNodes(tracks), sortEdges(playsEdges),
        `${tracks.length} music track(s) played in map ${query.mapNodeId}`,
      );
    }

    case 'find_assets_used_by': {
      const consumer = graph.getNode(query.consumerNodeId);
      const assets: Node[] = [];
      const usesEdges: Edge[] = [];
      if (consumer !== null) {
        for (const e of graph.outgoing(query.consumerNodeId)) {
          if (e.kind !== 'uses_asset') continue;
          const a = graph.getNode(e.to);
          if (a !== null && a.kind === 'asset') {
            assets.push(a);
            usesEdges.push(e);
          }
        }
      }
      return finalize(query, sortNodes(assets), sortEdges(usesEdges),
        `${assets.length} asset(s) used by ${query.consumerNodeId}`,
      );
    }

    case 'find_unlocks_dependents': {
      // Forward walk over `unlocks` edges from the writer script - 
      // produces the dependency cascade "what scripts does this
      // script enable, transitively?"
      const writerNode = graph.getNode(query.writerScriptNodeId);
      const dependents: Node[] = [];
      const unlocksEdges: Edge[] = [];
      if (writerNode !== null) {
        const reachable = graph.reachable({
          startId: query.writerScriptNodeId,
          edgeKinds: ['unlocks'],
        });
        for (const id of reachable) {
          if (id === query.writerScriptNodeId) continue;
          const n = graph.getNode(id);
          if (n !== null) dependents.push(n);
        }
        // Edges in the forward unlocks fan-out.
        for (const e of graph.allEdges()) {
          if (e.kind !== 'unlocks') continue;
          if (e.from === query.writerScriptNodeId || reachable.has(e.from)) {
            unlocksEdges.push(e);
          }
        }
      }
      return finalize(query, sortNodes(dependents), sortEdges(unlocksEdges),
        `${dependents.length} script(s) unlocked transitively by ${query.writerScriptNodeId}`,
      );
    }

    case 'find_nodes_by_kind': {
      const nodes = graph.nodesByKind(query.nodeKind);
      return finalize(query, sortNodes([...nodes]), [],
        `${nodes.length} node(s) of kind '${query.nodeKind}'`,
      );
    }

    case 'find_edges_by_kind': {
      const edges = graph.edgesByKind(query.edgeKind);
      return finalize(query, [], sortEdges([...edges]),
        `${edges.length} edge(s) of kind '${query.edgeKind}'`,
      );
    }
  }
}

function finalize(
  query: SemanticQuery,
  nodes: ReadonlyArray<Node>,
  edges: ReadonlyArray<Edge>,
  summary: string,
): SemanticQueryResult {
  return Object.freeze({
    ok: true,
    query,
    matchedNodes: Object.isFrozen(nodes) ? nodes : Object.freeze([...nodes]),
    matchedEdges: Object.isFrozen(edges) ? edges : Object.freeze([...edges]),
    summary,
  });
}

function sortNodes(nodes: Node[]): ReadonlyArray<Node> {
  return Object.freeze(nodes.sort((a, b) => a.id.localeCompare(b.id)));
}

function sortEdges(edges: Edge[]): ReadonlyArray<Edge> {
  return Object.freeze(edges.sort((a, b) => a.id.localeCompare(b.id)));
}

function dedupAndSortNodes(nodes: Node[]): ReadonlyArray<Node> {
  const seen = new Set<string>();
  const out: Node[] = [];
  for (const n of nodes) {
    if (!seen.has(n.id)) {
      seen.add(n.id);
      out.push(n);
    }
  }
  return sortNodes(out);
}
