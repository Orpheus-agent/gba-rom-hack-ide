/**
 * EngineClient - the editor backend's typed bridge to the introspection
 * engine.
 *
 * Engine/editor single source of truth: the editor backend MAY NOT
 * re-implement detection / classification / coverage. It consumes the
 * engine's
 * `WorkspaceModel` directly via this module. Any backend code that
 * needs detected ROM content (maps, species, events, etc.) goes
 * through `runEngineOnRom` here - never through a parallel scanner.
 *
 * Two properties this module is required to keep true:
 *   - Editor backend has zero ROM-bytes-parsing logic outside this
 *     module (the existing `app/backend/src/scan/*` modules are
 *     `legacy-pending-removal` and will be migrated to delegate
 *     through `runEngineOnRom` in subsequent UW-0 iterations).
 *   - The cumulative end-to-end test asserts that `runEngineOnRom`
 *     on a synthetic ROM produces a `WorkspaceModel` with the
 *     expected sections populated.
 *
 * This module is the canonical and only path from editor backend to
 * engine output. It exposes:
 *   - `runEngineOnRom({ romBytes, sourcePath })` - runs the full
 *     default detector pipeline (PD 13 substrate).
 *   - `runEngineOnRomPath({ romPath })` - convenience that reads
 *     the file then calls `runEngineOnRom`.
 *   - `WorkspaceModel`, `IngestReport`, family verdict types re-exported
 *     so backend route handlers can type their responses against the
 *     engine's canonical shapes.
 */

import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  classify,
  detectors as detectorsNs,
  graph as graphNs,
  ingest,
  rom as romNs,
  signatures,
  workspace,
} from '@rom-introspection/engine';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Default signatures directory used by `runEngineOnRom` when no
 * `signaturesDir` is supplied. Resolves to the project root's
 * `/signatures/` folder by walking up from `app/backend/src/`.
 *
 * Path: `app/backend/src/engine-client.ts` → `../..` = `app/backend/`,
 * `../../..` = `app/`, `../../../..` = project root, then `/signatures/`.
 */
export const DEFAULT_SIGNATURES_DIR = path.resolve(__dirname, '..', '..', '..', 'signatures');

export interface RunEngineOnRomArgs {
  /** ROM bytes (Uint8Array; Node `Buffer` is accepted since `Buffer
   *  extends Uint8Array`). */
  readonly romBytes: Uint8Array;
  /** Source path (or synthetic://... marker) for identity provenance. */
  readonly sourcePath: string;
  /** Optional operator-supplied corpus class label
   *  ('vanilla' | 'heavyHack' | 'cfru' | 'decomp' | 'customFork'). */
  readonly corpusClass?: string | null;
  /** Override the signatures directory (default
   *  `DEFAULT_SIGNATURES_DIR`). */
  readonly signaturesDir?: string;
  /** Override the WorkspaceModel `generatedAtUtc` for deterministic
   *  tests. */
  readonly nowIsoUtc?: string;
  /** Mark the loaded ROM as synthetic (test fixture). Default false
   *  (the editor's normal path is user-supplied real ROMs). */
  readonly synthetic?: boolean;
}

export interface RunEngineOnRomResult {
  readonly workspaceModel: workspace.WorkspaceModel;
  readonly ingestReport: ingest.IngestReport;
  readonly familyVerdict: classify.FamilyVerdict;
}

/**
 * Run the engine's default detector pipeline against the given ROM
 * bytes and return the canonical `WorkspaceModel` plus the underlying
 * `IngestReport` + `FamilyVerdict` for any backend code that needs
 * the raw artifacts.
 *
 * Pipeline (per `engine/scripts/ingest-smoke.mjs`):
 *   1. Load the signature DB (hot-loadable per D-0007).
 *   2. Build the default detector set.
 *   3. Load the ROM into a `RomImage` (validates header + size).
 *   4. Run `ingestRom` orchestrator (PD 1 enforced at boundary).
 *   5. Classify family (vanilla / heavy hack / unrecognized).
 *   6. Build the relationship graph.
 *   7. Generate the canonical `WorkspaceModel`.
 *
 * Throws:
 *   - `RomLoadError` from the engine if `romBytes` cannot be parsed
 *     as a valid GBA ROM image.
 *   - `OrchestratorPDViolation` from the engine if any detector
 *     violates PD 1 (empty-success).
 *   - I/O errors if `signaturesDir` is unreadable.
 */
export async function runEngineOnRom(args: RunEngineOnRomArgs): Promise<RunEngineOnRomResult> {
  const signaturesDir = args.signaturesDir ?? DEFAULT_SIGNATURES_DIR;

  const signatureDb = await signatures.loadSignatureDb({
    signaturesDir,
    strict: false,
  });
  const detectors = ingest.buildDefaultDetectorSet({ signatureDb });

  const rom = romNs.loadRomFromBytes({
    bytes: args.romBytes,
    sourcePath: args.sourcePath,
    synthetic: args.synthetic ?? false,
    corpusClass: args.corpusClass ?? null,
  });

  const report = await ingest.ingestRom({ rom, detectors });
  const verdict = classify.classifyFamily(report);
  const graph = graphNs.buildRelationshipGraph({
    report,
    verdict,
    romBytes: rom.bytes,
  });
  const workspaceModel = workspace.generateWorkspace({
    report,
    graph,
    familyVerdict: {
      family: verdict.family,
      confidence: verdict.confidence,
    },
    nowIsoUtc: args.nowIsoUtc,
  });

  return { workspaceModel, ingestReport: report, familyVerdict: verdict };
}

export interface RunEngineOnRomPathArgs {
  readonly romPath: string;
  readonly corpusClass?: string | null;
  readonly signaturesDir?: string;
  readonly nowIsoUtc?: string;
}

/**
 * Convenience wrapper: read the ROM file from disk then call
 * `runEngineOnRom`. Source path is the resolved absolute path.
 */
export async function runEngineOnRomPath(
  args: RunEngineOnRomPathArgs,
): Promise<RunEngineOnRomResult> {
  const absPath = path.resolve(args.romPath);
  const bytes = await readFile(absPath);
  return runEngineOnRom({
    romBytes: bytes,
    sourcePath: absPath,
    corpusClass: args.corpusClass,
    signaturesDir: args.signaturesDir,
    nowIsoUtc: args.nowIsoUtc,
  });
}

// ---------------------------------------------------------------
// Lightweight structure scan (UW-1-T4)
// ---------------------------------------------------------------

/**
 * Lightweight ROM structure scan that runs ONLY the 3 substrate
 * detectors needed to populate `WorkspaceIdentity` (header,
 * pointer-network, compression-format) - NOT the full ingest
 * pipeline of 16+ detectors. Used by the editor's project-open
 * flow to populate the identity card without paying for the full
 * ~3-second pipeline cost.
 *
 * The returned shape mirrors the relevant `WorkspaceIdentity`
 * fields exactly (same types from `workspace` namespace) so the
 * editor's `ProjectIdentity.romStructure` field is type-compatible
 * with the engine's canonical types per PD 13.
 *
 * Performance budget: ~500ms-1s on a 16 MiB ROM (vs ~3s for
 * `runEngineOnRom`).
 */
export interface ScanRomStructureArgs {
  readonly romBytes: Uint8Array;
  readonly sourcePath: string;
  readonly synthetic?: boolean;
}

/**
 * Per-subsystem detection summary lifted from the engine's
 * WorkspaceFeatureDetection. One entry per engine detector that ran
 * during `scanRomStructure` (currently: save-system, moves, type-chart,
 * items, abilities). Surfaced by the editor IdentityCard so users see
 * which combat-data subsystems the engine found (Cat 2 + Cat 4 editor
 * surface; UW-2-T6 iter 72).
 *
 * Per PD 13: derived directly from the engine's
 * `WorkspaceFeatureDetection.detectors[]` array - no editor-side
 * re-detection.
 */
export interface DetectedSubsystem {
  /** Stable detector id (e.g. 'moves_system', 'save_system'). */
  readonly id: string;
  /** Human-readable detector name (e.g. 'Moves System (Gen-3
   *  gBattleMoves scanner)'). */
  readonly name: string;
  /** Detection phase (currently 8 for all subsystem detectors). */
  readonly phase: number;
  /** Detection status from the engine: detected / partial /
   *  not_detected. */
  readonly status: 'detected' | 'partial' | 'not_detected';
  /** Confidence in [0, 1]. */
  readonly confidence: number;
  /** Detector runtime in milliseconds. */
  readonly runtimeMs: number;
  /** Optional one-line summary lifted from the detector's primary
   *  evidence (e.g. "Found gBattleMoves at offset 0x250000 (355
   *  moves, 4260 bytes)"). null for not_detected. */
  readonly summary: string | null;
  /** First N decoded names lifted from the detector's `result.data
   *  .sampleNames` when present. Used by the IdentityCard's
   *  DetectedSubsystemsSection to render a chip-list preview of
   *  decoded names below the summary (UW-2-T9 iter 75). Absent for
   *  detectors that don't expose sampleNames (save_system,
   *  type_chart_system, items_system unless iter 74 ran - items_system
   *  added it iter 74). */
  readonly sampleNames?: ReadonlyArray<string>;
}

/**
 * Per-scored-unknown-region summary surfaced for the IdentityCard's
 * UnknownsPolicySection (Cat 15 substrate; UW-2-T14 iter 80). One entry
 * per CoverageRegion with `kind === 'unknown_scored'` that the engine's
 * detectors registered with a confidence score but couldn't fully
 * classify.
 *
 * Per PD 12: the editor surfaces every scored-unknown region with
 * confidence + provenance + (optional) note so the user sees WHAT the
 * engine doesn't recognize and WHY - not a silent dead zone.
 */
export interface CoverageScoredUnknownRegion {
  readonly start: number;
  readonly end: number;
  readonly sizeBytes: number;
  readonly score: number;
  readonly provenance: string;
  readonly note?: string;
}

/**
 * Coverage summary surfaced for the IdentityCard's UnknownsPolicySection
 * (Cat 15 substrate; UW-2-T14 iter 80). Lifted from the engine's
 * IngestReport.coverage - totals (classified / scored-unknown /
 * unaccounted bytes + percentages) + top-N largest scored-unknown
 * regions sorted by size descending.
 *
 * Note: in the lightweight `scanRomStructure` path the coverage map
 * only covers the ~14 fast detectors' output, so the `unaccounted`
 * percentage will be high. The editor presents this honestly and
 * advises the user that running the full Scan Project pass closes
 * the unaccounted gap.
 */
export interface CoverageSummary {
  readonly romSize: number;
  readonly classifiedBytes: number;
  readonly unknownScoredBytes: number;
  readonly unaccountedBytes: number;
  readonly classifiedPct: number;
  readonly unknownScoredPct: number;
  readonly unaccountedPct: number;
  readonly regionCount: number;
  /** Top-N largest scored-unknown regions, sorted by size desc. */
  readonly topScoredUnknownRegions: ReadonlyArray<CoverageScoredUnknownRegion>;
}

export interface RomStructureScanResult {
  readonly memoryLayout: workspace.WorkspaceIdentityMemoryLayout;
  readonly pointerTables: workspace.WorkspaceIdentityPointerTableInventory | null;
  readonly compressionRegions: workspace.WorkspaceIdentityCompressionRegionInventory | null;
  /** Per-subsystem detection summaries from the 5 Cat 2/4 detectors
   *  (save-system, moves, type-chart, items, abilities). Empty array
   *  if the lightweight scan did not include subsystem detectors. */
  readonly detectedSubsystems: ReadonlyArray<DetectedSubsystem>;
  /** Coverage totals + scored-unknown regions for Cat 15 unknowns-policy
   *  surface (UW-2-T14 iter 80). null if not computed. */
  readonly coverageSummary: CoverageSummary;
}

export async function scanRomStructure(
  args: ScanRomStructureArgs,
): Promise<RomStructureScanResult> {
  const rom = romNs.loadRomFromBytes({
    bytes: args.romBytes,
    sourcePath: args.sourcePath,
    synthetic: args.synthetic ?? false,
    corpusClass: null,
  });
  // Detector subset: 3 structural detectors (header / pointer-network
  // / compression-format) for the identity card's memory map AND 11
  // subsystem detectors (save-system / moves / type-chart / items /
  // abilities / move-names / species-names / save-data-system /
  // menu-system / palette-system / audio-system) for the IdentityCard's
  // "Detected Subsystems" section (UW-2-T6 through UW-2-T13). Skip
  // the heaviest detectors (species-system / trainers / encounters /
  // maps / scripts / runtime) - those run during the full scanProject
  // pass triggered by the user, not at project-open.
  const detectors = [
    detectorsNs.headerFingerprintDetector,
    detectorsNs.pointerNetworkDetector,
    detectorsNs.compressionFormatDetector,
    detectorsNs.saveSystemDetector,
    detectorsNs.movesSystemDetector,
    detectorsNs.typeChartSystemDetector,
    detectorsNs.itemsSystemDetector,
    detectorsNs.abilitiesSystemDetector,
    detectorsNs.moveNamesDetector,
    detectorsNs.speciesNamesDetector,
    detectorsNs.saveDataSystemDetector,
    detectorsNs.menuSystemDetector,
    detectorsNs.paletteSystemDetector,
    detectorsNs.audioSystemDetector,
    detectorsNs.pokedexSystemDetector,
    detectorsNs.typeNamesDetector,
    detectorsNs.trainerClassNamesDetector,
    detectorsNs.cryTableDetector,
    detectorsNs.textPointerTablesDetector,
    detectorsNs.lz77PointerTablesDetector,
  ];
  const report = await ingest.ingestRom({ rom, detectors });
  // Use the workspace generator's existing lift logic by passing
  // an empty relationship graph - only the identity + featureDetection
  // sections are meaningful for our use case.
  const emptyGraph = new graphNs.RelationshipGraphBuilder().build();
  const ws = workspace.generateWorkspace({ report, graph: emptyGraph });
  // Lift the 5 subsystem detector summaries from
  // WorkspaceFeatureDetection.detectors[]. Filter to the 5 IDs we
  // care about so editor consumers don't have to know about the
  // structural detectors that also ran.
  const subsystemIds = new Set([
    'save_system',
    'moves_system',
    'type_chart_system',
    'items_system',
    'abilities_system',
    'move_names',
    'species_names',
    'save_data_system',
    'menu_system',
    'palette_system',
    'audio_system',
    'pokedex_system',
    'type_names',
    'trainer_class_names',
    'cry_table_system',
    'text_pointer_tables',
    'lz77_pointer_tables',
  ]);
  const detectedSubsystems: DetectedSubsystem[] = [];
  for (const det of ws.featureDetection.detectors) {
    if (!subsystemIds.has(det.id)) continue;
    // Lift the primary evidence summary from the IngestReport so the
    // editor can show "Found gBattleMoves at offset 0x..." etc.
    // without the editor having to know each detector's data shape.
    const detection = report.detections.find((d) => d.detectorId === det.id);
    let summary: string | null = null;
    let sampleNames: ReadonlyArray<string> | undefined = undefined;
    if (detection && detection.detection.status === 'detected') {
      const firstEvidence = detection.detection.evidence?.[0];
      if (firstEvidence && typeof firstEvidence.summary === 'string') {
        summary = firstEvidence.summary;
      }
      // Lift sampleNames if the detector exposes it. species_names /
      // ability_names / move_names / items_system all return
      // `data.sampleNames: ReadonlyArray<string>` in their detected
      // branch (iters 59, 71, 73, 74). The engine's Detection<unknown>
      // is type-erased here so use a runtime structural check on the
      // narrowed-detected payload's `data` field.
      const data = detection.detection.data as unknown;
      if (data && typeof data === 'object') {
        const candidate = (data as { sampleNames?: unknown }).sampleNames;
        if (
          Array.isArray(candidate) &&
          candidate.every((v): v is string => typeof v === 'string')
        ) {
          sampleNames = candidate;
        }
      }
    }
    detectedSubsystems.push({
      id: det.id,
      name: det.name,
      phase: det.phase,
      status: det.status,
      confidence: det.confidence,
      runtimeMs: det.runtimeMs,
      summary,
      ...(sampleNames !== undefined ? { sampleNames } : {}),
    });
  }
  // UW-2-T14 iter 80: lift coverage totals + top-N largest scored-
  // unknown regions for the IdentityCard's UnknownsPolicySection (Cat
  // 15 surface). Filter regions to `kind === 'unknown_scored'`, sort
  // by size desc, take top 5.
  const SCORED_UNKNOWN_PREVIEW_COUNT = 5;
  const scoredUnknownRegions: CoverageScoredUnknownRegion[] = [];
  for (const r of report.coverage.regions) {
    if (r.kind === 'unknown_scored') {
      scoredUnknownRegions.push({
        start: r.start,
        end: r.end,
        sizeBytes: r.end - r.start,
        score: r.score,
        provenance: r.provenance,
        ...(r.note ? { note: r.note } : {}),
      });
    }
  }
  scoredUnknownRegions.sort((a, b) => b.sizeBytes - a.sizeBytes);
  const coverageSummary: CoverageSummary = {
    romSize: report.coverage.romSize,
    classifiedBytes: report.coverage.classifiedBytes,
    unknownScoredBytes: report.coverage.unknownScoredBytes,
    unaccountedBytes: report.coverage.unaccountedBytes,
    classifiedPct: report.coverage.classifiedPct,
    unknownScoredPct: report.coverage.unknownScoredPct,
    unaccountedPct: report.coverage.unaccountedPct,
    regionCount: report.coverage.regionCount,
    topScoredUnknownRegions: scoredUnknownRegions.slice(0, SCORED_UNKNOWN_PREVIEW_COUNT),
  };

  return {
    memoryLayout: ws.identity.memoryLayout,
    pointerTables: ws.identity.pointerTables,
    compressionRegions: ws.identity.compressionRegions,
    detectedSubsystems,
    coverageSummary,
  };
}

// Re-export the canonical engine types so backend route handlers can
// type their responses against engine shapes without importing the
// engine package directly. PD 13 - single conduit.
export type WorkspaceModel = workspace.WorkspaceModel;
export type WorkspaceIdentity = workspace.WorkspaceIdentity;
export type WorkspaceWorldGraph = workspace.WorkspaceWorldGraph;
export type WorkspaceMap = workspace.WorkspaceMap;
export type WorkspaceEventGraph = workspace.WorkspaceEventGraph;
export type WorkspaceStoryProgression = workspace.WorkspaceStoryProgression;
export type WorkspaceAssetBrowser = workspace.WorkspaceAssetBrowser;
export type WorkspaceMechanicInventory = workspace.WorkspaceMechanicInventory;
export type WorkspaceRuntimeSystems = workspace.WorkspaceRuntimeSystems;
export type WorkspaceFeatureDetection = workspace.WorkspaceFeatureDetection;
export type WorkspaceCoverage = workspace.WorkspaceCoverage;

export type IngestReport = ingest.IngestReport;
export type FamilyVerdict = classify.FamilyVerdict;
