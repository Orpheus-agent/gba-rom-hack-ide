import { describe, expect, it } from 'vitest';
import { encodeString, STRING_TERMINATOR } from '../text/codec.js';
import {
  TRAINER_CLASS_NAME_SLOT_BYTES,
  TRAINER_CLASS_NAMES_ANCHOR_CONFIRMATION,
  TRAINER_CLASS_NAMES_MIN_VALID_SLOTS,
  findTrainerClassNamesTable,
  readTrainerClassNamesAt,
  validateTrainerClassNames,
} from './trainer-class-names.js';

// Vanilla FRLG trainer-class names sample (first ~20). ASCII-safe
// transcriptions of the canonical class list.
const VANILLA_FRLG_CLASSES = [
  'YOUNGSTER',
  'BUG CATCHER',
  'HIKER',
  'CAMPER',
  'PICNICKER',
  'ENGINEER',
  'TAMER',
  'FISHERMAN',
  'CYCLIST',
  'CYCLIST',
  'GENTLEMAN',
  'TEACHER',
  'PSYCHIC',
  'BIRD KEEPER',
  'CHANNELER',
  'BLACK BELT',
  'JUGGLER',
  'TUBER',
  'BOSS',
  'SAGE',
  'GAMBLER',
  'BURGLAR',
  'SUPER NERD',
  'SCIENTIST',
  'SAILOR',
  'ROCKER',
  'TRIATHLETE',
  'PAINTER',
  'BIKER',
  'BEAUTY',
];

function plantClassNamesTable(buf: Uint8Array, offset: number, count: number): void {
  for (let i = 0; i < count; i++) {
    const slotStart = offset + i * TRAINER_CLASS_NAME_SLOT_BYTES;
    const name = VANILLA_FRLG_CLASSES[i] ?? `CLASS${String(i).padStart(2, '0')}`;
    const encoded = encodeString(name);
    const slot = new Uint8Array(TRAINER_CLASS_NAME_SLOT_BYTES);
    slot.set(
      encoded.subarray(0, Math.min(encoded.length, TRAINER_CLASS_NAME_SLOT_BYTES - 1)),
      0,
    );
    const termPos = Math.min(encoded.length, TRAINER_CLASS_NAME_SLOT_BYTES - 1);
    slot[termPos] = STRING_TERMINATOR;
    buf.set(slot, slotStart);
  }
}

function fillNonClassBytes(buf: Uint8Array, fromOffset: number): void {
  // Bytes outside Gen-3 uppercase/space/terminator range to ensure
  // validator rejects everything outside the planted region.
  for (let i = fromOffset; i < buf.length; i++) {
    buf[i] = 100 + ((i * 13) % 50); // 100..149 - all outside the codec's uppercase letter range
  }
}

describe('TRAINER_CLASS_NAME_SLOT_BYTES', () => {
  it('is 13', () => {
    expect(TRAINER_CLASS_NAME_SLOT_BYTES).toBe(13);
  });
});

describe('TRAINER_CLASS_NAMES_ANCHOR_CONFIRMATION', () => {
  it('is at least 10 (anchor confirmation count)', () => {
    expect(TRAINER_CLASS_NAMES_ANCHOR_CONFIRMATION).toBeGreaterThanOrEqual(10);
  });
});

describe('readTrainerClassNamesAt', () => {
  it('reads planted class names', () => {
    const buf = new Uint8Array(2 * 1024);
    plantClassNamesTable(buf, 0x100, 10);
    const names = readTrainerClassNamesAt(buf, 0x100, 10);
    expect(names[0]).toBe('YOUNGSTER');
    expect(names[1]).toBe('BUG CATCHER');
    expect(names[2]).toBe('HIKER');
  });
});

describe('validateTrainerClassNames', () => {
  it('accepts a vanilla-shaped 30-class table', () => {
    const buf = new Uint8Array(2 * 1024);
    plantClassNamesTable(buf, 0, 30);
    const names = readTrainerClassNamesAt(buf, 0, 30);
    expect(validateTrainerClassNames(names)).toBe(true);
  });

  it('rejects too-few entries', () => {
    expect(validateTrainerClassNames(['HIKER', 'YOUNGSTER', 'BUG CATCHER'])).toBe(false);
  });

  it('rejects garbage entries', () => {
    const garbage = Array(40).fill('???');
    expect(validateTrainerClassNames(garbage)).toBe(false);
  });
});

describe('findTrainerClassNamesTable', () => {
  it('returns null on tiny buffer', () => {
    expect(findTrainerClassNamesTable(new Uint8Array(100))).toBeNull();
  });

  it('returns null on garbage-only ROM', () => {
    const buf = new Uint8Array(4 * 1024);
    fillNonClassBytes(buf, 0);
    expect(findTrainerClassNamesTable(buf)).toBeNull();
  });

  it('locates the planted table at the correct offset', () => {
    const buf = new Uint8Array(4 * 1024);
    fillNonClassBytes(buf, 0);
    plantClassNamesTable(buf, 0x200, 40);
    expect(findTrainerClassNamesTable(buf)).toBe(0x200);
  });

  it('rejects runs below the min-valid-slots floor', () => {
    const buf = new Uint8Array(4 * 1024);
    fillNonClassBytes(buf, 0);
    // Plant ANCHOR_CONFIRMATION + a few more = 12 slots; below
    // MIN_VALID_SLOTS = 30 - should return null even though anchor
    // confirms.
    plantClassNamesTable(buf, 0x200, 12);
    expect(findTrainerClassNamesTable(buf)).toBeNull();
  });

  it('uses TRAINER_CLASS_NAMES_MIN_VALID_SLOTS as threshold', () => {
    expect(TRAINER_CLASS_NAMES_MIN_VALID_SLOTS).toBeGreaterThanOrEqual(20);
  });

  it('skips planted tables fully inside cartridge header (0..0xBF)', () => {
    // Only ~9 slots fit fully in the 0..0xBF header (9 * 13 = 117 ≤
    // 0xBF=191). Scanner doesn't anchor before 0xC0; returns null.
    const buf = new Uint8Array(4 * 1024);
    fillNonClassBytes(buf, 0);
    plantClassNamesTable(buf, 0x10, 9);
    expect(findTrainerClassNamesTable(buf)).toBeNull();
  });
});
