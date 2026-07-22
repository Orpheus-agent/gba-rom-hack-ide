/**
 * Type name table detector - Phase UW-3 / Category 4 substrate (iter 83
 * / UW-3-T2).
 *
 * Detects the Gen-3 `gTypeNames` table - a packed array of 7-byte slots
 * holding decoded type names ("NORMAL", "FIGHT", "FLYING", "FIRE", etc.).
 *
 * Complements iter 69's `typeChartSystemDetector` (which finds the
 * matchup triplet table by type-ID number) - this detector finds the
 * parallel string table that decodes those IDs to human names.
 *
 * Per PD 5: signature-driven via NORMAL+FIGHT pair at 7-byte stride;
 * universal across every Gen-3 Pokémon ROM.
 *
 * Per PD 1: typed `not_detected` for ROM-too-small / no-signature /
 * validator-reject paths.
 */

import { makeDetected, makeEvidence, makeNotDetected } from '../detection/index.js';
import type { Detection } from '../detection/index.js';
import type { CoverageMap } from '../coverage/index.js';
import type { RomImage } from '../rom/loader.js';
import type { RomDetector } from './types.js';
import {
  TYPE_NAME_SLOT_BYTES,
  TYPE_NAMES_MIN_VALID_SLOTS,
  findTypeNamesTable,
  readTypeNamesAt,
  validateTypeNames,
} from '../battle/index.js';

export const TYPE_NAMES_DETECTOR_ID = 'type_names';

/** Defensive cap on declared type count when probing forward from the
 *  detected table start. Vanilla = 18 types; hacks may add (Fairy
 *  backport adds 1; mega-style hacks add more). */
const TYPE_NAMES_PROBE_COUNT = 64;

export interface TypeNamesReport {
  readonly tableOffset: number;
  readonly validTypeCount: number;
  /** Decoded names (first N). */
  readonly sampleNames: ReadonlyArray<string>;
}

export const typeNamesDetector: RomDetector<TypeNamesReport> = {
  id: TYPE_NAMES_DETECTOR_ID,
  name: 'Type Names (Gen-3 gTypeNames signature scan)',
  phase: 8,
  detect(rom: RomImage, coverage: CoverageMap): Detection<TypeNamesReport> {
    if (rom.byteLength < TYPE_NAMES_MIN_VALID_SLOTS * TYPE_NAME_SLOT_BYTES) {
      return makeNotDetected({
        confidence: 1.0,
        evidence: [
          makeEvidence({
            kind: 'heuristic',
            summary: `ROM is ${String(rom.byteLength)} bytes - too small to host ≥${String(TYPE_NAMES_MIN_VALID_SLOTS)} 7-byte type name slots`,
            weight: 1.0,
          }),
        ],
        reason: 'ROM too small to scan for Gen-3 gTypeNames table',
      });
    }

    const tableOffset = findTypeNamesTable(rom.bytes);
    if (tableOffset === null) {
      return makeNotDetected({
        confidence: 0.9,
        evidence: [
          makeEvidence({
            kind: 'heuristic',
            summary: `scanned ${String(rom.byteLength)} bytes for the gTypeNames signature (NORMAL at slot 0, FIGHT at slot+7, terminator at slot[6]) - no match`,
            weight: 1.0,
            detail: { romByteLength: rom.byteLength },
          }),
        ],
        reason:
          'No Gen-3 gTypeNames table found - ROM may be non-Pokémon, may have replaced the NORMAL/FIGHT ordering, or may have removed those types (very rare in Gen-3 hacks)',
      });
    }

    const probed = readTypeNamesAt(rom.bytes, tableOffset, TYPE_NAMES_PROBE_COUNT);
    if (!validateTypeNames(probed)) {
      return makeNotDetected({
        confidence: 0.75,
        evidence: [
          makeEvidence({
            kind: 'heuristic',
            summary: `gTypeNames signature matched at offset 0x${tableOffset.toString(16)} but validation rejected the table`,
            weight: 1.0,
            detail: { tableOffset, probedCount: probed.length },
          }),
        ],
        reason:
          'gTypeNames signature matched but the decoded table fails the type-name shape validator - likely a coincidental signature match',
      });
    }

    // Walk forward counting consecutive valid type names. Stop after 3
    // consecutive bad entries (smaller window than name tables since
    // type-name table is small).
    let validTypeCount = 0;
    let consecutiveBad = 0;
    for (let i = 0; i < probed.length; i++) {
      const name = probed[i]!;
      const looksReal =
        name.length >= 2 &&
        name.length <= 6 &&
        /[A-Z]{2,}/.test(name) &&
        !name.includes('??');
      if (looksReal) {
        validTypeCount = i + 1;
        consecutiveBad = 0;
      } else {
        consecutiveBad++;
        if (consecutiveBad >= 3) break;
      }
    }

    const tableByteLength = validTypeCount * TYPE_NAME_SLOT_BYTES;
    try {
      coverage.addClassified({
        start: tableOffset,
        end: tableOffset + tableByteLength,
        probableClass: 'table',
        score: 0.92,
        provenance: `${TYPE_NAMES_DETECTOR_ID}#gTypeNames`,
        note: `Gen-3 gTypeNames (${String(validTypeCount)} slots × ${String(TYPE_NAME_SLOT_BYTES)} bytes)`,
      });
    } catch {
      // Overlap - skip.
    }

    // Confidence: vanilla = 18. ≥15 = essentially certainly real.
    const confidence =
      validTypeCount >= 18 ? 0.95 : validTypeCount >= 12 ? 0.92 : 0.85;

    return makeDetected({
      confidence,
      data: Object.freeze({
        tableOffset,
        validTypeCount,
        sampleNames: Object.freeze(probed.slice(0, validTypeCount)),
      }),
      evidence: [
        makeEvidence({
          kind: 'heuristic',
          summary: `Found gTypeNames at offset 0x${tableOffset.toString(16)} (${String(validTypeCount)} valid slots, ${String(tableByteLength)} bytes)`,
          weight: 1.0,
          detail: {
            tableOffset,
            validTypeCount,
            sampleTypeNames: probed.slice(0, 5),
          },
        }),
      ],
    });
  },
};
