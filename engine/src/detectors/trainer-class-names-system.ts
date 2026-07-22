/**
 * Gen-3 gTrainerClassNames detector - Phase UW-3 / Category 6 substrate
 * (iter 84 / UW-3-T3).
 *
 * Detects the trainer-class name table referenced by each Trainer
 * struct's `trainerClass` byte field. Uses structural-only validation
 * since trainer-class name orderings DIVERGE between FRLG (107 classes)
 * and Emerald/RSE (58 classes) - there is no universal canonical-pair
 * signature available.
 *
 * Per PD 5: structural anchor (10 consecutive valid 13-byte slots) +
 * forward walk; works on any Gen-3 cart with the canonical
 * 13-byte-slot trainer-class layout.
 *
 * Per PD 1: typed `not_detected` for ROM-too-small / no-anchor paths.
 *
 * Per PD 13: editor auto-surfaces via existing WorkspaceFeatureDetection
 * conduit.
 */

import { makeDetected, makeEvidence, makeNotDetected } from '../detection/index.js';
import type { Detection } from '../detection/index.js';
import type { CoverageMap } from '../coverage/index.js';
import type { RomImage } from '../rom/loader.js';
import type { RomDetector } from './types.js';
import {
  TRAINER_CLASS_NAME_SLOT_BYTES,
  TRAINER_CLASS_NAMES_MIN_VALID_SLOTS,
  findTrainerClassNamesTable,
  readTrainerClassNamesAt,
  validateTrainerClassNames,
} from '../trainers/trainer-class-names.js';

export const TRAINER_CLASS_NAMES_DETECTOR_ID = 'trainer_class_names';

const TRAINER_CLASS_NAMES_PROBE_COUNT = 256;

export interface TrainerClassNamesReport {
  readonly tableOffset: number;
  readonly validClassCount: number;
  readonly sampleNames: ReadonlyArray<string>;
}

export const trainerClassNamesDetector: RomDetector<TrainerClassNamesReport> = {
  id: TRAINER_CLASS_NAMES_DETECTOR_ID,
  name: 'Trainer Class Names (Gen-3 gTrainerClassNames structural scan)',
  phase: 8,
  detect(rom: RomImage, coverage: CoverageMap): Detection<TrainerClassNamesReport> {
    const minBytes =
      0xc0 + TRAINER_CLASS_NAMES_MIN_VALID_SLOTS * TRAINER_CLASS_NAME_SLOT_BYTES;
    if (rom.byteLength < minBytes) {
      return makeNotDetected({
        confidence: 1.0,
        evidence: [
          makeEvidence({
            kind: 'heuristic',
            summary: `ROM is ${String(rom.byteLength)} bytes - too small to host ≥${String(TRAINER_CLASS_NAMES_MIN_VALID_SLOTS)} 13-byte trainer-class name slots`,
            weight: 1.0,
          }),
        ],
        reason: 'ROM too small to scan for Gen-3 gTrainerClassNames table',
      });
    }

    const tableOffset = findTrainerClassNamesTable(rom.bytes);
    if (tableOffset === null) {
      return makeNotDetected({
        confidence: 0.85,
        evidence: [
          makeEvidence({
            kind: 'heuristic',
            summary: `scanned ${String(rom.byteLength)} bytes for a run of ≥${String(TRAINER_CLASS_NAMES_MIN_VALID_SLOTS)} 13-byte slots each containing valid Gen-3 ALL-CAPS trainer-class names (10-slot anchor confirmation) - none found`,
            weight: 1.0,
            detail: { romByteLength: rom.byteLength },
          }),
        ],
        reason:
          'No Gen-3 gTrainerClassNames table found - either non-Pokémon ROM or trainer-class system rewritten',
      });
    }

    const probed = readTrainerClassNamesAt(
      rom.bytes,
      tableOffset,
      TRAINER_CLASS_NAMES_PROBE_COUNT,
    );
    if (!validateTrainerClassNames(probed)) {
      return makeNotDetected({
        confidence: 0.75,
        evidence: [
          makeEvidence({
            kind: 'heuristic',
            summary: `gTrainerClassNames anchor matched at offset 0x${tableOffset.toString(16)} but full-table validation rejected the read`,
            weight: 1.0,
            detail: { tableOffset, probedCount: probed.length },
          }),
        ],
        reason: 'Anchor matched but validator rejected - likely coincidental text run',
      });
    }

    let validClassCount = 0;
    let consecutiveBad = 0;
    for (let i = 0; i < probed.length; i++) {
      const name = probed[i]!;
      const looksReal =
        name.length >= 2 &&
        name.length <= 12 &&
        (/[A-Z]{3,}/.test(name) || /[A-Z]+ [A-Z]+/.test(name)) &&
        !name.includes('??');
      if (looksReal) {
        validClassCount = i + 1;
        consecutiveBad = 0;
      } else {
        consecutiveBad++;
        if (consecutiveBad >= 5) break;
      }
    }

    const tableByteLength = validClassCount * TRAINER_CLASS_NAME_SLOT_BYTES;
    try {
      coverage.addClassified({
        start: tableOffset,
        end: tableOffset + tableByteLength,
        probableClass: 'table',
        score: 0.92,
        provenance: `${TRAINER_CLASS_NAMES_DETECTOR_ID}#gTrainerClassNames`,
        note: `Gen-3 gTrainerClassNames (${String(validClassCount)} slots × ${String(TRAINER_CLASS_NAME_SLOT_BYTES)} bytes)`,
      });
    } catch {
      // Overlap - skip.
    }

    // Confidence: Emerald ~58 / FRLG ~107 / heavy hacks ≥150.
    const confidence =
      validClassCount >= 80 ? 0.95 : validClassCount >= 40 ? 0.92 : 0.88;

    return makeDetected({
      confidence,
      data: Object.freeze({
        tableOffset,
        validClassCount,
        sampleNames: Object.freeze(probed.slice(0, 16)),
      }),
      evidence: [
        makeEvidence({
          kind: 'heuristic',
          summary: `Found gTrainerClassNames at offset 0x${tableOffset.toString(16)} (${String(validClassCount)} valid slots, ${String(tableByteLength)} bytes)`,
          weight: 1.0,
          detail: {
            tableOffset,
            validClassCount,
            sampleTrainerClassNames: probed.slice(0, 5),
          },
        }),
      ],
    });
  },
};
