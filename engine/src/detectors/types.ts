/**
 * Universal detector contract.
 *
 * Per §6.4 + §15 (Phase 1+), every detector in the engine is a function from
 * a ROM image + a shared coverage accumulator to a typed Detection result.
 * Detectors are pure with respect to their inputs except for the side-effect
 * of WRITING coverage regions (because coverage is a global per-ROM
 * accumulator - every detector contributes; the §Phase-3 finalizer drains
 * the rest into scored-unknown).
 *
 * The contract enforces:
 *   - every detector declares its `id` + the §15 phase it serves
 *   - every detector returns a typed Detection<T> (the universal result type
 *     from engine/src/detection)
 *   - every detector that found something writes its region(s) into the
 *     shared CoverageMap before returning, so the orchestrator's coverage
 *     ledger reflects the contribution
 *
 * Detectors are registered with the orchestrator (engine/src/ingest/
 * orchestrator.ts). The orchestrator runs them in declared order, asserts
 * no empty-success per result, and aggregates the IngestReport.
 */

import type { Detection } from '../detection/index.js';
import type { CoverageMap } from '../coverage/index.js';
import type { RomImage } from '../rom/loader.js';

/**
 * A detector's typed result + the side-effect contract.
 *
 * `T` is the system-specific reconstructed payload type (e.g. `GbaHeader`,
 * a species table, a script AST). Detectors implementing this interface
 * declare their concrete `T` so callers and tests can introspect them.
 */
export interface RomDetector<T> {
  /** Stable detector id (snake_case). Used in log lines, evidence, and the
   *  registry. Must be unique within an orchestrator. */
  readonly id: string;
  /** Detector display name (human-readable). */
  readonly name: string;
  /** Which §15 phase this detector serves. Phase 0 detectors are the
   *  hardware-spec-only ones (header). Phase 1+ detectors implement
   *  fingerprinting/signature/heuristic logic per their phase's spec. */
  readonly phase: number;
  /**
   * Run the detector against `rom`. May call methods on `coverage` to
   * register classified regions. MUST return a typed Detection<T> - never
   * undefined, never an unbounded throw (catch internal failures and turn
   * them into `not_detected` with a reason).
   */
  detect(rom: RomImage, coverage: CoverageMap): Promise<Detection<T>> | Detection<T>;
}
