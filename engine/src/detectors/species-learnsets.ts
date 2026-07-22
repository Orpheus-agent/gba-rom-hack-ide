/**
 * Phase-8 detector: species learnsets (P8-T5).
 *
 * Per §15 Phase 8 species catalogue (base stats, typings, evolutions,
 * **learnsets**, TM/HM compat, abilities, hidden abilities, forms,
 * mega/regional/custom forms, ...), this detector adds LEVEL-UP
 * LEARNSETS - the gLevelUpLearnsets ROM-pointer table + per-species
 * terminator-delimited u16 arrays.
 *
 * After P8-T4 (evolutions), this is the second deeper-species detector.
 * Like evolutions, learnsets are LAYERED onto existing species:N
 * nodes via `updateNodeDetail` (no new NodeKind/EdgeKind required;
 * learnsets are intra-species data - `(level, moveId)` pairs).
 * Adding `move` as a NodeKind + `species_learns_move` EdgeKind is a
 * later iteration (would require move-table detection first).
 *
 * Coverage contribution: every byte of the discovered pointer table
 * AND every byte of each pointed-at learnset array is registered as
 * `table` class at confidence 0.9.
 *
 * PD 5: structural-only - scanner finds the pointer table by walking
 * 4-byte stride and verifying each u32 derefs to a valid learnset.
 *
 * PD 8: previously-unaccounted learnset arrays (variable-length,
 * scattered across the ROM) are now classified.
 */

import { makeDetected, makeEvidence, makeNotDetected } from '../detection/index.js';
import type { Detection } from '../detection/index.js';
import type { CoverageMap } from '../coverage/index.js';
import type { RomImage } from '../rom/loader.js';
import type { RomDetector } from './types.js';
import {
  LEARNSET_TABLE_SCAN_MIN_POINTERS,
  scanLearnsetPointerTable,
  type LearnsetPointerTable,
} from '../species/index.js';

export const SPECIES_LEARNSETS_DETECTOR_ID = 'species_learnsets';

export interface SpeciesLearnsetsReport {
  /** Discovered gLevelUpLearnsets pointer table + each species'
   *  parsed learnset array. */
  readonly learnsetPointerTable: LearnsetPointerTable;
  /** Mirror: number of (pointer, learnset) pairs in the table. */
  readonly pointerCount: number;
  /** Mirror: count of species with ≥1 non-terminator learn entry. */
  readonly populatedSpeciesCount: number;
  /** Total parsed (level, move) entries across all species - the
   *  "size" of the learnset corpus this detector surfaces. */
  readonly totalLearnEntryCount: number;
  /** Distinct move ids referenced by any learnset entry. */
  readonly referencedMoveIds: ReadonlyArray<number>;
}

export const speciesLearnsetsDetector: RomDetector<SpeciesLearnsetsReport> = {
  id: SPECIES_LEARNSETS_DETECTOR_ID,
  name: 'Species Learnsets (Gen-3 gLevelUpLearnsets scanner)',
  phase: 8,
  detect(rom: RomImage, coverage: CoverageMap): Detection<SpeciesLearnsetsReport> {
    if (rom.byteLength < LEARNSET_TABLE_SCAN_MIN_POINTERS * 4) {
      return makeNotDetected({
        confidence: 1.0,
        evidence: [
          makeEvidence({
            kind: 'heuristic',
            summary: `ROM is ${String(rom.byteLength)} bytes - too small to host a ≥${String(LEARNSET_TABLE_SCAN_MIN_POINTERS)}-pointer gLevelUpLearnsets table`,
            weight: 1.0,
          }),
        ],
        reason: 'ROM too small to scan for Gen-3 gLevelUpLearnsets pointer table',
      });
    }

    const learnsetPointerTable = scanLearnsetPointerTable(rom.bytes);
    if (learnsetPointerTable === null) {
      return makeNotDetected({
        confidence: 0.85,
        evidence: [
          makeEvidence({
            kind: 'heuristic',
            summary: `scanned ${String(rom.byteLength)} bytes for a run of ≥${String(LEARNSET_TABLE_SCAN_MIN_POINTERS)} u32 ROM-pointers each dereferencing to a valid learnset (terminator-delimited u16 array, level≤100, move 1..511) - none found`,
            weight: 1.0,
            detail: {
              romByteLength: rom.byteLength,
              minPointers: LEARNSET_TABLE_SCAN_MIN_POINTERS,
            },
          }),
        ],
        reason:
          'No Gen-3 gLevelUpLearnsets pointer table found - either the ROM has no learnset data, the learnset engine has been rewritten with a non-pointer-table layout, or the table is too small to clear the min-pointers threshold',
      });
    }

    // Register coverage for the pointer table itself.
    try {
      coverage.addClassified({
        start: learnsetPointerTable.tableStart,
        end: learnsetPointerTable.tableEndExclusive,
        probableClass: 'table',
        score: 0.9,
        provenance: `${SPECIES_LEARNSETS_DETECTOR_ID}#gLevelUpLearnsets`,
        note: `Gen-3 gLevelUpLearnsets pointer table (${String(learnsetPointerTable.pointerCount)} pointers)`,
      });
    } catch {
      // Overlap with another detector - skip.
    }

    // Register coverage for each per-species learnset array. Each is
    // (entries.length + 1) × 2 bytes (entries + 0xFFFF terminator).
    let totalLearnEntryCount = 0;
    const referencedMoveSet = new Set<number>();
    for (const entry of learnsetPointerTable.entries) {
      const ls = entry.learnset;
      totalLearnEntryCount += ls.entries.length;
      for (const e of ls.entries) referencedMoveSet.add(e.move);
      try {
        coverage.addClassified({
          start: ls.fileOffset,
          end: ls.fileOffset + ls.byteLength,
          probableClass: 'table',
          score: 0.9,
          provenance: `${SPECIES_LEARNSETS_DETECTOR_ID}#learnset_array`,
          note: `Gen-3 learnset array (${String(ls.entries.length)} entries + terminator)`,
        });
      } catch {
        // Overlap - skip.
      }
    }

    const referencedMoveIds = Object.freeze(
      Array.from(referencedMoveSet).sort((a, b) => a - b),
    );

    // Confidence: vanilla FireRed has 411 species, most populated;
    // ≥100 populated entries is essentially certainly real.
    const confidence =
      learnsetPointerTable.populatedEntryCount >= 100
        ? 0.95
        : learnsetPointerTable.populatedEntryCount >= 20
          ? 0.9
          : 0.85;

    return makeDetected({
      confidence,
      data: Object.freeze({
        learnsetPointerTable,
        pointerCount: learnsetPointerTable.pointerCount,
        populatedSpeciesCount: learnsetPointerTable.populatedEntryCount,
        totalLearnEntryCount,
        referencedMoveIds,
      }),
      evidence: [
        makeEvidence({
          kind: 'heuristic',
          summary: `Found gLevelUpLearnsets at offset 0x${learnsetPointerTable.tableStart.toString(16)} (${String(learnsetPointerTable.pointerCount)} species pointers, ${String(learnsetPointerTable.populatedEntryCount)} populated, ${String(totalLearnEntryCount)} total learn entries referencing ${String(referencedMoveIds.length)} distinct moves)`,
          weight: 1.0,
          detail: {
            tableStart: learnsetPointerTable.tableStart,
            tableEndExclusive: learnsetPointerTable.tableEndExclusive,
            pointerCount: learnsetPointerTable.pointerCount,
            populatedSpeciesCount: learnsetPointerTable.populatedEntryCount,
            totalLearnEntryCount,
            distinctMoveCount: referencedMoveIds.length,
          },
        }),
      ],
    });
  },
};
