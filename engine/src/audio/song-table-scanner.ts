/**
 * gSongTable scanner - Gen-3 sound-engine song-table detection.
 *
 * The Gen-3 SAPPY engine references every song via a flat in-ROM array
 * named `gSongTable` in the pret decomps. Each entry is 8 bytes:
 *
 *   struct Song {
 *     SongHeader *header;   // 0x00 - pointer to SongHeader struct
 *     u16 ms;               // 0x04 - music-select context (sound bank id)
 *     u16 me;               // 0x06 - misc / sound bank backup
 *   };
 *
 * Standard table layout: entry 0 is conventionally MUS_DUMMY (header
 * points at a no-op song); the table extends until the end of the
 * songs and the rest of the structure is sound-effect ids. Many hacks
 * extend or repoint the table - there's no canonical ROM offset.
 *
 * Detection approach (PD 5: no baked offsets):
 *  - 4-byte stride scan over the ROM.
 *  - At each candidate, greedy-walk consecutive 8-byte entries; each
 *    entry's header pointer must resolve to a valid in-ROM SongHeader
 *    (validated by parseSongHeader).
 *  - Stop when (a) an entry has a NULL header pointer (sentinel - many
 *    hacks zero-terminate; vanilla typically doesn't), (b) the next
 *    entry fails to validate, or (c) `maxSongsInTable` cap is reached.
 *  - Accept the run as the song table iff ≥ minSongsInTable entries
 *    succeeded.
 *
 * The first such run wins (real Gen-3 carts have exactly one
 * `gSongTable`).
 *
 * Performance budget: ~50–80 ms for a 16 MiB ROM. The expensive step
 * is per-candidate SongHeader parse; the structural rejection in
 * `parseSongHeader` (track count + voice pointer) ends most candidates
 * in <100 ns.
 */

import { GBA_ROM_BASE_ADDRESS } from '../pointers/index.js';
import { parseSongHeader, type SongHeader } from './song-header.js';

/** Bytes per gSongTable entry (`{u32 headerPtr, u16 ms, u16 me}`). */
export const SONG_TABLE_ENTRY_SIZE_BYTES = 8;

export interface SongTableEntry {
  /** File offset of THIS table entry (not the SongHeader it points at). */
  readonly entryFileOffset: number;
  /** Index of the entry within the table (0-based). */
  readonly index: number;
  /** ms field (sound-bank selection). */
  readonly ms: number;
  /** me field (misc). */
  readonly me: number;
  /** The parsed SongHeader the entry's headerPtr resolved to. */
  readonly header: SongHeader;
}

export interface SongTable {
  /** ROM file offset of the table start (entry 0). */
  readonly tableStart: number;
  /** Exclusive end offset (includes the sentinel entry if hit). */
  readonly tableEndExclusive: number;
  /** Number of valid (non-sentinel) entries found. */
  readonly entryCount: number;
  /** Each entry, in table order. */
  readonly entries: ReadonlyArray<SongTableEntry>;
  /** Whether the table run terminated at a NULL-pointer sentinel. */
  readonly sentinelTerminated: boolean;
}

export interface ScanSongTableOptions {
  /** Minimum entries to claim a run is the song table. Default 3. */
  readonly minSongsInTable?: number;
  /** Cap on entries walked per candidate. Default 4096. */
  readonly maxSongsInTable?: number;
}

/**
 * Find the gSongTable structurally. Returns null if no convincing run
 * of song-table entries exists.
 */
export function scanSongTable(
  bytes: Uint8Array,
  opts?: ScanSongTableOptions,
): SongTable | null {
  const minSongsInTable = opts?.minSongsInTable ?? 3;
  const maxSongsInTable = opts?.maxSongsInTable ?? 4096;
  if (!Number.isInteger(minSongsInTable) || minSongsInTable < 1) {
    throw new Error(
      `minSongsInTable must be a positive integer, got ${String(minSongsInTable)}`,
    );
  }
  if (!Number.isInteger(maxSongsInTable) || maxSongsInTable < minSongsInTable) {
    throw new Error(
      `maxSongsInTable must be >= minSongsInTable, got ${String(maxSongsInTable)}`,
    );
  }

  const stride = 4;
  const limit = bytes.length - SONG_TABLE_ENTRY_SIZE_BYTES;
  for (let candidateStart = 0; candidateStart <= limit; candidateStart += stride) {
    const entries: SongTableEntry[] = [];
    let sentinelTerminated = false;
    let cursor = candidateStart;

    while (entries.length < maxSongsInTable) {
      if (cursor + SONG_TABLE_ENTRY_SIZE_BYTES > bytes.length) break;
      const rawHeaderPtr = readUint32Le(bytes, cursor);

      // NULL header pointer = end-of-table sentinel.
      if (rawHeaderPtr === 0) {
        sentinelTerminated = true;
        cursor += SONG_TABLE_ENTRY_SIZE_BYTES;
        break;
      }

      const high = (rawHeaderPtr >>> 24) & 0xff;
      if (high !== 0x08 && high !== 0x09) break;
      const headerFileOffset = rawHeaderPtr - GBA_ROM_BASE_ADDRESS;
      if (headerFileOffset < 0 || headerFileOffset >= bytes.length) break;

      const parsed = parseSongHeader(bytes, headerFileOffset);
      if (!parsed.ok) break;

      const ms = readUint16Le(bytes, cursor + 0x04);
      const me = readUint16Le(bytes, cursor + 0x06);
      entries.push(
        Object.freeze({
          entryFileOffset: cursor,
          index: entries.length,
          ms,
          me,
          header: parsed.header,
        }),
      );
      cursor += SONG_TABLE_ENTRY_SIZE_BYTES;
    }

    if (entries.length >= minSongsInTable) {
      return Object.freeze({
        tableStart: candidateStart,
        tableEndExclusive: cursor,
        entryCount: entries.length,
        entries: Object.freeze(entries),
        sentinelTerminated,
      });
    }
  }
  return null;
}

function readUint16Le(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8)) >>> 0;
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
