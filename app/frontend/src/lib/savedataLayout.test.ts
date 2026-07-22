import { describe, expect, it } from 'vitest';
import {
  SAVEBLOCK_POINTERS,
  SAVEBLOCK_LAYOUT_FRLG,
  SAVEBLOCK_LAYOUT_EMERALD,
  BADGE_FLAG_IDS,
  FLAGS_COUNT_BY_FAMILY,
  VARS_COUNT_BY_FAMILY,
  VARS_START_BASE,
  getSaveBlockLayout,
} from './savedataLayout';

// Every constant below is independently verified against pret/
// pokefirered + pret/pokeemerald global.h. If these tests fail
// because someone updated the layout constants, double-check the
// source: a wrong offset corrupts the user's save data.

describe('SAVEBLOCK_POINTERS (per-family IWRAM ptr addresses)', () => {
  it('FRLG points at IWRAM addresses (0x03xxxxxx range)', () => {
    const { sb1, sb2 } = SAVEBLOCK_POINTERS['firered-vanilla'];
    expect(sb1).toBe(0x03005008);
    expect(sb2).toBe(0x0300500c);
    // sb1 + 4 == sb2 (the two pointers are consecutive).
    expect(sb2).toBe(sb1 + 4);
  });

  it('Emerald points at IWRAM addresses (0x03xxxxxx range)', () => {
    const { sb1, sb2 } = SAVEBLOCK_POINTERS['emerald-vanilla'];
    expect(sb1).toBe(0x03005d8c);
    expect(sb2).toBe(0x03005d90);
    expect(sb2).toBe(sb1 + 4);
  });
});

describe('SAVEBLOCK_LAYOUT_FRLG (pret-sourced offsets)', () => {
  it('playerName in SB2 at 0x000, 8 bytes', () => {
    expect(SAVEBLOCK_LAYOUT_FRLG.playerName).toEqual({
      block: 'sb2',
      offset: 0x0000,
      size: 8,
    });
  });
  it('playerGender in SB2 at 0x008, 1 byte', () => {
    expect(SAVEBLOCK_LAYOUT_FRLG.playerGender).toEqual({
      block: 'sb2',
      offset: 0x0008,
      size: 1,
    });
  });
  it('money in SB1 at 0x290, 4 bytes (XOR-encrypted)', () => {
    expect(SAVEBLOCK_LAYOUT_FRLG.money).toEqual({
      block: 'sb1',
      offset: 0x0290,
      size: 4,
    });
  });
  it('encryptionKey in SB2 at 0xF20, 4 bytes', () => {
    // This is the CRITICAL constant - Bulbapedia had it wrong at 0x0AF8,
    // pret/global.h confirms 0xF20 for FRLG.
    expect(SAVEBLOCK_LAYOUT_FRLG.encryptionKey).toEqual({
      block: 'sb2',
      offset: 0x0f20,
      size: 4,
    });
  });
  it('flagsArray in SB1 at 0xEE0, 288 bytes (2304 flags)', () => {
    expect(SAVEBLOCK_LAYOUT_FRLG.flagsArray).toEqual({
      block: 'sb1',
      offset: 0x0ee0,
      size: 288,
    });
  });
  it('varsArray in SB1 at 0x1000, 512 bytes (256 vars × u16)', () => {
    expect(SAVEBLOCK_LAYOUT_FRLG.varsArray).toEqual({
      block: 'sb1',
      offset: 0x1000,
      size: 512,
    });
  });
  it('playerParty in SB1 at 0x038, 6 slots × 100 bytes', () => {
    expect(SAVEBLOCK_LAYOUT_FRLG.playerParty).toEqual({
      block: 'sb1',
      offset: 0x0038,
      slotSize: 100,
      slotCount: 6,
    });
  });
});

describe('SAVEBLOCK_LAYOUT_EMERALD (pret-sourced offsets, distinct from FRLG)', () => {
  it('playerName + playerGender match FRLG (same SaveBlock2 layout for those fields)', () => {
    expect(SAVEBLOCK_LAYOUT_EMERALD.playerName).toEqual({
      block: 'sb2',
      offset: 0x0000,
      size: 8,
    });
    expect(SAVEBLOCK_LAYOUT_EMERALD.playerGender).toEqual({
      block: 'sb2',
      offset: 0x0008,
      size: 1,
    });
  });

  it('money at SB1 0x490 (NOT 0x290 - Emerald reshuffles SaveBlock1)', () => {
    expect(SAVEBLOCK_LAYOUT_EMERALD.money.offset).toBe(0x0490);
    expect(SAVEBLOCK_LAYOUT_EMERALD.money.offset).not.toBe(SAVEBLOCK_LAYOUT_FRLG.money.offset);
  });

  it('encryptionKey at SB2 0x0AC (NOT 0xF20 - Emerald moved the key)', () => {
    expect(SAVEBLOCK_LAYOUT_EMERALD.encryptionKey.offset).toBe(0x00ac);
    expect(SAVEBLOCK_LAYOUT_EMERALD.encryptionKey.offset).not.toBe(
      SAVEBLOCK_LAYOUT_FRLG.encryptionKey.offset,
    );
  });

  it('flagsArray at SB1 0x1270, 300 bytes (2400 flags)', () => {
    expect(SAVEBLOCK_LAYOUT_EMERALD.flagsArray).toEqual({
      block: 'sb1',
      offset: 0x1270,
      size: 300,
    });
  });

  it('varsArray at SB1 0x139C', () => {
    expect(SAVEBLOCK_LAYOUT_EMERALD.varsArray.offset).toBe(0x139c);
  });

  it('playerParty at SB1 0x238 (NOT 0x038 - Emerald has more fields ahead of party)', () => {
    expect(SAVEBLOCK_LAYOUT_EMERALD.playerParty.offset).toBe(0x0238);
  });
});

describe('getSaveBlockLayout dispatcher', () => {
  it('routes firered-vanilla → SAVEBLOCK_LAYOUT_FRLG', () => {
    expect(getSaveBlockLayout('firered-vanilla')).toBe(SAVEBLOCK_LAYOUT_FRLG);
  });
  it('routes emerald-vanilla → SAVEBLOCK_LAYOUT_EMERALD', () => {
    expect(getSaveBlockLayout('emerald-vanilla')).toBe(SAVEBLOCK_LAYOUT_EMERALD);
  });
});

describe('BADGE_FLAG_IDS (sourced from pret include/constants/flags.h)', () => {
  it('FRLG badges at 0x820..0x827 (FLAG_BADGE01_GET..FLAG_BADGE08_GET)', () => {
    const ids = BADGE_FLAG_IDS['firered-vanilla'];
    expect(ids).toHaveLength(8);
    expect(ids[0]).toBe(0x820);
    expect(ids[7]).toBe(0x827);
    // Consecutive.
    for (let i = 1; i < 8; i++) expect(ids[i]).toBe(ids[i - 1]! + 1);
  });

  it('Emerald badges at 0x867..0x86E', () => {
    const ids = BADGE_FLAG_IDS['emerald-vanilla'];
    expect(ids).toHaveLength(8);
    expect(ids[0]).toBe(0x867);
    expect(ids[7]).toBe(0x86e);
    for (let i = 1; i < 8; i++) expect(ids[i]).toBe(ids[i - 1]! + 1);
  });
});

describe('VARS_START_BASE + counts (per pret)', () => {
  it('VARS_START_BASE is 0x4000 for both FRLG and Emerald (pret convention)', () => {
    expect(VARS_START_BASE).toBe(0x4000);
  });
  it('FRLG has 256 vars', () => {
    expect(VARS_COUNT_BY_FAMILY['firered-vanilla']).toBe(256);
  });
  it('Emerald has 256 vars', () => {
    expect(VARS_COUNT_BY_FAMILY['emerald-vanilla']).toBe(256);
  });
});

describe('FLAGS_COUNT_BY_FAMILY (derived from flagsArray.size × 8)', () => {
  it('FRLG: 288 bytes × 8 = 2304 flags', () => {
    expect(FLAGS_COUNT_BY_FAMILY['firered-vanilla']).toBe(2304);
    expect(FLAGS_COUNT_BY_FAMILY['firered-vanilla']).toBe(
      SAVEBLOCK_LAYOUT_FRLG.flagsArray.size * 8,
    );
  });
  it('Emerald: 300 bytes × 8 = 2400 flags', () => {
    expect(FLAGS_COUNT_BY_FAMILY['emerald-vanilla']).toBe(2400);
    expect(FLAGS_COUNT_BY_FAMILY['emerald-vanilla']).toBe(
      SAVEBLOCK_LAYOUT_EMERALD.flagsArray.size * 8,
    );
  });
});
