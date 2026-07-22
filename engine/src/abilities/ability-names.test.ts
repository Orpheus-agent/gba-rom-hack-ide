import { describe, expect, it } from 'vitest';
import { encodeString, STRING_TERMINATOR } from '../text/codec.js';
import {
  ABILITY_NAME_SLOT_BYTES,
  ABILITY_NAMES_MIN_VALID_SLOTS,
  ABILITY_PLACEHOLDER_BYTE,
  findAbilityNamesTable,
  readAbilityNamesAt,
  validateAbilityNames,
} from './ability-names.js';

const VANILLA_ABILITY_NAMES = [
  '---', // 0 placeholder
  'STENCH',
  'DRIZZLE',
  'SPEED BOOST',
  'BATTLE ARMOR',
  'STURDY',
  'DAMP',
  'LIMBER',
  'SAND VEIL',
  'STATIC',
  'VOLT ABSORB',
  'WATER ABSORB',
  'OBLIVIOUS',
  'CLOUD NINE',
  'COMPOUNDEYES',
  'INSOMNIA',
  'COLOR CHANGE',
  'IMMUNITY',
  'FLASH FIRE',
  'SHIELD DUST',
  'OWN TEMPO',
];

/** Plant a vanilla-shaped gAbilityNames table at `offset` in `buf`. */
function plantAbilityNamesTable(buf: Uint8Array, offset: number, count: number): void {
  // Slot 0: placeholder "---" + terminator + padding zeros.
  const placeholder = new Uint8Array(ABILITY_NAME_SLOT_BYTES);
  placeholder[0] = ABILITY_PLACEHOLDER_BYTE;
  placeholder[1] = ABILITY_PLACEHOLDER_BYTE;
  placeholder[2] = ABILITY_PLACEHOLDER_BYTE;
  placeholder[3] = STRING_TERMINATOR;
  buf.set(placeholder, offset);

  for (let i = 1; i < count; i++) {
    const slotStart = offset + i * ABILITY_NAME_SLOT_BYTES;
    const name = VANILLA_ABILITY_NAMES[i] ?? `ABILITY${String(i).padStart(2, '0')}`;
    const encoded = encodeString(name);
    const slot = new Uint8Array(ABILITY_NAME_SLOT_BYTES);
    slot.set(encoded.subarray(0, Math.min(encoded.length, ABILITY_NAME_SLOT_BYTES - 1)), 0);
    // Always terminate at last byte if encoded fits exactly, or at the
    // position after the encoded content otherwise.
    const termPos = Math.min(encoded.length, ABILITY_NAME_SLOT_BYTES - 1);
    slot[termPos] = STRING_TERMINATOR;
    buf.set(slot, slotStart);
  }
}

describe('ABILITY_NAME_SLOT_BYTES', () => {
  it('is 13', () => {
    expect(ABILITY_NAME_SLOT_BYTES).toBe(13);
  });
});

describe('readAbilityNamesAt', () => {
  it('reads the planted vanilla names', () => {
    const buf = new Uint8Array(4 * 1024);
    plantAbilityNamesTable(buf, 0x200, 8);
    const names = readAbilityNamesAt(buf, 0x200, 8);
    expect(names.length).toBe(8);
    expect(names[0]).toBe('---');
    expect(names[1]).toBe('STENCH');
    expect(names[2]).toBe('DRIZZLE');
    expect(names[3]).toBe('SPEED BOOST');
    expect(names[4]).toBe('BATTLE ARMOR');
  });

  it('returns fewer entries when buffer runs out', () => {
    // Plant 4 slots (52 bytes) into a 60-byte buffer; request 10. Should
    // stop at slot 4 because slot 5's start (52) + 13 > 60.
    const buf = new Uint8Array(60);
    plantAbilityNamesTable(buf, 0, 4);
    const names = readAbilityNamesAt(buf, 0, 10);
    expect(names.length).toBeLessThanOrEqual(4);
  });

  it('caps reads at ABILITY_NAMES_READ_CAP', () => {
    const buf = new Uint8Array(64 * 1024);
    plantAbilityNamesTable(buf, 0, 50);
    const names = readAbilityNamesAt(buf, 0, 99999);
    expect(names.length).toBeLessThanOrEqual(1024);
  });
});

describe('validateAbilityNames', () => {
  it('accepts a vanilla-shaped 78-ability set', () => {
    const buf = new Uint8Array(2 * 1024);
    plantAbilityNamesTable(buf, 0, 78);
    const names = readAbilityNamesAt(buf, 0, 78);
    expect(validateAbilityNames(names)).toBe(true);
  });

  it('rejects too-few entries', () => {
    expect(validateAbilityNames(['STENCH', 'DRIZZLE'])).toBe(false);
  });

  it('rejects garbage entries', () => {
    const garbage = Array(50).fill('???');
    expect(validateAbilityNames(garbage)).toBe(false);
  });

  it('accepts multi-word ability names with space separator', () => {
    const buf = new Uint8Array(2 * 1024);
    plantAbilityNamesTable(buf, 0, 78);
    const names = readAbilityNamesAt(buf, 0, 78);
    // SPEED BOOST at idx 3 must pass per /[A-Z]+ [A-Z]+/ test
    expect(names[3]).toBe('SPEED BOOST');
    expect(validateAbilityNames(names)).toBe(true);
  });
});

describe('findAbilityNamesTable', () => {
  it('returns null on tiny buffer', () => {
    expect(findAbilityNamesTable(new Uint8Array(64))).toBeNull();
  });

  it('returns null when no STENCH signature is present', () => {
    const buf = new Uint8Array(8 * 1024);
    // Garbage fill - no canonical bytes.
    for (let i = 0; i < buf.length; i++) buf[i] = (i * 13 + 7) % 256;
    expect(findAbilityNamesTable(buf)).toBeNull();
  });

  it('locates the planted table at the correct offset', () => {
    const buf = new Uint8Array(4 * 1024);
    plantAbilityNamesTable(buf, 0x800, 78);
    const offset = findAbilityNamesTable(buf);
    expect(offset).toBe(0x800);
  });

  it('rejects a STENCH+DRIZZLE pair without a valid placeholder slot', () => {
    const buf = new Uint8Array(4 * 1024);
    // Plant STENCH+DRIZZLE at correct stride but no placeholder.
    const stench = encodeString('STENCH');
    const drizzle = encodeString('DRIZZLE');
    const offset = 0x800;
    buf.set(stench, offset + ABILITY_NAME_SLOT_BYTES);
    buf.set(drizzle, offset + 2 * ABILITY_NAME_SLOT_BYTES);
    // Fill placeholder slot with arbitrary non-placeholder bytes.
    for (let i = 0; i < ABILITY_NAME_SLOT_BYTES; i++) buf[offset + i] = 0x42;
    expect(findAbilityNamesTable(buf)).toBeNull();
  });

  it('rejects a STENCH match without DRIZZLE at the next slot', () => {
    const buf = new Uint8Array(4 * 1024);
    const stench = encodeString('STENCH');
    const placeholder = new Uint8Array(ABILITY_NAME_SLOT_BYTES);
    placeholder[0] = ABILITY_PLACEHOLDER_BYTE;
    placeholder[1] = ABILITY_PLACEHOLDER_BYTE;
    placeholder[2] = ABILITY_PLACEHOLDER_BYTE;
    placeholder[3] = STRING_TERMINATOR;
    buf.set(placeholder, 0x800);
    buf.set(stench, 0x800 + ABILITY_NAME_SLOT_BYTES);
    // No DRIZZLE - leave next slot as zeros.
    expect(findAbilityNamesTable(buf)).toBeNull();
  });
});
