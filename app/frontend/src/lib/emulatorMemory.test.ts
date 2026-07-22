import { describe, expect, it } from 'vitest';
import {
  EmulatorMemory,
  SAVESTATE_TOTAL_SIZE,
  SAVESTATE_EWRAM_OFFSET,
  SAVESTATE_IWRAM_OFFSET,
  GBA_SIZE_EWRAM,
  GBA_SIZE_IWRAM,
  gbaAddressToRegion,
  gbaAddressToSavestateOffset,
  type EmulatorMemoryHost,
} from './emulatorMemory';

/** A fake mgba host that owns a 397312-byte buffer (the savestate
 *  format size) and implements the four savestate methods against it.
 *  Lets us simulate the full pause→capture→patch→load round-trip in
 *  unit tests without spinning up a real WASM emulator.
 *
 *  Implemented as a factory + INSTANCE methods (not class methods)
 *  so tests can `delete host.forceAutoSaveState` to simulate the
 *  binding missing one of the four required methods. (class methods
 *  live on the prototype; `delete` on the instance is a no-op.) */
function makeFakeMgbaHost(): {
  host: EmulatorMemoryHost;
  state: {
    buffer: Uint8Array;
    lastUploadedName: string | null;
    captureCount: number;
    loadCount: number;
    capturesSucceed: boolean;
    loadsSucceed: boolean;
    forceNullCapture: boolean;
  };
} {
  const state = {
    buffer: new Uint8Array(SAVESTATE_TOTAL_SIZE),
    lastUploadedName: null as string | null,
    captureCount: 0,
    loadCount: 0,
    capturesSucceed: true,
    loadsSucceed: true,
    forceNullCapture: false,
  };
  let staged: Uint8Array | null = null;
  const host: EmulatorMemoryHost = {
    forceAutoSaveState() {
      state.captureCount++;
      return state.capturesSucceed;
    },
    getAutoSaveState() {
      if (state.forceNullCapture) return null;
      return {
        autoSaveStateName: '/data/autosave/firered.ssm',
        // Return a fresh clone so the bridge can mutate it without
        // affecting our backing buffer.
        data: new Uint8Array(state.buffer),
      };
    },
    async uploadAutoSaveState(name: string, data: Uint8Array) {
      state.lastUploadedName = name;
      if (data.length !== SAVESTATE_TOTAL_SIZE) {
        throw new Error(
          `fake: uploaded data was ${String(data.length)} bytes, expected ${String(SAVESTATE_TOTAL_SIZE)}`,
        );
      }
      staged = new Uint8Array(data);
    },
    loadAutoSaveState() {
      state.loadCount++;
      if (!state.loadsSucceed) return false;
      if (staged) {
        state.buffer = staged;
        staged = null;
      }
      return true;
    },
  };
  return { host, state };
}

describe('gbaAddressToRegion', () => {
  it('maps EWRAM addresses to {ewram, regionOffset}', () => {
    expect(gbaAddressToRegion(0x02000000)).toEqual({ region: 'ewram', regionOffset: 0 });
    expect(gbaAddressToRegion(0x02000100)).toEqual({ region: 'ewram', regionOffset: 0x100 });
    expect(gbaAddressToRegion(0x0203FFFF)).toEqual({
      region: 'ewram',
      regionOffset: GBA_SIZE_EWRAM - 1,
    });
  });

  it('maps IWRAM addresses to {iwram, regionOffset}', () => {
    expect(gbaAddressToRegion(0x03000000)).toEqual({ region: 'iwram', regionOffset: 0 });
    expect(gbaAddressToRegion(0x03005008)).toEqual({
      region: 'iwram',
      regionOffset: 0x5008,
    });
    expect(gbaAddressToRegion(0x03007FFF)).toEqual({
      region: 'iwram',
      regionOffset: GBA_SIZE_IWRAM - 1,
    });
  });

  it('rejects addresses outside EWRAM + IWRAM ranges', () => {
    expect(() => gbaAddressToRegion(0)).toThrow(/outside/);
    expect(() => gbaAddressToRegion(0x01FFFFFF)).toThrow(/outside/);
    expect(() => gbaAddressToRegion(0x02040000)).toThrow(/outside/); // 1 past EWRAM end
    expect(() => gbaAddressToRegion(0x02FFFFFF)).toThrow(/outside/);
    expect(() => gbaAddressToRegion(0x03008000)).toThrow(/outside/); // 1 past IWRAM end
    expect(() => gbaAddressToRegion(0x08000000)).toThrow(/outside/); // ROM
  });

  it('rejects negative + non-integer inputs', () => {
    expect(() => gbaAddressToRegion(-1)).toThrow(/Invalid/);
    expect(() => gbaAddressToRegion(1.5)).toThrow(/Invalid/);
    expect(() => gbaAddressToRegion(NaN)).toThrow(/Invalid/);
  });
});

describe('gbaAddressToSavestateOffset', () => {
  it('computes EWRAM offsets correctly', () => {
    // Base of EWRAM should land at the EWRAM savestate slot start.
    expect(gbaAddressToSavestateOffset(0x02000000)).toBe(SAVESTATE_EWRAM_OFFSET);
    // Mid-EWRAM
    expect(gbaAddressToSavestateOffset(0x02024000)).toBe(SAVESTATE_EWRAM_OFFSET + 0x24000);
    // Last byte of EWRAM
    expect(gbaAddressToSavestateOffset(0x0203FFFF)).toBe(
      SAVESTATE_EWRAM_OFFSET + GBA_SIZE_EWRAM - 1,
    );
  });

  it('computes IWRAM offsets correctly', () => {
    expect(gbaAddressToSavestateOffset(0x03000000)).toBe(SAVESTATE_IWRAM_OFFSET);
    // gSaveBlock1Ptr in vanilla FRLG
    expect(gbaAddressToSavestateOffset(0x03005008)).toBe(SAVESTATE_IWRAM_OFFSET + 0x5008);
    // gSaveBlock1Ptr in vanilla Emerald
    expect(gbaAddressToSavestateOffset(0x03005D8C)).toBe(SAVESTATE_IWRAM_OFFSET + 0x5D8C);
  });
});

describe('EmulatorMemory - isSupported', () => {
  it('returns true when the host has all four savestate methods', () => {
    const { host, state } = makeFakeMgbaHost();
    const m = new EmulatorMemory(host);
    expect(m.isSupported()).toBe(true);
  });

  it('returns false when forceAutoSaveState is missing', () => {
    const { host, state } = makeFakeMgbaHost();
    // Strip method to simulate the binding missing it (host methods
    // are typed as optional, so this is a valid delete).
    delete host.forceAutoSaveState;
    const m = new EmulatorMemory(host);
    expect(m.isSupported()).toBe(false);
  });

  it('returns false when getAutoSaveState is missing', () => {
    const { host, state } = makeFakeMgbaHost();
    // Strip method to simulate the binding missing it (host methods
    // are typed as optional, so this is a valid delete).
    delete host.getAutoSaveState;
    const m = new EmulatorMemory(host);
    expect(m.isSupported()).toBe(false);
  });

  it('returns false when uploadAutoSaveState is missing', () => {
    const { host, state } = makeFakeMgbaHost();
    // Strip method to simulate the binding missing it (host methods
    // are typed as optional, so this is a valid delete).
    delete host.uploadAutoSaveState;
    const m = new EmulatorMemory(host);
    expect(m.isSupported()).toBe(false);
  });

  it('returns false when loadAutoSaveState is missing', () => {
    const { host, state } = makeFakeMgbaHost();
    // Strip method to simulate the binding missing it (host methods
    // are typed as optional, so this is a valid delete).
    delete host.loadAutoSaveState;
    const m = new EmulatorMemory(host);
    expect(m.isSupported()).toBe(false);
  });
});

describe('EmulatorMemory - read path', () => {
  it('readU8 captures a savestate + returns the byte at the right offset', async () => {
    const { host, state } = makeFakeMgbaHost();
    // Pre-seed the savestate buffer with a marker at gSaveBlock1Ptr's offset.
    const offset = SAVESTATE_IWRAM_OFFSET + 0x5008;
    state.buffer[offset] = 0xab;
    const m = new EmulatorMemory(host);
    expect(await m.readU8(0x03005008)).toBe(0xab);
    expect(state.captureCount).toBe(1);
  });

  it('readU32LE reads little-endian u32 from EWRAM', async () => {
    const { host, state } = makeFakeMgbaHost();
    // 0x12345678 LE at the start of EWRAM
    const o = SAVESTATE_EWRAM_OFFSET;
    state.buffer[o + 0] = 0x78;
    state.buffer[o + 1] = 0x56;
    state.buffer[o + 2] = 0x34;
    state.buffer[o + 3] = 0x12;
    const m = new EmulatorMemory(host);
    expect(await m.readU32LE(0x02000000)).toBe(0x12345678);
  });

  it('readU16LE reads little-endian u16 from IWRAM', async () => {
    const { host, state } = makeFakeMgbaHost();
    const o = SAVESTATE_IWRAM_OFFSET + 0x100;
    state.buffer[o + 0] = 0xcd;
    state.buffer[o + 1] = 0xab;
    const m = new EmulatorMemory(host);
    expect(await m.readU16LE(0x03000100)).toBe(0xabcd);
  });

  it('readBytes returns a contiguous run, length-respecting', async () => {
    const { host, state } = makeFakeMgbaHost();
    const o = SAVESTATE_EWRAM_OFFSET + 0x290;
    for (let i = 0; i < 4; i++) state.buffer[o + i] = i + 1;
    const m = new EmulatorMemory(host);
    const got = await m.readBytes(0x02000290, 4);
    expect(Array.from(got)).toEqual([1, 2, 3, 4]);
  });

  it('readBytes length=0 short-circuits (no capture)', async () => {
    const { host, state } = makeFakeMgbaHost();
    const m = new EmulatorMemory(host);
    const got = await m.readBytes(0x02000000, 0);
    expect(got.length).toBe(0);
    expect(state.captureCount).toBe(0);
  });

  it('rejects reads that span the EWRAM/IWRAM boundary', async () => {
    const { host, state } = makeFakeMgbaHost();
    const m = new EmulatorMemory(host);
    // 1 byte past EWRAM end → out of range
    await expect(m.readBytes(0x0203FFFF, 2)).rejects.toThrow(/outside/);
  });
});

describe('EmulatorMemory - write path', () => {
  it('writeU8 patches the savestate + reloads, surviving subsequent reads', async () => {
    const { host, state } = makeFakeMgbaHost();
    const m = new EmulatorMemory(host);
    await m.writeU8(0x02000100, 0x42);
    expect(state.lastUploadedName).toBe('/data/autosave/firered.ssm');
    expect(state.loadCount).toBe(1);
    // Subsequent read returns the patched value.
    expect(await m.readU8(0x02000100)).toBe(0x42);
  });

  it('writeU32LE writes little-endian + verifies via readU32LE', async () => {
    const { host, state } = makeFakeMgbaHost();
    const m = new EmulatorMemory(host);
    await m.writeU32LE(0x03005008, 0xdeadbeef);
    expect(await m.readU32LE(0x03005008)).toBe(0xdeadbeef);
    // Direct byte check too.
    const o = SAVESTATE_IWRAM_OFFSET + 0x5008;
    expect(state.buffer[o + 0]).toBe(0xef);
    expect(state.buffer[o + 1]).toBe(0xbe);
    expect(state.buffer[o + 2]).toBe(0xad);
    expect(state.buffer[o + 3]).toBe(0xde);
  });

  it('writeBytes patches a contiguous run + leaves surrounding bytes intact', async () => {
    const { host, state } = makeFakeMgbaHost();
    // Pre-seed neighbours so we can detect spillover.
    const o = SAVESTATE_EWRAM_OFFSET + 0x100;
    state.buffer[o - 1] = 0xaa;
    state.buffer[o + 3] = 0xaa;
    const m = new EmulatorMemory(host);
    await m.writeBytes(0x02000100, new Uint8Array([1, 2, 3]));
    expect(state.buffer[o - 1]).toBe(0xaa);
    expect(state.buffer[o + 0]).toBe(1);
    expect(state.buffer[o + 1]).toBe(2);
    expect(state.buffer[o + 2]).toBe(3);
    expect(state.buffer[o + 3]).toBe(0xaa);
  });

  it('writeBytes length=0 short-circuits (no capture, no load)', async () => {
    const { host, state } = makeFakeMgbaHost();
    const m = new EmulatorMemory(host);
    await m.writeBytes(0x02000000, new Uint8Array(0));
    expect(state.captureCount).toBe(0);
    expect(state.loadCount).toBe(0);
  });

  it('writeU8 rejects values outside u8 range', async () => {
    const { host, state } = makeFakeMgbaHost();
    const m = new EmulatorMemory(host);
    await expect(m.writeU8(0x02000000, -1)).rejects.toThrow(/u8 out of range/);
    await expect(m.writeU8(0x02000000, 256)).rejects.toThrow(/u8 out of range/);
    await expect(m.writeU8(0x02000000, 1.5)).rejects.toThrow(/u8 out of range/);
  });

  it('writeU16LE rejects values outside u16 range', async () => {
    const { host, state } = makeFakeMgbaHost();
    const m = new EmulatorMemory(host);
    await expect(m.writeU16LE(0x02000000, -1)).rejects.toThrow(/u16 out of range/);
    await expect(m.writeU16LE(0x02000000, 0x10000)).rejects.toThrow(/u16 out of range/);
  });

  it('writeU32LE rejects values outside u32 range', async () => {
    const { host, state } = makeFakeMgbaHost();
    const m = new EmulatorMemory(host);
    await expect(m.writeU32LE(0x02000000, -1)).rejects.toThrow(/u32 out of range/);
    await expect(m.writeU32LE(0x02000000, 0x1_00000000)).rejects.toThrow(/u32 out of range/);
  });

  it('rejects writes that span the EWRAM/IWRAM boundary', async () => {
    const { host, state } = makeFakeMgbaHost();
    const m = new EmulatorMemory(host);
    await expect(
      m.writeBytes(0x0203FFFF, new Uint8Array([1, 2])),
    ).rejects.toThrow(/outside/);
  });
});

describe('EmulatorMemory - failure modes', () => {
  it('captureSavestate failure surfaces as a thrown Error', async () => {
    const { host, state } = makeFakeMgbaHost();
    state.capturesSucceed = false;
    const m = new EmulatorMemory(host);
    await expect(m.readU8(0x02000000)).rejects.toThrow(/forceAutoSaveState/);
  });

  it('null capture surfaces as a thrown Error', async () => {
    const { host, state } = makeFakeMgbaHost();
    state.forceNullCapture = true;
    const m = new EmulatorMemory(host);
    await expect(m.readU8(0x02000000)).rejects.toThrow(/getAutoSaveState/);
  });

  it('loadAutoSaveState failure surfaces as a thrown Error', async () => {
    const { host, state } = makeFakeMgbaHost();
    state.loadsSucceed = false;
    const m = new EmulatorMemory(host);
    await expect(m.writeU8(0x02000000, 0x42)).rejects.toThrow(/loadAutoSaveState/);
  });

  it('mismatched savestate size surfaces as a thrown Error', async () => {
    const { host, state } = makeFakeMgbaHost();
    // Shrink the buffer so getAutoSaveState() returns the wrong size.
    state.buffer = new Uint8Array(SAVESTATE_TOTAL_SIZE - 100);
    const m = new EmulatorMemory(host);
    await expect(m.readU8(0x02000000)).rejects.toThrow(/Unexpected savestate size/);
  });

  it('missing methods on host throw with a helpful message', async () => {
    const { host } = makeFakeMgbaHost();
    delete host.forceAutoSaveState;
    const m = new EmulatorMemory(host);
    await expect(m.readU8(0x02000000)).rejects.toThrow(/requires mgba-wasm/);
  });
});

describe('EmulatorMemory - call sequencing', () => {
  it('write captures exactly once + loads exactly once per call', async () => {
    const { host, state } = makeFakeMgbaHost();
    const m = new EmulatorMemory(host);
    await m.writeU8(0x02000000, 0x11);
    expect(state.captureCount).toBe(1);
    expect(state.loadCount).toBe(1);
  });

  it('read captures exactly once per call', async () => {
    const { host, state } = makeFakeMgbaHost();
    const m = new EmulatorMemory(host);
    await m.readU8(0x02000000);
    expect(state.captureCount).toBe(1);
    expect(state.loadCount).toBe(0);
  });

  it('multiple ops issue independent capture/load pairs', async () => {
    const { host, state } = makeFakeMgbaHost();
    const m = new EmulatorMemory(host);
    await m.writeU8(0x02000000, 0x11);
    await m.writeU8(0x02000001, 0x22);
    await m.readU8(0x02000000);
    expect(state.captureCount).toBe(3); // 2 writes + 1 read
    expect(state.loadCount).toBe(2);
  });
});
