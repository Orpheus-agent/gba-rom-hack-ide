/**
 * Phase-8 detector: species system detection (P8-T1).
 *
 * Per §15 Phase 8, the species system covers base stats, typings,
 * evolutions, learnsets, TM/HM compat, abilities, etc. P8-T1 starts
 * with the foundational BaseStats table - once we know where it is
 * and how many species are present, subsequent P8 tasks layer
 * evolutions, learnsets, etc. on top by following the same indexing.
 *
 * Coverage contribution: every byte of the discovered gBaseStats table
 * is registered as `table` class at confidence 0.9.
 *
 * PD 5: structural-only - `scanBaseStatsTable` finds the table by
 * validating the 28-byte struct shape per record; no baked offsets.
 *
 * PD 1 / §15 P8 acceptance: this detector is the FIRST step in
 * defeating the "species was the only populated system" failure mode
 * - though paradoxically the FIRST system we surface here IS species.
 * That's correct: the "beyond species" §15 P8 mandate means species
 * + trainer + encounter ALL need full detection. P8-T1 establishes
 * species (the foundational table); subsequent P8 tasks add trainer
 * (gTrainers) + encounter (gWildMonHeaders is P5-T6 anchor; semantic
 * trainer-list is per-trainer).
 */

import { makeDetected, makeEvidence, makeNotDetected } from '../detection/index.js';
import type { Detection } from '../detection/index.js';
import type { CoverageMap } from '../coverage/index.js';
import type { RomImage } from '../rom/loader.js';
import type { RomDetector } from './types.js';
import {
  BASE_STATS_SCAN_MIN_RECORDS,
  BASE_STATS_STRUCT_SIZE_BYTES,
  scanBaseStatsTable,
  type BaseStatsTable,
} from '../species/index.js';

export const SPECIES_SYSTEM_DETECTOR_ID = 'species_system';

export interface SpeciesSystemReport {
  /** Discovered gBaseStats table. */
  readonly baseStatsTable: BaseStatsTable;
  /** Convenience mirror of baseStatsTable.speciesCount. */
  readonly speciesCount: number;
}

export const speciesSystemDetector: RomDetector<SpeciesSystemReport> = {
  id: SPECIES_SYSTEM_DETECTOR_ID,
  name: 'Species System (Gen-3 gBaseStats scanner)',
  phase: 8,
  detect(rom: RomImage, coverage: CoverageMap): Detection<SpeciesSystemReport> {
    if (
      rom.byteLength <
      BASE_STATS_SCAN_MIN_RECORDS * BASE_STATS_STRUCT_SIZE_BYTES
    ) {
      return makeNotDetected({
        confidence: 1.0,
        evidence: [
          makeEvidence({
            kind: 'heuristic',
            summary: `ROM is ${String(rom.byteLength)} bytes - too small to host a ≥${String(BASE_STATS_SCAN_MIN_RECORDS)}-record gBaseStats table`,
            weight: 1.0,
          }),
        ],
        reason: 'ROM too small to scan for Gen-3 gBaseStats table',
      });
    }

    const baseStatsTable = scanBaseStatsTable(rom.bytes);
    if (baseStatsTable === null) {
      return makeNotDetected({
        confidence: 0.85,
        evidence: [
          makeEvidence({
            kind: 'heuristic',
            summary: `scanned ${String(rom.byteLength)} bytes for a run of ≥${String(BASE_STATS_SCAN_MIN_RECORDS)} 28-byte BaseStats records (structural signature: type1/type2 ≤17, growthRate ≤5, padding bytes 0x1A/0x1B == 0, ≥1 non-zero stat) - none found`,
            weight: 1.0,
            detail: {
              romByteLength: rom.byteLength,
              structSize: BASE_STATS_STRUCT_SIZE_BYTES,
              minRecords: BASE_STATS_SCAN_MIN_RECORDS,
            },
          }),
        ],
        reason:
          'No Gen-3 gBaseStats table found - either the ROM is non-Gen-3, the species engine has been rewritten with a non-flat layout, or the ROM contains too few species records to clear the min-records threshold',
      });
    }

    try {
      coverage.addClassified({
        start: baseStatsTable.tableStart,
        end: baseStatsTable.tableEndExclusive,
        probableClass: 'table',
        score: 0.9,
        provenance: `${SPECIES_SYSTEM_DETECTOR_ID}#gBaseStats`,
        note: `Gen-3 gBaseStats (${String(baseStatsTable.speciesCount)} species)`,
      });
    } catch {
      // Overlap with another detector - skip.
    }

    // Confidence: vanilla FireRed/Emerald have 411 species; heavy hacks
    // expand to 700+. Anything above 250 is essentially certainly real.
    const confidence =
      baseStatsTable.speciesCount >= 400
        ? 0.95
        : baseStatsTable.speciesCount >= 100
          ? 0.9
          : 0.85;

    return makeDetected({
      confidence,
      data: Object.freeze({
        baseStatsTable,
        speciesCount: baseStatsTable.speciesCount,
      }),
      evidence: [
        makeEvidence({
          kind: 'heuristic',
          summary: `Found gBaseStats at offset 0x${baseStatsTable.tableStart.toString(16)} (${String(baseStatsTable.speciesCount)} species, ${String(baseStatsTable.tableEndExclusive - baseStatsTable.tableStart)} bytes)`,
          weight: 1.0,
          detail: {
            tableStart: baseStatsTable.tableStart,
            tableEndExclusive: baseStatsTable.tableEndExclusive,
            speciesCount: baseStatsTable.speciesCount,
          },
        }),
      ],
    });
  },
};
