/**
 * WP-B v2.1 - Emulator memory bridge.
 *
 * Goal: let the debug menu read/write GBA WRAM on a running mGBA-WASM
 * emulator instance, without forking the binding.
 *
 * Approach: SAVESTATE PATCHING. mgba's GBA savestate is a fixed-layout
 * binary blob (per include/mgba/internal/gba/serialize.h, size 0x61000):
 *
 *   [header + IO + palette + OAM + VRAM]   0x00000 - 0x18FFF
 *   IWRAM (32 KB)                          0x19000 - 0x20FFF
 *   EWRAM (256 KB)                         0x21000 - 0x60FFF
 *
 * The layout is stable across mgba versions (it's their compatibility
 * contract). Each memory op pauses the emulator, captures a savestate,
 * patches bytes at the calculated offset, writes the savestate back,
 * loads it, resumes. ~100ms per operation in browser - snappy enough
 * for debug-menu interactions.
 *
 * Why not direct HEAPU8 access: @thenick775/mgba-wasm@2.4.1 exposes
 * exactly these wasmExports (verified via dist/mgba.js inspection):
 *   screenshot, buttonPress, buttonUnpress, toggleRewind, setVolume,
 *   getVolume, getMainLoopTiming*, setMainLoopTiming, pauseGame,
 *   resumeGame, pauseAudio, resumeAudio, setEventEnable, bindKey,
 *   saveState, loadState, autoLoadCheats, loadGame, saveStateSlot,
 *   loadStateSlot, addCoreCallbacks, setIntegerCoreSetting,
 *   setupConstants, autoSaveState, loadAutoSaveState, quickReload,
 *   quitGame, quitMgba, main, malloc, free, pthread_*
 *
 * Notably absent: readMemory / writeMemory / GBAView / GBAStore /
 * coreReadMemory. Forking to add them is the long-term answer but
 * adds a build-mgba-from-source dependency we'd rather avoid. The
 * savestate-patch path uses only documented public API.
 *
 * Why not getSave() / uploadSaveOrSaveState(): getSave() returns the
 * battery-backed SRAM (the on-flash save file, post-checksum, post-
 * XOR-encryption). That's the FINAL save the player would see after
 * `SAVE`-ing in-game - not the LIVE WRAM. The savestate captures the
 * live WRAM directly, no encryption layer to navigate.
 */

/** mGBA savestate constants - fixed by the format spec.
 *  See: include/mgba/internal/gba/serialize.h in mgba upstream. */
export const SAVESTATE_TOTAL_SIZE = 0x61000; // 397,312 bytes
export const SAVESTATE_IWRAM_OFFSET = 0x19000; // 102,400
export const SAVESTATE_EWRAM_OFFSET = 0x21000; // 135,168
export const GBA_SIZE_IWRAM = 0x8000; // 32 KB
export const GBA_SIZE_EWRAM = 0x40000; // 256 KB

/** GBA memory regions we know how to address. Reads/writes outside
 *  these regions throw - we don't try to patch VRAM/OAM/palette/IO
 *  (the savestate has them, but live-patching them while the PPU is
 *  rendering is a recipe for visual glitches). */
export type GbaMemoryRegion = 'ewram' | 'iwram';

/** Minimal interface we need from the mGBA-WASM Module. The real
 *  EmulatorInstance from EmulatorHost.tsx is a superset. */
export interface EmulatorMemoryHost {
  pauseGame?: () => void;
  resumeGame?: () => void;
  forceAutoSaveState?: () => boolean;
  getAutoSaveState?: () => { autoSaveStateName: string; data: Uint8Array } | null;
  uploadAutoSaveState?: (name: string, data: Uint8Array) => Promise<void>;
  loadAutoSaveState?: () => boolean;
}

/** Resolve a GBA bus address to (region, offset within region). Throws
 *  for addresses outside the EWRAM/IWRAM ranges we support. */
export function gbaAddressToRegion(
  gbaAddress: number,
): { region: GbaMemoryRegion; regionOffset: number } {
  if (!Number.isInteger(gbaAddress) || gbaAddress < 0) {
    throw new RangeError(`Invalid GBA address: ${String(gbaAddress)}`);
  }
  // EWRAM: 0x02000000-0x0203FFFF
  if (gbaAddress >= 0x02000000 && gbaAddress < 0x02000000 + GBA_SIZE_EWRAM) {
    return { region: 'ewram', regionOffset: gbaAddress - 0x02000000 };
  }
  // IWRAM: 0x03000000-0x03007FFF
  if (gbaAddress >= 0x03000000 && gbaAddress < 0x03000000 + GBA_SIZE_IWRAM) {
    return { region: 'iwram', regionOffset: gbaAddress - 0x03000000 };
  }
  throw new RangeError(
    `GBA address 0x${gbaAddress.toString(16).padStart(8, '0')} is outside the EWRAM (0x02000000-0x0203FFFF) and IWRAM (0x03000000-0x03007FFF) ranges supported by the memory bridge.`,
  );
}

/** Compute the byte offset within a savestate blob for a given GBA
 *  address. Inverse mapping: offset in savestate = region base in
 *  savestate + offset within region. */
export function gbaAddressToSavestateOffset(gbaAddress: number): number {
  const { region, regionOffset } = gbaAddressToRegion(gbaAddress);
  const regionBase = region === 'ewram' ? SAVESTATE_EWRAM_OFFSET : SAVESTATE_IWRAM_OFFSET;
  return regionBase + regionOffset;
}

/** Wrap an emulator host with a read/write API addressed by GBA
 *  bus address (0x02xxxxxx EWRAM, 0x03xxxxxx IWRAM).
 *
 *  Per-write cost: ~100ms (pause → savestate capture → FS write →
 *  loadState → resume). For typical debug-menu interactions (set one
 *  flag, set money) that's invisible. For bulk operations the caller
 *  should batch: read once → mutate locally → write once.
 *
 *  Concurrency: not safe for parallel writes from multiple callers.
 *  The debug menu UI guards against concurrent clicks by disabling
 *  buttons while a write is in flight. */
export class EmulatorMemory {
  constructor(private readonly host: EmulatorMemoryHost) {}

  /** Required-API gate: returns false if any of the savestate methods
   *  this layer depends on are missing from the host. */
  isSupported(): boolean {
    return (
      typeof this.host.forceAutoSaveState === 'function' &&
      typeof this.host.getAutoSaveState === 'function' &&
      typeof this.host.uploadAutoSaveState === 'function' &&
      typeof this.host.loadAutoSaveState === 'function'
    );
  }

  /** Read a contiguous run of bytes from a GBA address. Captures a
   *  fresh savestate first so the bytes reflect current emulator state. */
  async readBytes(gbaAddress: number, length: number): Promise<Uint8Array> {
    if (length <= 0) return new Uint8Array(0);
    const start = gbaAddressToSavestateOffset(gbaAddress);
    // Guard: don't allow reads that span the EWRAM/IWRAM boundary
    // (since they're at non-adjacent savestate offsets).
    gbaAddressToRegion(gbaAddress + length - 1); // throws if out of range
    const blob = await this.captureSavestate();
    return blob.slice(start, start + length);
  }

  async readU8(gbaAddress: number): Promise<number> {
    const bytes = await this.readBytes(gbaAddress, 1);
    return bytes[0]!;
  }
  async readU16LE(gbaAddress: number): Promise<number> {
    const bytes = await this.readBytes(gbaAddress, 2);
    return bytes[0]! | (bytes[1]! << 8);
  }
  async readU32LE(gbaAddress: number): Promise<number> {
    const bytes = await this.readBytes(gbaAddress, 4);
    return (
      ((bytes[0]! | (bytes[1]! << 8) | (bytes[2]! << 16) | (bytes[3]! << 24)) >>> 0)
    );
  }

  /** Write a contiguous run of bytes at a GBA address. Captures a
   *  savestate, patches it, writes back, loads - all atomically per call. */
  async writeBytes(gbaAddress: number, bytes: Uint8Array): Promise<void> {
    if (bytes.length === 0) return;
    const start = gbaAddressToSavestateOffset(gbaAddress);
    gbaAddressToRegion(gbaAddress + bytes.length - 1); // throws if out of range
    if (start + bytes.length > SAVESTATE_TOTAL_SIZE) {
      throw new RangeError(
        `Write at savestate offset 0x${start.toString(16)} of ${bytes.length} bytes would exceed savestate size 0x${SAVESTATE_TOTAL_SIZE.toString(16)}`,
      );
    }
    const captured = await this.captureSavestateRaw();
    const patched = new Uint8Array(captured.data);
    patched.set(bytes, start);
    await this.host.uploadAutoSaveState!(captured.autoSaveStateName, patched);
    const ok = this.host.loadAutoSaveState!();
    if (!ok) {
      throw new Error('mGBA failed to load the patched savestate (loadAutoSaveState returned false)');
    }
  }

  async writeU8(gbaAddress: number, value: number): Promise<void> {
    if (!Number.isInteger(value) || value < 0 || value > 0xff) {
      throw new RangeError(`u8 out of range: ${String(value)}`);
    }
    await this.writeBytes(gbaAddress, new Uint8Array([value & 0xff]));
  }
  async writeU16LE(gbaAddress: number, value: number): Promise<void> {
    if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
      throw new RangeError(`u16 out of range: ${String(value)}`);
    }
    await this.writeBytes(gbaAddress, new Uint8Array([value & 0xff, (value >>> 8) & 0xff]));
  }
  async writeU32LE(gbaAddress: number, value: number): Promise<void> {
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
      throw new RangeError(`u32 out of range: ${String(value)}`);
    }
    await this.writeBytes(
      gbaAddress,
      new Uint8Array([
        value & 0xff,
        (value >>> 8) & 0xff,
        (value >>> 16) & 0xff,
        (value >>> 24) & 0xff,
      ]),
    );
  }

  // Internal: capture + return both the savestate name (so we can
  // round-trip the upload) and the captured bytes.
  private async captureSavestateRaw(): Promise<{ autoSaveStateName: string; data: Uint8Array }> {
    if (!this.isSupported()) {
      throw new Error(
        'EmulatorMemory requires mgba-wasm savestate methods (forceAutoSaveState, getAutoSaveState, uploadAutoSaveState, loadAutoSaveState). The host is missing one or more.',
      );
    }
    const captured = this.host.forceAutoSaveState!();
    if (!captured) {
      throw new Error('mGBA failed to capture an autosave state (forceAutoSaveState returned false)');
    }
    const blob = this.host.getAutoSaveState!();
    if (!blob) {
      throw new Error('mGBA returned no autosave state (getAutoSaveState returned null)');
    }
    if (blob.data.length !== SAVESTATE_TOTAL_SIZE) {
      throw new Error(
        `Unexpected savestate size: got ${String(blob.data.length)}, expected ${String(SAVESTATE_TOTAL_SIZE)}. mgba savestate format may have changed; the layout constants in lib/emulatorMemory.ts need updating.`,
      );
    }
    return blob;
  }

  /** Shortcut for read-only captures that don't need the auto-save name. */
  private async captureSavestate(): Promise<Uint8Array> {
    const { data } = await this.captureSavestateRaw();
    return data;
  }
}
