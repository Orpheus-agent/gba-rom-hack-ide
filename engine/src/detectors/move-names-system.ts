/**
 * Move name table detector - Phase UW-2 / Category 4 substrate (iter
 * 73 / UW-2-T7).
 *
 * Detects the Gen-3 `gMoveNames` table - a packed array of 13-byte
 * slots holding decoded move names ("POUND", "KARATE CHOP", "DOUBLE
 * SLAP", etc.). Uses signature scan via `findMoveNamesTable` so it
 * works on ROMs that relocated the table from vanilla offsets (heavy
 * hacks like Unbound, CFRU forks, Radical Red).
 *
 * Per PD 5: no FireRed/Emerald baked offsets; signature scan searches
 * for canonical POUND (move ID 1) + KARATE CHOP (move ID 2) byte
 * sequences at 13-byte stride.
 *
 * Per PD 1: typed `not_detected` with reason when no plausible table
 * is found.
 *
 * Per PD 13: this detector is the canonical engine-side path; future
 * editor-side move inspector consumes this detector's output.
 *
 * Pairs with iter 68's moves-system detector - that one finds the
 * gBattleMoves struct table (binary data: power/type/accuracy/pp);
 * this one finds the gMoveNames string table (decoded names).
 * Together they give a complete view of the moves subsystem,
 * unlocking visual move editors with name labels (UW-2-T(later) /
 * PD 14).
 *
 * Advances:
 *   - Category 4 (Moves/items/abilities/battle mechanics) - pairs
 *     with the iter 68 moves-data detector. Cat 4 now has the trio:
 *     gBattleMoves data + gMoveNames text + (via iter 71) shared
 *     ability-name pattern.
 *   - Minor Category 7 (Dialogue/text) advance - move names ARE text
 *     data; this detector adds 354+ decoded strings to the engine's
 *     text surface.
 */

import { makeDetected, makeEvidence, makeNotDetected } from '../detection/index.js';
import type { Detection } from '../detection/index.js';
import type { CoverageMap } from '../coverage/index.js';
import type { RomImage } from '../rom/loader.js';
import type { RomDetector } from './types.js';
import {
  MOVE_NAME_SLOT_BYTES,
  MOVE_NAMES_MIN_VALID_SLOTS,
  findMoveNamesTable,
  readMoveNamesAt,
  validateMoveNames,
} from '../moves/index.js';

export const MOVE_NAMES_DETECTOR_ID = 'move_names';

/** Defensive cap on declared move count when probing forward from the
 *  detected table start. Vanilla has 355; Radical Red has ~800. */
const MOVE_NAMES_PROBE_COUNT = 1024;

export interface MoveNamesReport {
  /** File offset of the gMoveNames table (placeholder slot 0). */
  readonly tableOffset: number;
  /** Best-effort count of slots that decode as plausible move names
   *  (placeholder + real entries). */
  readonly validMoveCount: number;
  /** First 16 decoded names for at-a-glance audit (placeholder at
   *  index 0; POUND at index 1; KARATE CHOP at index 2). */
  readonly sampleNames: ReadonlyArray<string>;
}

export const moveNamesDetector: RomDetector<MoveNamesReport> = {
  id: MOVE_NAMES_DETECTOR_ID,
  name: 'Move Names (Gen-3 gMoveNames signature scan)',
  phase: 8,
  detect(rom: RomImage, coverage: CoverageMap): Detection<MoveNamesReport> {
    if (rom.byteLength < MOVE_NAMES_MIN_VALID_SLOTS * MOVE_NAME_SLOT_BYTES) {
      return makeNotDetected({
        confidence: 1.0,
        evidence: [
          makeEvidence({
            kind: 'heuristic',
            summary: `ROM is ${String(rom.byteLength)} bytes - too small to host ≥${String(MOVE_NAMES_MIN_VALID_SLOTS)} 13-byte move name slots`,
            weight: 1.0,
          }),
        ],
        reason: 'ROM too small to scan for Gen-3 gMoveNames table',
      });
    }

    const tableOffset = findMoveNamesTable(rom.bytes);
    if (tableOffset === null) {
      return makeNotDetected({
        confidence: 0.9,
        evidence: [
          makeEvidence({
            kind: 'heuristic',
            summary: `scanned ${String(rom.byteLength)} bytes for the gMoveNames signature (POUND at slot+13, KARATE CHOP at slot+26, dash-placeholder shape at slot 0) - no match`,
            weight: 1.0,
            detail: { romByteLength: rom.byteLength },
          }),
        ],
        reason:
          'No Gen-3 gMoveNames table found - ROM may be non-Pokémon, may have replaced the POUND/KARATE CHOP ordering, or may have removed those moves (rare in Gen-3 hacks)',
      });
    }

    const probed = readMoveNamesAt(rom.bytes, tableOffset, MOVE_NAMES_PROBE_COUNT);
    if (!validateMoveNames(probed)) {
      return makeNotDetected({
        confidence: 0.75,
        evidence: [
          makeEvidence({
            kind: 'heuristic',
            summary: `gMoveNames signature matched at offset 0x${tableOffset.toString(16)} but validation rejected the table (most entries don't decode as move-name-shaped strings)`,
            weight: 1.0,
            detail: { tableOffset, probedCount: probed.length },
          }),
        ],
        reason:
          'gMoveNames signature matched but the decoded table fails the move-name shape validator - likely a coincidental signature match rather than a real table',
      });
    }

    // Walk forward counting consecutive valid moves. Stop after 5
    // consecutive bad entries.
    let validMoveCount = 0;
    let consecutiveBad = 0;
    for (let i = 0; i < probed.length; i++) {
      const name = probed[i]!;
      const isPlaceholder = i === 0 && /^-+$/.test(name);
      const looksReal =
        isPlaceholder ||
        (name.length >= 2 &&
          name.length <= 12 &&
          (/[A-Z]{3,}/.test(name) || /[A-Z]+ [A-Z]+/.test(name)) &&
          !name.includes('??'));
      if (looksReal) {
        validMoveCount = i + 1;
        consecutiveBad = 0;
      } else {
        consecutiveBad++;
        if (consecutiveBad >= 5) break;
      }
    }

    const tableByteLength = validMoveCount * MOVE_NAME_SLOT_BYTES;
    try {
      coverage.addClassified({
        start: tableOffset,
        end: tableOffset + tableByteLength,
        probableClass: 'table',
        score: 0.9,
        provenance: `${MOVE_NAMES_DETECTOR_ID}#gMoveNames`,
        note: `Gen-3 gMoveNames (${String(validMoveCount)} slots × ${String(MOVE_NAME_SLOT_BYTES)} bytes)`,
      });
    } catch {
      // Overlap with another detector - skip coverage registration but
      // still return the detection.
    }

    // Confidence scales with validMoveCount. Vanilla = 355. Heavy
    // hacks may exceed 800.
    const confidence =
      validMoveCount >= 300 ? 0.95 : validMoveCount >= 200 ? 0.9 : 0.8;

    return makeDetected({
      confidence,
      data: Object.freeze({
        tableOffset,
        validMoveCount,
        // RT-1.4: return ALL validated names, not just the first 16.
        // The lifter iterates `sampleNames` to populate
        // manifest.moveNames[], so capping at 16 meant the editor +
        // agent saw only the first 16 moves of every ROM. Vanilla has
        // 355, Radical Red has 800+.
        sampleNames: Object.freeze(probed.slice(0, validMoveCount)),
      }),
      evidence: [
        makeEvidence({
          kind: 'heuristic',
          summary: `Found gMoveNames at offset 0x${tableOffset.toString(16)} (${String(validMoveCount)} valid slots, ${String(tableByteLength)} bytes)`,
          weight: 1.0,
          detail: {
            tableOffset,
            validMoveCount,
            tableByteLength,
            sampleMoveNames: probed.slice(1, 6),
          },
        }),
      ],
    });
  },
};
