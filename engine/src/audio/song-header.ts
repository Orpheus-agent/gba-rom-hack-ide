/**
 * Gen-3 SAPPY / MPlayDef song-header parser.
 *
 * The Gen-3 sound engine (commonly called "M4A" or "SAPPY") stores each
 * song as a flat in-ROM struct whose shape is shared across every
 * vanilla Gen-3 cart, every decomp build (pret/pokefirered, pret/
 * pokeemerald), and the typical hacks/forks built on those - the music
 * engine is rarely re-implemented because the Game Boy Advance sound
 * driver lives in the BIOS/ROM and re-using the same engine is the
 * path of least resistance for any hack.
 *
 *   struct SongHeader {
 *     u8 trackCount;            // 0x00 - number of MusicPlayerTrack pointers
 *     u8 blockCount;            // 0x01 - (often 0 in vanilla)
 *     u8 priority;              // 0x02
 *     u8 reverb;                // 0x03
 *     ToneData *toneGroupPtr;   // 0x04 - voice-group / tone-group pointer
 *     MusicPlayerTrack *track[trackCount]; // 0x08… - each track pointer
 *   };
 *
 * Total bytes on-disk = 4 + 4 + trackCount * 4 = 8 + trackCount * 4.
 *
 * PD 5: structural-only detection - every constraint validates a shape
 * (plausible track count, voice-group pointer is a valid in-ROM
 * address, every track pointer is valid in-ROM). Works on any Gen-3
 * cart whose music engine is intact; we never hard-code a song-table
 * location.
 */

import { GBA_ROM_BASE_ADDRESS } from '../pointers/index.js';

/** Fixed-prefix size of a SongHeader (before the track-pointer array). */
export const SONG_HEADER_FIXED_PREFIX_BYTES = 8;
/** Plausible upper bound on a Gen-3 song's track count. Vanilla songs
 *  range 1..10; the mp2k engine documents a 16-channel hardware limit;
 *  setting 32 captures heavy hacks that double-up. */
export const SONG_HEADER_MAX_TRACK_COUNT = 32;
/** Plausible upper bound on the blockCount byte. */
export const SONG_HEADER_MAX_BLOCK_COUNT = 64;

export interface SongHeader {
  readonly trackCount: number;
  readonly blockCount: number;
  readonly priority: number;
  readonly reverb: number;
  /** File offset of the voice-group (tone-group) pointer's target. */
  readonly voiceGroupOffset: number;
  /** File offset of each MusicPlayerTrack pointer's target, in order. */
  readonly trackOffsets: ReadonlyArray<number>;
  /** ROM file offset of the SongHeader struct itself. */
  readonly fileOffset: number;
  /** Total bytes occupied by this header on-disk
   *  (= 8 + trackCount * 4). */
  readonly byteLength: number;
}

export type SongHeaderParseFailure =
  | { kind: 'too_short'; bytesAvailable: number; bytesRequired: number }
  | { kind: 'implausible_track_count'; observed: number; max: number }
  | { kind: 'implausible_block_count'; observed: number; max: number }
  | { kind: 'invalid_voice_group_pointer'; rawAddress: number }
  | { kind: 'invalid_track_pointer'; trackIndex: number; rawAddress: number };

export type SongHeaderParseResult =
  | { ok: true; header: SongHeader }
  | { ok: false; failure: SongHeaderParseFailure };

/**
 * Parse a SAPPY SongHeader at `offset` into `bytes`. Returns ok=true
 * only when the structural constraints are satisfied:
 *  - trackCount ∈ [1, SONG_HEADER_MAX_TRACK_COUNT]
 *  - blockCount ≤ SONG_HEADER_MAX_BLOCK_COUNT
 *  - voice-group pointer is a valid in-ROM address (high byte 0x08/0x09,
 *    target inside bytes)
 *  - every track pointer is a valid in-ROM address
 */
export function parseSongHeader(bytes: Uint8Array, offset: number): SongHeaderParseResult {
  if (offset < 0 || offset + SONG_HEADER_FIXED_PREFIX_BYTES > bytes.length) {
    return {
      ok: false,
      failure: {
        kind: 'too_short',
        bytesAvailable: Math.max(0, bytes.length - offset),
        bytesRequired: SONG_HEADER_FIXED_PREFIX_BYTES,
      },
    };
  }

  const trackCount = bytes[offset + 0x00] ?? 0;
  const blockCount = bytes[offset + 0x01] ?? 0;
  const priority = bytes[offset + 0x02] ?? 0;
  const reverb = bytes[offset + 0x03] ?? 0;

  if (trackCount < 1 || trackCount > SONG_HEADER_MAX_TRACK_COUNT) {
    return {
      ok: false,
      failure: {
        kind: 'implausible_track_count',
        observed: trackCount,
        max: SONG_HEADER_MAX_TRACK_COUNT,
      },
    };
  }
  if (blockCount > SONG_HEADER_MAX_BLOCK_COUNT) {
    return {
      ok: false,
      failure: {
        kind: 'implausible_block_count',
        observed: blockCount,
        max: SONG_HEADER_MAX_BLOCK_COUNT,
      },
    };
  }

  const byteLength = SONG_HEADER_FIXED_PREFIX_BYTES + trackCount * 4;
  if (offset + byteLength > bytes.length) {
    return {
      ok: false,
      failure: {
        kind: 'too_short',
        bytesAvailable: bytes.length - offset,
        bytesRequired: byteLength,
      },
    };
  }

  const voiceGroup = resolveRomPointer(bytes, offset + 0x04);
  if (voiceGroup === null) {
    return {
      ok: false,
      failure: {
        kind: 'invalid_voice_group_pointer',
        rawAddress: readUint32Le(bytes, offset + 0x04),
      },
    };
  }

  const trackOffsets: number[] = [];
  for (let i = 0; i < trackCount; i++) {
    const tOff = resolveRomPointer(bytes, offset + 0x08 + i * 4);
    if (tOff === null) {
      return {
        ok: false,
        failure: {
          kind: 'invalid_track_pointer',
          trackIndex: i,
          rawAddress: readUint32Le(bytes, offset + 0x08 + i * 4),
        },
      };
    }
    trackOffsets.push(tOff);
  }

  return {
    ok: true,
    header: Object.freeze({
      trackCount,
      blockCount,
      priority,
      reverb,
      voiceGroupOffset: voiceGroup,
      trackOffsets: Object.freeze(trackOffsets),
      fileOffset: offset,
      byteLength,
    }),
  };
}

/** Resolve a 32-bit LE GBA ROM pointer at `offset` to a file offset.
 *  Returns null if the pointer's high byte is not 0x08/0x09 or the
 *  resulting file offset falls outside `bytes`. NULL (raw 0) is NOT
 *  accepted - the caller must check this themselves. */
function resolveRomPointer(bytes: Uint8Array, offset: number): number | null {
  if (offset + 4 > bytes.length) return null;
  const raw = readUint32Le(bytes, offset);
  if (raw === 0) return null;
  const high = (raw >>> 24) & 0xff;
  if (high !== 0x08 && high !== 0x09) return null;
  const fileOffset = raw - GBA_ROM_BASE_ADDRESS;
  if (fileOffset < 0 || fileOffset >= bytes.length) return null;
  return fileOffset;
}

function readUint32Le(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) |
      ((bytes[offset + 1] ?? 0) << 8) |
      ((bytes[offset + 2] ?? 0) << 16) |
      ((bytes[offset + 3] ?? 0) << 24)) >>>
    0
  );
}
