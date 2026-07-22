import { describe, expect, it } from 'vitest';
import { GBA_ROM_BASE_ADDRESS } from '../pointers/index.js';
import {
  WILD_POKEMON_INFO_STRUCT_SIZE_BYTES,
  WILD_POKEMON_LEVEL_MAX,
  WILD_POKEMON_SLOT_SIZE_BYTES,
  WILD_POKEMON_SPECIES_MAX,
  parseWildPokemon,
  parseWildPokemonInfo,
} from './wild-info.js';

function makeBuf(size = 0x2000): Buffer {
  return Buffer.alloc(size);
}

/** Plant N WildPokemon slots at `slotsAt`. Each slot has minLevel=2+i,
 *  maxLevel=4+i, species = baseSpecies + i. */
function plantSlots(buf: Buffer, slotsAt: number, n: number, baseSpecies = 1): void {
  for (let i = 0; i < n; i++) {
    const at = slotsAt + i * WILD_POKEMON_SLOT_SIZE_BYTES;
    buf[at + 0x00] = 2 + i;
    buf[at + 0x01] = 4 + i;
    buf.writeUInt16LE(baseSpecies + i, at + 0x02);
  }
}

/** Plant a WildPokemonInfo at `infoAt` with `slotsAt` (raw file offset)
 *  pointer + encounterRate=25. */
function plantInfo(buf: Buffer, infoAt: number, slotsAt: number, rate = 25): void {
  buf[infoAt + 0x00] = rate;
  buf[infoAt + 0x01] = 0;
  buf[infoAt + 0x02] = 0;
  buf[infoAt + 0x03] = 0;
  buf.writeUInt32LE((GBA_ROM_BASE_ADDRESS + slotsAt) >>> 0, infoAt + 0x04);
}

describe('parseWildPokemon - happy paths', () => {
  it('parses a valid slot (minLevel=5, maxLevel=10, species=25)', () => {
    const buf = makeBuf();
    const at = 0x100;
    buf[at + 0x00] = 5;
    buf[at + 0x01] = 10;
    buf.writeUInt16LE(25, at + 0x02);
    const r = parseWildPokemon(buf, at);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.slot.minLevel).toBe(5);
      expect(r.slot.maxLevel).toBe(10);
      expect(r.slot.species).toBe(25);
      expect(r.slot.fileOffset).toBe(at);
    }
  });

  it('accepts minLevel == maxLevel', () => {
    const buf = makeBuf();
    buf[0x100 + 0x00] = 50;
    buf[0x100 + 0x01] = 50;
    buf.writeUInt16LE(1, 0x100 + 0x02);
    expect(parseWildPokemon(buf, 0x100).ok).toBe(true);
  });

  it('result slot is frozen', () => {
    const buf = makeBuf();
    buf[0x100 + 0x00] = 5;
    buf[0x100 + 0x01] = 5;
    buf.writeUInt16LE(1, 0x100 + 0x02);
    const r = parseWildPokemon(buf, 0x100);
    if (r.ok) expect(Object.isFrozen(r.slot)).toBe(true);
  });
});

describe('parseWildPokemon - failure modes', () => {
  it('fails too_short when buffer < 4 bytes', () => {
    const r = parseWildPokemon(new Uint8Array(2), 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('too_short');
  });

  it('fails invalid_level when minLevel == 0', () => {
    const buf = makeBuf();
    buf[0x100 + 0x01] = 5;
    buf.writeUInt16LE(1, 0x100 + 0x02);
    const r = parseWildPokemon(buf, 0x100);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('invalid_level');
  });

  it('fails invalid_level when minLevel > 100', () => {
    const buf = makeBuf();
    buf[0x100 + 0x00] = 101;
    buf[0x100 + 0x01] = 110;
    buf.writeUInt16LE(1, 0x100 + 0x02);
    const r = parseWildPokemon(buf, 0x100);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('invalid_level');
  });

  it('fails inverted_level_range when maxLevel < minLevel', () => {
    const buf = makeBuf();
    buf[0x100 + 0x00] = 50;
    buf[0x100 + 0x01] = 10;
    buf.writeUInt16LE(1, 0x100 + 0x02);
    const r = parseWildPokemon(buf, 0x100);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('inverted_level_range');
  });

  it('fails zero_species', () => {
    const buf = makeBuf();
    buf[0x100 + 0x00] = 5;
    buf[0x100 + 0x01] = 5;
    buf.writeUInt16LE(0, 0x100 + 0x02);
    const r = parseWildPokemon(buf, 0x100);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('zero_species');
  });

  it('fails invalid_species when species > MAX', () => {
    const buf = makeBuf();
    buf[0x100 + 0x00] = 5;
    buf[0x100 + 0x01] = 5;
    buf.writeUInt16LE(WILD_POKEMON_SPECIES_MAX + 1, 0x100 + 0x02);
    const r = parseWildPokemon(buf, 0x100);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('invalid_species');
  });

  it('honors caller-supplied speciesMax override', () => {
    const buf = makeBuf();
    buf[0x100 + 0x00] = 5;
    buf[0x100 + 0x01] = 5;
    buf.writeUInt16LE(500, 0x100 + 0x02);
    const r = parseWildPokemon(buf, 0x100, { speciesMax: 100 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('invalid_species');
  });
});

describe('parseWildPokemonInfo - happy paths', () => {
  it('parses 12 land slots with cycling species', () => {
    const buf = makeBuf();
    const infoAt = 0x100;
    const slotsAt = 0x200;
    plantSlots(buf, slotsAt, 12, 10);
    plantInfo(buf, infoAt, slotsAt);
    const r = parseWildPokemonInfo(buf, infoAt, { slotCount: 12 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.info.encounterRate).toBe(25);
      expect(r.info.slotCount).toBe(12);
      expect(r.info.slots[0]?.species).toBe(10);
      expect(r.info.slots[11]?.species).toBe(21);
      expect(r.info.slotsOffset).toBe(slotsAt);
      expect(r.info.fileOffset).toBe(infoAt);
    }
  });

  it('parses fewer slots than requested when run terminates early', () => {
    const buf = makeBuf();
    const infoAt = 0x100;
    const slotsAt = 0x200;
    plantSlots(buf, slotsAt, 5, 10);
    // Slot 5 has invalid species (0) - walker stops at 5
    plantInfo(buf, infoAt, slotsAt);
    const r = parseWildPokemonInfo(buf, infoAt, { slotCount: 12 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.info.slotCount).toBe(5);
  });

  it('handles NULL slots pointer (returns empty slots array)', () => {
    const buf = makeBuf();
    const infoAt = 0x100;
    buf[infoAt + 0x00] = 10; // encounterRate
    // slotsPtr = 0 (NULL)
    const r = parseWildPokemonInfo(buf, infoAt, { slotCount: 12 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.info.slotsOffset).toBeNull();
      expect(r.info.slotCount).toBe(0);
      expect(r.info.slots).toEqual([]);
    }
  });

  it('result info + slots are frozen', () => {
    const buf = makeBuf();
    plantSlots(buf, 0x200, 5, 1);
    plantInfo(buf, 0x100, 0x200);
    const r = parseWildPokemonInfo(buf, 0x100, { slotCount: 5 });
    if (r.ok) {
      expect(Object.isFrozen(r.info)).toBe(true);
      expect(Object.isFrozen(r.info.slots)).toBe(true);
    }
  });
});

describe('parseWildPokemonInfo - failure modes', () => {
  it('fails too_short when buffer < 8 bytes from offset', () => {
    const r = parseWildPokemonInfo(new Uint8Array(4), 0, { slotCount: 12 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('too_short');
  });

  it('fails nonzero_padding when pad1 != 0', () => {
    const buf = makeBuf();
    buf[0x100 + 0x00] = 25;
    buf[0x100 + 0x01] = 0xff; // pad1 corrupt
    const r = parseWildPokemonInfo(buf, 0x100, { slotCount: 12 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('nonzero_padding');
  });

  it('fails nonzero_padding when pad3 != 0', () => {
    const buf = makeBuf();
    buf[0x100 + 0x00] = 25;
    buf[0x100 + 0x03] = 0x42;
    const r = parseWildPokemonInfo(buf, 0x100, { slotCount: 12 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('nonzero_padding');
  });

  it('fails implausible_encounter_rate when rate > MAX', () => {
    const buf = makeBuf();
    buf[0x100 + 0x00] = 0xff; // rate = 255 > 200
    const r = parseWildPokemonInfo(buf, 0x100, { slotCount: 12 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('implausible_encounter_rate');
  });

  it('fails invalid_slots_pointer when ptr is outside ROM space', () => {
    const buf = makeBuf();
    buf[0x100 + 0x00] = 25;
    // slotsPtr → IWRAM (not ROM)
    buf.writeUInt32LE(0x03000123, 0x100 + 0x04);
    const r = parseWildPokemonInfo(buf, 0x100, { slotCount: 12 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('invalid_slots_pointer');
  });

  it('fails invalid_slots_pointer when resolved offset exceeds buffer length', () => {
    const buf = makeBuf(0x200);
    buf[0x100 + 0x00] = 25;
    buf.writeUInt32LE((GBA_ROM_BASE_ADDRESS + 0x500000) >>> 0, 0x100 + 0x04); // way past buffer
    const r = parseWildPokemonInfo(buf, 0x100, { slotCount: 12 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('invalid_slots_pointer');
  });

  it('throws on invalid slotCount=0', () => {
    expect(() =>
      parseWildPokemonInfo(makeBuf(), 0x100, { slotCount: 0 }),
    ).toThrow();
  });
});

describe('constants', () => {
  it('struct size = 8, slot size = 4', () => {
    expect(WILD_POKEMON_INFO_STRUCT_SIZE_BYTES).toBe(8);
    expect(WILD_POKEMON_SLOT_SIZE_BYTES).toBe(4);
  });
  it('level max = 100, species max = 2048', () => {
    expect(WILD_POKEMON_LEVEL_MAX).toBe(100);
    expect(WILD_POKEMON_SPECIES_MAX).toBe(2048);
  });
});
