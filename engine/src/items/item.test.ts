import { describe, expect, it } from 'vitest';
import {
  GBA_ROM_BASE,
  ITEM_STRUCT_SIZE_BYTES,
  ITEM_NAME_LENGTH_BYTES,
  ITEM_POCKET_MAX,
  ITEM_OFFSET_ITEM_ID,
  ITEM_OFFSET_PRICE,
  ITEM_OFFSET_POCKET,
  ITEM_OFFSET_DESCRIPTION_PTR,
  ITEM_OFFSET_FIELD_USE_FUNC_PTR,
  ITEM_OFFSET_BATTLE_USE_FUNC_PTR,
  ITEM_OFFSET_PADDING,
  parseItem,
} from './item.js';

function writeU16LE(b: Uint8Array, offset: number, v: number): void {
  b[offset] = v & 0xff;
  b[offset + 1] = (v >> 8) & 0xff;
}

function writeU32LE(b: Uint8Array, offset: number, v: number): void {
  b[offset] = v & 0xff;
  b[offset + 1] = (v >> 8) & 0xff;
  b[offset + 2] = (v >> 16) & 0xff;
  b[offset + 3] = (v >> 24) & 0xff;
}

function makeValidItemBytes(opts: { itemId: number; pocket?: number; price?: number }): Uint8Array {
  const buf = new Uint8Array(ITEM_STRUCT_SIZE_BYTES);
  // Name (14 bytes) - fill with 0xFF terminator at index 0 = empty name
  buf.fill(0xff, 0, ITEM_NAME_LENGTH_BYTES);
  writeU16LE(buf, ITEM_OFFSET_ITEM_ID, opts.itemId);
  writeU16LE(buf, ITEM_OFFSET_PRICE, opts.price ?? 100);
  buf[ITEM_OFFSET_POCKET] = opts.pocket ?? 0;
  // Pointers: zero is valid. Padding already zero from fill.
  return buf;
}

describe('ITEM_STRUCT_SIZE_BYTES', () => {
  it('is 44', () => {
    expect(ITEM_STRUCT_SIZE_BYTES).toBe(44);
  });
});

describe('parseItem', () => {
  it('parses a valid item with itemId=0', () => {
    const buf = makeValidItemBytes({ itemId: 0 });
    const r = parseItem(buf, 0);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.itemId).toBe(0);
      expect(r.value.pocket).toBe(0);
      expect(r.value.price).toBe(100);
      expect(r.value.descriptionPtr).toBe(0);
      expect(r.value.fieldUseFuncPtr).toBe(0);
      expect(r.value.battleUseFuncPtr).toBe(0);
    }
  });

  it('parses a valid item with itemId=375 (high vanilla)', () => {
    const buf = makeValidItemBytes({ itemId: 375, pocket: 5, price: 9999 });
    const r = parseItem(buf, 0);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.itemId).toBe(375);
      expect(r.value.pocket).toBe(5);
      expect(r.value.price).toBe(9999);
    }
  });

  it('parses an item with non-null ROM-space pointers', () => {
    const buf = makeValidItemBytes({ itemId: 1 });
    writeU32LE(buf, ITEM_OFFSET_DESCRIPTION_PTR, GBA_ROM_BASE + 0x100000);
    writeU32LE(buf, ITEM_OFFSET_FIELD_USE_FUNC_PTR, GBA_ROM_BASE + 0x200000);
    writeU32LE(buf, ITEM_OFFSET_BATTLE_USE_FUNC_PTR, GBA_ROM_BASE + 0x300000);
    const r = parseItem(buf, 0);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.descriptionPtr).toBe(GBA_ROM_BASE + 0x100000);
      expect(r.value.fieldUseFuncPtr).toBe(GBA_ROM_BASE + 0x200000);
      expect(r.value.battleUseFuncPtr).toBe(GBA_ROM_BASE + 0x300000);
    }
  });

  it('rejects out-of-bounds offset', () => {
    const buf = new Uint8Array(40);
    const r = parseItem(buf, 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('out_of_bounds');
  });

  it('rejects pocket > 9', () => {
    const buf = makeValidItemBytes({ itemId: 0, pocket: ITEM_POCKET_MAX + 1 });
    const r = parseItem(buf, 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('pocket_out_of_range');
  });

  it('rejects non-zero padding byte 0x29', () => {
    const buf = makeValidItemBytes({ itemId: 0 });
    buf[ITEM_OFFSET_PADDING + 0] = 1;
    const r = parseItem(buf, 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('padding_not_zero');
  });

  it('rejects non-zero padding byte 0x2A', () => {
    const buf = makeValidItemBytes({ itemId: 0 });
    buf[ITEM_OFFSET_PADDING + 1] = 1;
    const r = parseItem(buf, 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('padding_not_zero');
  });

  it('rejects non-zero padding byte 0x2B', () => {
    const buf = makeValidItemBytes({ itemId: 0 });
    buf[ITEM_OFFSET_PADDING + 2] = 1;
    const r = parseItem(buf, 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('padding_not_zero');
  });

  it('rejects out-of-ROM-space description pointer (e.g. 0x02000000 EWRAM)', () => {
    const buf = makeValidItemBytes({ itemId: 0 });
    writeU32LE(buf, ITEM_OFFSET_DESCRIPTION_PTR, 0x02000000);
    const r = parseItem(buf, 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('description_ptr_invalid');
  });

  it('rejects out-of-ROM-space fieldUseFunc pointer', () => {
    const buf = makeValidItemBytes({ itemId: 0 });
    writeU32LE(buf, ITEM_OFFSET_FIELD_USE_FUNC_PTR, 0x03000000);
    const r = parseItem(buf, 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('field_use_func_ptr_invalid');
  });

  it('rejects out-of-ROM-space battleUseFunc pointer', () => {
    const buf = makeValidItemBytes({ itemId: 0 });
    writeU32LE(buf, ITEM_OFFSET_BATTLE_USE_FUNC_PTR, 0x0a000000); // exclusive end
    const r = parseItem(buf, 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('battle_use_func_ptr_invalid');
  });

  it('accepts zero pointer (the canonical "no function" sentinel)', () => {
    const buf = makeValidItemBytes({ itemId: 0 });
    writeU32LE(buf, ITEM_OFFSET_DESCRIPTION_PTR, 0);
    writeU32LE(buf, ITEM_OFFSET_FIELD_USE_FUNC_PTR, 0);
    writeU32LE(buf, ITEM_OFFSET_BATTLE_USE_FUNC_PTR, 0);
    const r = parseItem(buf, 0);
    expect(r.ok).toBe(true);
  });
});
