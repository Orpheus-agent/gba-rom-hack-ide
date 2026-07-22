/**
 * Relationship graph types.
 *
 * §15 Phase 4 mandates a "unified dependency graph linking maps↔events↔
 * scripts↔NPCs↔encounters↔music↔assets↔flags↔species↔story-state, with
 * typed edges and bidirectional traversal." This file defines the typed
 * nodes/edges; the graph mechanics (mutation builder, immutable snapshot,
 * query API) live in `./graph.ts`.
 *
 * Design notes:
 *
 * - Nodes have stable string `id`s so the graph can be populated
 *   incrementally across detectors without index churn. ROM-relative
 *   entities encode the offset in the id (e.g. `rom_region:0x800000`,
 *   `map:0x1234`); abstract entities encode the natural key (e.g.
 *   `species:BULBASAUR`, `signature:firered-family`).
 *
 * - Edges are directional but the graph is QUERIED bidirectionally - 
 *   `outgoing(id)` + `incoming(id)` both work in O(1). The Edge's
 *   direction matters semantically (`warp_to` is asymmetric).
 *
 * - Every edge carries `confidence` ∈ [0,1] and `provenance` naming the
 *   detector + iteration. §15 P4 acceptance: "edges carry
 *   provenance/confidence" - enforced at construction.
 *
 * - The node-kind + edge-kind enums are LARGE on purpose: they cover the
 *   full §15 P4 entity list so later detectors don't need to extend the
 *   type. Phase-5+ detectors populate the still-unused kinds.
 */

/** Every entity kind the §15 Phase 4 graph models. */
export type NodeKind =
  | 'rom_region'        // a byte range (e.g. a pointer-table target)
  | 'signature_match'   // a matched signature DB entry
  | 'family_verdict'    // the per-ROM family classification verdict
  | 'map'               // §15 P5: a Pokémon-style map / area
  | 'warp'              // §15 P5: a connection point between maps
  | 'event'             // §15 P6: a scripted event
  | 'script'            // §15 P6: a script entrypoint
  | 'npc'               // §15 P6: an NPC / object event
  | 'flag'              // §15 P7: a story flag
  | 'variable'          // §15 P7: a story variable
  | 'story_state'       // §15 P6/P7: an abstract progression state
  | 'species'           // §15 P8: a Pokémon species
  | 'trainer'           // §15 P8: a trainer entry
  | 'encounter_table'   // §15 P8: an encounter table
  | 'music_track'       // §15 P9: a music/SFX entry
  | 'asset'             // §15 P9: a graphics/sprite/palette asset
  | 'building';         // §15 P5: virtual entity grouping multi-floor buildings

/** Every relationship kind the graph models. */
export type EdgeKind =
  | 'points_to'         // pointer-network: source rom_region points at target rom_region
  | 'classifies_as'     // signature_match → family_verdict
  | 'family_kind'       // family_verdict → engine kind (cosmetic edge)
  | 'warp_to'           // §15 P5: warp connects two maps
  | 'connects_to'       // §15 P5: maps adjacent in world graph
  | 'has_event'         // §15 P5/P6: map contains event
  | 'script_triggers'   // §15 P6: event runs script
  | 'sets_flag'         // §15 P6/P7: script writes flag
  | 'reads_flag'        // §15 P6/P7: script reads flag
  | 'gates_on'          // §15 P6: event requires flag/var precondition
  | 'unlocks'           // §15 P6: event causes story_state transition
  | 'uses_asset'        // §15 P9: map/event references asset
  | 'plays_music'       // §15 P5/P9: map → music_track
  | 'encounters_in'     // §15 P8: encounter_table populates map
  | 'encounters_species' // §15 P8: encounter_table includes species
  | 'evolves_into'      // §15 P8: species evolves into target species
  | 'contains';         // §15 P5: building → constituent map (floor)

export interface Node {
  /** Stable globally-unique id (e.g. "rom_region:0x800000"). */
  readonly id: string;
  readonly kind: NodeKind;
  /** Optional human-readable label; defaults to id at render time. */
  readonly label?: string;
  /** Which detector / iteration created this node. */
  readonly provenance: string;
  /** Optional structured payload - kind-specific. */
  readonly detail?: Readonly<Record<string, unknown>>;
}

export interface Edge {
  /** Stable id, typically `${kind}:${from}->${to}`. */
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly kind: EdgeKind;
  /** Confidence in this edge in [0, 1]. */
  readonly confidence: number;
  /** Which detector / iteration / signal created this edge. */
  readonly provenance: string;
  /** Optional structured payload - edge-kind-specific. */
  readonly detail?: Readonly<Record<string, unknown>>;
}

/** Thrown when input violates an invariant (bad confidence, missing id, etc.). */
export class GraphInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GraphInvariantError';
  }
}

/** Thrown when adding an edge to a node that hasn't been registered. */
export class GraphMissingNodeError extends Error {
  constructor(message: string, readonly nodeId: string) {
    super(message);
    this.name = 'GraphMissingNodeError';
  }
}
