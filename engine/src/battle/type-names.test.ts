import { describe, expect, it } from 'vitest';
import { encodeString, STRING_TERMINATOR } from '../text/codec.js';
import {
  TYPE_NAME_SLOT_BYTES,
  TYPE_NAMES_MIN_VALID_SLOTS,
  TYPE_NAMES_READ_CAP,
  findTypeNamesTable,
  readTypeNamesAt,
  validateTypeNames,
} from './type-names.js';

// Vanilla Gen-3 type names by ID (FRLG/Emerald): 18 types.
const VANILLA_TYPE_NAMES = [
  'NORMAL',
  'FIGHT',
  'FLYING',
  'POISON',
  'GROUND',
  'ROCK',
  'BUG',
  'GHOST',
  'STEEL',
  'MYS',
  'FIRE',
  'WATER',
  'GRASS',
  'ELECTR',
  'PSYCHC',
  'ICE',
  'DRAGON',
  'DARK',
];

function plantTypeNamesTable(buf: Uint8Array, offset: number, count: number): void {
  for (let i = 0; i < count; i++) {
    const slotStart = offset + i * TYPE_NAME_SLOT_BYTES;
    const name = VANILLA_TYPE_NAMES[i] ?? `T${String(i).padStart(3, '0')}`;
    const encoded = encodeString(name);
    const slot = new Uint8Array(TYPE_NAME_SLOT_BYTES);
    slot.set(encoded.subarray(0, Math.min(encoded.length, TYPE_NAME_SLOT_BYTES - 1)), 0);
    const termPos = Math.min(encoded.length, TYPE_NAME_SLOT_BYTES - 1);
    slot[termPos] = STRING_TERMINATOR;
    buf.set(slot, slotStart);
  }
}

describe('TYPE_NAME_SLOT_BYTES', () => {
  it('is 7', () => {
    expect(TYPE_NAME_SLOT_BYTES).toBe(7);
  });
});

describe('readTypeNamesAt', () => {
  it('reads planted vanilla type names', () => {
    const buf = new Uint8Array(1024);
    plantTypeNamesTable(buf, 0x100, 18);
    const names = readTypeNamesAt(buf, 0x100, 18);
    expect(names[0]).toBe('NORMAL');
    expect(names[1]).toBe('FIGHT');
    expect(names[2]).toBe('FLYING');
    expect(names[10]).toBe('FIRE');
    expect(names[17]).toBe('DARK');
  });

  it('caps reads at TYPE_NAMES_READ_CAP', () => {
    const buf = new Uint8Array(4 * 1024);
    plantTypeNamesTable(buf, 0, 30);
    const names = readTypeNamesAt(buf, 0, 99999);
    expect(names.length).toBeLessThanOrEqual(TYPE_NAMES_READ_CAP);
  });
});

describe('validateTypeNames', () => {
  it('accepts a vanilla 18-type table', () => {
    const buf = new Uint8Array(1024);
    plantTypeNamesTable(buf, 0, 18);
    const names = readTypeNamesAt(buf, 0, 18);
    expect(validateTypeNames(names)).toBe(true);
  });

  it('rejects too-few entries', () => {
    expect(validateTypeNames(['NORMAL', 'FIGHT', 'FLYING'])).toBe(false);
  });

  it('rejects garbage entries', () => {
    const garbage = Array(20).fill('???');
    expect(validateTypeNames(garbage)).toBe(false);
  });

  it('enforces TYPE_NAMES_MIN_VALID_SLOTS threshold', () => {
    const justUnder = Array(TYPE_NAMES_MIN_VALID_SLOTS - 1).fill('NORMAL');
    const justAt = Array(TYPE_NAMES_MIN_VALID_SLOTS).fill('NORMAL');
    expect(validateTypeNames(justUnder)).toBe(false);
    expect(validateTypeNames(justAt)).toBe(true);
  });
});

describe('findTypeNamesTable', () => {
  it('returns null on tiny buffer', () => {
    expect(findTypeNamesTable(new Uint8Array(8))).toBeNull();
  });

  it('returns null when no NORMAL signature is present', () => {
    const buf = new Uint8Array(1024);
    for (let i = 0; i < buf.length; i++) buf[i] = (i * 13 + 7) % 256;
    expect(findTypeNamesTable(buf)).toBeNull();
  });

  it('locates the planted table at the correct offset', () => {
    const buf = new Uint8Array(1024);
    plantTypeNamesTable(buf, 0x100, 18);
    expect(findTypeNamesTable(buf)).toBe(0x100);
  });

  it('rejects NORMAL without FIGHT at slot+7', () => {
    const buf = new Uint8Array(1024);
    const normal = encodeString('NORMAL');
    buf.set(normal, 0x100);
    buf[0x100 + 6] = STRING_TERMINATOR;
    // No FIGHT planted at 0x107.
    expect(findTypeNamesTable(buf)).toBeNull();
  });

  it('rejects NORMAL without terminator at slot[6]', () => {
    const buf = new Uint8Array(1024);
    const normal = encodeString('NORMAL');
    const fight = encodeString('FIGHT');
    buf.set(normal, 0x100);
    // No terminator at 0x106.
    buf[0x100 + 6] = 0x42; // non-terminator byte
    buf.set(fight, 0x107);
    expect(findTypeNamesTable(buf)).toBeNull();
  });
});
