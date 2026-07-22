import { describe, expect, it } from 'vitest';
import {
  BASE_STATS_ABILITY_MAX,
  BASE_STATS_EGG_GROUP_MAX,
  BASE_STATS_GROWTH_RATE_MAX,
  BASE_STATS_STRUCT_SIZE_BYTES,
  BASE_STATS_TYPE_MAX,
  parseBaseStats,
} from './base-stats.js';

interface PlantArgs {
  bufferSize?: number;
  offset?: number;
  baseHP?: number;
  baseAttack?: number;
  baseDefense?: number;
  baseSpeed?: number;
  baseSpAttack?: number;
  baseSpDefense?: number;
  type1?: number;
  type2?: number;
  catchRate?: number;
  expYield?: number;
  evYield0?: number;
  evYield1?: number; // upper 4 bits = padding_A (must be 0)
  item1?: number;
  item2?: number;
  genderRatio?: number;
  eggCycles?: number;
  friendship?: number;
  growthRate?: number;
  eggGroup1?: number;
  eggGroup2?: number;
  ability1?: number;
  ability2?: number;
  safariZoneFleeRate?: number;
  bodyColorAndNoFlip?: number;
  paddingB0?: number;
  paddingB1?: number;
}

function plant(args: PlantArgs): { buf: Buffer; offset: number } {
  const offset = args.offset ?? 0x100;
  const buf = Buffer.alloc(args.bufferSize ?? 0x1000);
  buf[offset + 0x00] = args.baseHP ?? 45;
  buf[offset + 0x01] = args.baseAttack ?? 49;
  buf[offset + 0x02] = args.baseDefense ?? 49;
  buf[offset + 0x03] = args.baseSpeed ?? 45;
  buf[offset + 0x04] = args.baseSpAttack ?? 65;
  buf[offset + 0x05] = args.baseSpDefense ?? 65;
  buf[offset + 0x06] = args.type1 ?? 12; // GRASS
  buf[offset + 0x07] = args.type2 ?? 3; // POISON
  buf[offset + 0x08] = args.catchRate ?? 45;
  buf[offset + 0x09] = args.expYield ?? 64;
  buf[offset + 0x0a] = args.evYield0 ?? 0;
  buf[offset + 0x0b] = args.evYield1 ?? 0;
  buf.writeUInt16LE(args.item1 ?? 0, offset + 0x0c);
  buf.writeUInt16LE(args.item2 ?? 0, offset + 0x0e);
  buf[offset + 0x10] = args.genderRatio ?? 31;
  buf[offset + 0x11] = args.eggCycles ?? 20;
  buf[offset + 0x12] = args.friendship ?? 70;
  buf[offset + 0x13] = args.growthRate ?? 3; // MEDIUM_SLOW
  buf[offset + 0x14] = args.eggGroup1 ?? 1;
  buf[offset + 0x15] = args.eggGroup2 ?? 7;
  buf[offset + 0x16] = args.ability1 ?? 65; // OVERGROW
  buf[offset + 0x17] = args.ability2 ?? 0;
  buf[offset + 0x18] = args.safariZoneFleeRate ?? 0;
  buf[offset + 0x19] = args.bodyColorAndNoFlip ?? 0x06; // bodyColor=6, noFlip=0
  buf[offset + 0x1a] = args.paddingB0 ?? 0;
  buf[offset + 0x1b] = args.paddingB1 ?? 0;
  return { buf, offset };
}

describe('parseBaseStats - happy paths', () => {
  it('parses Bulbasaur-like baseline stats', () => {
    const { buf, offset } = plant({});
    const r = parseBaseStats(buf, offset);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.baseStats.baseHP).toBe(45);
      expect(r.baseStats.type1).toBe(12); // GRASS
      expect(r.baseStats.type2).toBe(3); // POISON
      expect(r.baseStats.growthRate).toBe(3);
      expect(r.baseStats.ability1).toBe(65);
      expect(r.baseStats.fileOffset).toBe(offset);
    }
  });

  it('parses single-type species (type1 == type2)', () => {
    const { buf, offset } = plant({ type1: 10, type2: 10 }); // both FIRE
    const r = parseBaseStats(buf, offset);
    expect(r.ok).toBe(true);
  });

  it('parses high-stat legendary-like species', () => {
    const { buf, offset } = plant({
      baseHP: 106,
      baseAttack: 110,
      baseDefense: 90,
      baseSpeed: 130,
      baseSpAttack: 154,
      baseSpDefense: 90,
      type1: 16, // DRAGON
      type2: 2, // FLYING
    });
    const r = parseBaseStats(buf, offset);
    expect(r.ok).toBe(true);
  });

  it('result is frozen', () => {
    const { buf, offset } = plant({});
    const r = parseBaseStats(buf, offset);
    if (r.ok) expect(Object.isFrozen(r.baseStats)).toBe(true);
  });
});

describe('parseBaseStats - failure modes', () => {
  it('fails too_short when buffer < 28 bytes', () => {
    expect(parseBaseStats(new Uint8Array(20), 0).ok).toBe(false);
  });

  it('fails implausible_type when type1 > 17', () => {
    const { buf, offset } = plant({ type1: 100 });
    const r = parseBaseStats(buf, offset);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('implausible_type');
  });

  it('fails implausible_type when type2 > 17', () => {
    const { buf, offset } = plant({ type2: 200 });
    const r = parseBaseStats(buf, offset);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('implausible_type');
  });

  it('fails implausible_growth_rate when growthRate > 5', () => {
    const { buf, offset } = plant({ growthRate: 10 });
    const r = parseBaseStats(buf, offset);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('implausible_growth_rate');
  });

  it('fails implausible_egg_group when eggGroup1 > 14', () => {
    const { buf, offset } = plant({ eggGroup1: 50 });
    const r = parseBaseStats(buf, offset);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('implausible_egg_group');
  });

  it('fails implausible_ability when ability1 > MAX', () => {
    const { buf, offset } = plant({ ability1: 255 });
    const r = parseBaseStats(buf, offset);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('implausible_ability');
  });

  it('fails nonzero_padding when paddingB0 != 0', () => {
    const { buf, offset } = plant({ paddingB0: 0xff });
    const r = parseBaseStats(buf, offset);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('nonzero_padding');
  });

  it('fails nonzero_padding when paddingB1 != 0', () => {
    const { buf, offset } = plant({ paddingB1: 0xff });
    const r = parseBaseStats(buf, offset);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('nonzero_padding');
  });

  it('fails nonzero_padding when evYield upper 4 bits != 0', () => {
    const { buf, offset } = plant({ evYield1: 0xf0 });
    const r = parseBaseStats(buf, offset);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('nonzero_padding');
  });

  it('fails all_zero_stats when all six stats are 0', () => {
    const { buf, offset } = plant({
      baseHP: 0,
      baseAttack: 0,
      baseDefense: 0,
      baseSpeed: 0,
      baseSpAttack: 0,
      baseSpDefense: 0,
    });
    const r = parseBaseStats(buf, offset);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('all_zero_stats');
  });
});

describe('BASE_STATS_STRUCT_SIZE_BYTES', () => {
  it('equals 28', () => {
    expect(BASE_STATS_STRUCT_SIZE_BYTES).toBe(28);
  });
});

describe('constants', () => {
  it('TYPE_MAX = 17, GROWTH_RATE_MAX = 5, EGG_GROUP_MAX = 15, ABILITY_MAX = 200', () => {
    expect(BASE_STATS_TYPE_MAX).toBe(17);
    expect(BASE_STATS_GROWTH_RATE_MAX).toBe(5);
    // EGG_GROUP_MAX bumped to 15 in RT-1.2 - EGG_GROUP_UNDISCOVERED
    // is 15 and every legendary + baby Pokémon uses it. The vanilla
    // value of 14 dropped Mewtwo, Mew, the legendary birds, etc.
    expect(BASE_STATS_EGG_GROUP_MAX).toBe(15);
    expect(BASE_STATS_ABILITY_MAX).toBe(200);
  });
});
