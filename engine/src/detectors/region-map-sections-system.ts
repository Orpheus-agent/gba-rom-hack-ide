/**
 * Region-map sections detector - Phase UX-B / iter-equivalent.
 *
 * Wraps scanRegionMapSections (engine/src/world/region-map-sections.ts)
 * to surface the universal Gen-3 `gRegionMapEntries[]` table as a
 * standard RomDetector. Per the UW-D-0015 invariant this detector
 * co-ships with a lifter registered in
 * `app/backend/src/scan/binary-rom-registry.ts` that produces one
 * RegionMapSectionEntry per detected entry. A subsequent cross-ref pass
 * walks ctx.maps[] and rewrites each map's `name` from iter-95's
 * synthetic `Map ?.202` to the real area name like "PALLET TOWN" via
 * the regionMapSection byte exposed on each EnrichedMap.
 *
 * Why this detector matters (PD 13 + PD 14 + PD 16):
 *   - Editor surface: every map sidebar entry + map editor title bar
 *     now shows a real in-game area name, not a synthetic id.
 *   - Universal: every Gen-3 cart embeds gRegionMapEntries; vanilla
 *     offsets vary across forks but the 12-byte struct signature is
 *     invariant.
 *   - Hack-aware: Unbound/Radical Red expand the table with custom
 *     area names; the structural scanner catches them all.
 *
 * Phase 8 (matches other Category 1/5 substrate detectors). Runs after
 * map_system so the lifter + cross-ref can chain off the EnrichedMap
 * regionMapSection byte iter-95 exposes.
 */

import { makeDetected, makeEvidence, makeNotDetected } from '../detection/index.js';
import type { Detection } from '../detection/index.js';
import type { CoverageMap } from '../coverage/index.js';
import type { RomImage } from '../rom/loader.js';
import type { RomDetector } from './types.js';
import {
  REGION_MAP_SECTIONS_MIN_ENTRIES,
  REGION_MAP_SECTIONS_MIN_NAMED,
  scanRegionMapSections,
  type RegionMapSectionsTable,
} from '../world/index.js';

export const REGION_MAP_SECTIONS_SYSTEM_DETECTOR_ID = 'region_map_sections_system';

export interface RegionMapSectionsSystemReport {
  /** Discovered gRegionMapEntries[] table. */
  readonly sectionTable: RegionMapSectionsTable;
  /** Mirror of sectionTable.entryCount. */
  readonly entryCount: number;
  /** Mirror of sectionTable.namedCount - entries with a non-zero name
   *  pointer that decoded to a printable Gen-3 charset string. */
  readonly namedCount: number;
  /** First-N decoded area names for at-a-glance audit (skips empty
   *  sentinel slots). */
  readonly sampleNames: ReadonlyArray<string>;
  /** Which struct layout the accepted table uses ('8byte' for FRLG-style,
   *  '12byte' for Emerald-style). RT-1.1. */
  readonly layoutKind: '8byte' | '12byte';
}

export const regionMapSectionsSystemDetector: RomDetector<RegionMapSectionsSystemReport> = {
  id: REGION_MAP_SECTIONS_SYSTEM_DETECTOR_ID,
  name: 'Region Map Sections System (Gen-3 gRegionMapEntries scanner)',
  phase: 8,
  detect(rom: RomImage, coverage: CoverageMap): Detection<RegionMapSectionsSystemReport> {
    // The smallest layout (8-byte FRLG struct) sets the lower bound; we
    // still need at least minEntries × 8 bytes past the GBA header.
    if (rom.byteLength < 0xc0 + REGION_MAP_SECTIONS_MIN_ENTRIES * 8) {
      return makeNotDetected({
        confidence: 1.0,
        evidence: [
          makeEvidence({
            kind: 'heuristic',
            summary: `ROM is ${String(rom.byteLength)} bytes - too small to host the gRegionMapEntries table after the GBA header`,
            weight: 1.0,
          }),
        ],
        reason: 'ROM too small to scan for Gen-3 gRegionMapEntries',
      });
    }

    // RT-1.1: scanRegionMapSections now tries BOTH the 12-byte
    // (Emerald) and 8-byte (FRLG) struct layouts and returns whichever
    // produces more named entries past the variety guards. The
    // returned table reports `layoutKind` + `entrySize` so we can
    // surface that to downstream consumers.
    const table = scanRegionMapSections(rom.bytes);
    if (table === null) {
      return makeNotDetected({
        confidence: 0.9,
        evidence: [
          makeEvidence({
            kind: 'heuristic',
            summary: `scanned ${String(rom.byteLength)} bytes for a run of ≥${String(REGION_MAP_SECTIONS_MIN_ENTRIES)} RegionMapLocation structs (8-byte or 12-byte) with ≥${String(REGION_MAP_SECTIONS_MIN_NAMED)} decoded names - none found`,
            weight: 1.0,
            detail: {
              romByteLength: rom.byteLength,
              minEntries: REGION_MAP_SECTIONS_MIN_ENTRIES,
              minNamed: REGION_MAP_SECTIONS_MIN_NAMED,
            },
          }),
        ],
        reason:
          'No Gen-3 gRegionMapEntries table found in either the 12-byte (Emerald) or 8-byte (FRLG) layout. Either the ROM is non-Gen-3, the region-map system has been rewritten, or the area-name strings have been moved out of ROM-space.',
      });
    }

    try {
      coverage.addClassified({
        start: table.tableStart,
        end: table.tableEndExclusive,
        probableClass: 'table',
        score: 0.92,
        provenance: `${REGION_MAP_SECTIONS_SYSTEM_DETECTOR_ID}#gRegionMapEntries`,
        note: `Gen-3 gRegionMapEntries (${String(table.entryCount)} entries × ${String(table.entrySize)} bytes [${table.layoutKind}], ${String(table.namedCount)} named)`,
      });
    } catch {
      /* overlap */
    }

    const sampleNames = table.sections
      .filter((s) => s.name.length > 0)
      .slice(0, 16)
      .map((s) => s.name);

    // Confidence: scales with named-count + entry-count vs vanilla
    // baseline (~196 entries × ~88 named on FRLG).
    const confidence =
      table.namedCount >= 60 ? 0.97 : table.namedCount >= 30 ? 0.92 : 0.85;

    return makeDetected({
      confidence,
      data: Object.freeze({
        sectionTable: table,
        entryCount: table.entryCount,
        namedCount: table.namedCount,
        sampleNames: Object.freeze(sampleNames),
        layoutKind: table.layoutKind,
      }),
      evidence: [
        makeEvidence({
          kind: 'heuristic',
          summary: `Found gRegionMapEntries at 0x${table.tableStart.toString(16)} (${String(table.entryCount)} entries × ${String(table.entrySize)}b [${table.layoutKind}], ${String(table.namedCount)} named) - sample: ${sampleNames.slice(0, 3).join(' / ')}`,
          weight: 1.0,
          detail: {
            tableStart: table.tableStart,
            tableEndExclusive: table.tableEndExclusive,
            entryCount: table.entryCount,
            namedCount: table.namedCount,
            sampleNames: sampleNames.slice(0, 8),
            layoutKind: table.layoutKind,
            entrySize: table.entrySize,
          },
        }),
      ],
    });
  },
};
