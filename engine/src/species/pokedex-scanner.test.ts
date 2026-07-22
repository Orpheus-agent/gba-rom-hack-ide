import { describe, expect, it } from 'vitest';
import { encodeString, STRING_TERMINATOR } from '../text/codec.js';
import { GBA_ROM_BASE } from '../items/index.js';
import {
  POKEDEX_CATEGORY_NAME_LENGTH_BYTES,
  POKEDEX_ENTRY_STRUCT_SIZE_BYTES,
  POKEDEX_OFFSET_CATEGORY_NAME,
  POKEDEX_OFFSET_DESCRIPTION_PTR,
  POKEDEX_OFFSET_HEIGHT,
  POKEDEX_OFFSET_WEIGHT,
} from './pokedex-entry.js';
import { scanPokedexTable } from './pokedex-scanner.js';

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

const VANILLA_CATEGORIES = [
  'UNKNOWN',
  'SEED',
  'SEED',
  'SEED',
  'LIZARD',
  'FLAME',
  'FLAME',
  'TINY TURTLE',
  'TURTLE',
  'SHELLFISH',
  'WORM',
  'COCOON',
];

function plantPokedexTable(buf: Uint8Array, offset: number, count: number): void {
  for (let i = 0; i < count; i++) {
    const p = offset + i * POKEDEX_ENTRY_STRUCT_SIZE_BYTES;
    // Wipe record
    for (let j = 0; j < POKEDEX_ENTRY_STRUCT_SIZE_BYTES; j++) buf[p + j] = 0;
    const cat = VANILLA_CATEGORIES[i] ?? `MON${String(i).padStart(3, '0')}`;
    const encoded = encodeString(cat);
    const copyLen = Math.min(encoded.length, POKEDEX_CATEGORY_NAME_LENGTH_BYTES - 1);
    for (let j = 0; j < copyLen; j++) buf[p + POKEDEX_OFFSET_CATEGORY_NAME + j] = encoded[j]!;
    buf[p + POKEDEX_OFFSET_CATEGORY_NAME + copyLen] = STRING_TERMINATOR;
    writeU16LE(buf, p + POKEDEX_OFFSET_HEIGHT, 7 + (i % 20));
    writeU16LE(buf, p + POKEDEX_OFFSET_WEIGHT, 69 + (i * 3) % 1000);
    writeU32LE(buf, p + POKEDEX_OFFSET_DESCRIPTION_PTR, GBA_ROM_BASE + 0x100000 + i * 64);
  }
}

function fillNonPokedexBytes(buf: Uint8Array, fromOffset: number): void {
  // Bytes that fail validation: every odd byte high, alternating noise.
  for (let i = fromOffset; i < buf.length; i++) {
    buf[i] = i % 2 === 1 ? 0x80 | ((i * 13) % 128) : (i * 7) % 256;
  }
}

describe('scanPokedexTable', () => {
  it('returns null when ROM is too small', () => {
    const buf = new Uint8Array(2 * 1024);
    expect(scanPokedexTable(buf)).toBeNull();
  });

  it('returns null when no Pokédex table is present', () => {
    const buf = new Uint8Array(64 * 1024);
    fillNonPokedexBytes(buf, 0);
    expect(scanPokedexTable(buf)).toBeNull();
  });

  it('detects a planted 411-entry vanilla-shaped table', () => {
    const buf = new Uint8Array(64 * 1024);
    fillNonPokedexBytes(buf, 0);
    plantPokedexTable(buf, 0x1000, 411);
    const r = scanPokedexTable(buf);
    expect(r).not.toBeNull();
    if (r) {
      expect(r.tableStart).toBe(0x1000);
      expect(r.entryCount).toBe(411);
      expect(r.tableEndExclusive).toBe(0x1000 + 411 * POKEDEX_ENTRY_STRUCT_SIZE_BYTES);
    }
  });

  it('rejects runs below the min-records floor', () => {
    const buf = new Uint8Array(32 * 1024);
    fillNonPokedexBytes(buf, 0);
    plantPokedexTable(buf, 0x1000, 50); // below default 100
    expect(scanPokedexTable(buf)).toBeNull();
    const lenient = scanPokedexTable(buf, { minRecords: 30 });
    expect(lenient).not.toBeNull();
    if (lenient) expect(lenient.entryCount).toBe(50);
  });

  it('skips entries planted ENTIRELY inside the cartridge header (≤6 entries fit)', () => {
    // 5 entries × 32 = 160 bytes from offset 0x10..0xB0 fits fully in
    // the 0..0xBF header region. Scanner starts at 0xC0 + sees only
    // garbage past the planted table → no detection.
    const buf = new Uint8Array(32 * 1024);
    fillNonPokedexBytes(buf, 0);
    plantPokedexTable(buf, 0x10, 5);
    expect(scanPokedexTable(buf)).toBeNull();
  });
});
