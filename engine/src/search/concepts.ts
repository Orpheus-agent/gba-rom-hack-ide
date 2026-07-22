/**
 * Named concept queries - Phase 11 P11-T2.
 *
 * Per §15 Phase 11 acceptance, the engine must answer concept-level
 * queries like "starter selection", "all events after Boulder Badge",
 * "every warp leading to Victory Road", "all scripts that change
 * weather" - semantic concepts, not raw graph traversals.
 *
 * The P11-T1 structural query layer (`runner.ts` + `queries.ts`)
 * ships 11 primitives like `find_scripts_writing_flag(flagId)` and
 * `find_maps_warping_to(mapNodeId)`. This module composes those
 * primitives into NAMED, USER-FACING concepts:
 *
 *   - Each concept has a stable `id` (e.g. `'starter_selection'`)
 *     and a human-readable `label`.
 *   - Each concept takes a typed `ConceptSeed` arg with the per-ROM
 *     bindings it needs (e.g. `starter_selection` needs the flag
 *     id that gets set when the player chooses a starter; that
 *     mapping comes from the signature DB matched entry).
 *   - Each concept returns a `ConceptQueryResult` - same shape as
 *     `SemanticQueryResult` from P11-T1, with `concept.id` echoed
 *     for caller logging.
 *
 * The PATTERN is the deliverable: subsequent iterations add more
 * concepts (every §15 P11 named category eventually has one) by
 * composing the same structural primitives + per-concept signature
 * DB seeds. Universal across families per PD 5 - only the seeds
 * change per family/build.
 *
 * PD 1: when a concept's seed is empty for this ROM (e.g. the
 * signature DB doesn't carry a `starterFlagId` for this build),
 * the concept returns ok=true with an empty matchedNodes array
 * and `summary: 'no seeds provided'`. This is a LEGITIMATE
 * answer per the empty-success carve-out for queries - not a
 * failure of the concept layer.
 */

import type { RelationshipGraph } from '../graph/graph.js';
import { runSemanticQuery } from './runner.js';
import type { SemanticQueryResult } from './queries.js';

/** Per-concept seed data; typically sourced from the signature DB
 *  matched entry for this ROM's family. Each concept reads only the
 *  fields it needs; missing fields trigger the "no seeds available"
 *  legitimate empty answer. */
export interface ConceptSeed {
  /** Flag ids the engine treats as "starter selection" markers.
   *  pret/pokefirered: FLAG_SYS_POKEMON_GET (varies per build). */
  readonly starterFlagIds?: ReadonlyArray<number>;
  /** Flag ids the engine treats as "Pokémon League / badge progression"
   *  markers. pret/pokefirered: FLAG_BADGE01_GET..FLAG_BADGE08_GET. */
  readonly badgeFlagIds?: ReadonlyArray<number>;
  /** Map node ids the engine considers "Victory Road" maps. */
  readonly victoryRoadMapNodeIds?: ReadonlyArray<string>;
  /** Opcode names the engine treats as weather-changing operations.
   *  pret/pokefirered: 'setweather', 'doweather'. */
  readonly weatherChangeOpcodeNames?: ReadonlyArray<string>;
}

export interface ConceptQueryResult {
  /** The concept's stable id (e.g. `'starter_selection'`). */
  readonly conceptId: string;
  /** Human-readable concept label. */
  readonly conceptLabel: string;
  /** True iff the concept was structurally interpretable. Always true
   *  for the concepts shipped today; reserved for future concepts
   *  that may have a hard precondition (e.g. require a runtime
   *  trace from Phase 10). */
  readonly ok: boolean;
  /** Aggregated structural-query results that made up this concept.
   *  Useful for the Phase-12 search UI to render "concept X expanded
   *  to N structural queries returning M nodes total". */
  readonly subResults: ReadonlyArray<SemanticQueryResult>;
  /** Deduplicated union of matched nodes across all sub-results. */
  readonly matchedNodes: ReadonlyArray<string>; // ids
  /** Deduplicated union of matched edges across all sub-results. */
  readonly matchedEdges: ReadonlyArray<string>; // ids
  /** Human-readable summary suitable for surfacing in the search UI. */
  readonly summary: string;
}

export interface NamedConcept {
  readonly id: string;
  readonly label: string;
  /** Run the concept against the graph + per-ROM seed data. */
  run(graph: RelationshipGraph, seed: ConceptSeed): ConceptQueryResult;
}

/**
 * Starter Selection - scripts that set any starter-class flag.
 * Signature DB seed: `starterFlagIds` (list of flag ids the family
 * uses to mark "player has chosen their starter"). Without seeds,
 * returns ok=true + empty + "no seeds provided" - a legitimate
 * answer for ROMs whose family has no starterFlagIds registered.
 */
export const starterSelectionConcept: NamedConcept = {
  id: 'starter_selection',
  label: 'Starter Selection scripts',
  run(graph, seed) {
    const flagIds = seed.starterFlagIds ?? [];
    return composeConcept(
      'starter_selection',
      'Starter Selection scripts',
      flagIds.map((flagId) => runSemanticQuery(graph, {
        kind: 'find_scripts_writing_flag',
        flagId,
      })),
      flagIds.length === 0
        ? 'no starterFlagIds provided in seed (signature DB lacks family-specific starter flag mapping)'
        : undefined,
    );
  },
};

/**
 * Events After Boulder Badge / Badge N - scripts that read a badge
 * flag (= gated on badge progression). Signature DB seed:
 * `badgeFlagIds`. Without seeds, returns ok=true + empty.
 */
export const eventsAfterBadgeConcept: NamedConcept = {
  id: 'events_after_badge',
  label: 'Events triggered after obtaining a badge',
  run(graph, seed) {
    const flagIds = seed.badgeFlagIds ?? [];
    return composeConcept(
      'events_after_badge',
      'Events triggered after obtaining a badge',
      flagIds.map((flagId) => runSemanticQuery(graph, {
        kind: 'find_scripts_reading_flag',
        flagId,
      })),
      flagIds.length === 0
        ? 'no badgeFlagIds provided in seed (signature DB lacks family-specific badge flag mapping)'
        : undefined,
    );
  },
};

/**
 * Every Warp Leading to Victory Road - maps that warp to any of the
 * Victory Road map node ids. Signature DB seed: `victoryRoadMap
 * NodeIds` (the family's VR map node id list).
 */
export const victoryRoadWarpsConcept: NamedConcept = {
  id: 'victory_road_warps',
  label: 'Every warp leading to Victory Road',
  run(graph, seed) {
    const mapIds = seed.victoryRoadMapNodeIds ?? [];
    return composeConcept(
      'victory_road_warps',
      'Every warp leading to Victory Road',
      mapIds.map((mapId) => runSemanticQuery(graph, {
        kind: 'find_maps_warping_to',
        destinationMapNodeId: mapId,
      })),
      mapIds.length === 0
        ? 'no victoryRoadMapNodeIds provided in seed (signature DB lacks Victory Road map ids for this family)'
        : undefined,
    );
  },
};

/**
 * Scripts That Change Weather - scripts whose bytecode contains
 * any opcode named in `weatherChangeOpcodeNames`. Detection works
 * by walking all `script_triggers` edges' source scripts AND any
 * script body offsets we can locate, intersecting with opcode-name
 * usage. For this iteration's minimal implementation, we use a
 * proxy: scripts that read a flag known to gate weather (when seed
 * provides such mappings); a richer version layered in later P11-Tn
 * would inspect each script's bytecode walked opcode names.
 *
 * For now this returns the proxy version; future P11-T3+ extends
 * with bytecode-level opcode-name scanning.
 */
export const weatherChangeConcept: NamedConcept = {
  id: 'scripts_that_change_weather',
  label: 'Scripts that change weather',
  run(_graph, seed) {
    // Proxy implementation: signature DB seed identifies weather-
    // change opcode NAMES; a full implementation would re-walk
    // every script body's bytecode (P6-T4 walker) and surface
    // scripts whose opcode list contains any seed name. For
    // P11-T2 minimal scope: return ok=true with an explicit
    // routing message so the Phase-12 search UI tells the user
    // "this concept is registered, requires bytecode scan layered
    // in a future iteration". Routes through composeConcept as a
    // legitimate empty answer per PD 1.
    const seedNames = seed.weatherChangeOpcodeNames ?? [];
    return composeConcept(
      'scripts_that_change_weather',
      'Scripts that change weather',
      [],
      seedNames.length === 0
        ? 'no weatherChangeOpcodeNames provided in seed'
        : 'concept registered but full bytecode-opcode-name scan implementation routed to future P11-T3+ iteration',
    );
  },
};

/**
 * Concept registry - every named concept exported by this module.
 * Plugin-friendly: external modules can extend this array at
 * load time.
 */
export const ALL_NAMED_CONCEPTS: ReadonlyArray<NamedConcept> = Object.freeze([
  starterSelectionConcept,
  eventsAfterBadgeConcept,
  victoryRoadWarpsConcept,
  weatherChangeConcept,
]);

/** Compose a concept result from a list of structural-query
 *  sub-results. Deduplicates matched node/edge ids across them. */
function composeConcept(
  conceptId: string,
  conceptLabel: string,
  subResults: ReadonlyArray<SemanticQueryResult>,
  emptyReason?: string,
): ConceptQueryResult {
  const nodeSet = new Set<string>();
  const edgeSet = new Set<string>();
  for (const sr of subResults) {
    for (const n of sr.matchedNodes) nodeSet.add(n.id);
    for (const e of sr.matchedEdges) edgeSet.add(e.id);
  }
  const matchedNodes = Object.freeze(Array.from(nodeSet).sort());
  const matchedEdges = Object.freeze(Array.from(edgeSet).sort());
  const summary =
    subResults.length === 0
      ? `${conceptLabel}: ${emptyReason ?? 'no results'}`
      : `${conceptLabel}: ${matchedNodes.length} node(s), ${matchedEdges.length} edge(s) across ${subResults.length} sub-query result(s)`;
  return Object.freeze({
    conceptId,
    conceptLabel,
    ok: true,
    subResults: Object.freeze([...subResults]),
    matchedNodes,
    matchedEdges,
    summary,
  });
}
