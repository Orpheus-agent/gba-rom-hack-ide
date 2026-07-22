/**
 * Phase-8 detector: trainer system detection (P8-T2).
 *
 * Per §15 Phase 8, the trainer system covers tables, AI, battle
 * scripting, classes, sprites, custom rules, and infers progression +
 * difficulty curves. P8-T2 starts with the foundational `gTrainers`
 * table - once we know where it is and how many trainers are present,
 * subsequent P8 tasks layer AI-flag semantics, party introspection
 * (via partyPointer), class names, and difficulty/progression chains.
 *
 * Coverage contribution: every byte of the discovered gTrainers table
 * is registered as `table` class at confidence 0.9.
 *
 * PD 5: structural-only - `scanTrainerTable` finds the table by
 * validating the 40-byte struct shape per record; no baked offsets.
 *
 * PD 1 / §15 P8 acceptance: this detector advances the "species is no
 * longer the only populated system" mandate - after P8-T1 surfaced
 * species, P8-T2 surfaces trainers. The 'trainer' NodeKind, declared
 * since Phase 4, is now populated alongside species.
 */

import { makeDetected, makeEvidence, makeNotDetected } from '../detection/index.js';
import type { Detection } from '../detection/index.js';
import type { CoverageMap } from '../coverage/index.js';
import type { RomImage } from '../rom/loader.js';
import type { RomDetector } from './types.js';
import {
  TRAINER_SCAN_MIN_RECORDS,
  TRAINER_STRUCT_SIZE_BYTES,
  scanTrainerTable,
  type TrainerTable,
} from '../trainers/index.js';

export const TRAINER_SYSTEM_DETECTOR_ID = 'trainer_system';

export interface TrainerSystemReport {
  /** Discovered gTrainers table. */
  readonly trainerTable: TrainerTable;
  /** Convenience mirror of trainerTable.trainerCount. */
  readonly trainerCount: number;
}

export const trainerSystemDetector: RomDetector<TrainerSystemReport> = {
  id: TRAINER_SYSTEM_DETECTOR_ID,
  name: 'Trainer System (Gen-3 gTrainers scanner)',
  phase: 8,
  detect(rom: RomImage, coverage: CoverageMap): Detection<TrainerSystemReport> {
    if (
      rom.byteLength <
      TRAINER_SCAN_MIN_RECORDS * TRAINER_STRUCT_SIZE_BYTES
    ) {
      return makeNotDetected({
        confidence: 1.0,
        evidence: [
          makeEvidence({
            kind: 'heuristic',
            summary: `ROM is ${String(rom.byteLength)} bytes - too small to host a ≥${String(TRAINER_SCAN_MIN_RECORDS)}-record gTrainers table`,
            weight: 1.0,
          }),
        ],
        reason: 'ROM too small to scan for Gen-3 gTrainers table',
      });
    }

    const trainerTable = scanTrainerTable(rom.bytes);
    if (trainerTable === null) {
      return makeNotDetected({
        confidence: 0.85,
        evidence: [
          makeEvidence({
            kind: 'heuristic',
            summary: `scanned ${String(rom.byteLength)} bytes for a run of ≥${String(TRAINER_SCAN_MIN_RECORDS)} 40-byte Trainer records (structural signature: 6 padding bytes at 0x19/0x1A/0x1B/0x21/0x22/0x23 == 0, partyFlags ≤ 3, partySize ∈ [1,6], aiFlags ≤ 0xFFFF, valid/NULL partyPointer, Gen-3 charset trainerName) - none found`,
            weight: 1.0,
            detail: {
              romByteLength: rom.byteLength,
              structSize: TRAINER_STRUCT_SIZE_BYTES,
              minRecords: TRAINER_SCAN_MIN_RECORDS,
            },
          }),
        ],
        reason:
          'No Gen-3 gTrainers table found - either the ROM is non-Gen-3, the trainer engine has been rewritten with a non-flat layout, or the ROM contains too few trainer records to clear the min-records threshold',
      });
    }

    try {
      coverage.addClassified({
        start: trainerTable.tableStart,
        end: trainerTable.tableEndExclusive,
        probableClass: 'table',
        score: 0.9,
        provenance: `${TRAINER_SYSTEM_DETECTOR_ID}#gTrainers`,
        note: `Gen-3 gTrainers (${String(trainerTable.trainerCount)} trainers)`,
      });
    } catch {
      // Overlap with another detector - skip.
    }

    // Confidence: vanilla FireRed has 743, Emerald 855; heavy hacks
    // expand to 1000+. Anything above 400 is essentially certainly real.
    const confidence =
      trainerTable.trainerCount >= 400
        ? 0.95
        : trainerTable.trainerCount >= 100
          ? 0.9
          : 0.85;

    return makeDetected({
      confidence,
      data: Object.freeze({
        trainerTable,
        trainerCount: trainerTable.trainerCount,
      }),
      evidence: [
        makeEvidence({
          kind: 'heuristic',
          summary: `Found gTrainers at offset 0x${trainerTable.tableStart.toString(16)} (${String(trainerTable.trainerCount)} trainers, ${String(trainerTable.tableEndExclusive - trainerTable.tableStart)} bytes)`,
          weight: 1.0,
          detail: {
            tableStart: trainerTable.tableStart,
            tableEndExclusive: trainerTable.tableEndExclusive,
            trainerCount: trainerTable.trainerCount,
          },
        }),
      ],
    });
  },
};
