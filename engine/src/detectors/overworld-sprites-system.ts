/**
 * Overworld sprites detector - iter 101 / UW-3-T20.
 *
 * Wraps `scanOverworldSpriteTable` (engine/src/world/overworld-sprites.ts)
 * to surface the universal Gen-3 `gObjectEventGraphicsInfoPointers[]`
 * table as a standard RomDetector. Per the UW-D-0015 invariant this
 * detector co-ships with a lifter registered in
 * `app/backend/src/scan/binary-rom-registry.ts` that produces one
 * OverworldSpriteEntry per detected OW sprite.
 *
 * Why this detector matters (PD 13 + PD 16):
 *   - Editor surface: "Overworld sprites" - operators can inspect every
 *     overworld sprite (player, NPCs, follow-mons, doors, decorations)
 *     with its palette tag, size, dimensions, and movement tracks. This
 *     is the bridge between map-system object events (which carry
 *     graphicsId integers) and the sprite library that renders them.
 *   - Universal: every Gen-3 cart embeds this table; vanilla offsets
 *     vary across forks but the 36-byte struct signature + ROM-pointer
 *     array + cluster-span are invariant.
 *   - Hack-aware (PD 16): Unbound, Radical Red, CFRU all expand this
 *     table with custom OW sprites; the structural signature catches
 *     them all without baked offsets.
 *
 * Phase 8 (matches other Category 5/8 substrate detectors - palette,
 * cry table, lz77 sprite tables). Runs after map-system / encounter-
 * system, before region-finalizer.
 */

import { makeDetected, makeEvidence, makeNotDetected } from '../detection/index.js';
import type { Detection } from '../detection/index.js';
import type { CoverageMap } from '../coverage/index.js';
import type { RomImage } from '../rom/loader.js';
import type { RomDetector } from './types.js';
import {
  OVERWORLD_SPRITES_MIN_ENTRIES,
  scanOverworldSpriteTable,
  type OverworldSpriteTable,
} from '../world/index.js';

export const OVERWORLD_SPRITES_SYSTEM_DETECTOR_ID = 'overworld_sprites_system';

export interface OverworldSpritesSystemReport {
  /** Discovered gObjectEventGraphicsInfoPointers[] table. */
  readonly spriteTable: OverworldSpriteTable;
  /** Convenience mirror of spriteTable.entryCount. */
  readonly entryCount: number;
  /** Count of pointer entries whose 36-byte struct passed validation
   *  (== spriteTable.sprites.length). Null pointer-table slots count
   *  toward entryCount but not validCount. */
  readonly validCount: number;
}

export const overworldSpritesSystemDetector: RomDetector<OverworldSpritesSystemReport> = {
  id: OVERWORLD_SPRITES_SYSTEM_DETECTOR_ID,
  name: 'Overworld Sprites System (Gen-3 gObjectEventGraphicsInfoPointers scanner)',
  phase: 8,
  detect(rom: RomImage, coverage: CoverageMap): Detection<OverworldSpritesSystemReport> {
    if (rom.byteLength < 0xc0 + OVERWORLD_SPRITES_MIN_ENTRIES * 4) {
      return makeNotDetected({
        confidence: 1.0,
        evidence: [
          makeEvidence({
            kind: 'heuristic',
            summary: `ROM is ${String(rom.byteLength)} bytes - too small to host the ≥${String(OVERWORLD_SPRITES_MIN_ENTRIES)}-entry overworld sprite pointer table`,
            weight: 1.0,
          }),
        ],
        reason: 'ROM too small to scan for gObjectEventGraphicsInfoPointers',
      });
    }

    const table = scanOverworldSpriteTable(rom.bytes);
    if (table === null) {
      return makeNotDetected({
        confidence: 0.9,
        evidence: [
          makeEvidence({
            kind: 'heuristic',
            summary: `scanned ${String(rom.byteLength)} bytes for a ≥${String(OVERWORLD_SPRITES_MIN_ENTRIES)}-entry u32 ROM-pointer array where every target parses as a 36-byte ObjectEventGraphicsInfo struct (size ≤31, width/height in [8,256], tracks ≤7, 5 trailing pointer fields ROM-space or 0) - none found`,
            weight: 1.0,
            detail: {
              romByteLength: rom.byteLength,
              minEntries: OVERWORLD_SPRITES_MIN_ENTRIES,
            },
          }),
        ],
        reason:
          'No Gen-3 gObjectEventGraphicsInfoPointers[] found - either non-Gen-3, the overworld sprite system has been rewritten with a non-pointer-array layout, or the cart has fewer than the minimum-records threshold of overworld sprites',
      });
    }

    try {
      coverage.addClassified({
        start: table.tableStart,
        end: table.tableEndExclusive,
        probableClass: 'pointer_network',
        score: 0.92,
        provenance: `${OVERWORLD_SPRITES_SYSTEM_DETECTOR_ID}#gObjectEventGraphicsInfoPointers`,
        note: `Gen-3 OW sprite pointer table (${String(table.entryCount)} entries × 4 bytes)`,
      });
    } catch {
      // Overlap with another detector - skip coverage registration.
    }

    const validCount = table.sprites.length;
    // Confidence: scales with entry count + valid fraction. Vanilla
    // FRLG has ~239 entries; heavy hacks 300+.
    const confidence =
      table.entryCount >= 200 ? 0.96 : table.entryCount >= 150 ? 0.92 : 0.86;

    return makeDetected({
      confidence,
      data: Object.freeze({
        spriteTable: table,
        entryCount: table.entryCount,
        validCount,
      }),
      evidence: [
        makeEvidence({
          kind: 'heuristic',
          summary: `Found gObjectEventGraphicsInfoPointers at 0x${table.tableStart.toString(16)} (${String(table.entryCount)} entries, ${String(validCount)} valid sprite structs)`,
          weight: 1.0,
          detail: {
            tableStart: table.tableStart,
            tableEndExclusive: table.tableEndExclusive,
            entryCount: table.entryCount,
            validCount,
            sampleSpriteSizes: table.sprites.slice(0, 5).map((s) => ({
              width: s.width,
              height: s.height,
              size: s.size,
              paletteTag: s.paletteTag,
            })),
          },
        }),
      ],
    });
  },
};
