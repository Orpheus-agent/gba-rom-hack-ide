/**
 * Experience-curves detector - iter 100 / UW-3-T19.
 *
 * Wraps `scanExperienceTable` (engine/src/experience/curves.ts) to
 * surface the universal Gen-3 `gExperienceTables[6][101]` table as a
 * standard RomDetector. Per the iter-92 invariant (UW-D-0015) this
 * detector co-ships with a lifter registered in
 * `app/backend/src/scan/binary-rom-registry.ts` that produces one
 * ExperienceCurveEntry per growth-rate row.
 *
 * Why this detector matters (PD 13 + PD 16):
 *   - Editor surface: "Level-up XP curves" - operators can compare
 *     vanilla curves against hack tweaks (e.g. Radical Red flattens
 *     certain growth rates for pacing).
 *   - Universal: every Gen-3 cart embeds this table; vanilla offsets
 *     vary across forks but the structural signature (6 × 101 monotone
 *     u32s with leading zero-pair) is invariant.
 *   - Hack-aware (PD 16): the growth-rate name is inferred from the
 *     level-100 XP magnitude, so hacks that permute the row order or
 *     tweak curves still get correct identification.
 *
 * Phase 8 (matches other Category 4 substrate detectors - moves,
 * items, abilities, type-chart). Runs after binary-fingerprint /
 * map-system / etc., before region-finalizer.
 */

import { makeDetected, makeEvidence, makeNotDetected } from '../detection/index.js';
import type { Detection } from '../detection/index.js';
import type { CoverageMap } from '../coverage/index.js';
import type { RomImage } from '../rom/loader.js';
import type { RomDetector } from './types.js';
import {
  EXPERIENCE_CURVE_COUNT,
  EXPERIENCE_CURVE_TABLE_BYTES,
  scanExperienceTable,
  type ExperienceTable,
} from '../experience/index.js';

export const EXPERIENCE_CURVES_SYSTEM_DETECTOR_ID = 'experience_curves_system';

export interface ExperienceCurvesSystemReport {
  /** Discovered gExperienceTables[6][101] table. */
  readonly experienceTable: ExperienceTable;
  /** Convenience mirror of experienceTable.curves.length (always 6). */
  readonly curveCount: number;
  /** Count of curves whose level-100 XP matches a canonical vanilla
   *  growth-rate profile (MEDIUM_FAST / ERRATIC / FLUCTUATING /
   *  MEDIUM_SLOW / FAST / SLOW). 6 in vanilla; lower if a hack rewrote
   *  curves with non-canonical magnitudes. */
  readonly canonicallyNamedCount: number;
}

export const experienceCurvesSystemDetector: RomDetector<ExperienceCurvesSystemReport> = {
  id: EXPERIENCE_CURVES_SYSTEM_DETECTOR_ID,
  name: 'Experience Curves System (Gen-3 gExperienceTables scanner)',
  phase: 8,
  detect(rom: RomImage, coverage: CoverageMap): Detection<ExperienceCurvesSystemReport> {
    if (rom.byteLength < EXPERIENCE_CURVE_TABLE_BYTES + 0xc0) {
      return makeNotDetected({
        confidence: 1.0,
        evidence: [
          makeEvidence({
            kind: 'heuristic',
            summary: `ROM is ${String(rom.byteLength)} bytes - too small to host the 2424-byte gExperienceTables[6][101] table after the GBA header`,
            weight: 1.0,
          }),
        ],
        reason: 'ROM too small to scan for Gen-3 gExperienceTables',
      });
    }

    const table = scanExperienceTable(rom.bytes);
    if (table === null) {
      return makeNotDetected({
        confidence: 0.9,
        evidence: [
          makeEvidence({
            kind: 'heuristic',
            summary: `scanned ${String(rom.byteLength)} bytes for a 6×101 monotone u32 table with leading zero-pairs + level-100 ≥ 600,000 - none found`,
            weight: 1.0,
            detail: {
              romByteLength: rom.byteLength,
              tableSize: EXPERIENCE_CURVE_TABLE_BYTES,
              curvesRequired: EXPERIENCE_CURVE_COUNT,
            },
          }),
        ],
        reason:
          'No Gen-3 gExperienceTables[6][101] found - either non-Gen-3, the level-up system has been replaced with a non-table-based formula, or the curves have been corrupted beyond the magnitude floor',
      });
    }

    try {
      coverage.addClassified({
        start: table.tableStart,
        end: table.tableEndExclusive,
        probableClass: 'table',
        score: 0.95,
        provenance: `${EXPERIENCE_CURVES_SYSTEM_DETECTOR_ID}#gExperienceTables`,
        note: `Gen-3 gExperienceTables (6 curves × 101 entries × 4 bytes)`,
      });
    } catch {
      // Overlap with another detector - skip coverage registration.
    }

    let canonicallyNamedCount = 0;
    for (const c of table.curves) {
      if (c.growthRateName !== null) canonicallyNamedCount++;
    }

    // Confidence: detecting the exact 6×101 pattern is essentially
    // proof. Lower only if no curves matched canonical profiles (still
    // detected the structure, just non-vanilla magnitudes).
    const confidence = canonicallyNamedCount >= 6 ? 0.98 : canonicallyNamedCount >= 3 ? 0.92 : 0.85;

    return makeDetected({
      confidence,
      data: Object.freeze({
        experienceTable: table,
        curveCount: table.curves.length,
        canonicallyNamedCount,
      }),
      evidence: [
        makeEvidence({
          kind: 'heuristic',
          summary: `Found gExperienceTables at 0x${table.tableStart.toString(16)} (${String(EXPERIENCE_CURVE_COUNT)} curves × 101 entries; ${String(canonicallyNamedCount)} match canonical growth-rate profiles)`,
          weight: 1.0,
          detail: {
            tableStart: table.tableStart,
            tableEndExclusive: table.tableEndExclusive,
            curveCount: table.curves.length,
            canonicallyNamedCount,
            growthRateNames: table.curves.map((c) => c.growthRateName ?? '(unknown)'),
            xpAtLevel100: table.curves.map((c) => c.xpAtLevel100),
          },
        }),
      ],
    });
  },
};
