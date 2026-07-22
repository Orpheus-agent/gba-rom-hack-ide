/**
 * Heal-locations detector - Phase O.42.
 *
 * Wraps scanHealLocations (engine/src/world/heal-locations.ts) to
 * surface the universal Gen-3 `sHealLocations[]` / `gHealLocations[]`
 * table as a standard RomDetector. The table maps each SPAWN_* index
 * to a (map group, map num, x, y) destination - the warps the game
 * uses on white-out + after Fly / Teleport, plus mom's house initial
 * spawn.
 *
 * Per the UW-D-0015 invariant this detector co-ships with a lifter
 * (registered in `app/backend/src/scan/binary-rom-registry.ts`) that
 * produces one HealLocationEntry per detected entry. Frontend
 * inspector surface (the HealLocationsView coming next) renders the
 * table as a list of editable (slot, destination map, x, y) tuples
 * via a new write route.
 *
 * Phase 8 - runs after map_system so the lifter can resolve each
 * heal-location's (group, mapNum) to an existing MapNode for the
 * destination column.
 */

import { makeDetected, makeEvidence, makeNotDetected } from '../detection/index.js';
import type { Detection } from '../detection/index.js';
import type { CoverageMap } from '../coverage/index.js';
import type { RomImage } from '../rom/loader.js';
import type { RomDetector } from './types.js';
import {
  HEAL_LOCATIONS_MIN_ENTRIES,
  scanHealLocations,
  type HealLocationsTable,
} from '../world/heal-locations.js';

export const HEAL_LOCATIONS_SYSTEM_DETECTOR_ID = 'heal_locations_system';

export interface HealLocationsSystemReport {
  /** Discovered sHealLocations[] table. */
  readonly table: HealLocationsTable;
  /** Mirror of table.entryCount. */
  readonly entryCount: number;
  /** First-N (group, mapNum, x, y) tuples for at-a-glance audit. */
  readonly sampleEntries: ReadonlyArray<{
    readonly group: number;
    readonly mapNum: number;
    readonly x: number;
    readonly y: number;
  }>;
}

const SAMPLE_LIMIT = 6;

export const healLocationsSystemDetector: RomDetector<HealLocationsSystemReport> = {
  id: HEAL_LOCATIONS_SYSTEM_DETECTOR_ID,
  name: 'Heal Locations System (Gen-3 sHealLocations scanner)',
  phase: 8,
  detect(rom: RomImage, _coverage: CoverageMap): Detection<HealLocationsSystemReport> {
    if (rom.byteLength < 0xc0 + HEAL_LOCATIONS_MIN_ENTRIES * 6) {
      return makeNotDetected({
        confidence: 1.0,
        evidence: [
          makeEvidence({
            kind: 'heuristic',
            summary: `ROM is ${String(rom.byteLength)} bytes - too small to host the sHealLocations table after the GBA header`,
            weight: 1.0,
          }),
        ],
        reason: 'ROM too small to scan for Gen-3 sHealLocations',
      });
    }
    const table = scanHealLocations(rom.bytes);
    if (table === null) {
      return makeNotDetected({
        confidence: 0.85,
        evidence: [
          makeEvidence({
            kind: 'heuristic',
            summary: `No run of ≥ ${String(HEAL_LOCATIONS_MIN_ENTRIES)} consecutive valid HealLocation structs found`,
            weight: 1.0,
          }),
        ],
        reason: 'No sHealLocations table found',
      });
    }
    const samples = table.entries
      .slice(0, SAMPLE_LIMIT)
      .map((e) => ({ group: e.group, mapNum: e.mapNum, x: e.x, y: e.y }));
    return makeDetected({
      confidence: 0.95,
      evidence: [
        makeEvidence({
          kind: 'heuristic',
          summary: `sHealLocations[] at file offset 0x${table.tableStart.toString(16)} with ${String(table.entryCount)} entries`,
          weight: 1.0,
        }),
      ],
      data: {
        table,
        entryCount: table.entryCount,
        sampleEntries: samples,
      },
    });
  },
};
