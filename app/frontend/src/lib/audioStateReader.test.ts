/**
 * Phase 9E - audioStateReader tests.
 *
 * We can't drive a real emulator here, but we can exercise the byte-
 * level struct parsing + the host-degradation paths via a mocked
 * EmulatorMemoryHost.
 */

import { describe, expect, it } from 'vitest';
import {
  FRLG_GMPLAYINFO_BGM_ADDR,
  FRLG_GMPLAYINFO_SE1_ADDR,
  FRLG_GMPLAYINFO_SE2_ADDR,
  FRLG_GMPLAYINFO_SE3_ADDR,
  MPLAYINFO_IDENT_SIGNATURE,
  MPLAYINFO_OFFSETS,
  MUSIC_PLAYER_INFO_SIZE,
  readAudioState,
} from './audioStateReader';
import type { EmulatorMemoryHost } from './emulatorMemory';

/** Build a 64-byte MusicPlayerInfo blob with the given fields. */
function buildSlotBytes(opts: {
  songHeaderPointer: number;
  status: number;
  trackCount: number;
  clock: number;
  tempoD: number;
  tempoU: number;
  ident: number;
}): Uint8Array {
  const b = new Uint8Array(MUSIC_PLAYER_INFO_SIZE);
  const setU32 = (off: number, v: number): void => {
    b[off] = v & 0xff;
    b[off + 1] = (v >>> 8) & 0xff;
    b[off + 2] = (v >>> 16) & 0xff;
    b[off + 3] = (v >>> 24) & 0xff;
  };
  const setU16 = (off: number, v: number): void => {
    b[off] = v & 0xff;
    b[off + 1] = (v >>> 8) & 0xff;
  };
  setU32(MPLAYINFO_OFFSETS.songHeader, opts.songHeaderPointer);
  setU32(MPLAYINFO_OFFSETS.status, opts.status);
  b[MPLAYINFO_OFFSETS.trackCount] = opts.trackCount;
  setU32(MPLAYINFO_OFFSETS.clock, opts.clock);
  setU16(MPLAYINFO_OFFSETS.tempoD, opts.tempoD);
  setU16(MPLAYINFO_OFFSETS.tempoU, opts.tempoU);
  setU32(MPLAYINFO_OFFSETS.ident, opts.ident);
  return b;
}

/** Build a 0x110-byte payload (BGM + SE1 + SE2 + SE3) for the
 *  readAudioState() round-trip test. */
function buildAudioPayload(slots: {
  bgm: Uint8Array;
  se1: Uint8Array;
  se2: Uint8Array;
  se3: Uint8Array;
}): Uint8Array {
  const totalLen = FRLG_GMPLAYINFO_SE3_ADDR + MUSIC_PLAYER_INFO_SIZE - FRLG_GMPLAYINFO_BGM_ADDR;
  const out = new Uint8Array(totalLen);
  out.set(slots.bgm, 0);
  out.set(slots.se1, FRLG_GMPLAYINFO_SE1_ADDR - FRLG_GMPLAYINFO_BGM_ADDR);
  out.set(slots.se2, FRLG_GMPLAYINFO_SE2_ADDR - FRLG_GMPLAYINFO_BGM_ADDR);
  out.set(slots.se3, FRLG_GMPLAYINFO_SE3_ADDR - FRLG_GMPLAYINFO_BGM_ADDR);
  return out;
}

/** Make a host whose savestate path returns `bytes` when readBytes
 *  is invoked at FRLG_GMPLAYINFO_BGM_ADDR. */
function makeFakeHost(savestate: Uint8Array): EmulatorMemoryHost {
  return {
    pauseGame: () => undefined,
    resumeGame: () => undefined,
    forceAutoSaveState: () => true,
    getAutoSaveState: () => ({
      autoSaveStateName: 'fake.state',
      // The EmulatorMemory bridge expects a full 0x61000-byte savestate
      // blob. We allocate it + slot our IWRAM bytes at SAVESTATE_IWRAM_OFFSET +
      // (BGM_ADDR - 0x03000000).
      data: (() => {
        const SAVESTATE_TOTAL = 0x61000;
        const SAVESTATE_IWRAM_OFFSET = 0x19000;
        const out = new Uint8Array(SAVESTATE_TOTAL);
        const iwramOffsetForBgm = SAVESTATE_IWRAM_OFFSET + (FRLG_GMPLAYINFO_BGM_ADDR - 0x03000000);
        out.set(savestate, iwramOffsetForBgm);
        return out;
      })(),
    }),
    uploadAutoSaveState: async () => undefined,
    loadAutoSaveState: () => true,
  };
}

describe('audioStateReader (Phase 9E)', () => {
  it('parses a populated BGM slot as looksLikePlaying when ident + status are right', async () => {
    const bgm = buildSlotBytes({
      songHeaderPointer: 0x08abcdef,
      status: 0x01, // playing
      trackCount: 8,
      clock: 1024,
      tempoD: 0x100,
      tempoU: 0x80,
      ident: MPLAYINFO_IDENT_SIGNATURE,
    });
    const idle = buildSlotBytes({
      songHeaderPointer: 0,
      status: 0,
      trackCount: 0,
      clock: 0,
      tempoD: 0,
      tempoU: 0,
      ident: 0,
    });
    const payload = buildAudioPayload({ bgm, se1: idle, se2: idle, se3: idle });
    const host = makeFakeHost(payload);
    const snap = await readAudioState(host);
    expect(snap.bgm).not.toBeNull();
    expect(snap.bgm?.looksLikePlaying).toBe(true);
    expect(snap.bgm?.songHeaderPointer).toBe(0x08abcdef);
    expect(snap.bgm?.trackCount).toBe(8);
    expect(snap.bgm?.clock).toBe(1024);
    expect(snap.bgm?.tempoD).toBe(0x100);
    expect(snap.anySlotPlaying).toBe(true);
  });

  it('marks all slots as not-playing when ident is missing', async () => {
    const idle = buildSlotBytes({
      songHeaderPointer: 0,
      status: 0,
      trackCount: 0,
      clock: 0,
      tempoD: 0,
      tempoU: 0,
      ident: 0,
    });
    const payload = buildAudioPayload({ bgm: idle, se1: idle, se2: idle, se3: idle });
    const host = makeFakeHost(payload);
    const snap = await readAudioState(host);
    expect(snap.bgm?.looksLikePlaying).toBe(false);
    expect(snap.se1?.looksLikePlaying).toBe(false);
    expect(snap.se2?.looksLikePlaying).toBe(false);
    expect(snap.se3?.looksLikePlaying).toBe(false);
    expect(snap.anySlotPlaying).toBe(false);
  });

  it('marks a slot as not-playing when songHeader points outside ROM', async () => {
    // ident is correct + status bit 0 is set + clock is non-zero - 
    // but the songHeader points at IWRAM (0x03xxxxxx), so it's noise.
    const noisy = buildSlotBytes({
      songHeaderPointer: 0x03001234,
      status: 0x01,
      trackCount: 8,
      clock: 1024,
      tempoD: 0x100,
      tempoU: 0x80,
      ident: MPLAYINFO_IDENT_SIGNATURE,
    });
    const idle = buildSlotBytes({
      songHeaderPointer: 0,
      status: 0,
      trackCount: 0,
      clock: 0,
      tempoD: 0,
      tempoU: 0,
      ident: 0,
    });
    const payload = buildAudioPayload({ bgm: noisy, se1: idle, se2: idle, se3: idle });
    const host = makeFakeHost(payload);
    const snap = await readAudioState(host);
    expect(snap.bgm?.looksLikePlaying).toBe(false);
    expect(snap.anySlotPlaying).toBe(false);
  });

  it('returns a snapshot with all slots null when the host does not support savestates', async () => {
    const host: EmulatorMemoryHost = {
      pauseGame: () => undefined,
      resumeGame: () => undefined,
      // No forceAutoSaveState / getAutoSaveState → mem.isSupported() = false.
    };
    const snap = await readAudioState(host);
    expect(snap.bgm).toBeNull();
    expect(snap.se1).toBeNull();
    expect(snap.se2).toBeNull();
    expect(snap.se3).toBeNull();
    expect(snap.anySlotPlaying).toBe(false);
  });

  it('exposes the documented vanilla FRLG / CFRU addresses', () => {
    expect(FRLG_GMPLAYINFO_BGM_ADDR).toBe(0x03007300);
    expect(FRLG_GMPLAYINFO_SE1_ADDR).toBe(0x03007340);
    expect(FRLG_GMPLAYINFO_SE2_ADDR).toBe(0x03007380);
    expect(FRLG_GMPLAYINFO_SE3_ADDR).toBe(0x030073d0);
    expect(MUSIC_PLAYER_INFO_SIZE).toBe(0x40);
  });

  it('parses the slots in the right order from the payload', async () => {
    // Each slot gets a different distinctive tempoD so we can verify
    // the subarray slicing.
    const bgm = buildSlotBytes({
      songHeaderPointer: 0x08000000,
      status: 1,
      trackCount: 1,
      clock: 100,
      tempoD: 0x1111,
      tempoU: 1,
      ident: MPLAYINFO_IDENT_SIGNATURE,
    });
    const se1 = buildSlotBytes({
      songHeaderPointer: 0x08000000,
      status: 1,
      trackCount: 1,
      clock: 100,
      tempoD: 0x2222,
      tempoU: 1,
      ident: MPLAYINFO_IDENT_SIGNATURE,
    });
    const se2 = buildSlotBytes({
      songHeaderPointer: 0x08000000,
      status: 1,
      trackCount: 1,
      clock: 100,
      tempoD: 0x3333,
      tempoU: 1,
      ident: MPLAYINFO_IDENT_SIGNATURE,
    });
    const se3 = buildSlotBytes({
      songHeaderPointer: 0x08000000,
      status: 1,
      trackCount: 1,
      clock: 100,
      tempoD: 0x4444,
      tempoU: 1,
      ident: MPLAYINFO_IDENT_SIGNATURE,
    });
    const payload = buildAudioPayload({ bgm, se1, se2, se3 });
    const host = makeFakeHost(payload);
    const snap = await readAudioState(host);
    expect(snap.bgm?.tempoD).toBe(0x1111);
    expect(snap.se1?.tempoD).toBe(0x2222);
    expect(snap.se2?.tempoD).toBe(0x3333);
    expect(snap.se3?.tempoD).toBe(0x4444);
    expect(snap.bgm?.addr).toBe(FRLG_GMPLAYINFO_BGM_ADDR);
    expect(snap.se1?.addr).toBe(FRLG_GMPLAYINFO_SE1_ADDR);
    expect(snap.se2?.addr).toBe(FRLG_GMPLAYINFO_SE2_ADDR);
    expect(snap.se3?.addr).toBe(FRLG_GMPLAYINFO_SE3_ADDR);
  });
});
