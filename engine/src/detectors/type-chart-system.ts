/**
 * Gen-3 Type Effectiveness Chart detector - Phase UW-2 / Category 4
 * substrate (iter 69 / UW-2-T3).
 *
 * Detects the `gTypeEffectiveness` 3-byte-triplet table - every Gen-3
 * combat ROM stores the 18×18 type matchup data here, terminated by
 * `0xFF 0xFF 0x00`. Uses universal structural-signature detection (no
 * baked offsets) so it works on vanilla AND hacks that have relocated,
 * expanded (Sun/Moon Fairy backport), or rewritten the table.
 *
 * Per PD 5: no FireRed/Emerald-only assumption; signature scan checks
 * triplet shape per record (attacker/defender ≤17 OR sentinels;
 * effectiveness ∈ {0,5,10,20}).
 *
 * Per PD 1: typed `not_detected` with reason when ROM too small OR no
 * ≥30-triplet run found.
 *
 * Advances:
 *   - Category 4 (Moves / items / abilities / battle mechanics) - second
 *     concrete combat-system data table (after gBattleMoves iter 68);
 *     enables future damage-formula scaffolding + STAB calc + matchup
 *     UI.
 */

import { makeDetected, makeEvidence, makeNotDetected } from '../detection/index.js';
import type { Detection } from '../detection/index.js';
import type { CoverageMap } from '../coverage/index.js';
import type { RomImage } from '../rom/loader.js';
import type { RomDetector } from './types.js';
import {
  TYPE_CHART_SCAN_MIN_TRIPLETS,
  TYPE_MATCHUP_SIZE_BYTES,
  scanTypeChart,
  type TypeChartTable,
} from '../battle/index.js';

export const TYPE_CHART_SYSTEM_DETECTOR_ID = 'type_chart_system';

export interface TypeChartSystemReport {
  /** Discovered gTypeEffectiveness table. */
  readonly typeChart: TypeChartTable;
  /** Convenience mirror of typeChart.matchupCount. */
  readonly matchupCount: number;
  /** Convenience mirror of typeChart.hasForesightSeparator. */
  readonly hasForesightSeparator: boolean;
}

export const typeChartSystemDetector: RomDetector<TypeChartSystemReport> = {
  id: TYPE_CHART_SYSTEM_DETECTOR_ID,
  name: 'Type Chart System (Gen-3 gTypeEffectiveness scanner)',
  phase: 8,
  detect(rom: RomImage, coverage: CoverageMap): Detection<TypeChartSystemReport> {
    const minBytes = 0xc0 + TYPE_CHART_SCAN_MIN_TRIPLETS * TYPE_MATCHUP_SIZE_BYTES;
    if (rom.byteLength < minBytes) {
      return makeNotDetected({
        confidence: 1.0,
        evidence: [
          makeEvidence({
            kind: 'heuristic',
            summary: `ROM is ${String(rom.byteLength)} bytes - too small to host a ≥${String(TYPE_CHART_SCAN_MIN_TRIPLETS)}-triplet gTypeEffectiveness table after the cartridge header`,
            weight: 1.0,
          }),
        ],
        reason: 'ROM too small to scan for Gen-3 gTypeEffectiveness table',
      });
    }

    const chart = scanTypeChart(rom.bytes);
    if (chart === null) {
      return makeNotDetected({
        confidence: 0.85,
        evidence: [
          makeEvidence({
            kind: 'heuristic',
            summary: `scanned ${String(rom.byteLength)} bytes for a run of ≥${String(TYPE_CHART_SCAN_MIN_TRIPLETS)} 3-byte type matchup triplets anchored on 0xFF 0xFF 0x00 - none found`,
            weight: 1.0,
            detail: {
              romByteLength: rom.byteLength,
              tripletSize: TYPE_MATCHUP_SIZE_BYTES,
              minTriplets: TYPE_CHART_SCAN_MIN_TRIPLETS,
            },
          }),
        ],
        reason:
          'No Gen-3 gTypeEffectiveness table found - either the ROM is non-Gen-3, the battle engine has been rewritten with a different effectiveness representation, or the table is shorter than the min-triplets threshold',
      });
    }

    // Register coverage. (matchups + foresight separator if any + end-table)
    // triplets each at 3 bytes.
    try {
      coverage.addClassified({
        start: chart.tableStart,
        end: chart.tableEndExclusive,
        probableClass: 'table',
        score: 0.9,
        provenance: `${TYPE_CHART_SYSTEM_DETECTOR_ID}#gTypeEffectiveness`,
        note: `Gen-3 gTypeEffectiveness (${String(chart.matchupCount)} matchups${chart.hasForesightSeparator ? ' + foresight separator' : ''} × 3 bytes)`,
      });
    } catch {
      // Overlap with another detector - skip.
    }

    // Confidence: vanilla FireRed/Emerald has ~107 real matchups plus
    // a foresight separator plus the end-table. Anything above 80 is
    // essentially certainly real.
    const confidence =
      chart.matchupCount >= 100 ? 0.95 : chart.matchupCount >= 60 ? 0.9 : 0.85;

    return makeDetected({
      confidence,
      data: Object.freeze({
        typeChart: chart,
        matchupCount: chart.matchupCount,
        hasForesightSeparator: chart.hasForesightSeparator,
      }),
      evidence: [
        makeEvidence({
          kind: 'heuristic',
          summary: `Found gTypeEffectiveness at offset 0x${chart.tableStart.toString(16)} (${String(chart.matchupCount)} matchups${chart.hasForesightSeparator ? ' + foresight separator' : ''}, ${String(chart.tableEndExclusive - chart.tableStart)} bytes total)`,
          weight: 1.0,
          detail: {
            tableStart: chart.tableStart,
            tableEndExclusive: chart.tableEndExclusive,
            matchupCount: chart.matchupCount,
            tripletCount: chart.tripletCount,
            hasForesightSeparator: chart.hasForesightSeparator,
          },
        }),
      ],
    });
  },
};
