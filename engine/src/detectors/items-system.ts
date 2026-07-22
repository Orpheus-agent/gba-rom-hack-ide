/**
 * Gen-3 Items System detector - Phase UW-2 / Category 4 substrate (iter
 * 70 / UW-2-T4).
 *
 * Detects the `gItems` table - a packed array of 44-byte Item structs
 * holding bag/key/TM/HM/berry items. Uses universal structural-signature
 * detection (no baked offsets) anchored on the `itemId == record index`
 * invariant, so it works on vanilla AND hacks that have relocated or
 * expanded the item list (CFRU adds ~100 items; Unbound adds many more).
 *
 * Per PD 5: no FireRed/Emerald-only assumption; the itemId-matches-index
 * invariant holds for every Gen-3 cart that retains a flat `gItems`
 * array.
 *
 * Per PD 1: typed `not_detected` with reason when ROM too small OR no
 * ≥100-record run found.
 *
 * Advances:
 *   - Category 4 (Moves / items / abilities / battle mechanics) - third
 *     concrete combat-data table (after moves iter 68 + type chart iter
 *     69). Together these three establish enough substrate for a
 *     read-only damage-calculator UI in a later phase.
 */

import { makeDetected, makeEvidence, makeNotDetected } from '../detection/index.js';
import type { Detection } from '../detection/index.js';
import type { CoverageMap } from '../coverage/index.js';
import type { RomImage } from '../rom/loader.js';
import type { RomDetector } from './types.js';
import {
  ITEMS_SCAN_MIN_RECORDS,
  ITEM_NAME_LENGTH_BYTES,
  ITEM_OFFSET_NAME,
  ITEM_STRUCT_SIZE_BYTES,
  scanItemsTable,
  type ItemsTable,
} from '../items/index.js';
import { decodeString } from '../text/codec.js';

export const ITEMS_SYSTEM_DETECTOR_ID = 'items_system';

/** How many item-name samples to decode. RT-1.6 raised this to a
 *  high cap so the entire detected item list is decoded - the lifter
 *  iterates `sampleNames` to populate `manifest.items[]` so a low cap
 *  meant the editor saw only the first 24 of vanilla's 376 items. */
const ITEMS_SYSTEM_SAMPLE_NAME_COUNT = 2048;

export interface ItemsSystemReport {
  /** Discovered gItems table. */
  readonly itemsTable: ItemsTable;
  /** Convenience mirror of itemsTable.itemCount. */
  readonly itemCount: number;
  /** First N items' decoded inline names - mirrors the same `sampleNames`
   *  convention used by species-names, ability-names, and move-names
   *  detectors (UW-2-T8 iter 74). Item names live INLINE in the gItems
   *  struct (offset 0x00..0x0D, 14 bytes per record); decoded via the
   *  engine's Gen-3 text codec.
   *
   *  Index 0 is item 0 ("?????" / ITEM_NONE placeholder in vanilla);
   *  index 1 is item 1 ("MASTER BALL" in vanilla FRLG); etc. */
  readonly sampleNames: ReadonlyArray<string>;
}

export const itemsSystemDetector: RomDetector<ItemsSystemReport> = {
  id: ITEMS_SYSTEM_DETECTOR_ID,
  name: 'Items System (Gen-3 gItems scanner)',
  phase: 8,
  detect(rom: RomImage, coverage: CoverageMap): Detection<ItemsSystemReport> {
    const minBytes = 0xc0 + ITEMS_SCAN_MIN_RECORDS * ITEM_STRUCT_SIZE_BYTES;
    if (rom.byteLength < minBytes) {
      return makeNotDetected({
        confidence: 1.0,
        evidence: [
          makeEvidence({
            kind: 'heuristic',
            summary: `ROM is ${String(rom.byteLength)} bytes - too small to host a ≥${String(ITEMS_SCAN_MIN_RECORDS)}-record gItems table (needs ≥${String(minBytes)} bytes after cartridge header)`,
            weight: 1.0,
          }),
        ],
        reason: 'ROM too small to scan for Gen-3 gItems table',
      });
    }

    const table = scanItemsTable(rom.bytes);
    if (table === null) {
      return makeNotDetected({
        confidence: 0.85,
        evidence: [
          makeEvidence({
            kind: 'heuristic',
            summary: `scanned ${String(rom.byteLength)} bytes for a run of ≥${String(ITEMS_SCAN_MIN_RECORDS)} 44-byte Item records where each record's itemId field equals its position in the table - none found`,
            weight: 1.0,
            detail: {
              romByteLength: rom.byteLength,
              structSize: ITEM_STRUCT_SIZE_BYTES,
              minRecords: ITEMS_SCAN_MIN_RECORDS,
            },
          }),
        ],
        reason:
          'No Gen-3 gItems table found - either the ROM is non-Gen-3, the item system has been rewritten with a non-flat / non-44-byte layout, or the table is shorter than the min-records threshold',
      });
    }

    // Register coverage.
    try {
      coverage.addClassified({
        start: table.tableStart,
        end: table.tableEndExclusive,
        probableClass: 'table',
        score: 0.92,
        provenance: `${ITEMS_SYSTEM_DETECTOR_ID}#gItems`,
        note: `Gen-3 gItems (${String(table.itemCount)} items × ${String(ITEM_STRUCT_SIZE_BYTES)} bytes)`,
      });
    } catch {
      // Overlap with another detector - skip.
    }

    // Decode the first N items' inline names via the engine text codec
    // (UW-2-T8 iter 74). Item name field is at offset 0x00..0x0D within
    // each 44-byte struct. Skip if the count is short.
    const namesCap = Math.min(ITEMS_SYSTEM_SAMPLE_NAME_COUNT, table.itemCount);
    const sampleNames: string[] = [];
    for (let i = 0; i < namesCap; i++) {
      const recordStart = table.tableStart + i * ITEM_STRUCT_SIZE_BYTES;
      sampleNames.push(
        decodeString(rom.bytes, recordStart + ITEM_OFFSET_NAME, ITEM_NAME_LENGTH_BYTES),
      );
    }

    // Confidence: vanilla FRLG has 376 items, Emerald has 377. Heavy
    // hacks can expand to 1000+. Anything above 200 is essentially
    // certainly real.
    const confidence =
      table.itemCount >= 300 ? 0.95 : table.itemCount >= 200 ? 0.92 : 0.88;

    return makeDetected({
      confidence,
      data: Object.freeze({
        itemsTable: table,
        itemCount: table.itemCount,
        sampleNames: Object.freeze(sampleNames),
      }),
      evidence: [
        makeEvidence({
          kind: 'heuristic',
          summary: `Found gItems at offset 0x${table.tableStart.toString(16)} (${String(table.itemCount)} items, ${String(table.tableEndExclusive - table.tableStart)} bytes)`,
          weight: 1.0,
          detail: {
            tableStart: table.tableStart,
            tableEndExclusive: table.tableEndExclusive,
            itemCount: table.itemCount,
            sampleItemNames: sampleNames.slice(0, 5),
          },
        }),
      ],
    });
  },
};
