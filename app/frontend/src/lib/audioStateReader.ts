/**
 * Phase 9E - Audio state reader.
 *
 * Reads the GBA's M4A (Sappy) music-player state from IWRAM via the
 * existing savestate-patch bridge. Mirrors the pattern of
 * `battleStateReader.ts` (Phase 9C) for HP-bar polling.
 *
 * **What it reads.** Pokémon's audio engine keeps four
 * `struct MusicPlayerInfo` globals - one for background music
 * (`gMPlayInfo_BGM`) and three for sound effect slots
 * (`gMPlayInfo_SE1/2/3`). Each is 64 bytes (0x40). The struct
 * carries:
 *
 *   +0x00  songHeader  pointer to the song's compiled track table
 *                      in ROM (or 0 when nothing is playing)
 *   +0x04  status      u32 (bit 0 = playing, other bits = fade state)
 *   +0x08  trackCount  u8 (number of MIDI tracks active in the song)
 *   +0x09  priority    u8
 *   +0x0A  cmd         u8
 *   +0x0C  clock       u32 (advances 1/tick; resets to 0 on song
 *                      start - our beat counter)
 *   +0x18  memAccArea  pointer
 *   +0x1C  tempoD      u16
 *   +0x1E  tempoU      u16
 *   +0x20  tempoI      u16
 *   +0x22  tempoC      u16
 *   +0x24  fadeOI      u16
 *   +0x26  fadeOC      u16
 *   +0x28  fadeOV      u16
 *   +0x2C  tracks      pointer
 *   +0x30  tone        pointer
 *   +0x34  ident       u32 (0x68736D53 'MSsh' when initialised - 
 *                      sanity-check signature)
 *
 * **Addresses.** CFRU's `BPRE.ld` documents the canonical addresses
 * (same as vanilla FRLG - CFRU doesn't relocate the audio engine):
 *
 *   gMPlayInfo_BGM = 0x03007300  (IWRAM)
 *   gMPlayInfo_SE1 = 0x03007340
 *   gMPlayInfo_SE2 = 0x03007380
 *   gMPlayInfo_SE3 = 0x030073D0
 *
 * **What it does NOT do.** We don't read the song-table at
 * `gSongTable` to look up the track NAME - that's a ROM-side scan,
 * not a WRAM poll, and Phase 6's vanilla-truth overlay covers song
 * names by ID. The timeline UI resolves names via the symbol DB +
 * vanilla overlay.
 *
 * Read-only by design (per Phase 9E plan): no track-warp + no
 * track-switch. The user can hum along and click track names to
 * inspect; that's it.
 *
 * **Stability.** The struct layout is from pret/pokefirered's
 * `include/gba/m4a_internal.h` and is identical across vanilla
 * FRLG, CFRU, and CFRU+DPE (Skeli789's BPRE.ld pins it).
 */

import { EmulatorMemory, gbaAddressToRegion } from './emulatorMemory';
import type { EmulatorMemoryHost } from './emulatorMemory';

/** Documented vanilla FRLG + CFRU + CFRU+DPE addresses. */
export const FRLG_GMPLAYINFO_BGM_ADDR = 0x03007300;
export const FRLG_GMPLAYINFO_SE1_ADDR = 0x03007340;
export const FRLG_GMPLAYINFO_SE2_ADDR = 0x03007380;
export const FRLG_GMPLAYINFO_SE3_ADDR = 0x030073d0;

/** sizeof(struct MusicPlayerInfo) = 64 bytes. */
export const MUSIC_PLAYER_INFO_SIZE = 0x40;

/** Offsets within the struct (from pret/pokefirered m4a_internal.h). */
export const MPLAYINFO_OFFSETS = {
  songHeader: 0x00, // u32 pointer
  status: 0x04, // u32
  trackCount: 0x08, // u8
  priority: 0x09, // u8
  cmd: 0x0a, // u8
  clock: 0x0c, // u32
  memAccArea: 0x18, // u32 pointer
  tempoD: 0x1c, // u16
  tempoU: 0x1e, // u16
  tempoI: 0x20, // u16
  tempoC: 0x22, // u16
  fadeOI: 0x24, // u16
  fadeOC: 0x26, // u16
  fadeOV: 0x28, // u16
  tracks: 0x2c, // u32 pointer
  tone: 0x30, // u32 pointer
  ident: 0x34, // u32 signature
} as const;

/** Magic value at +0x34 once the player is initialised. We use this
 *  to differentiate "audio engine running" from "garbage memory we
 *  happened to read". From pret pret/pokefirered/src/m4a.c. */
export const MPLAYINFO_IDENT_SIGNATURE = 0x68736d53;

export interface MusicPlayerSnapshot {
  /** The struct's own address (0x03007300 for BGM, etc.). Helpful
   *  when callers want to disambiguate snapshots from different
   *  slots. */
  readonly addr: number;
  /** `songHeader` pointer - into ROM (0x08000000+) when playing,
   *  0 when idle. */
  readonly songHeaderPointer: number;
  /** `status` bitfield. status & 1 == playing. */
  readonly status: number;
  /** Number of MIDI tracks active in the playing song. */
  readonly trackCount: number;
  /** Priority byte. Higher wins on slot contention. */
  readonly priority: number;
  /** Last command byte the player executed. */
  readonly cmd: number;
  /** Monotonic clock - advances 1 tick per frame the player ran,
   *  resets on song start. Beats-elapsed counter for the UI. */
  readonly clock: number;
  /** Tempo: ticks-per-quarter-note (D) + reciprocal (U). The
   *  effective BPM = (60 × 1000 × tempoU) / (tempoD × 0x100).
   *  For the UI we just surface the raw fields. */
  readonly tempoD: number;
  readonly tempoU: number;
  /** Magic signature at +0x34. Equals MPLAYINFO_IDENT_SIGNATURE
   *  when the player is initialised. */
  readonly ident: number;
  /** True when the snapshot's `ident` matches the magic signature
   *  AND `songHeaderPointer` points into ROM. */
  readonly looksLikePlaying: boolean;
}

export interface AudioStateSnapshot {
  readonly bgm: MusicPlayerSnapshot | null;
  readonly se1: MusicPlayerSnapshot | null;
  readonly se2: MusicPlayerSnapshot | null;
  readonly se3: MusicPlayerSnapshot | null;
  /** True when at least one slot has a plausible currently-playing
   *  song. The timeline UI shows "no music" when this is false. */
  readonly anySlotPlaying: boolean;
}

function parseMusicPlayer(bytes: Uint8Array, slotAddr: number): MusicPlayerSnapshot {
  const u32 = (off: number): number =>
    (bytes[off]! | (bytes[off + 1]! << 8) | (bytes[off + 2]! << 16) | (bytes[off + 3]! << 24)) >>> 0;
  const u16 = (off: number): number => bytes[off]! | (bytes[off + 1]! << 8);
  const u8 = (off: number): number => bytes[off]!;
  const songHeaderPointer = u32(MPLAYINFO_OFFSETS.songHeader);
  const ident = u32(MPLAYINFO_OFFSETS.ident);
  const status = u32(MPLAYINFO_OFFSETS.status);
  // "Looks plausible" sanity:
  //  - ident has the magic value (engine initialised).
  //  - songHeaderPointer falls in ROM region (0x08000000..0x09FFFFFF).
  //  - status low bit set (playing) - note SE slots are idle most of
  //    the time so `looksLikePlaying` will be false for them in
  //    quiet moments. That's the desired UX.
  const isInRom =
    songHeaderPointer >= 0x08000000 && songHeaderPointer < 0x0a000000;
  const looksLikePlaying =
    ident === MPLAYINFO_IDENT_SIGNATURE && isInRom && (status & 1) !== 0;
  return {
    addr: slotAddr,
    songHeaderPointer,
    status,
    trackCount: u8(MPLAYINFO_OFFSETS.trackCount),
    priority: u8(MPLAYINFO_OFFSETS.priority),
    cmd: u8(MPLAYINFO_OFFSETS.cmd),
    clock: u32(MPLAYINFO_OFFSETS.clock),
    tempoD: u16(MPLAYINFO_OFFSETS.tempoD),
    tempoU: u16(MPLAYINFO_OFFSETS.tempoU),
    ident,
    looksLikePlaying,
  };
}

/**
 * Read all four MusicPlayerInfo slots in one round-trip. The four
 * addresses sit adjacent in IWRAM (0x03007300..0x030074D0), 256 bytes
 * contiguous - one savestate-patch read covers them all.
 *
 * Returns `null` for each slot when:
 *  - the host doesn't expose the savestate-patch API
 *    (`isSupported()` returns false), OR
 *  - the read itself throws (paused emulator, idb fault, etc.)
 *
 * @param host - the active mGBA-WASM emulator module (from
 *   `EmulatorHost.getActiveEmulatorModule()`).
 */
export async function readAudioState(host: EmulatorMemoryHost): Promise<AudioStateSnapshot> {
  // Quick region sanity: should never throw for these addresses, but
  // surface as a "no audio" snapshot rather than a runtime explosion.
  for (const a of [
    FRLG_GMPLAYINFO_BGM_ADDR,
    FRLG_GMPLAYINFO_SE1_ADDR,
    FRLG_GMPLAYINFO_SE2_ADDR,
    FRLG_GMPLAYINFO_SE3_ADDR,
  ]) {
    const r = gbaAddressToRegion(a);
    if (r.region !== 'iwram') {
      return { bgm: null, se1: null, se2: null, se3: null, anySlotPlaying: false };
    }
  }
  const mem = new EmulatorMemory(host);
  if (!mem.isSupported()) {
    return { bgm: null, se1: null, se2: null, se3: null, anySlotPlaying: false };
  }
  // 0x030073D0 + 0x40 = 0x03007410 → 0x110 bytes from BGM.
  const totalBytes = FRLG_GMPLAYINFO_SE3_ADDR + MUSIC_PLAYER_INFO_SIZE - FRLG_GMPLAYINFO_BGM_ADDR;
  let raw: Uint8Array;
  try {
    raw = await mem.readBytes(FRLG_GMPLAYINFO_BGM_ADDR, totalBytes);
  } catch {
    return { bgm: null, se1: null, se2: null, se3: null, anySlotPlaying: false };
  }
  const bgm = parseMusicPlayer(
    raw.subarray(0, MUSIC_PLAYER_INFO_SIZE),
    FRLG_GMPLAYINFO_BGM_ADDR,
  );
  const se1 = parseMusicPlayer(
    raw.subarray(
      FRLG_GMPLAYINFO_SE1_ADDR - FRLG_GMPLAYINFO_BGM_ADDR,
      FRLG_GMPLAYINFO_SE1_ADDR - FRLG_GMPLAYINFO_BGM_ADDR + MUSIC_PLAYER_INFO_SIZE,
    ),
    FRLG_GMPLAYINFO_SE1_ADDR,
  );
  const se2 = parseMusicPlayer(
    raw.subarray(
      FRLG_GMPLAYINFO_SE2_ADDR - FRLG_GMPLAYINFO_BGM_ADDR,
      FRLG_GMPLAYINFO_SE2_ADDR - FRLG_GMPLAYINFO_BGM_ADDR + MUSIC_PLAYER_INFO_SIZE,
    ),
    FRLG_GMPLAYINFO_SE2_ADDR,
  );
  const se3 = parseMusicPlayer(
    raw.subarray(
      FRLG_GMPLAYINFO_SE3_ADDR - FRLG_GMPLAYINFO_BGM_ADDR,
      FRLG_GMPLAYINFO_SE3_ADDR - FRLG_GMPLAYINFO_BGM_ADDR + MUSIC_PLAYER_INFO_SIZE,
    ),
    FRLG_GMPLAYINFO_SE3_ADDR,
  );
  return {
    bgm,
    se1,
    se2,
    se3,
    anySlotPlaying:
      bgm.looksLikePlaying ||
      se1.looksLikePlaying ||
      se2.looksLikePlaying ||
      se3.looksLikePlaying,
  };
}
