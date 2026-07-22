/**
 * Canonical workspace model - Phase 12 P12-T1.
 *
 * Per §15 Phase 12 acceptance:
 * > "supplying any corpus ROM with no manual input yields all listed
 * > workspace surfaces, navigable and editable; the user can
 * > immediately navigate the world, inspect mechanics, edit events,
 * > replace assets, rewrite progression, add mechanics, modify
 * > systems, inject content; stable + responsive on the heaviest
 * > corpus ROM."
 *
 * Per §15 P12 catalogue, on ingestion completion the engine must
 * auto-generate: world graph, map hierarchy, event graph, story-
 * progression graph, dependency graph, asset browser, runtime-systems
 * panel, mechanic inventory, feature-detection report, editable
 * visual workspace.
 *
 * This module defines the TYPED CANONICAL MODEL - a single
 * serializable data structure that bundles every detector + runtime
 * + search output into one navigable surface. Any editor frontend
 * (the existing `/app/` editor per D-0001 §17 composition, or any
 * future Phase-12 visual editor) consumes this WorkspaceModel to
 * render its surfaces.
 *
 * Design notes:
 *   - The model is INDEXED for fast UI lookups (per-NodeKind buckets,
 *     by-id maps surfaced as serializable arrays). The editor doesn't
 *     re-walk the graph for routine queries.
 *   - The model is FLAT - no detector-internal types leak through.
 *     Every section is a plain JSON-friendly shape.
 *   - The model is GENERATED, not authoritative - the source of
 *     truth is the underlying IngestReport + RelationshipGraph +
 *     RuntimeValidatorReport + search results. Re-running detection
 *     regenerates the model.
 *
 * PD 1: every section reports its presence honestly. When a
 * detector wasn't run OR returned not_detected, the corresponding
 * section is empty/null with a `present: false` discriminator.
 * Never empty-success.
 */

import type { Edge, Node } from '../graph/types.js';
import type { RuntimeTraceEvent } from '../runtime/script-interpreter.js';

/** Top-level workspace surface bundling every Phase-0-through-11
 *  detection output. Editor frontends consume this directly. */
export interface WorkspaceModel {
  /** Generation timestamp for cache invalidation / audit. */
  readonly generatedAtUtc: string;
  /** Identity card - ROM metadata + family verdict. */
  readonly identity: WorkspaceIdentity;
  /** World graph surface - maps + warps + buildings + connections. */
  readonly worldGraph: WorkspaceWorldGraph;
  /** Per-map detail bundle - events, tilesets, palettes, music. */
  readonly maps: ReadonlyArray<WorkspaceMap>;
  /** Event graph - all event/script/npc nodes with their trigger
   *  edges, gating, and unlocks chains. */
  readonly eventGraph: WorkspaceEventGraph;
  /** Story-progression graph - flags + variables + roles. */
  readonly storyProgression: WorkspaceStoryProgression;
  /** Asset browser - all asset nodes bucketed by sub-kind, with
   *  reverse-lookup "what uses this asset?" pre-computed. */
  readonly assetBrowser: WorkspaceAssetBrowser;
  /** Mechanic inventory - species, trainers, encounter tables. */
  readonly mechanicInventory: WorkspaceMechanicInventory;
  /** Runtime-systems panel - trace events + validation findings. */
  readonly runtimeSystems: WorkspaceRuntimeSystems;
  /** Feature-detection report - per-detector status + confidence. */
  readonly featureDetection: WorkspaceFeatureDetection;
  /** ROM coverage summary - classified vs scored-unknown vs unaccounted. */
  readonly coverage: WorkspaceCoverage;
}

export interface WorkspaceIdentity {
  /** ROM SHA-1 (canonical identity per D-0008). */
  readonly sha1: string;
  /** ROM byte length. */
  readonly byteLength: number;
  /** Source path (if loaded from disk) or synthetic://... marker. */
  readonly sourcePath: string;
  /** Operator-supplied corpus class if any. */
  readonly corpusClass: string | null;
  /** True if this is a synthetic fixture (B-0001 route-around). */
  readonly synthetic: boolean;
  /** Family classification verdict (P1-T2 binary fingerprint output). */
  readonly familyVerdict: {
    readonly family: string;
    readonly confidence: number;
    readonly matchedSignatures: ReadonlyArray<string>;
  };
  /** Parsed Gen-3 GBA cartridge header (UW-1-T1). `null` when the
   *  header-fingerprint detector returned not_detected (the cart
   *  failed Nintendo's 0x96 fixed-marker check OR the ROM is
   *  shorter than 192 bytes - both correctly produce a complete
   *  WorkspaceModel with null header per PD 4 universality before
   *  completeness). */
  readonly header: WorkspaceIdentityHeader | null;
  /** Pre-formatted human-readable header label (e.g. "Pokémon
   *  FireRed - BPRE (POKEMON FIRE) v1") for the editor's identity
   *  card. `null` when `header` is null. */
  readonly headerDisplay: string | null;
  /** Top-level memory layout: where the cartridge header sits within
   *  the ROM (always 0x00..0xC0 for GBA), the body region after the
   *  header, and the total ROM size. This is the FOUNDATION view that
   *  later memory-map detectors (pointer-table regions, compression
   *  regions, etc.) overlay on top of. */
  readonly memoryLayout: WorkspaceIdentityMemoryLayout;
  /** Pointer-network inventory (UW-1-T2). Summary lifted from the
   *  `pointer_network` detector (counts + top-N sample tables). Full
   *  detail still lives in `report.detections` for advanced
   *  inspection. `null` when the detector returned not_detected
   *  (ROM too small to scan / no pointer runs found). */
  readonly pointerTables: WorkspaceIdentityPointerTableInventory | null;
  /** Compression-region inventory (UW-1-T2). Summary lifted from the
   *  `compression_format` detector (counts + top-N sample LZ77
   *  blocks). `null` when the detector returned not_detected. */
  readonly compressionRegions: WorkspaceIdentityCompressionRegionInventory | null;
}

export interface WorkspaceIdentityHeader {
  /** 12-byte internal game title (e.g. "POKEMON FIRE"). Trimmed of
   *  trailing nulls/spaces. */
  readonly internalTitle: string;
  /** 4-byte game code (e.g. "BPRE" for Pokémon FireRed). */
  readonly gameCode: string;
  /** 2-byte maker code (e.g. "01" for Nintendo). */
  readonly makerCode: string;
  /** 1-byte software version (0 = v1.0, 1 = v1.1, etc.). */
  readonly softwareVersion: number;
  /** Friendly label when `gameCode` matches a known Pokémon game
   *  code; null otherwise. NEVER load-bearing for detection (PD 5). */
  readonly knownGame: string | null;
  /** Always `true` for a populated header - the 0x96 fixed-marker
   *  byte at 0xB2 validated. If the marker is invalid, the
   *  header-fingerprint detector returns `partial` or `not_detected`
   *  and this whole `header` field is `null`. */
  readonly fixedMarkerValid: true;
}

export interface WorkspaceIdentityMemoryLayout {
  /** Total ROM byte length (same as identity.byteLength; mirrored
   *  here for the memory-map view's self-containment). */
  readonly romSize: number;
  /** Cartridge header region (always 0..0xC0 per GBA hardware spec). */
  readonly headerOffset: number;
  readonly headerLength: number;
  /** Body region: everything after the header. */
  readonly bodyOffset: number;
  readonly bodyLength: number;
}

export interface WorkspaceIdentityPointerTableInventory {
  /** Total individual pointers discovered across the ROM. */
  readonly totalPointerCount: number;
  /** Total distinct pointer TABLES (runs of consecutive pointers at
   *  stride 4) found. */
  readonly tableCount: number;
  /** Sum of all-table byte lengths (= tableCount entries × 4 bytes
   *  each, summed). */
  readonly tableBytesCovered: number;
  /** Top-N largest pointer tables for at-a-glance display in the
   *  identity card (capped at 8 entries). Sorted by table.length
   *  descending. */
  readonly largestTables: ReadonlyArray<{
    /** Table start offset within the ROM. */
    readonly offset: number;
    /** Number of pointer entries in the table. */
    readonly length: number;
    /** Stride between consecutive entries (always 4 for GBA pointers). */
    readonly stride: 4;
  }>;
  /** Total distinct cross-reference cluster targets - points-to
   *  destinations that ≥2 pointers reference. */
  readonly clusterTargetCount: number;
}

export interface WorkspaceIdentityCompressionRegionInventory {
  /** Confirmed LZ77 stream count (verified by successful decompression). */
  readonly confirmedLz77BlockCount: number;
  /** Sum of confirmed-LZ77-stream compressed byte lengths. */
  readonly confirmedLz77BytesCovered: number;
  /** High-entropy regions that did NOT overlap a confirmed LZ77 block - 
   *  registered as `probable_compression` scored-unknowns by the detector. */
  readonly probableCompressionRegionCount: number;
  /** Sum of probable-compression scored-unknown byte lengths. */
  readonly probableCompressionBytesScored: number;
  /** Top-N largest confirmed LZ77 blocks for at-a-glance display
   *  (capped at 8 entries). Sorted by compressedLength descending. */
  readonly largestLz77Blocks: ReadonlyArray<{
    /** Block start offset within the ROM. */
    readonly offset: number;
    /** Compressed stream length in bytes. */
    readonly compressedSize: number;
    /** Decompressed payload size declared in the LZ77 header. */
    readonly uncompressedSize: number;
  }>;
}

export interface WorkspaceWorldGraph {
  readonly mapNodeIds: ReadonlyArray<string>;
  readonly warpNodeIds: ReadonlyArray<string>;
  readonly buildingNodeIds: ReadonlyArray<string>;
  /** Per-map summary tile: id + label + outgoing edges count. */
  readonly mapSummaries: ReadonlyArray<{
    readonly mapNodeId: string;
    readonly label: string;
    readonly outgoingWarpCount: number;
    readonly outgoingConnectionCount: number;
    readonly hasEventCount: number;
  }>;
}

export interface WorkspaceMap {
  readonly mapNodeId: string;
  readonly label: string;
  /** Map-level detail copied from the graph node detail. */
  readonly detail: Record<string, unknown>;
  /** Event nodes attached to this map (npcs/warps/coordEvents/bgEvents). */
  readonly eventNodeIds: ReadonlyArray<string>;
  /** Tileset asset ids referenced by this map. */
  readonly tilesetAssetIds: ReadonlyArray<string>;
  /** Music track id (= the gSongTable entry index) used by this map. */
  readonly musicTrackId: string | null;
  /** Encounter table ids attached to this map. */
  readonly encounterTableIds: ReadonlyArray<string>;
}

export interface WorkspaceEventGraph {
  /** Every event node (NPC / coord / bg / hidden item / etc.) with
   *  its trigger relationships. */
  readonly eventNodes: ReadonlyArray<{
    readonly id: string;
    readonly kind: string;
    readonly label: string;
    readonly detail: Record<string, unknown>;
  }>;
  /** Every script node. */
  readonly scriptNodes: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly detail: Record<string, unknown>;
  }>;
  /** has_event edges (map → event). */
  readonly hasEventEdges: ReadonlyArray<{ from: string; to: string }>;
  /** script_triggers edges (event → script). */
  readonly scriptTriggersEdges: ReadonlyArray<{ from: string; to: string }>;
  /** unlocks chain edges (script → script via shared flag, from P7-T3). */
  readonly unlocksEdges: ReadonlyArray<{
    from: string;
    to: string;
    viaVariableId?: number;
  }>;
}

export interface WorkspaceStoryProgression {
  /** Every variable/flag node with its role classification (from P7-T2). */
  readonly variables: ReadonlyArray<{
    readonly id: string;
    readonly variableId: number;
    readonly role: string | null;
    readonly setsCount: number;
    readonly readsCount: number;
    readonly gatesCount: number;
  }>;
}

export interface WorkspaceAssetBrowser {
  /** All asset nodes bucketed by sub-kind. */
  readonly bySubKind: Readonly<
    Record<
      string,
      ReadonlyArray<{
        readonly id: string;
        readonly label: string;
        readonly detail: Record<string, unknown>;
        /** Reverse-lookup: ids of consumer nodes that reference this asset
         *  via uses_asset edges. Pre-computed for fast "what uses this?"
         *  in the asset browser. */
        readonly consumerNodeIds: ReadonlyArray<string>;
      }>
    >
  >;
  /** Total asset count across all sub-kinds. */
  readonly totalAssetCount: number;
}

export interface WorkspaceMechanicInventory {
  /** All species:N nodes with their merged P8 detail (baseStats +
   *  evolutions + learnset + tmhmCompat). */
  readonly species: ReadonlyArray<{
    readonly id: string;
    readonly speciesIndex: number;
    readonly label: string;
    readonly detail: Record<string, unknown>;
  }>;
  /** All trainer:N nodes with detail. */
  readonly trainers: ReadonlyArray<{
    readonly id: string;
    readonly trainerIndex: number;
    readonly label: string;
    readonly detail: Record<string, unknown>;
  }>;
  /** All encounter_table:N nodes with detail (incl. encountersDeep
   *  from P8-T3). */
  readonly encounterTables: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly detail: Record<string, unknown>;
  }>;
}

export interface WorkspaceRuntimeSystems {
  /** True iff the Phase-10 runtime validator ran. */
  readonly present: boolean;
  /** When present: per-script-body trace bundles. */
  readonly traces: ReadonlyArray<{
    readonly entrypointOffset: number;
    readonly executedOpcodeCount: number;
    readonly traceEvents: ReadonlyArray<RuntimeTraceEvent>;
    readonly bodyByteLength: number;
  }>;
  /** Static-vs-runtime validation findings. */
  readonly validationFindings: ReadonlyArray<{
    readonly assumptionClass: string;
    readonly writerScriptOffset: number;
    readonly readerScriptOffset: number;
    readonly flagId: number;
    readonly verdict: 'confirmed' | 'diverged';
  }>;
  /** Distinct flag/variable ids observed during runtime traces. */
  readonly observedFlagIds: ReadonlyArray<number>;
  readonly observedVariableIds: ReadonlyArray<number>;
}

export interface WorkspaceFeatureDetection {
  /** Per-detector summary. */
  readonly detectors: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly phase: number;
    readonly status: 'detected' | 'partial' | 'not_detected';
    readonly confidence: number;
    readonly runtimeMs: number;
  }>;
  /** Aggregate counts. */
  readonly summary: {
    readonly detectedCount: number;
    readonly partialCount: number;
    readonly notDetectedCount: number;
  };
}

export interface WorkspaceCoverage {
  readonly romSize: number;
  readonly classifiedBytes: number;
  readonly unknownScoredBytes: number;
  readonly unaccountedBytes: number;
  readonly classifiedPct: number;
  readonly unknownScoredPct: number;
  readonly unaccountedPct: number;
  readonly regionCount: number;
}

/** Local helpers exported for unit-test convenience: utility to
 *  shallow-copy a graph Node into a plain serializable shape. */
export function nodeToPlain(n: Node): {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  readonly detail: Record<string, unknown>;
} {
  return {
    id: n.id,
    kind: n.kind,
    label: n.label ?? n.id,
    detail: (n.detail as Record<string, unknown>) ?? {},
  };
}

/** Local helper: shallow-copy a graph Edge into a plain shape. */
export function edgeToPlain(e: Edge): { from: string; to: string; detail?: Record<string, unknown> } {
  return {
    from: e.from,
    to: e.to,
    ...(e.detail ? { detail: e.detail as Record<string, unknown> } : {}),
  };
}
