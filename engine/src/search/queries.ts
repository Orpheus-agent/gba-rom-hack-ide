/**
 * Semantic search query layer - Phase 11 P11-T1.
 *
 * Per §15 Phase 11 acceptance:
 * > "for every corpus ROM, semantic queries of each listed category
 * > return correct concept-level results (validated against the
 * > §Phase-4 graph) and jump to the right workspace context; results
 * > are semantic, not mere substring matches."
 *
 * This module defines the TYPED QUERY VOCABULARY - a discriminated
 * union of every semantic question the engine can answer over the
 * combined typed graph (Phase-4 backbone + P5/P8/P9 detector
 * contributions) + runtime traces (P10).
 *
 * Two kinds of query inhabit the union:
 *
 *   1. **Structural queries** - directly map onto graph edges/nodes
 *      already typed by prior detectors. Example:
 *      `find_scripts_writing_flag(flagId)` walks the `sets_flag`
 *      edges from P7-T1. These satisfy the §15 P11 acceptance
 *      "results are semantic, not mere substring matches" by
 *      leveraging the TYPED nature of the relationship graph.
 *
 *   2. **Concept queries** - named higher-level concepts that
 *      compose multiple structural queries + signature DB seeds.
 *      Examples: "starter selection", "all events after Boulder
 *      Badge", "every warp leading to Victory Road". These are
 *      implemented as one-line aliases over structural queries
 *      where the signature DB maps the concept name to a concrete
 *      flag id / map id / NodeKind filter.
 *
 * P11-T1 ships the structural-query foundation. Subsequent
 * P11-Tn iterations layer named concept queries on top using the
 * signature DB to seed concept→entity mappings.
 *
 * PD 5: structural queries are universal across families; concept
 * queries reach into the pluggable signature DB for family-specific
 * seed knowledge (Boulder Badge = flag X in pret/pokefirered, flag
 * Y in pret/pokeemerald). The query interpreter itself stays
 * universal - only the seeds change per family.
 *
 * PD 1: every query result carries a `matchedNodes`/`matchedEdges`
 * array (which may be empty when the query genuinely has no matches
 * in this ROM - e.g. "find scripts writing flag 0x9999" when no
 * such flag exists). Empty arrays are a LEGITIMATE answer, NOT an
 * empty-success failure - the query was executed faithfully and
 * the result is "no matches." The caller distinguishes this from
 * "query failed" via the `ok` boolean.
 */

import type { Node, Edge, NodeKind, EdgeKind } from '../graph/types.js';

/** Universal semantic query - a tagged union of every question the
 *  engine answers structurally over the relationship graph + runtime
 *  traces. Concept queries layer on top via signature-DB seeds. */
export type SemanticQuery =
  | { readonly kind: 'find_scripts_writing_flag'; readonly flagId: number }
  | { readonly kind: 'find_scripts_reading_flag'; readonly flagId: number }
  | { readonly kind: 'find_events_in_map'; readonly mapNodeId: string }
  | { readonly kind: 'find_maps_warping_to'; readonly destinationMapNodeId: string }
  | {
      readonly kind: 'find_encounter_tables_containing_species';
      readonly speciesIndex: number;
    }
  | { readonly kind: 'find_evolution_chain'; readonly speciesIndex: number }
  | { readonly kind: 'find_music_tracks_used_by_map'; readonly mapNodeId: string }
  | {
      readonly kind: 'find_assets_used_by';
      readonly consumerNodeId: string;
    }
  | {
      readonly kind: 'find_unlocks_dependents';
      readonly writerScriptNodeId: string;
    }
  | { readonly kind: 'find_nodes_by_kind'; readonly nodeKind: NodeKind }
  | { readonly kind: 'find_edges_by_kind'; readonly edgeKind: EdgeKind };

/** Result of a single semantic query against a graph + (optional)
 *  runtime trace context. */
export interface SemanticQueryResult {
  /** True iff the query was structurally interpretable (i.e. it
   *  reached the dispatch layer without an unsupported-kind error).
   *  Empty `matchedNodes` + `matchedEdges` are STILL `ok: true` - 
   *  they mean "no matches in this ROM", which is a legitimate
   *  semantic answer per PD 1. */
  readonly ok: boolean;
  /** The query that produced this result (echo, for caller logging). */
  readonly query: SemanticQuery;
  /** Nodes whose IDs match the query. Sorted by id for determinism. */
  readonly matchedNodes: ReadonlyArray<Node>;
  /** Edges whose endpoints / kind match the query. Sorted by id. */
  readonly matchedEdges: ReadonlyArray<Edge>;
  /** Concise human-readable explanation: "found N nodes / M edges
   *  matching <query summary>". Useful for the Phase-12 search UI. */
  readonly summary: string;
  /** When `ok` is false, the dispatch-layer reason. */
  readonly errorReason?: string;
}
