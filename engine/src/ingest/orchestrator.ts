/**
 * Ingest orchestrator.
 *
 * Runs a registered set of detectors against a ROM image, aggregates their
 * Detection results, and ENFORCES the universal contract at the boundary:
 *   - every detector result passes `assertNoEmptySuccess` (PD 1 - a detector
 *     that returned `detected` with empty data triggers an OrchestratorPDViolation,
 *     never silently propagates)
 *   - each detector contributes its own coverage regions to a shared
 *     CoverageMap; the orchestrator returns the final report so callers
 *     have a single object that's both the per-system detection roundup and
 *     the byte-coverage snapshot
 *
 * The Phase 0 acceptance criterion is exactly this orchestrator + the
 * header-fingerprint detector + the coverage figures from it. Phase 1+ adds
 * more detectors to the registry; the orchestrator's contract does not
 * change.
 */

import { CoverageMap, type CoverageReport } from '../coverage/index.js';
import {
  EmptySuccessError,
  assertNoEmptySuccess,
  type Detection,
} from '../detection/index.js';
import type { RomImage } from '../rom/loader.js';
import type { RomDetector } from '../detectors/types.js';

/**
 * Per-detector result row. `detection` is the raw Detection<T> as the
 * detector returned it; `runtimeMs` is the wall-clock time the detector took.
 */
export interface DetectionRunResult {
  readonly detectorId: string;
  readonly detectorName: string;
  readonly phase: number;
  readonly detection: Detection<unknown>;
  readonly runtimeMs: number;
}

/**
 * Aggregated ingest report. Carries both the per-detector Detection roundup
 * AND the coverage snapshot built up by the detectors as they ran.
 *
 * `emptySuccessViolations` lists detector IDs that attempted to return an
 * empty-success result (caught by `assertNoEmptySuccess` and re-thrown).
 * Always empty in a correctly-functioning build - its presence in the type
 * is precisely so PD 1 violations can be SURFACED in a report rather than
 * silently logged and dropped. If the field is non-empty, the orchestrator
 * threw, so a non-empty value here only exists as part of the thrown error.
 */
export interface IngestReport {
  readonly rom: {
    readonly sha1: string;
    readonly byteLength: number;
    readonly sourcePath: string | null;
    readonly corpusClass: string | null;
    readonly synthetic: boolean;
  };
  readonly detections: ReadonlyArray<DetectionRunResult>;
  readonly coverage: CoverageReport;
  readonly summary: IngestSummary;
}

export interface IngestSummary {
  readonly detectedCount: number;
  readonly partialCount: number;
  readonly notDetectedCount: number;
  readonly totalDetectors: number;
}

/**
 * Thrown when a detector violates PD 1 (returns `detected`/`partial` with
 * empty data, or zero evidence). Carries enough context to identify the
 * offending detector immediately.
 */
export class OrchestratorPDViolation extends Error {
  constructor(
    message: string,
    readonly detectorId: string,
    override readonly cause: EmptySuccessError,
  ) {
    super(message);
    this.name = 'OrchestratorPDViolation';
  }
}

/**
 * Run all `detectors` against `rom` in declared order. Each detector writes
 * its coverage regions into a shared CoverageMap. The orchestrator boundary-
 * asserts every Detection result against the PD 1 invariant.
 *
 * Returns an IngestReport. Throws `OrchestratorPDViolation` if any detector
 * tries to smuggle an empty-success result through.
 */
export async function ingestRom(args: {
  rom: RomImage;
  detectors: ReadonlyArray<RomDetector<unknown>>;
}): Promise<IngestReport> {
  const coverage = new CoverageMap(args.rom.byteLength);
  const results: DetectionRunResult[] = [];

  for (const detector of args.detectors) {
    const startedAtMs = nowMs();
    let detection: Detection<unknown>;
    try {
      detection = await detector.detect(args.rom, coverage);
    } catch (e) {
      // A detector throwing an unhandled exception is a different failure
      // mode from empty-success. We surface it as a not_detected result so
      // the report is still useful (the operator sees the crash + which
      // detector did it), rather than crashing the whole ingest. The
      // EmptySuccessError case is handled below to convert it into the
      // explicit PD 1 violation type - that one is fatal because it means
      // the detector itself is broken in a way that defeats the contract.
      if (e instanceof EmptySuccessError) {
        throw new OrchestratorPDViolation(
          `detector "${detector.id}" violated PD 1 (no empty success): ${e.message}`,
          detector.id,
          e,
        );
      }
      // Convert any other detector throw into a typed not_detected so the
      // report aggregates honestly. The detector should have caught its
      // own internal failures and returned not_detected; this catch is the
      // safety net for bugs in the detector itself.
      const runtimeMs = nowMs() - startedAtMs;
      results.push({
        detectorId: detector.id,
        detectorName: detector.name,
        phase: detector.phase,
        runtimeMs,
        detection: {
          status: 'not_detected',
          confidence: 0.0 as Detection<unknown>['confidence'],
          evidence: [
            {
              kind: 'heuristic',
              summary: `detector threw: ${(e as Error).message}`,
              weight: 1.0,
            },
          ],
          reason: `detector "${detector.id}" threw an unhandled exception during detect(): ${(e as Error).message}`,
        },
      });
      continue;
    }

    // PD 1 boundary enforcement. The constructors already do this, but plugin
    // detectors might hand-roll Detection objects; this catches them.
    try {
      assertNoEmptySuccess(detection);
    } catch (e) {
      if (e instanceof EmptySuccessError) {
        throw new OrchestratorPDViolation(
          `detector "${detector.id}" violated PD 1 (no empty success): ${e.message}`,
          detector.id,
          e,
        );
      }
      throw e;
    }

    const runtimeMs = nowMs() - startedAtMs;
    results.push({
      detectorId: detector.id,
      detectorName: detector.name,
      phase: detector.phase,
      runtimeMs,
      detection,
    });
  }

  const detectedCount = results.filter((r) => r.detection.status === 'detected').length;
  const partialCount = results.filter((r) => r.detection.status === 'partial').length;
  const notDetectedCount = results.filter((r) => r.detection.status === 'not_detected').length;

  return Object.freeze({
    rom: Object.freeze({
      sha1: args.rom.sha1,
      byteLength: args.rom.byteLength,
      sourcePath: args.rom.sourcePath,
      corpusClass: args.rom.corpusClass,
      synthetic: args.rom.synthetic,
    }),
    detections: Object.freeze([...results]),
    coverage: coverage.report(),
    summary: Object.freeze({
      detectedCount,
      partialCount,
      notDetectedCount,
      totalDetectors: results.length,
    }),
  });
}

function nowMs(): number {
  // `performance.now()` would be slightly more precise but only matters when
  // we're profiling micro-ops. For detector timings (typically ms to tens of
  // ms each) Date.now() is fine and avoids a Node-version compatibility
  // concern with `globalThis.performance` in some sandboxes.
  return Date.now();
}
