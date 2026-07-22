/**
 * Workspace generator - Phase 12 P12-T1.
 *
 * Composes a canonical `WorkspaceModel` from an `IngestReport`, the
 * built `RelationshipGraph`, an optional `RuntimeValidatorReport`,
 * and family verdict context. Pure function over those inputs; the
 * editor frontend re-generates the model whenever a new ingest
 * completes.
 *
 * The generator is the SOLE consumer of the underlying detector
 * data shapes - it lifts them into the flat JSON-friendly
 * WorkspaceModel sections defined in `./model.ts`. The editor never
 * peeks into IngestReport.detections.find(...) - it reads
 * workspace.<section>.<field>.
 */

import type { IngestReport } from '../ingest/index.js';
import type { RelationshipGraph } from '../graph/graph.js';
import type { Edge, Node } from '../graph/types.js';
import type { RuntimeValidatorReport } from '../detectors/runtime-validator.js';
import {
  HEADER_FINGERPRINT_DETECTOR_ID,
  type HeaderFingerprintPayload,
} from '../detectors/header-fingerprint.js';
import {
  POINTER_NETWORK_DETECTOR_ID,
  type PointerNetworkSummary,
} from '../detectors/pointer-network.js';
import {
  COMPRESSION_FORMAT_DETECTOR_ID,
  type CompressionInventory,
} from '../detectors/compression-format.js';
import { GBA_HEADER_LENGTH } from '../rom/header.js';

/** Maximum number of sample entries to include in identity-inventory
 *  views (top-N largest tables / blocks for at-a-glance display). */
const IDENTITY_INVENTORY_SAMPLE_CAP = 8;
import {
  edgeToPlain,
  nodeToPlain,
  type WorkspaceAssetBrowser,
  type WorkspaceCoverage,
  type WorkspaceEventGraph,
  type WorkspaceFeatureDetection,
  type WorkspaceIdentity,
  type WorkspaceIdentityCompressionRegionInventory,
  type WorkspaceIdentityHeader,
  type WorkspaceIdentityMemoryLayout,
  type WorkspaceIdentityPointerTableInventory,
  type WorkspaceMap,
  type WorkspaceMechanicInventory,
  type WorkspaceModel,
  type WorkspaceRuntimeSystems,
  type WorkspaceStoryProgression,
  type WorkspaceWorldGraph,
} from './model.js';

export interface GenerateWorkspaceArgs {
  readonly report: IngestReport;
  readonly graph: RelationshipGraph;
  /** Optional family verdict (from classifyFamily()). Default
   *  produces a permissive "unrecognized" identity card. */
  readonly familyVerdict?: {
    readonly family: string;
    readonly confidence: number;
    readonly matchedSignatures?: ReadonlyArray<string>;
  };
  /** Optional Phase-10 runtime validator report. When absent, the
   *  `runtimeSystems` section reports `present: false`. */
  readonly runtimeReport?: RuntimeValidatorReport;
  /** Optional override of the generator timestamp (for deterministic tests). */
  readonly nowIsoUtc?: string;
}

export function generateWorkspace(args: GenerateWorkspaceArgs): WorkspaceModel {
  const { report, graph, familyVerdict, runtimeReport } = args;
  const generatedAtUtc = args.nowIsoUtc ?? new Date().toISOString();

  // UW-1-T1: lift the cartridge header out of the header-fingerprint
  // detection into a first-class WorkspaceIdentity field, so editor
  // consumers don't dig through report.detections.find(...) to render
  // an identity card. When the detector returned `partial` or
  // `not_detected` (bad fixed marker, too-short ROM), `header`
  // remains null and `headerDisplay` does too (PD 1 honored - never
  // empty-success-with-fake-header).
  const headerDetectionRow = report.detections.find(
    (d) => d.detectorId === HEADER_FINGERPRINT_DETECTOR_ID,
  );
  let workspaceHeader: WorkspaceIdentityHeader | null = null;
  let headerDisplay: string | null = null;
  if (
    headerDetectionRow?.detection.status === 'detected' &&
    headerDetectionRow.detection.data &&
    typeof headerDetectionRow.detection.data === 'object' &&
    'header' in headerDetectionRow.detection.data
  ) {
    const payload = headerDetectionRow.detection.data as HeaderFingerprintPayload;
    workspaceHeader = {
      internalTitle: payload.header.internalTitle,
      gameCode: payload.header.gameCode,
      makerCode: payload.header.makerCode,
      softwareVersion: payload.header.softwareVersion,
      knownGame: payload.header.knownGame,
      fixedMarkerValid: payload.header.fixedMarkerValid,
    };
    headerDisplay = payload.display;
  }

  const memoryLayout: WorkspaceIdentityMemoryLayout = {
    romSize: report.rom.byteLength,
    headerOffset: 0,
    headerLength: GBA_HEADER_LENGTH,
    bodyOffset: GBA_HEADER_LENGTH,
    bodyLength: Math.max(0, report.rom.byteLength - GBA_HEADER_LENGTH),
  };

  // UW-1-T2: lift pointer-network summary + compression-format inventory
  // out of report.detections into first-class WorkspaceIdentity fields.
  // Both fall back to null when their detector returned not_detected
  // (PD 1 honored - never empty-success-with-fabricated-inventory).
  const pointerNetworkRow = report.detections.find(
    (d) => d.detectorId === POINTER_NETWORK_DETECTOR_ID,
  );
  let pointerTables: WorkspaceIdentityPointerTableInventory | null = null;
  if (
    pointerNetworkRow?.detection.status === 'detected' &&
    pointerNetworkRow.detection.data &&
    typeof pointerNetworkRow.detection.data === 'object' &&
    'pointerCount' in pointerNetworkRow.detection.data
  ) {
    const summary = pointerNetworkRow.detection.data as PointerNetworkSummary;
    const sortedTables = [...summary.tables].sort((a, b) => b.length - a.length);
    pointerTables = {
      totalPointerCount: summary.pointerCount,
      tableCount: summary.tables.length,
      tableBytesCovered: summary.tableBytesCovered,
      largestTables: sortedTables.slice(0, IDENTITY_INVENTORY_SAMPLE_CAP).map((t) => ({
        offset: t.start,
        length: t.length,
        stride: 4 as const,
      })),
      clusterTargetCount: summary.clusterTargetCount,
    };
  }

  const compressionFormatRow = report.detections.find(
    (d) => d.detectorId === COMPRESSION_FORMAT_DETECTOR_ID,
  );
  let compressionRegions: WorkspaceIdentityCompressionRegionInventory | null = null;
  if (
    compressionFormatRow?.detection.status === 'detected' &&
    compressionFormatRow.detection.data &&
    typeof compressionFormatRow.detection.data === 'object' &&
    'lz77Blocks' in compressionFormatRow.detection.data
  ) {
    const inv = compressionFormatRow.detection.data as CompressionInventory;
    const sortedBlocks = [...inv.lz77Blocks].sort(
      (a, b) => b.compressedLength - a.compressedLength,
    );
    compressionRegions = {
      confirmedLz77BlockCount: inv.lz77Blocks.length,
      confirmedLz77BytesCovered: inv.lz77BytesCovered,
      probableCompressionRegionCount: inv.probableCompressionRegions.length,
      probableCompressionBytesScored: inv.probableCompressionBytesScored,
      largestLz77Blocks: sortedBlocks.slice(0, IDENTITY_INVENTORY_SAMPLE_CAP).map((b) => ({
        offset: b.start,
        compressedSize: b.compressedLength,
        uncompressedSize: b.uncompressedSize,
      })),
    };
  }

  const identity: WorkspaceIdentity = {
    sha1: report.rom.sha1,
    byteLength: report.rom.byteLength,
    sourcePath: report.rom.sourcePath ?? 'unknown',
    corpusClass: report.rom.corpusClass,
    synthetic: report.rom.synthetic,
    familyVerdict: {
      family: familyVerdict?.family ?? 'unrecognized',
      confidence: familyVerdict?.confidence ?? 0,
      matchedSignatures: familyVerdict?.matchedSignatures ?? [],
    },
    header: workspaceHeader,
    headerDisplay,
    memoryLayout,
    pointerTables,
    compressionRegions,
  };

  // World graph: map/warp/building summaries.
  const mapNodes = graph.nodesByKind('map');
  const warpNodes = graph.nodesByKind('warp');
  const buildingNodes = graph.nodesByKind('building');
  const worldGraph: WorkspaceWorldGraph = {
    mapNodeIds: mapNodes.map((n) => n.id),
    warpNodeIds: warpNodes.map((n) => n.id),
    buildingNodeIds: buildingNodes.map((n) => n.id),
    mapSummaries: mapNodes.map((m) => {
      const outgoing = graph.outgoing(m.id);
      return {
        mapNodeId: m.id,
        label: m.label ?? m.id,
        outgoingWarpCount: outgoing.filter((e) => e.kind === 'warp_to').length,
        outgoingConnectionCount: outgoing.filter((e) => e.kind === 'connects_to').length,
        hasEventCount: outgoing.filter((e) => e.kind === 'has_event').length,
      };
    }),
  };

  // Per-map detail bundles.
  const maps: WorkspaceMap[] = mapNodes.map((m) => {
    const outgoing = graph.outgoing(m.id);
    return {
      mapNodeId: m.id,
      label: m.label ?? m.id,
      detail: (m.detail as Record<string, unknown>) ?? {},
      eventNodeIds: outgoing.filter((e) => e.kind === 'has_event').map((e) => e.to),
      tilesetAssetIds: outgoing
        .filter((e) => e.kind === 'uses_asset')
        .map((e) => e.to)
        .filter((id) => id.startsWith('asset:tileset:')),
      musicTrackId:
        outgoing.find((e) => e.kind === 'plays_music')?.to ?? null,
      encounterTableIds: graph
        .nodesByKind('encounter_table')
        .filter((et) => graph.outgoing(et.id).some((e) => e.kind === 'encounters_in' && e.to === m.id))
        .map((et) => et.id),
    };
  });

  // Event graph - event/script/npc nodes + their typed edges.
  const eventNodeKinds: Array<Node['kind']> = ['event', 'npc', 'warp'];
  const eventNodes = eventNodeKinds.flatMap((kind) => graph.nodesByKind(kind));
  const scriptNodes = graph.nodesByKind('script');
  const eventGraph: WorkspaceEventGraph = {
    eventNodes: eventNodes.map((n) => ({
      id: n.id,
      kind: n.kind,
      label: n.label ?? n.id,
      detail: (n.detail as Record<string, unknown>) ?? {},
    })),
    scriptNodes: scriptNodes.map(nodeToPlain).map((n) => ({
      id: n.id,
      label: n.label,
      detail: n.detail,
    })),
    hasEventEdges: graph.edgesByKind('has_event').map(edgeToPlain),
    scriptTriggersEdges: graph.edgesByKind('script_triggers').map(edgeToPlain),
    unlocksEdges: graph.edgesByKind('unlocks').map((e) => {
      const detail = e.detail as { viaVariableId?: number } | undefined;
      return {
        from: e.from,
        to: e.to,
        ...(detail?.viaVariableId !== undefined
          ? { viaVariableId: detail.viaVariableId }
          : {}),
      };
    }),
  };

  // Story progression - variable nodes + their P7-T2 role + usage profile.
  const variableNodes = graph.nodesByKind('variable');
  const storyProgression: WorkspaceStoryProgression = {
    variables: variableNodes.map((n) => {
      const d = (n.detail as Record<string, unknown>) ?? {};
      const usageProfile = (d.usageProfile as Record<string, number> | undefined) ?? {};
      return {
        id: n.id,
        variableId: typeof d.variableId === 'number' ? d.variableId : 0,
        role: typeof d.role === 'string' ? d.role : null,
        setsCount: usageProfile.setsCount ?? 0,
        readsCount: usageProfile.readsCount ?? 0,
        gatesCount: usageProfile.gatesCount ?? 0,
      };
    }),
  };

  // Asset browser - bucket asset nodes by detail.assetKind/assetType/sub-kind.
  const assetNodes = graph.nodesByKind('asset');
  const bySubKind: Record<
    string,
    Array<{
      id: string;
      label: string;
      detail: Record<string, unknown>;
      consumerNodeIds: string[];
    }>
  > = {};
  for (const a of assetNodes) {
    const d = (a.detail as Record<string, unknown>) ?? {};
    const subKind =
      (typeof d.assetKind === 'string' && d.assetKind) ||
      (typeof d.assetType === 'string' && d.assetType) ||
      'unknown';
    const consumers = graph.incoming(a.id)
      .filter((e) => e.kind === 'uses_asset')
      .map((e) => e.from);
    const bucket = (bySubKind[subKind] ??= []);
    bucket.push({
      id: a.id,
      label: a.label ?? a.id,
      detail: d,
      consumerNodeIds: consumers,
    });
  }
  const assetBrowser: WorkspaceAssetBrowser = {
    bySubKind: Object.freeze(
      Object.fromEntries(
        Object.entries(bySubKind).map(([k, v]) => [k, Object.freeze(v.map((x) => Object.freeze({ ...x, consumerNodeIds: Object.freeze(x.consumerNodeIds) })))]),
      ),
    ),
    totalAssetCount: assetNodes.length,
  };

  // Mechanic inventory - species + trainer + encounter_table.
  const speciesNodes = graph.nodesByKind('species');
  const trainerNodes = graph.nodesByKind('trainer');
  const encounterTableNodes = graph.nodesByKind('encounter_table');
  const mechanicInventory: WorkspaceMechanicInventory = {
    species: speciesNodes.map((n) => {
      const d = (n.detail as Record<string, unknown>) ?? {};
      return {
        id: n.id,
        speciesIndex: typeof d.speciesIndex === 'number' ? d.speciesIndex : 0,
        label: n.label ?? n.id,
        detail: d,
      };
    }),
    trainers: trainerNodes.map((n) => {
      const d = (n.detail as Record<string, unknown>) ?? {};
      return {
        id: n.id,
        trainerIndex: typeof d.trainerIndex === 'number' ? d.trainerIndex : 0,
        label: n.label ?? n.id,
        detail: d,
      };
    }),
    encounterTables: encounterTableNodes.map((n) => ({
      id: n.id,
      label: n.label ?? n.id,
      detail: (n.detail as Record<string, unknown>) ?? {},
    })),
  };

  // Runtime systems - Phase 10 output or `present: false`.
  const runtimeSystems: WorkspaceRuntimeSystems = runtimeReport
    ? {
        present: true,
        traces: runtimeReport.traces.map((t) => ({
          entrypointOffset: t.entrypointOffset,
          executedOpcodeCount: t.executedOpcodeCount,
          traceEvents: t.traceEvents,
          bodyByteLength: t.bodyByteLength,
        })),
        validationFindings: runtimeReport.validationFindings.map((f) => ({
          assumptionClass: f.assumptionClass,
          writerScriptOffset: f.writerScriptOffset,
          readerScriptOffset: f.readerScriptOffset,
          flagId: f.flagId,
          verdict: f.verdict,
        })),
        observedFlagIds: runtimeReport.observedFlagIds,
        observedVariableIds: runtimeReport.observedVariableIds,
      }
    : {
        present: false,
        traces: [],
        validationFindings: [],
        observedFlagIds: [],
        observedVariableIds: [],
      };

  // Feature detection - per-detector status summary.
  const featureDetection: WorkspaceFeatureDetection = {
    detectors: report.detections.map((d) => ({
      id: d.detectorId,
      name: d.detectorName,
      phase: d.phase,
      status: d.detection.status,
      confidence: d.detection.confidence,
      runtimeMs: d.runtimeMs,
    })),
    summary: {
      detectedCount: report.summary.detectedCount,
      partialCount: report.summary.partialCount,
      notDetectedCount: report.summary.notDetectedCount,
    },
  };

  // Coverage summary - mirror of CoverageReport sans regions array.
  const coverage: WorkspaceCoverage = {
    romSize: report.coverage.romSize,
    classifiedBytes: report.coverage.classifiedBytes,
    unknownScoredBytes: report.coverage.unknownScoredBytes,
    unaccountedBytes: report.coverage.unaccountedBytes,
    classifiedPct: report.coverage.classifiedPct,
    unknownScoredPct: report.coverage.unknownScoredPct,
    unaccountedPct: report.coverage.unaccountedPct,
    regionCount: report.coverage.regionCount,
  };

  return Object.freeze({
    generatedAtUtc,
    identity,
    worldGraph: Object.freeze({
      ...worldGraph,
      mapNodeIds: Object.freeze([...worldGraph.mapNodeIds]),
      warpNodeIds: Object.freeze([...worldGraph.warpNodeIds]),
      buildingNodeIds: Object.freeze([...worldGraph.buildingNodeIds]),
      mapSummaries: Object.freeze([...worldGraph.mapSummaries]),
    }),
    maps: Object.freeze(maps.map((m) => Object.freeze(m))),
    eventGraph: Object.freeze({
      ...eventGraph,
      eventNodes: Object.freeze([...eventGraph.eventNodes]),
      scriptNodes: Object.freeze([...eventGraph.scriptNodes]),
      hasEventEdges: Object.freeze([...eventGraph.hasEventEdges]),
      scriptTriggersEdges: Object.freeze([...eventGraph.scriptTriggersEdges]),
      unlocksEdges: Object.freeze([...eventGraph.unlocksEdges]),
    }),
    storyProgression: Object.freeze({
      ...storyProgression,
      variables: Object.freeze([...storyProgression.variables]),
    }),
    assetBrowser,
    mechanicInventory: Object.freeze({
      species: Object.freeze([...mechanicInventory.species]),
      trainers: Object.freeze([...mechanicInventory.trainers]),
      encounterTables: Object.freeze([...mechanicInventory.encounterTables]),
    }),
    runtimeSystems: Object.freeze({
      ...runtimeSystems,
      traces: Object.freeze([...runtimeSystems.traces]),
      validationFindings: Object.freeze([...runtimeSystems.validationFindings]),
    }),
    featureDetection: Object.freeze({
      ...featureDetection,
      detectors: Object.freeze([...featureDetection.detectors]),
    }),
    coverage,
  });
}

/** Helper unused locally but referenced from tests/serializers. */
export type { Edge, Node };
