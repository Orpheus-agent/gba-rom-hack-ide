/**
 * Object-event palettes detector - Phase F "Rendering Truth"
 * (semantic-world plan §Phase 1.1).
 *
 * Wraps `scanObjectEventPaletteTable` (engine/src/world/
 * object-event-palettes.ts) to surface the universal Gen-3
 * `sObjectEventSpritePalettes[]` table as a standard RomDetector. Per
 * the UW-D-0015 invariant this detector co-ships with a lifter
 * registered in `app/backend/src/scan/binary-rom-registry.ts` that
 * produces one ObjectEventPaletteEntry per detected palette slot,
 * indexed by tag for the iter-101 OverworldSpriteEntry cross-ref.
 *
 * Why this detector matters (PD 13 + PD 14):
 *   - Editor visual fidelity: without this table the editor cannot
 *     resolve each OW sprite's `paletteTag1` to its actual 32-byte
 *     BGR555 palette block. Result before this detector existed: every
 *     NPC, the player, every overworld object rendered as a grayscale
 *     silhouette. This is the single biggest "doesn't look like the
 *     game" complaint in the current product.
 *   - Substrate for the inspector panel + the world-graph polish: with
 *     real palettes a sprite preview becomes inline-renderable instead
 *     of a placeholder swatch.
 *
 * Phase 8 (matches other Category 5/8 substrate detectors - palette,
 * cry table, lz77 sprite tables, overworld sprites). Runs after
 * overworld-sprites-system, before region-finalizer.
 */

import { makeDetected, makeEvidence, makeNotDetected } from '../detection/index.js';
import type { Detection } from '../detection/index.js';
import type { CoverageMap } from '../coverage/index.js';
import type { RomImage } from '../rom/loader.js';
import type { RomDetector } from './types.js';
import {
  OBJECT_EVENT_PALETTES_MIN_ENTRIES,
  scanObjectEventPaletteTable,
  type ObjectEventPaletteTable,
} from '../world/index.js';

export const OBJECT_EVENT_PALETTES_SYSTEM_DETECTOR_ID = 'object_event_palettes_system';

export interface ObjectEventPalettesSystemReport {
  /** Discovered sObjectEventSpritePalettes[] table. */
  readonly paletteTable: ObjectEventPaletteTable;
  /** Convenience mirror of paletteTable.entryCount. */
  readonly entryCount: number;
}

export const objectEventPalettesSystemDetector: RomDetector<ObjectEventPalettesSystemReport> = {
  id: OBJECT_EVENT_PALETTES_SYSTEM_DETECTOR_ID,
  name: 'Object Event Palettes (Gen-3 sObjectEventSpritePalettes scanner)',
  phase: 8,
  detect(rom: RomImage, coverage: CoverageMap): Detection<ObjectEventPalettesSystemReport> {
    const minBytes = 0xc0 + (OBJECT_EVENT_PALETTES_MIN_ENTRIES + 1) * 8;
    if (rom.byteLength < minBytes) {
      return makeNotDetected({
        confidence: 1.0,
        evidence: [
          makeEvidence({
            kind: 'heuristic',
            summary: `ROM is ${String(rom.byteLength)} bytes - too small to host a ≥${String(OBJECT_EVENT_PALETTES_MIN_ENTRIES)}-entry sObjectEventSpritePalettes[] table past the cartridge header`,
            weight: 1.0,
          }),
        ],
        reason: 'ROM too small to scan for sObjectEventSpritePalettes[]',
      });
    }

    const table = scanObjectEventPaletteTable(rom.bytes);
    if (table === null) {
      return makeNotDetected({
        confidence: 0.85,
        evidence: [
          makeEvidence({
            kind: 'heuristic',
            summary: `scanned ${String(rom.byteLength)} bytes at u32 stride for a sentinel-terminated SpritePalette[] (8-byte entries: u32 ROM pointer + u16 tag + u16 pad=0; each pointer targets a valid 32-byte BGR555 palette block; ≥${String(OBJECT_EVENT_PALETTES_MIN_ENTRIES)} non-sentinel entries) - none found`,
            weight: 1.0,
            detail: {
              romByteLength: rom.byteLength,
              minEntries: OBJECT_EVENT_PALETTES_MIN_ENTRIES,
            },
          }),
        ],
        reason:
          'No Gen-3 sObjectEventSpritePalettes[] found - either non-Gen-3, the overworld palette system has been rewritten, or the table is below the minimum-records threshold',
      });
    }

    try {
      coverage.addClassified({
        start: table.tableStart,
        end: table.tableEndExclusive,
        probableClass: 'pointer_network',
        score: 0.92,
        provenance: `${OBJECT_EVENT_PALETTES_SYSTEM_DETECTOR_ID}#sObjectEventSpritePalettes`,
        note: `Gen-3 OW sprite palette table (${String(table.entryCount)} entries × 8 bytes + 8-byte NULL sentinel)`,
      });
    } catch {
      // Overlap with another detector - skip coverage registration.
    }

    // Confidence: vanilla FRLG ~25 entries, Emerald ~30. ≥25 = vanilla
    // class. ≥15 = moderate. ≥8 = baseline.
    const confidence =
      table.entryCount >= 25 ? 0.95 : table.entryCount >= 15 ? 0.9 : 0.85;

    return makeDetected({
      confidence,
      data: Object.freeze({
        paletteTable: table,
        entryCount: table.entryCount,
      }),
      evidence: [
        makeEvidence({
          kind: 'heuristic',
          summary: `Found sObjectEventSpritePalettes[] at 0x${table.tableStart.toString(16)} (${String(table.entryCount)} entries, sentinel at 0x${(table.tableEndExclusive - 8).toString(16)})`,
          weight: 1.0,
          detail: {
            tableStart: table.tableStart,
            tableEndExclusive: table.tableEndExclusive,
            entryCount: table.entryCount,
            sampleTags: table.entries.slice(0, 5).map((e) => ({
              tag: e.tag,
              paletteFileOffset: e.paletteFileOffset,
            })),
          },
        }),
      ],
    });
  },
};
