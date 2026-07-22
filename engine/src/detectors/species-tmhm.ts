/**
 * Phase-8 detector: species TM/HM compatibility (P8-T6).
 *
 * Per §15 Phase 8 species catalogue (base stats, typings, evolutions,
 * learnsets, **TM/HM compat**, abilities, ...), this detector adds
 * TM/HM COMPATIBILITY BITFIELDS - the gTMHMLearnsets flat u64-per-
 * species table.
 *
 * After P8-T5 (level-up learnsets), this is the third deeper-species
 * detector. Like baseStats/evolutions/learnsets, TM/HM data is
 * LAYERED onto existing species:N nodes via `updateNodeDetail`. No
 * new NodeKind/EdgeKind required.
 *
 * Coverage contribution: every byte of the discovered table is
 * registered as `table` class at confidence 0.9.
 *
 * PD 5: structural-only - `scanTMHMTable` finds the table by
 * validating each 8-byte slot's top-6-zero invariant. PD 8: byte
 * accounting closes for the table region.
 */

import { makeDetected, makeEvidence, makeNotDetected } from '../detection/index.js';
import type { Detection } from '../detection/index.js';
import type { CoverageMap } from '../coverage/index.js';
import type { RomImage } from '../rom/loader.js';
import type { RomDetector } from './types.js';
import {
  TMHM_SCAN_MIN_SLOTS,
  TMHM_STRUCT_SIZE_BYTES,
  scanTMHMTable,
  type TMHMTable,
} from '../species/index.js';

export const SPECIES_TMHM_DETECTOR_ID = 'species_tmhm';

export interface SpeciesTMHMReport {
  /** Discovered gTMHMLearnsets table. */
  readonly tmhmTable: TMHMTable;
  /** Mirror: total slots in the table. */
  readonly slotCount: number;
  /** Mirror: slots with ≥1 bit set. */
  readonly populatedSlotCount: number;
  /** Total set bits across all slots (rough "TM/HM corpus size"). */
  readonly totalCompatBitCount: number;
  /** Distinct TM/HM bit indices set by at least one species. */
  readonly referencedTmhmIndices: ReadonlyArray<number>;
}

export const speciesTMHMDetector: RomDetector<SpeciesTMHMReport> = {
  id: SPECIES_TMHM_DETECTOR_ID,
  name: 'Species TM/HM Compatibility (Gen-3 gTMHMLearnsets scanner)',
  phase: 8,
  detect(rom: RomImage, coverage: CoverageMap): Detection<SpeciesTMHMReport> {
    if (rom.byteLength < TMHM_SCAN_MIN_SLOTS * TMHM_STRUCT_SIZE_BYTES) {
      return makeNotDetected({
        confidence: 1.0,
        evidence: [
          makeEvidence({
            kind: 'heuristic',
            summary: `ROM is ${String(rom.byteLength)} bytes - too small to host a ≥${String(TMHM_SCAN_MIN_SLOTS)}-slot gTMHMLearnsets table`,
            weight: 1.0,
          }),
        ],
        reason: 'ROM too small to scan for Gen-3 gTMHMLearnsets table',
      });
    }

    // Pass already-classified regions as skipRanges so the scanner
    // doesn't false-positive anchor inside regions claimed by prior
    // detectors. Thumb opcode handler bytes (P6-T1) and wild-Pokémon
    // slot arrays (P8-T3) in particular have byte patterns that can
    // pass the per-slot TM/HM signature by coincidence.
    const existingRegions = coverage.report().regions;
    const skipRanges = existingRegions.map((r) => ({ start: r.start, end: r.end }));
    const tmhmTable = scanTMHMTable(rom.bytes, { skipRanges });
    if (tmhmTable === null) {
      return makeNotDetected({
        confidence: 0.85,
        evidence: [
          makeEvidence({
            kind: 'heuristic',
            summary: `scanned ${String(rom.byteLength)} bytes for a run of ≥${String(TMHM_SCAN_MIN_SLOTS)} 8-byte u64 slots with top 6 bits clear and ≥1 bit set in the bottom 58 - none found`,
            weight: 1.0,
            detail: {
              romByteLength: rom.byteLength,
              minSlots: TMHM_SCAN_MIN_SLOTS,
              slotSize: TMHM_STRUCT_SIZE_BYTES,
            },
          }),
        ],
        reason:
          'No Gen-3 gTMHMLearnsets table found - either the ROM lacks TM/HM data, the engine uses an expanded TM count requiring a different bit layout, or the table is too small to clear the min-slots threshold',
      });
    }

    try {
      coverage.addClassified({
        start: tmhmTable.tableStart,
        end: tmhmTable.tableEndExclusive,
        probableClass: 'table',
        score: 0.9,
        provenance: `${SPECIES_TMHM_DETECTOR_ID}#gTMHMLearnsets`,
        note: `Gen-3 gTMHMLearnsets (${String(tmhmTable.slotCount)} species slots, ${String(tmhmTable.populatedSlotCount)} populated)`,
      });
    } catch {
      // Overlap with another detector - skip.
    }

    let totalCompatBitCount = 0;
    const referencedIndexSet = new Set<number>();
    for (const slot of tmhmTable.slots) {
      totalCompatBitCount += slot.setBitCount;
      for (const idx of slot.setBitIndices) referencedIndexSet.add(idx);
    }
    const referencedTmhmIndices = Object.freeze(
      Array.from(referencedIndexSet).sort((a, b) => a - b),
    );

    // Confidence: vanilla FireRed has 411 slots, most populated;
    // ≥100 populated is essentially certainly real.
    const confidence =
      tmhmTable.populatedSlotCount >= 100
        ? 0.95
        : tmhmTable.populatedSlotCount >= 20
          ? 0.9
          : 0.85;

    return makeDetected({
      confidence,
      data: Object.freeze({
        tmhmTable,
        slotCount: tmhmTable.slotCount,
        populatedSlotCount: tmhmTable.populatedSlotCount,
        totalCompatBitCount,
        referencedTmhmIndices,
      }),
      evidence: [
        makeEvidence({
          kind: 'heuristic',
          summary: `Found gTMHMLearnsets at offset 0x${tmhmTable.tableStart.toString(16)} (${String(tmhmTable.slotCount)} slots, ${String(tmhmTable.populatedSlotCount)} populated, ${String(totalCompatBitCount)} total compat bits across ${String(referencedTmhmIndices.length)} distinct TM/HM indices)`,
          weight: 1.0,
          detail: {
            tableStart: tmhmTable.tableStart,
            tableEndExclusive: tmhmTable.tableEndExclusive,
            slotCount: tmhmTable.slotCount,
            populatedSlotCount: tmhmTable.populatedSlotCount,
            totalCompatBitCount,
            distinctTmhmIndexCount: referencedTmhmIndices.length,
          },
        }),
      ],
    });
  },
};
