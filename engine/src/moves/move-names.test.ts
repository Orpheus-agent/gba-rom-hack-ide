import { describe, expect, it } from 'vitest';
import { encodeString, STRING_TERMINATOR } from '../text/codec.js';
import {
  MOVE_NAME_SLOT_BYTES,
  MOVE_NAMES_MIN_VALID_SLOTS,
  MOVE_PLACEHOLDER_BYTE,
  findMoveNamesTable,
  readMoveNamesAt,
  validateMoveNames,
} from './move-names.js';

const VANILLA_MOVE_NAMES = [
  '-', // 0 placeholder (MOVE_NONE)
  'POUND',
  'KARATE CHOP',
  'DOUBLE SLAP',
  'COMET PUNCH',
  'MEGA PUNCH',
  'PAY DAY',
  'FIRE PUNCH',
  'ICE PUNCH',
  'THUNDERPUNCH',
  'SCRATCH',
  'VICEGRIP',
  'GUILLOTINE',
  'RAZOR WIND',
  'SWORDS DANCE',
  'CUT',
  'GUST',
  'WING ATTACK',
  'WHIRLWIND',
  'FLY',
  'BIND',
];

/** Plant a vanilla-shaped gMoveNames table at `offset` in `buf`. */
function plantMoveNamesTable(buf: Uint8Array, offset: number, count: number): void {
  // Slot 0: placeholder "-" + terminator + padding zeros.
  const placeholder = new Uint8Array(MOVE_NAME_SLOT_BYTES);
  placeholder[0] = MOVE_PLACEHOLDER_BYTE;
  placeholder[1] = STRING_TERMINATOR;
  buf.set(placeholder, offset);

  for (let i = 1; i < count; i++) {
    const slotStart = offset + i * MOVE_NAME_SLOT_BYTES;
    const name = VANILLA_MOVE_NAMES[i] ?? `MOVE${String(i).padStart(3, '0')}`;
    const encoded = encodeString(name);
    const slot = new Uint8Array(MOVE_NAME_SLOT_BYTES);
    slot.set(encoded.subarray(0, Math.min(encoded.length, MOVE_NAME_SLOT_BYTES - 1)), 0);
    const termPos = Math.min(encoded.length, MOVE_NAME_SLOT_BYTES - 1);
    slot[termPos] = STRING_TERMINATOR;
    buf.set(slot, slotStart);
  }
}

describe('MOVE_NAME_SLOT_BYTES', () => {
  it('is 13', () => {
    expect(MOVE_NAME_SLOT_BYTES).toBe(13);
  });
});

describe('readMoveNamesAt', () => {
  it('reads the planted vanilla names', () => {
    const buf = new Uint8Array(8 * 1024);
    plantMoveNamesTable(buf, 0x200, 10);
    const names = readMoveNamesAt(buf, 0x200, 10);
    expect(names.length).toBe(10);
    expect(names[0]).toBe('-');
    expect(names[1]).toBe('POUND');
    expect(names[2]).toBe('KARATE CHOP');
    expect(names[3]).toBe('DOUBLE SLAP');
    expect(names[4]).toBe('COMET PUNCH');
  });

  it('returns fewer entries when buffer runs out', () => {
    // 4 slots × 13 = 52 bytes needed; buffer 60 bytes; request 10 - caps at 4.
    const buf = new Uint8Array(60);
    plantMoveNamesTable(buf, 0, 4);
    const names = readMoveNamesAt(buf, 0, 10);
    expect(names.length).toBeLessThanOrEqual(4);
  });

  it('caps reads at MOVE_NAMES_READ_CAP', () => {
    const buf = new Uint8Array(128 * 1024);
    plantMoveNamesTable(buf, 0, 50);
    const names = readMoveNamesAt(buf, 0, 99999);
    expect(names.length).toBeLessThanOrEqual(2048);
  });
});

describe('validateMoveNames', () => {
  it('accepts a vanilla-shaped 50-move set', () => {
    const buf = new Uint8Array(2 * 1024);
    plantMoveNamesTable(buf, 0, 50);
    const names = readMoveNamesAt(buf, 0, 50);
    expect(validateMoveNames(names)).toBe(true);
  });

  it('rejects too-few entries', () => {
    expect(validateMoveNames(['POUND', 'KARATE CHOP'])).toBe(false);
  });

  it('rejects garbage entries', () => {
    const garbage = Array(70).fill('???');
    expect(validateMoveNames(garbage)).toBe(false);
  });

  it('accepts multi-word move names with space separator', () => {
    const buf = new Uint8Array(2 * 1024);
    plantMoveNamesTable(buf, 0, 60);
    const names = readMoveNamesAt(buf, 0, 60);
    // KARATE CHOP at idx 2; DOUBLE SLAP at idx 3 - must pass per
    // /[A-Z]+ [A-Z]+/ test.
    expect(names[2]).toBe('KARATE CHOP');
    expect(names[3]).toBe('DOUBLE SLAP');
    expect(validateMoveNames(names)).toBe(true);
  });

  it('uses MOVE_NAMES_MIN_VALID_SLOTS as the minimum', () => {
    const justUnder = Array(MOVE_NAMES_MIN_VALID_SLOTS - 1).fill('POUND');
    const justAt = Array(MOVE_NAMES_MIN_VALID_SLOTS).fill('POUND');
    expect(validateMoveNames(justUnder)).toBe(false);
    expect(validateMoveNames(justAt)).toBe(true);
  });
});

describe('findMoveNamesTable', () => {
  it('returns null on tiny buffer', () => {
    expect(findMoveNamesTable(new Uint8Array(64))).toBeNull();
  });

  it('returns null when no POUND signature is present', () => {
    const buf = new Uint8Array(8 * 1024);
    for (let i = 0; i < buf.length; i++) buf[i] = (i * 13 + 7) % 256;
    expect(findMoveNamesTable(buf)).toBeNull();
  });

  it('locates the planted table at the correct offset', () => {
    const buf = new Uint8Array(8 * 1024);
    plantMoveNamesTable(buf, 0x800, 60);
    const offset = findMoveNamesTable(buf);
    expect(offset).toBe(0x800);
  });

  it('rejects a POUND+KARATE CHOP pair without a valid dash-placeholder slot', () => {
    const buf = new Uint8Array(4 * 1024);
    const pound = encodeString('POUND');
    const karate = encodeString('KARATE CHOP');
    const offset = 0x800;
    buf.set(pound, offset + MOVE_NAME_SLOT_BYTES);
    buf.set(karate, offset + 2 * MOVE_NAME_SLOT_BYTES);
    // Fill placeholder slot with arbitrary non-placeholder bytes.
    for (let i = 0; i < MOVE_NAME_SLOT_BYTES; i++) buf[offset + i] = 0x42;
    expect(findMoveNamesTable(buf)).toBeNull();
  });

  it('rejects a POUND match without KARATE CHOP at the next slot', () => {
    const buf = new Uint8Array(4 * 1024);
    const pound = encodeString('POUND');
    const placeholder = new Uint8Array(MOVE_NAME_SLOT_BYTES);
    placeholder[0] = MOVE_PLACEHOLDER_BYTE;
    placeholder[1] = STRING_TERMINATOR;
    buf.set(placeholder, 0x800);
    buf.set(pound, 0x800 + MOVE_NAME_SLOT_BYTES);
    // No KARATE CHOP - leave next slot as zeros.
    expect(findMoveNamesTable(buf)).toBeNull();
  });
});
