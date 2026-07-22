import { describe, expect, it } from 'vitest';
import { encodeString, STRING_TERMINATOR } from '../text/codec.js';
import { GBA_ROM_BASE } from '../items/index.js';
import {
  POKEDEX_CATEGORY_NAME_LENGTH_BYTES,
  POKEDEX_ENTRY_STRUCT_SIZE_BYTES,
  POKEDEX_HEIGHT_MAX,
  POKEDEX_OFFSET_CATEGORY_NAME,
  POKEDEX_OFFSET_DESCRIPTION_PTR,
  POKEDEX_OFFSET_HEIGHT,
  POKEDEX_OFFSET_UNUSED_DESCRIPTION_PTR,
  POKEDEX_OFFSET_WEIGHT,
  POKEDEX_WEIGHT_MAX,
  parsePokedexEntry,
} from './pokedex-entry.js';

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

function plantValidPokedexEntry(opts: {
  categoryName: string;
  height?: number;
  weight?: number;
  descriptionPtr?: number;
}): Uint8Array {
  const buf = new Uint8Array(POKEDEX_ENTRY_STRUCT_SIZE_BYTES);
  const encoded = encodeString(opts.categoryName);
  const copyLen = Math.min(encoded.length, POKEDEX_CATEGORY_NAME_LENGTH_BYTES - 1);
  for (let i = 0; i < copyLen; i++) buf[POKEDEX_OFFSET_CATEGORY_NAME + i] = encoded[i]!;
  buf[POKEDEX_OFFSET_CATEGORY_NAME + copyLen] = STRING_TERMINATOR;
  writeU16LE(buf, POKEDEX_OFFSET_HEIGHT, opts.height ?? 7);
  writeU16LE(buf, POKEDEX_OFFSET_WEIGHT, opts.weight ?? 69);
  writeU32LE(buf, POKEDEX_OFFSET_DESCRIPTION_PTR, opts.descriptionPtr ?? (GBA_ROM_BASE + 0x100000));
  writeU32LE(buf, POKEDEX_OFFSET_UNUSED_DESCRIPTION_PTR, 0);
  return buf;
}

describe('POKEDEX_ENTRY_STRUCT_SIZE_BYTES', () => {
  it('is 32', () => {
    expect(POKEDEX_ENTRY_STRUCT_SIZE_BYTES).toBe(32);
  });
});

describe('parsePokedexEntry', () => {
  it('parses a valid SEED entry (BULBASAUR-shaped)', () => {
    const buf = plantValidPokedexEntry({ categoryName: 'SEED', height: 7, weight: 69 });
    const r = parsePokedexEntry(buf, 0);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.categoryName).toBe('SEED');
      expect(r.value.height).toBe(7);
      expect(r.value.weight).toBe(69);
    }
  });

  it('parses a multi-word category like LIZARD or DRAGON', () => {
    const buf = plantValidPokedexEntry({ categoryName: 'DRAGON' });
    const r = parsePokedexEntry(buf, 0);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.categoryName).toBe('DRAGON');
  });

  it('rejects out-of-bounds offset', () => {
    const buf = new Uint8Array(20);
    const r = parsePokedexEntry(buf, 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('out_of_bounds');
  });

  it('rejects category name without ≥3 uppercase A-Z chars', () => {
    const buf = plantValidPokedexEntry({ categoryName: 'A' });
    // overwrite category to "A" + terminator
    for (let i = 0; i < POKEDEX_CATEGORY_NAME_LENGTH_BYTES; i++) {
      buf[POKEDEX_OFFSET_CATEGORY_NAME + i] = i === 0 ? 0xbb : i === 1 ? STRING_TERMINATOR : 0;
    }
    const r = parsePokedexEntry(buf, 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('category_name_invalid');
  });

  it('rejects height > POKEDEX_HEIGHT_MAX', () => {
    const buf = plantValidPokedexEntry({ categoryName: 'SEED', height: POKEDEX_HEIGHT_MAX + 1 });
    const r = parsePokedexEntry(buf, 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('height_out_of_range');
  });

  it('rejects weight > POKEDEX_WEIGHT_MAX', () => {
    const buf = plantValidPokedexEntry({ categoryName: 'SEED', weight: POKEDEX_WEIGHT_MAX + 1 });
    const r = parsePokedexEntry(buf, 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('weight_out_of_range');
  });

  it('rejects description ptr outside ROM space', () => {
    const buf = plantValidPokedexEntry({ categoryName: 'SEED', descriptionPtr: 0x02000000 });
    const r = parsePokedexEntry(buf, 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('description_ptr_invalid');
  });

  it('accepts zero description ptr (placeholder allowed)', () => {
    const buf = plantValidPokedexEntry({ categoryName: 'UNKNOWN', descriptionPtr: 0 });
    const r = parsePokedexEntry(buf, 0);
    expect(r.ok).toBe(true);
  });
});
