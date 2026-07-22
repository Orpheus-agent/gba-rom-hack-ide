/**
 * Gen-3 gTrainers table scanner - Phase 8 P8-T2.
 *
 * Scans the ROM for a run of consecutive 40-byte Trainer structs. Each
 * struct has 6 zero-padding bytes (positions 0x19/0x1A/0x1B/0x21/0x22/
 * 0x23), enum-bounded partyFlags/doubleBattle/partySize/trainerClass/
 * aiFlags, a valid (or NULL) ROM pointer at 0x24, and a Gen-3-charset
 * 12-byte trainer name with at least one printable character.
 *
 * Combined per-slice random-match probability < 1e-18 - a run of ≥ 8
 * consecutive parse-successes is essentially certain to be the real
 * gTrainers table (vanilla FireRed has 743 entries; vanilla Emerald
 * has 855; CFRU/expansion builds extend further).
 *
 * Algorithm: 4-byte stride scan; at every candidate position greedy-
 * walk consecutive Trainer records 40 bytes apart until parse fails.
 * First convincing run wins. Conservative defaults: min 8, max 2048.
 *
 * PD 5: structural-only - no baked offsets; PD 8: every byte of the
 * discovered table is registered in coverage.
 */

import {
  TRAINER_STRUCT_SIZE_BYTES,
  parseTrainer,
  type Trainer,
} from './trainer.js';

/** Minimum records required to accept a run as the gTrainers table.
 *  Vanilla has 743+; even a near-empty test ROM should clear 8. */
export const TRAINER_SCAN_MIN_RECORDS = 8;
/** Cap on records walked per candidate. Vanilla maxes 743 (FireRed) /
 *  855 (Emerald). Heavy hacks extend; 2048 is generous. */
export const TRAINER_SCAN_MAX_RECORDS = 2048;

export interface TrainerTable {
  /** ROM file offset of the table's first byte (= trainer 0). */
  readonly tableStart: number;
  /** Exclusive end offset. */
  readonly tableEndExclusive: number;
  /** Number of valid trainers parsed. */
  readonly trainerCount: number;
  /** Each parsed trainer, in table order. Index = trainer id. */
  readonly trainers: ReadonlyArray<Trainer>;
}

export interface ScanTrainersOptions {
  readonly minTrainersInTable?: number;
  readonly maxTrainersInTable?: number;
}

/** Find the gTrainers table structurally. Returns null when no
 *  convincing run is found. */
export function scanTrainerTable(
  bytes: Uint8Array,
  opts?: ScanTrainersOptions,
): TrainerTable | null {
  const minTrainersInTable = opts?.minTrainersInTable ?? TRAINER_SCAN_MIN_RECORDS;
  const maxTrainersInTable = opts?.maxTrainersInTable ?? TRAINER_SCAN_MAX_RECORDS;
  if (!Number.isInteger(minTrainersInTable) || minTrainersInTable < 1) {
    throw new Error(
      `minTrainersInTable must be a positive integer, got ${String(minTrainersInTable)}`,
    );
  }
  if (
    !Number.isInteger(maxTrainersInTable) ||
    maxTrainersInTable < minTrainersInTable
  ) {
    throw new Error(
      `maxTrainersInTable must be >= minTrainersInTable, got ${String(maxTrainersInTable)}`,
    );
  }

  const stride = 4;
  const limit = bytes.length - TRAINER_STRUCT_SIZE_BYTES;
  for (let candidateStart = 0; candidateStart <= limit; candidateStart += stride) {
    const trainers: Trainer[] = [];
    let cursor = candidateStart;
    while (trainers.length < maxTrainersInTable) {
      if (cursor + TRAINER_STRUCT_SIZE_BYTES > bytes.length) break;
      const r = parseTrainer(bytes, cursor);
      if (!r.ok) break;
      trainers.push(r.trainer);
      cursor += TRAINER_STRUCT_SIZE_BYTES;
    }
    if (trainers.length >= minTrainersInTable) {
      return Object.freeze({
        tableStart: candidateStart,
        tableEndExclusive: cursor,
        trainerCount: trainers.length,
        trainers: Object.freeze(trainers),
      });
    }
  }
  return null;
}
