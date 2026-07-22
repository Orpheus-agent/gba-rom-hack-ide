/**
 * Gen-3 Moves System detector - Phase UW-2 / Category 2 + Category 4
 * substrate (iter 68 / UW-2-T2).
 *
 * Detects the `gBattleMoves` table - a packed array of 12-byte
 * BattleMove structs holding power/type/accuracy/PP/effect/etc. for
 * each move. Uses universal structural-signature detection (no baked
 * offsets) so it works on vanilla AND hacks that have relocated /
 * expanded the table.
 *
 * Per PD 5: no FireRed/Emerald-only assumption; signature scan checks
 * struct shape per record (type ≤17, accuracy ≤100, padding=0, etc.).
 * False-positive rate per random 12-byte slice <1e-8.
 *
 * Per PD 1: typed `not_detected` with reason when ROM too small OR no
 * 80+-entry run of valid moves found.
 *
 * Advances:
 *   - Category 2 (Game engine + runtime systems) - battle engine
 *     substrate; first concrete combat-system data table.
 *   - Category 4 (Moves / items / abilities / battle mechanics) - 
 *     foundational move table; later phases add effect semantics,
 *     trainer AI, damage formula, etc.
 */

import { makeDetected, makeEvidence, makeNotDetected } from '../detection/index.js';
import type { Detection } from '../detection/index.js';
import type { CoverageMap } from '../coverage/index.js';
import type { RomImage } from '../rom/loader.js';
import type { RomDetector } from './types.js';
import {
  BATTLE_MOVES_SCAN_MIN_RECORDS,
  BATTLE_MOVE_STRUCT_SIZE_BYTES,
  scanBattleMovesTable,
  type BattleMovesTable,
} from '../moves/index.js';

export const MOVES_SYSTEM_DETECTOR_ID = 'moves_system';

export interface MovesSystemReport {
  /** Discovered gBattleMoves table. */
  readonly battleMovesTable: BattleMovesTable;
  /** Convenience mirror of battleMovesTable.moveCount. */
  readonly moveCount: number;
}

export const movesSystemDetector: RomDetector<MovesSystemReport> = {
  id: MOVES_SYSTEM_DETECTOR_ID,
  name: 'Moves System (Gen-3 gBattleMoves scanner)',
  phase: 8,
  detect(rom: RomImage, coverage: CoverageMap): Detection<MovesSystemReport> {
    if (
      rom.byteLength <
      BATTLE_MOVES_SCAN_MIN_RECORDS * BATTLE_MOVE_STRUCT_SIZE_BYTES
    ) {
      return makeNotDetected({
        confidence: 1.0,
        evidence: [
          makeEvidence({
            kind: 'heuristic',
            summary: `ROM is ${String(rom.byteLength)} bytes - too small to host a ≥${String(BATTLE_MOVES_SCAN_MIN_RECORDS)}-record gBattleMoves table`,
            weight: 1.0,
          }),
        ],
        reason: 'ROM too small to scan for Gen-3 gBattleMoves table',
      });
    }

    const table = scanBattleMovesTable(rom.bytes);
    if (table === null) {
      return makeNotDetected({
        confidence: 0.85,
        evidence: [
          makeEvidence({
            kind: 'heuristic',
            summary: `scanned ${String(rom.byteLength)} bytes for a run of ≥${String(BATTLE_MOVES_SCAN_MIN_RECORDS)} 12-byte BattleMove records (signature: type ≤17, accuracy ≤100, padding bytes 0x0A/0x0B both 0, PP ∈ [1,40], priority ∈ [-7,+5]) - none found`,
            weight: 1.0,
            detail: {
              romByteLength: rom.byteLength,
              structSize: BATTLE_MOVE_STRUCT_SIZE_BYTES,
              minRecords: BATTLE_MOVES_SCAN_MIN_RECORDS,
            },
          }),
        ],
        reason:
          'No Gen-3 gBattleMoves table found - either the ROM is non-Gen-3, the battle engine has been rewritten with a non-flat layout, or the ROM contains too few move records to clear the min-records threshold',
      });
    }

    // Register coverage. The leading MOVE_NONE sentinel + N populated
    // moves = (table.moveCount * 12) bytes total.
    try {
      coverage.addClassified({
        start: table.tableStart,
        end: table.tableEndExclusive,
        probableClass: 'table',
        score: 0.9,
        provenance: `${MOVES_SYSTEM_DETECTOR_ID}#gBattleMoves`,
        note: `Gen-3 gBattleMoves (${String(table.moveCount)} moves × 12 bytes)`,
      });
    } catch {
      // Overlap with another detector - skip.
    }

    // Confidence: vanilla FireRed/Emerald has 355 moves (354 + Struggle).
    // Heavy hacks (Radical Red) expand to 800+. Anything above 200 is
    // essentially certainly real.
    const confidence =
      table.moveCount >= 300
        ? 0.95
        : table.moveCount >= 150
          ? 0.9
          : 0.85;

    return makeDetected({
      confidence,
      data: Object.freeze({
        battleMovesTable: table,
        moveCount: table.moveCount,
      }),
      evidence: [
        makeEvidence({
          kind: 'heuristic',
          summary: `Found gBattleMoves at offset 0x${table.tableStart.toString(16)} (${String(table.moveCount)} moves, ${String(table.tableEndExclusive - table.tableStart)} bytes)`,
          weight: 1.0,
          detail: {
            tableStart: table.tableStart,
            tableEndExclusive: table.tableEndExclusive,
            moveCount: table.moveCount,
          },
        }),
      ],
    });
  },
};
