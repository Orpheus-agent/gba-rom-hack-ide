/**
 * Phase 9C - Battle state reader tests.
 */

import { describe, expect, it } from 'vitest';
import {
  BATTLEMON_OFFSETS,
  BATTLEMON_STRUCT_SIZE,
  FRLG_VANILLA_GBATTLEMONS_ADDR,
  readBattleState,
} from './battleStateReader';
import {
  GBA_SIZE_EWRAM,
  SAVESTATE_EWRAM_OFFSET,
  SAVESTATE_TOTAL_SIZE,
} from './emulatorMemory';
import type { EmulatorMemoryHost } from './emulatorMemory';

/** Build a mock host whose `getAutoSaveState()` returns a 0x61000-byte
 *  savestate with the BattleMon structs patched at the FRLG vanilla
 *  EWRAM offset. */
function buildMockHost(opts: {
  playerSpecies?: number;
  playerLevel?: number;
  playerHp?: number;
  playerMaxHp?: number;
  opponentSpecies?: number;
  opponentLevel?: number;
  opponentHp?: number;
  opponentMaxHp?: number;
}): EmulatorMemoryHost {
  const blob = new Uint8Array(SAVESTATE_TOTAL_SIZE);
  const gBattleMonsAddr = FRLG_VANILLA_GBATTLEMONS_ADDR; // 0x02024084
  const ewramBase = 0x02000000;
  const offsetInEwram = gBattleMonsAddr - ewramBase;
  const playerBase = SAVESTATE_EWRAM_OFFSET + offsetInEwram;
  const opponentBase = playerBase + BATTLEMON_STRUCT_SIZE;

  function setU16(off: number, val: number): void {
    blob[off] = val & 0xff;
    blob[off + 1] = (val >> 8) & 0xff;
  }
  function setU8(off: number, val: number): void {
    blob[off] = val & 0xff;
  }
  // Player.
  setU16(playerBase + BATTLEMON_OFFSETS.species, opts.playerSpecies ?? 25); // Pikachu
  setU8(playerBase + BATTLEMON_OFFSETS.level, opts.playerLevel ?? 50);
  setU16(playerBase + BATTLEMON_OFFSETS.hp, opts.playerHp ?? 80);
  setU16(playerBase + BATTLEMON_OFFSETS.maxHp, opts.playerMaxHp ?? 100);
  setU8(playerBase + BATTLEMON_OFFSETS.type1, 13); // electric
  setU8(playerBase + BATTLEMON_OFFSETS.type2, 255); // none
  // Opponent.
  setU16(opponentBase + BATTLEMON_OFFSETS.species, opts.opponentSpecies ?? 6); // Charizard
  setU8(opponentBase + BATTLEMON_OFFSETS.level, opts.opponentLevel ?? 55);
  setU16(opponentBase + BATTLEMON_OFFSETS.hp, opts.opponentHp ?? 120);
  setU16(opponentBase + BATTLEMON_OFFSETS.maxHp, opts.opponentMaxHp ?? 150);
  setU8(opponentBase + BATTLEMON_OFFSETS.type1, 10); // fire
  setU8(opponentBase + BATTLEMON_OFFSETS.type2, 2); // flying

  const host: EmulatorMemoryHost = {
    forceAutoSaveState: () => true,
    getAutoSaveState: () => ({
      autoSaveStateName: '/autosave/0',
      data: blob,
    }),
    uploadAutoSaveState: async () => undefined,
    loadAutoSaveState: () => true,
    pauseGame: () => undefined,
    resumeGame: () => undefined,
  };
  return host;
}

describe('battleStateReader', () => {
  it('parses player + opponent BattleMon structs from a mock savestate', async () => {
    const host = buildMockHost({});
    const snap = await readBattleState(host);
    expect(snap.looksLikeAnActiveBattle).toBe(true);
    expect(snap.player).not.toBeNull();
    expect(snap.opponent).not.toBeNull();
    expect(snap.player!.speciesId).toBe(25);
    expect(snap.player!.level).toBe(50);
    expect(snap.player!.hp).toBe(80);
    expect(snap.player!.maxHp).toBe(100);
    expect(snap.player!.type1).toBe(13);
    expect(snap.opponent!.speciesId).toBe(6);
    expect(snap.opponent!.level).toBe(55);
    expect(snap.opponent!.hp).toBe(120);
    expect(snap.opponent!.maxHp).toBe(150);
  });

  it('marks the snapshot as not-a-battle when speciesId is 0', async () => {
    const host = buildMockHost({ playerSpecies: 0 });
    const snap = await readBattleState(host);
    expect(snap.player).toBeNull();
    expect(snap.looksLikeAnActiveBattle).toBe(false);
  });

  it('marks the snapshot as not-a-battle when hp > maxHp', async () => {
    const host = buildMockHost({ playerHp: 999, playerMaxHp: 100 });
    const snap = await readBattleState(host);
    expect(snap.player).toBeNull();
  });

  it('marks the snapshot as not-a-battle when level is > 100', async () => {
    const host = buildMockHost({ opponentLevel: 200 });
    const snap = await readBattleState(host);
    expect(snap.opponent).toBeNull();
  });

  it('returns null snapshots when the host does not expose savestate methods', async () => {
    const host: EmulatorMemoryHost = {}; // missing all required methods
    const snap = await readBattleState(host);
    expect(snap.player).toBeNull();
    expect(snap.opponent).toBeNull();
    expect(snap.looksLikeAnActiveBattle).toBe(false);
  });

  it('handles getAutoSaveState() throwing without crashing the caller', async () => {
    const host: EmulatorMemoryHost = {
      forceAutoSaveState: () => true,
      getAutoSaveState: () => {
        throw new Error('boom');
      },
      uploadAutoSaveState: async () => undefined,
      loadAutoSaveState: () => true,
    };
    const snap = await readBattleState(host);
    expect(snap.looksLikeAnActiveBattle).toBe(false);
  });

  it('EWRAM bounds: the BattleMon structs sit inside EWRAM', () => {
    const ewramBase = 0x02000000;
    const offset = FRLG_VANILLA_GBATTLEMONS_ADDR - ewramBase;
    expect(offset).toBeGreaterThanOrEqual(0);
    expect(offset + BATTLEMON_STRUCT_SIZE * 2).toBeLessThanOrEqual(GBA_SIZE_EWRAM);
  });
});
