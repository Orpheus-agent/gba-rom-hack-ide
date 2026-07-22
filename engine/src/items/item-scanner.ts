/**
 * Gen-3 Items table scanner - Phase UW-2 / Category 4 substrate (iter 70 /
 * UW-2-T4).
 *
 * Scans a ROM image for the `gItems` table by exploiting the universal
 * `itemId == record index` invariant:
 *
 *   gItems[i].itemId  ==  i    (for every i ∈ [0, itemCount))
 *
 * Strategy:
 *   1. Linear-scan the ROM (skipping the cartridge header at 0..0xBF).
 *   2. At each 4-byte-aligned position, check if `parseItem` succeeds AND
 *      the parsed itemId equals 0 - a candidate table-start anchor (the
 *      "ITEM_NONE" zeroth entry).
 *   3. From an anchor, walk forward in 44-byte strides counting records
 *      whose itemId matches the running index. Stop on parse failure, or
 *      on an itemId mismatch UNLESS the slot is a recognizable FRLG
 *      "unused placeholder" (itemId 0 + a real description pointer) - 
 *      vanilla FRLG pads gItems with a block of such "????" slots
 *      (indices ~52-62) whose itemId field is 0 rather than their index.
 *      Tolerating them lets the walk span the gap instead of truncating
 *      at index 52 (which failed the 100-record floor → items: 0).
 *   4. Track the longest valid run across all candidate anchors.
 *   5. Require ≥ ITEMS_SCAN_MIN_RECORDS (default 100) to be confident.
 *      Vanilla FRLG has 376 items; even shrunk hacks rarely drop below
 *      ~200, so 100 is a safe floor.
 *
 * Per-record stride traversal is O(record_count) per anchor; total cost
 * dominated by the linear anchor scan. On a 16 MiB ROM with ~4M
 * 4-byte-aligned positions the scan finishes in <500 ms.
 *
 * PD 12 honored: returns the LONGEST valid run; if multiple candidate
 * tables exist (rare; would imply a duplicated item table), only the
 * longest is kept.
 */

import {
  ITEM_OFFSET_ITEM_ID,
  ITEM_STRUCT_SIZE_BYTES,
  parseItem,
  type Item,
} from './item.js';

/** Minimum item-record count for confident detection. Vanilla = 376. */
export const ITEMS_SCAN_MIN_RECORDS = 100;

/** Skip the GBA cartridge header where item-shaped bytes would be noise. */
const CARTRIDGE_HEADER_END = 0xc0;

/** Maximum item count we'll trust (sanity cap; heavy hacks rarely top 2000). */
const ITEMS_SCAN_MAX_RECORDS = 4096;

export interface ItemsTable {
  /** Absolute byte offset of the first record (item ID 0) in the table. */
  readonly tableStart: number;
  /** Absolute byte offset one past the end of the table. */
  readonly tableEndExclusive: number;
  /** Number of records found (== highest valid itemId + 1). */
  readonly itemCount: number;
  /** Iter 99 (UW-3-T18) - parsed Item records in table-index order
   *  (item 0 first). Consumer-friendly per-item data with name bytes
   *  + price + holdEffect + pocket + type + importance + descriptionPtr. */
  readonly items: ReadonlyArray<Item>;
}

export interface ItemsScanOptions {
  /** Minimum records required (default = ITEMS_SCAN_MIN_RECORDS). */
  readonly minRecords?: number;
  /** Maximum records to walk (default = ITEMS_SCAN_MAX_RECORDS). */
  readonly maxRecords?: number;
}

function readU16LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

/**
 * Find the longest valid gItems table in `bytes`. Returns `null` if no
 * run reaches the min-records threshold.
 */
export function scanItemsTable(
  bytes: Uint8Array,
  options: ItemsScanOptions = {},
): ItemsTable | null {
  const minRecords = options.minRecords ?? ITEMS_SCAN_MIN_RECORDS;
  const maxRecords = options.maxRecords ?? ITEMS_SCAN_MAX_RECORDS;

  if (bytes.byteLength < CARTRIDGE_HEADER_END + minRecords * ITEM_STRUCT_SIZE_BYTES) {
    return null;
  }

  let best: ItemsTable | null = null;
  const limit = bytes.byteLength - ITEM_STRUCT_SIZE_BYTES;

  for (let p = CARTRIDGE_HEADER_END; p <= limit; p += 4) {
    // Fast pre-check: itemId at offset 0x0E must equal 0 (the ITEM_NONE
    // zeroth entry that anchors every gItems table).
    if (readU16LE(bytes, p + ITEM_OFFSET_ITEM_ID) !== 0) continue;

    // Confirm full record parses at the anchor.
    const anchor = parseItem(bytes, p);
    if (!anchor.ok) continue;
    if (anchor.value.itemId !== 0) continue;

    // Walk forward verifying itemId == index.
    let count = 1;
    let cursor = p + ITEM_STRUCT_SIZE_BYTES;
    while (cursor + ITEM_STRUCT_SIZE_BYTES <= bytes.byteLength && count < maxRecords) {
      const expectedId = count;
      const actualId = readU16LE(bytes, cursor + ITEM_OFFSET_ITEM_ID);
      const result = parseItem(bytes, cursor);
      if (!result.ok) break;
      // Real items satisfy `itemId == index`. FRLG (and FRLG-based hacks)
      // pad the list with UNUSED "????" placeholder slots whose itemId
      // field is 0 instead of their index - vanilla's first such gap is
      // at index 52, which previously truncated the run there and failed
      // the 100-record floor (→ items: 0). Tolerate those placeholders so
      // the walk spans the gap, but ONLY when the slot carries a genuine
      // description pointer: a zero-filled padding region (descriptionPtr
      // == 0) is NOT a placeholder and must still end the run so we don't
      // walk off the table into trailing padding.
      const isUnusedPlaceholder = actualId === 0 && result.value.descriptionPtr !== 0;
      if (actualId !== expectedId && !isUnusedPlaceholder) break;
      count++;
      cursor += ITEM_STRUCT_SIZE_BYTES;
    }

    if (count < minRecords) continue;

    // Iter 99 - accumulate parsed Item records so consumers (the
    // binary-rom lifter) can lift per-item price/pocket/holdEffect/
    // etc. instead of just names. Previously items were parsed but
    // discarded.
    const items: Item[] = [];
    items.push(anchor.value);
    let walkCursor = p + ITEM_STRUCT_SIZE_BYTES;
    for (let i = 1; i < count; i++) {
      const r = parseItem(bytes, walkCursor);
      if (!r.ok) break;
      items.push(r.value);
      walkCursor += ITEM_STRUCT_SIZE_BYTES;
    }

    const candidate: ItemsTable = {
      tableStart: p,
      tableEndExclusive: p + count * ITEM_STRUCT_SIZE_BYTES,
      itemCount: count,
      items: Object.freeze(items),
    };
    if (best === null || candidate.itemCount > best.itemCount) {
      best = candidate;
    }

    // Advance past this run so we don't re-scan its interior.
    p = cursor;
  }

  return best;
}
