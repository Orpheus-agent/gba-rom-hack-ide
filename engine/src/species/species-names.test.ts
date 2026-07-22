import { describe, expect, it } from 'vitest';
import { encodeString, STRING_TERMINATOR } from '../text/codec.js';
import {
  SPECIES_NAME_SLOT_BYTES,
  SPECIES_NAMES_MIN_VALID_SLOTS,
  SPECIES_NAMES_POINTER_FILE_OFFSET,
  SPECIES_PLACEHOLDER_BYTE,
  classifySpeciesNameSlot,
  findSpeciesNamesTable,
  findSpeciesNamesTableViaPointer,
  measureSpeciesNamesTable,
  readSpeciesNamesAt,
  validateSpeciesNames,
} from './species-names.js';

/** Build a single 11-byte name slot containing the encoded `name`,
 *  padded with 0xFF terminator. */
function buildSlot(name: string): Uint8Array {
  const slot = new Uint8Array(SPECIES_NAME_SLOT_BYTES).fill(STRING_TERMINATOR);
  const enc = encodeString(name);
  for (let i = 0; i < Math.min(enc.length, SPECIES_NAME_SLOT_BYTES); i++) {
    slot[i] = enc[i]!;
  }
  return slot;
}

/** Build the placeholder slot: 10 of 0xAC + 0xFF terminator. */
function buildPlaceholderSlot(): Uint8Array {
  const slot = new Uint8Array(SPECIES_NAME_SLOT_BYTES).fill(SPECIES_PLACEHOLDER_BYTE);
  slot[SPECIES_NAME_SLOT_BYTES - 1] = STRING_TERMINATOR;
  return slot;
}

/** Build a fake species-names table containing the given names at
 *  slots 1..N. Slot 0 is the standard placeholder. */
function buildTable(names: string[]): Uint8Array {
  const totalSlots = names.length + 1;
  const out = new Uint8Array(totalSlots * SPECIES_NAME_SLOT_BYTES).fill(STRING_TERMINATOR);
  const placeholder = buildPlaceholderSlot();
  out.set(placeholder, 0);
  for (let i = 0; i < names.length; i++) {
    out.set(buildSlot(names[i]!), (i + 1) * SPECIES_NAME_SLOT_BYTES);
  }
  return out;
}

describe('readSpeciesNamesAt', () => {
  it('reads N slots and decodes them', () => {
    const tbl = buildTable(['BULBASAUR', 'IVYSAUR', 'VENUSAUR']);
    const names = readSpeciesNamesAt(tbl, 0, 4);
    expect(names.length).toBe(4);
    expect(names[1]).toBe('BULBASAUR');
    expect(names[2]).toBe('IVYSAUR');
    expect(names[3]).toBe('VENUSAUR');
  });

  it('stops reading if a slot extends past buffer end', () => {
    const tbl = buildTable(['BULBASAUR', 'IVYSAUR']);
    // Ask for 10 slots but only 3 exist.
    const names = readSpeciesNamesAt(tbl, 0, 10);
    expect(names.length).toBe(3);
  });

  it('caps reads at SPECIES_NAMES_READ_CAP', () => {
    const tbl = new Uint8Array(5000 * SPECIES_NAME_SLOT_BYTES); // huge zero-filled buffer
    const names = readSpeciesNamesAt(tbl, 0, 100_000);
    expect(names.length).toBeLessThanOrEqual(4096); // SPECIES_NAMES_READ_CAP
  });
});

describe('validateSpeciesNames', () => {
  it('accepts a vanilla-shaped table (placeholder + 60 real names)', () => {
    const realNames = Array.from({ length: 60 }, (_, i) => `MON${String(i).padStart(3, '0')}`);
    const tbl = buildTable(realNames);
    const decoded = readSpeciesNamesAt(tbl, 0, realNames.length + 1);
    expect(validateSpeciesNames(decoded)).toBe(true);
  });

  it('rejects if too few entries', () => {
    expect(validateSpeciesNames(Array(SPECIES_NAMES_MIN_VALID_SLOTS - 1).fill('FOO'))).toBe(false);
  });

  it('rejects if most entries are unrecognizable garbage', () => {
    const garbage = ['?????????', '??????', '?????', '????', ''];
    const padded = Array.from({ length: 60 }, (_, i) => garbage[i % garbage.length]!);
    expect(validateSpeciesNames(padded)).toBe(false);
  });

  it('rejects names with consecutive ?? (misaligned read indicator)', () => {
    const realNames = Array.from({ length: 60 }, () => 'AA??BB');
    expect(validateSpeciesNames([''].concat(realNames))).toBe(false);
  });
});

describe('findSpeciesNamesTable - signature scan', () => {
  it('finds a planted table in a synthetic ROM', () => {
    const rom = new Uint8Array(1024 * 1024);
    const tbl = buildTable(['BULBASAUR', 'IVYSAUR', 'VENUSAUR', 'CHARMANDER']);
    rom.set(tbl, 0x10000);
    const offset = findSpeciesNamesTable(rom);
    expect(offset).toBe(0x10000);
  });

  it('returns null when no Bulbasaur signature is present', () => {
    const rom = new Uint8Array(64 * 1024);
    // Random noise, no Bulbasaur bytes.
    for (let i = 0; i < rom.length; i++) rom[i] = (i * 7) % 256;
    const offset = findSpeciesNamesTable(rom);
    expect(offset).toBeNull();
  });

  it('rejects an isolated BULBASAUR occurrence not at the right stride', () => {
    const rom = new Uint8Array(64 * 1024);
    // Plant BULBASAUR bytes but NOT followed by IVYSAUR at the +22 stride.
    const bulb = encodeString('BULBASAUR');
    rom.set(bulb, 0x2000);
    const offset = findSpeciesNamesTable(rom);
    expect(offset).toBeNull();
  });

  it('rejects when placeholder slot is missing (no terminator + chars)', () => {
    const rom = new Uint8Array(64 * 1024);
    // Plant BULBASAUR at +11 and IVYSAUR at +22, but DON'T plant the
    // placeholder at offset 0 - fill with zeros, which decodeByte
    // renders as space (0x00 → ' '), then the placeholder validator
    // won't see any 0xAC chars and rejects.
    const bulb = encodeString('BULBASAUR');
    const ivy = encodeString('IVYSAUR');
    const base = 0x3000;
    rom.set(bulb, base + SPECIES_NAME_SLOT_BYTES);
    rom.set(ivy, base + 2 * SPECIES_NAME_SLOT_BYTES);
    const offset = findSpeciesNamesTable(rom);
    expect(offset).toBeNull();
  });

  it('finds a planted table when BULBASAUR appears elsewhere first (skips false positives)', () => {
    const rom = new Uint8Array(2 * 1024 * 1024);
    // Plant a "fake" BULBASAUR bytes pattern WITHOUT the IVYSAUR at +22
    // earlier in the ROM. Validator should skip and find the real one later.
    const fakeBulb = encodeString('BULBASAUR');
    rom.set(fakeBulb, 0x5000);
    // Now plant the REAL table at 0x100000.
    const tbl = buildTable(['BULBASAUR', 'IVYSAUR', 'VENUSAUR']);
    rom.set(tbl, 0x100000);
    const offset = findSpeciesNamesTable(rom);
    expect(offset).toBe(0x100000);
  });

  it('finds a CFRU-style mixed-case "Bulbasaur"/"Ivysaur" table via signature scan', () => {
    // CFRU's extended species names table uses mixed-case names. When the
    // pointer at 0x144 has been damaged / is not present (e.g. a custom
    // build that doesn't write the pointer), the byte-pattern fallback
    // still recognizes the table.
    const rom = new Uint8Array(2 * 1024 * 1024);
    const tbl = buildTable(['Bulbasaur', 'Ivysaur', 'Venusaur', 'Charmander']);
    rom.set(tbl, 0x40000);
    const offset = findSpeciesNamesTable(rom);
    expect(offset).toBe(0x40000);
  });
});

describe('findSpeciesNamesTableViaPointer - canonical 0x144 dereference', () => {
  it('resolves the pointer at 0x144 to the species names table (vanilla layout)', () => {
    // Plant a 4 MiB ROM with a placeholder + Bulbasaur+Ivysaur table at
    // 0x245EE0 (vanilla FRLG's species names location) and a 32-bit LE
    // GBA pointer at file offset 0x144 (= GBA address 0x8000144).
    const rom = new Uint8Array(4 * 1024 * 1024);
    const tableFileOff = 0x245ee0;
    const tbl = buildTable(['BULBASAUR', 'IVYSAUR', 'VENUSAUR']);
    rom.set(tbl, tableFileOff);
    // GBA pointer = 0x08000000 | tableFileOff
    const gbaPtr = 0x08000000 | tableFileOff;
    rom[SPECIES_NAMES_POINTER_FILE_OFFSET] = gbaPtr & 0xff;
    rom[SPECIES_NAMES_POINTER_FILE_OFFSET + 1] = (gbaPtr >> 8) & 0xff;
    rom[SPECIES_NAMES_POINTER_FILE_OFFSET + 2] = (gbaPtr >> 16) & 0xff;
    rom[SPECIES_NAMES_POINTER_FILE_OFFSET + 3] = (gbaPtr >> 24) & 0xff;
    expect(findSpeciesNamesTableViaPointer(rom)).toBe(tableFileOff);
    expect(findSpeciesNamesTable(rom)).toBe(tableFileOff);
  });

  it('resolves a CFRU-style relocated mixed-case table at a non-vanilla offset', () => {
    // CFRU writes a pointer at 0x144 that targets its extended
    // (mixed-case "Bulbasaur") table at a relocated offset - e.g.
    // Radical Red 4.10 puts it at 0x14042CC. Synthesize the same shape:
    // a 32 MiB ROM with a mixed-case table at 0x1404000 and the
    // matching pointer at 0x144.
    const rom = new Uint8Array(32 * 1024 * 1024);
    const tableFileOff = 0x1404000;
    const tbl = buildTable(['Bulbasaur', 'Ivysaur', 'Venusaur']);
    rom.set(tbl, tableFileOff);
    const gbaPtr = (0x08000000 | tableFileOff) >>> 0;
    rom[SPECIES_NAMES_POINTER_FILE_OFFSET] = gbaPtr & 0xff;
    rom[SPECIES_NAMES_POINTER_FILE_OFFSET + 1] = (gbaPtr >> 8) & 0xff;
    rom[SPECIES_NAMES_POINTER_FILE_OFFSET + 2] = (gbaPtr >> 16) & 0xff;
    rom[SPECIES_NAMES_POINTER_FILE_OFFSET + 3] = (gbaPtr >> 24) & 0xff;
    expect(findSpeciesNamesTableViaPointer(rom)).toBe(tableFileOff);
    // The dispatcher prefers the pointer over signature scan.
    expect(findSpeciesNamesTable(rom)).toBe(tableFileOff);
  });

  it('returns null when the pointer at 0x144 is not a ROM-space address', () => {
    const rom = new Uint8Array(4 * 1024 * 1024);
    // Plant a non-ROM-space pointer (RAM = 0x02000000) at 0x144.
    rom[SPECIES_NAMES_POINTER_FILE_OFFSET] = 0x00;
    rom[SPECIES_NAMES_POINTER_FILE_OFFSET + 1] = 0x00;
    rom[SPECIES_NAMES_POINTER_FILE_OFFSET + 2] = 0x00;
    rom[SPECIES_NAMES_POINTER_FILE_OFFSET + 3] = 0x02; // 0x02000000 → RAM
    expect(findSpeciesNamesTableViaPointer(rom)).toBeNull();
  });

  it('returns null when the pointer dereferences to non-table bytes', () => {
    const rom = new Uint8Array(4 * 1024 * 1024);
    // Plant a ROM-space pointer at 0x144 → 0x100000, but at 0x100000
    // there is NO species names table (just zeros).
    rom[SPECIES_NAMES_POINTER_FILE_OFFSET] = 0x00;
    rom[SPECIES_NAMES_POINTER_FILE_OFFSET + 1] = 0x00;
    rom[SPECIES_NAMES_POINTER_FILE_OFFSET + 2] = 0x10;
    rom[SPECIES_NAMES_POINTER_FILE_OFFSET + 3] = 0x08; // 0x08100000
    expect(findSpeciesNamesTableViaPointer(rom)).toBeNull();
  });

  it('findSpeciesNamesTable falls back to signature scan when 0x144 is junk', () => {
    // Pointer at 0x144 is garbage; the canonical signature still locates
    // the planted table.
    const rom = new Uint8Array(2 * 1024 * 1024);
    rom[SPECIES_NAMES_POINTER_FILE_OFFSET] = 0xff;
    rom[SPECIES_NAMES_POINTER_FILE_OFFSET + 1] = 0xff;
    rom[SPECIES_NAMES_POINTER_FILE_OFFSET + 2] = 0xff;
    rom[SPECIES_NAMES_POINTER_FILE_OFFSET + 3] = 0xff;
    const tbl = buildTable(['BULBASAUR', 'IVYSAUR', 'VENUSAUR']);
    rom.set(tbl, 0x100000);
    expect(findSpeciesNamesTable(rom)).toBe(0x100000);
  });
});

describe('classifySpeciesNameSlot - byte-level slot validator', () => {
  it('accepts an uppercase species name slot (vanilla style)', () => {
    const rom = new Uint8Array(64);
    rom.set(buildSlot('BULBASAUR'), 0);
    expect(classifySpeciesNameSlot(rom, 0)).toBe('name');
  });

  it('accepts a mixed-case species name slot (CFRU style)', () => {
    const rom = new Uint8Array(64);
    rom.set(buildSlot('Bulbasaur'), 0);
    expect(classifySpeciesNameSlot(rom, 0)).toBe('name');
  });

  it('accepts a placeholder slot (??????????)', () => {
    const rom = new Uint8Array(64);
    rom.set(buildPlaceholderSlot(), 0);
    expect(classifySpeciesNameSlot(rom, 0)).toBe('placeholder');
  });

  it('accepts a short placeholder slot (single "?")', () => {
    // CFRU's mid-table placeholder rows are sometimes a single 0xAC
    // followed by 0xFF terminator and padding - not the full 10-char
    // "??????????" shape.
    const rom = new Uint8Array(64).fill(STRING_TERMINATOR);
    rom[0] = SPECIES_PLACEHOLDER_BYTE;
    rom[1] = STRING_TERMINATOR;
    expect(classifySpeciesNameSlot(rom, 0)).toBe('placeholder');
  });

  it('rejects a slot starting with whitespace (misaligned read)', () => {
    const rom = new Uint8Array(64);
    // 0x00 = space; not a legal start byte for a species name.
    rom[0] = 0x00;
    rom[1] = encodeString('A')[0]!;
    rom[2] = STRING_TERMINATOR;
    expect(classifySpeciesNameSlot(rom, 0)).toBe('garbage');
  });

  it('rejects a slot with no terminator', () => {
    const rom = new Uint8Array(64);
    // 11 letters in a row with no 0xFF terminator → too long.
    for (let i = 0; i < SPECIES_NAME_SLOT_BYTES; i++) {
      rom[i] = encodeString('A')[0]!;
    }
    expect(classifySpeciesNameSlot(rom, 0)).toBe('garbage');
  });

  it('rejects a 1-letter slot (too short)', () => {
    const rom = new Uint8Array(64);
    rom[0] = encodeString('A')[0]!;
    rom[1] = STRING_TERMINATOR;
    expect(classifySpeciesNameSlot(rom, 0)).toBe('garbage');
  });

  it("accepts Farfetch'd-style name with the smart-quote apostrophe", () => {
    const rom = new Uint8Array(64);
    // FARFETCH then 0xb4 (’) then D then 0xff
    const farfetchd = encodeString('FARFETCH');
    rom.set(farfetchd, 0);
    rom[farfetchd.length] = 0xb4;
    rom[farfetchd.length + 1] = encodeString('D')[0]!;
    rom[farfetchd.length + 2] = STRING_TERMINATOR;
    expect(classifySpeciesNameSlot(rom, 0)).toBe('name');
  });

  it('accepts Nidoran♀ with the female-symbol byte 0xB6', () => {
    const rom = new Uint8Array(64);
    const nido = encodeString('NIDORAN');
    rom.set(nido, 0);
    rom[nido.length] = 0xb6; // ♀
    rom[nido.length + 1] = STRING_TERMINATOR;
    expect(classifySpeciesNameSlot(rom, 0)).toBe('name');
  });

  it('returns eof when the slot extends past the buffer', () => {
    const rom = new Uint8Array(5);
    expect(classifySpeciesNameSlot(rom, 0)).toBe('eof');
  });
});

describe('measureSpeciesNamesTable - table-length walker', () => {
  it('returns the correct slot count for a vanilla-shaped table', () => {
    // Placeholder + 30 real names = 31 slots.
    const realNames = Array.from({ length: 30 }, (_, i) => `MON${String(i).padStart(3, '0')}`);
    const tbl = buildTable(realNames);
    const rom = new Uint8Array(tbl.length + 64).fill(0xff);
    rom.set(tbl, 0);
    const shape = measureSpeciesNamesTable(rom, 0);
    expect(shape.totalSlotCount).toBe(31);
    expect(shape.nameSlotCount).toBe(30);
    expect(shape.placeholderSlotCount).toBe(1);
  });

  it('counts embedded placeholders correctly (FRLG Hoenn-gap shape)', () => {
    // [placeholder, BULBASAUR, IVYSAUR, ??, ??, ??, VENUSAUR, CHARMANDER]
    const slots: Uint8Array[] = [];
    slots.push(buildPlaceholderSlot());
    slots.push(buildSlot('BULBASAUR'));
    slots.push(buildSlot('IVYSAUR'));
    // Three single-`?` placeholders
    for (let i = 0; i < 3; i++) {
      const s = new Uint8Array(SPECIES_NAME_SLOT_BYTES).fill(STRING_TERMINATOR);
      s[0] = SPECIES_PLACEHOLDER_BYTE;
      s[1] = STRING_TERMINATOR;
      slots.push(s);
    }
    slots.push(buildSlot('VENUSAUR'));
    slots.push(buildSlot('CHARMANDER'));
    const tbl = new Uint8Array(slots.length * SPECIES_NAME_SLOT_BYTES);
    for (let i = 0; i < slots.length; i++) tbl.set(slots[i]!, i * SPECIES_NAME_SLOT_BYTES);
    const rom = new Uint8Array(tbl.length + 64).fill(0x00);
    rom.set(tbl, 0);
    const shape = measureSpeciesNamesTable(rom, 0);
    expect(shape.totalSlotCount).toBe(8);
    expect(shape.nameSlotCount).toBe(4);
    expect(shape.placeholderSlotCount).toBe(4); // slot 0 + 3 embedded
  });

  it('stops at the table end and ignores trailing garbage', () => {
    const realNames = Array.from({ length: 25 }, (_, i) => `MON${String(i).padStart(3, '0')}`);
    const tbl = buildTable(realNames);
    const rom = new Uint8Array(tbl.length + 1024);
    rom.set(tbl, 0);
    // Plant non-name-shaped bytes after the table (decoding produces
    // letter-rich strings but the byte validator rejects them).
    for (let i = tbl.length; i < rom.length; i += 11) {
      rom[i] = 0x00; // space - not a legal first byte for a name
      rom[i + 1] = encodeString('X')[0]!;
      rom[i + 2] = encodeString('Y')[0]!;
      rom[i + 3] = STRING_TERMINATOR;
    }
    const shape = measureSpeciesNamesTable(rom, 0);
    expect(shape.totalSlotCount).toBe(26); // 1 placeholder + 25 names
  });
});
