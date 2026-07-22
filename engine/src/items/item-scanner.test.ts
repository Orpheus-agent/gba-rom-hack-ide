import { describe, expect, it } from 'vitest';
import {
  ITEM_NAME_LENGTH_BYTES,
  ITEM_OFFSET_ITEM_ID,
  ITEM_OFFSET_POCKET,
  ITEM_STRUCT_SIZE_BYTES,
} from './item.js';
import { scanItemsTable } from './item-scanner.js';

function writeU16LE(b: Uint8Array, offset: number, v: number): void {
  b[offset] = v & 0xff;
  b[offset + 1] = (v >> 8) & 0xff;
}

// Garbage-fill so the scanner doesn't accidentally walk into zero-padding
// and report bogus runs (zero bytes pass several validators).
function makeGarbageBuffer(size: number, seed = 0x91): Uint8Array {
  const b = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    // Use values guaranteed to FAIL parseItem at random alignment:
    // - pocket byte > 9
    // - padding bytes != 0
    // - itemId varies
    b[i] = 50 + ((i * 13 + seed) % 200); // 50..249 - guarantees pocket > 9, padding != 0
  }
  return b;
}

// Plant a valid gItems table at `offset` with `itemCount` records.
function plantItemsTable(
  buf: Uint8Array,
  offset: number,
  itemCount: number,
): void {
  for (let i = 0; i < itemCount; i++) {
    const p = offset + i * ITEM_STRUCT_SIZE_BYTES;
    // Zero entire record first.
    for (let j = 0; j < ITEM_STRUCT_SIZE_BYTES; j++) buf[p + j] = 0;
    // Name field: 14 bytes of 0xFF (terminator).
    for (let j = 0; j < ITEM_NAME_LENGTH_BYTES; j++) buf[p + j] = 0xff;
    // itemId at 0x0E must equal i.
    writeU16LE(buf, p + ITEM_OFFSET_ITEM_ID, i);
    // Pocket: rotate 0..9.
    buf[p + ITEM_OFFSET_POCKET] = i % 10;
    // Other fields already zero (price=0, pointers=0, padding=0). All valid.
  }
}

// Overwrite an already-planted slot so it mimics a vanilla FRLG "unused
// placeholder" item: itemId field forced to 0 (NOT its index) but with a
// real (non-zero, ROM-space) description pointer - the structural marker
// that distinguishes a genuine placeholder from zero-fill padding.
function makeUnusedPlaceholderSlot(buf: Uint8Array, offset: number): void {
  writeU16LE(buf, offset + ITEM_OFFSET_ITEM_ID, 0);
  // descriptionPtr at 0x14: a canonical GBA ROM-space pointer (0x08xxxxxx).
  buf[offset + 0x14] = 0x20;
  buf[offset + 0x15] = 0xb0;
  buf[offset + 0x16] = 0xdb;
  buf[offset + 0x17] = 0x08;
}

describe('scanItemsTable', () => {
  it('returns null when ROM is too small', () => {
    const tiny = new Uint8Array(64);
    expect(scanItemsTable(tiny)).toBeNull();
  });

  it('returns null when no item table is present', () => {
    const buf = makeGarbageBuffer(64 * 1024);
    expect(scanItemsTable(buf)).toBeNull();
  });

  it('detects a planted 376-item vanilla-shaped table', () => {
    const buf = makeGarbageBuffer(128 * 1024);
    const offset = 0x4000;
    plantItemsTable(buf, offset, 376);
    const r = scanItemsTable(buf);
    expect(r).not.toBeNull();
    if (r) {
      expect(r.tableStart).toBe(offset);
      expect(r.itemCount).toBe(376);
      expect(r.tableEndExclusive).toBe(offset + 376 * ITEM_STRUCT_SIZE_BYTES);
    }
  });

  it('spans FRLG unused-placeholder slots (itemId 0 + real desc ptr)', () => {
    // Vanilla FRLG pads gItems with a block of "????" placeholder slots
    // whose itemId is 0, not their index (first gap at index 52). A strict
    // itemId==index walk truncates there; the scanner must tolerate them.
    const buf = makeGarbageBuffer(128 * 1024);
    const offset = 0x4000;
    plantItemsTable(buf, offset, 376);
    // Mimic the vanilla gap: indices 52..62 are placeholders.
    for (let i = 52; i <= 62; i++) {
      makeUnusedPlaceholderSlot(buf, offset + i * ITEM_STRUCT_SIZE_BYTES);
    }
    const r = scanItemsTable(buf);
    expect(r).not.toBeNull();
    if (r) {
      expect(r.tableStart).toBe(offset);
      expect(r.itemCount).toBe(376);
      // The placeholder slots are still lifted, in index order, with id 0.
      expect(r.items[52]?.itemId).toBe(0);
      expect(r.items[51]?.itemId).toBe(51);
      expect(r.items[63]?.itemId).toBe(63);
    }
  });

  it('does NOT treat zero-fill padding as a placeholder (desc ptr 0)', () => {
    // A zero-id slot with descriptionPtr == 0 is padding, not a placeholder:
    // the run must END there rather than walking off into trailing zeros.
    const buf = makeGarbageBuffer(128 * 1024);
    const offset = 0x4000;
    plantItemsTable(buf, offset, 376);
    // Index 120 gets itemId 0 but leaves descriptionPtr == 0 (plain zero-fill).
    writeU16LE(buf, offset + 120 * ITEM_STRUCT_SIZE_BYTES + ITEM_OFFSET_ITEM_ID, 0);
    const r = scanItemsTable(buf);
    expect(r).not.toBeNull();
    if (r) expect(r.itemCount).toBe(120); // truncated at the zero-fill slot
  });

  it('rejects runs below the min-records floor', () => {
    const buf = makeGarbageBuffer(32 * 1024);
    plantItemsTable(buf, 0x1000, 50); // below default 100
    expect(scanItemsTable(buf)).toBeNull();
    // Caller-lowered floor accepts it.
    const lenient = scanItemsTable(buf, { minRecords: 25 });
    expect(lenient).not.toBeNull();
    if (lenient) expect(lenient.itemCount).toBe(50);
  });

  it('returns the LONGEST run when multiple tables exist', () => {
    const buf = makeGarbageBuffer(256 * 1024);
    plantItemsTable(buf, 0x2000, 150); // shorter
    plantItemsTable(buf, 0x20000, 300); // longer
    const r = scanItemsTable(buf);
    expect(r).not.toBeNull();
    if (r) {
      expect(r.tableStart).toBe(0x20000);
      expect(r.itemCount).toBe(300);
    }
  });

  it('skips the GBA cartridge header region (0..0xBF)', () => {
    // Plant items at offset 0x40 - should be ignored entirely.
    const buf = makeGarbageBuffer(64 * 1024);
    plantItemsTable(buf, 0x40, 200);
    // The walk-past-anchor logic also has to handle this - since the
    // anchor is INSIDE 0..0xBF, the scanner never starts there.
    expect(scanItemsTable(buf)).toBeNull();
  });

  it('respects max-records cap to prevent runaway walks', () => {
    const buf = makeGarbageBuffer(512 * 1024);
    plantItemsTable(buf, 0x2000, 200);
    const r = scanItemsTable(buf, { minRecords: 50, maxRecords: 75 });
    expect(r).not.toBeNull();
    if (r) expect(r.itemCount).toBe(75); // capped before reaching 200
  });
});
