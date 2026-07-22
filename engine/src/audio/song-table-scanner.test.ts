import { describe, expect, it } from 'vitest';
import { GBA_ROM_BASE_ADDRESS } from '../pointers/index.js';
import {
  SONG_TABLE_ENTRY_SIZE_BYTES as ENTRY,
  scanSongTable,
} from './song-table-scanner.js';

/** Plant a valid 1-track SongHeader at `at` (writes 12 bytes).
 *  voiceGroupAt and trackAt default to nearby offsets in-buffer. */
function plantHeader(buf: Buffer, at: number, opts?: {
  trackCount?: number;
  voiceGroupAt?: number;
  trackAt?: ReadonlyArray<number>;
}): void {
  const trackCount = opts?.trackCount ?? 1;
  buf[at + 0x00] = trackCount;
  buf[at + 0x01] = 0; // blockCount
  buf[at + 0x02] = 0x80; // priority
  buf[at + 0x03] = 0; // reverb
  buf.writeUInt32LE((GBA_ROM_BASE_ADDRESS + (opts?.voiceGroupAt ?? 0x100)) >>> 0, at + 0x04);
  for (let i = 0; i < trackCount; i++) {
    const trackOff = opts?.trackAt?.[i] ?? 0x200 + i * 0x40;
    buf.writeUInt32LE((GBA_ROM_BASE_ADDRESS + trackOff) >>> 0, at + 0x08 + i * 4);
  }
}

/** Plant a song-table entry at `at`: u32 headerPtr + u16 ms + u16 me. */
function plantEntry(
  buf: Buffer,
  at: number,
  headerAt: number,
  ms: number,
  me: number,
): void {
  buf.writeUInt32LE((GBA_ROM_BASE_ADDRESS + headerAt) >>> 0, at + 0x00);
  buf.writeUInt16LE(ms, at + 0x04);
  buf.writeUInt16LE(me, at + 0x06);
}

function plantSentinel(buf: Buffer, at: number): void {
  buf.writeUInt32LE(0, at + 0x00);
  buf.writeUInt16LE(0, at + 0x04);
  buf.writeUInt16LE(0, at + 0x06);
}

describe('scanSongTable - happy paths', () => {
  it('finds a 3-entry sentinel-terminated table', () => {
    const buf = Buffer.alloc(0x4000);
    const tableAt = 0x500;
    // Plant 3 song headers well after the table.
    const headerOffsets = [0x1000, 0x1100, 0x1200];
    for (const off of headerOffsets) plantHeader(buf, off);
    for (let i = 0; i < 3; i++) {
      plantEntry(buf, tableAt + i * ENTRY, headerOffsets[i]!, i, i * 2);
    }
    plantSentinel(buf, tableAt + 3 * ENTRY);

    const r = scanSongTable(buf);
    expect(r).not.toBeNull();
    if (r !== null) {
      expect(r.tableStart).toBe(tableAt);
      expect(r.entryCount).toBe(3);
      expect(r.sentinelTerminated).toBe(true);
      // Extent: 3 entries + 1 sentinel = 4 × 8 = 32 bytes
      expect(r.tableEndExclusive).toBe(tableAt + 4 * ENTRY);
      expect(r.entries[0]?.header.trackCount).toBe(1);
      expect(r.entries[0]?.ms).toBe(0);
      expect(r.entries[1]?.ms).toBe(1);
      expect(r.entries[2]?.me).toBe(4);
    }
  });

  it('finds a table without a sentinel (next entry fails to parse)', () => {
    const buf = Buffer.alloc(0x4000);
    const tableAt = 0x500;
    const headerOffsets = [0x1000, 0x1100, 0x1200];
    for (const off of headerOffsets) plantHeader(buf, off);
    for (let i = 0; i < 3; i++) {
      plantEntry(buf, tableAt + i * ENTRY, headerOffsets[i]!, i, 0);
    }
    // The bytes after the table are 0-fill - first u32 = 0 → sentinel.
    // To test the non-sentinel exit, plant a garbage non-zero u32 that
    // resolves to a non-ROM address.
    buf.writeUInt32LE(0x02000000, tableAt + 3 * ENTRY); // EWRAM ptr

    const r = scanSongTable(buf);
    expect(r).not.toBeNull();
    if (r !== null) {
      expect(r.entryCount).toBe(3);
      expect(r.sentinelTerminated).toBe(false);
      expect(r.tableEndExclusive).toBe(tableAt + 3 * ENTRY);
    }
  });

  it('result + entries are frozen', () => {
    const buf = Buffer.alloc(0x4000);
    const tableAt = 0x500;
    for (let i = 0; i < 3; i++) plantHeader(buf, 0x1000 + i * 0x100);
    for (let i = 0; i < 3; i++) plantEntry(buf, tableAt + i * ENTRY, 0x1000 + i * 0x100, 0, 0);
    plantSentinel(buf, tableAt + 3 * ENTRY);
    const r = scanSongTable(buf);
    if (r !== null) {
      expect(Object.isFrozen(r)).toBe(true);
      expect(Object.isFrozen(r.entries)).toBe(true);
      expect(Object.isFrozen(r.entries[0])).toBe(true);
    }
  });
});

describe('scanSongTable - rejection cases', () => {
  it('returns null when no run meets minSongsInTable', () => {
    const buf = Buffer.alloc(0x4000);
    const tableAt = 0x500;
    // Only 2 valid entries (default min is 3).
    for (let i = 0; i < 2; i++) plantHeader(buf, 0x1000 + i * 0x100);
    for (let i = 0; i < 2; i++) plantEntry(buf, tableAt + i * ENTRY, 0x1000 + i * 0x100, 0, 0);
    plantSentinel(buf, tableAt + 2 * ENTRY);
    expect(scanSongTable(buf)).toBeNull();
  });

  it('returns null for an empty buffer', () => {
    expect(scanSongTable(new Uint8Array(0))).toBeNull();
  });

  it('honors minSongsInTable=2 option', () => {
    const buf = Buffer.alloc(0x4000);
    const tableAt = 0x500;
    for (let i = 0; i < 2; i++) plantHeader(buf, 0x1000 + i * 0x100);
    for (let i = 0; i < 2; i++) plantEntry(buf, tableAt + i * ENTRY, 0x1000 + i * 0x100, 0, 0);
    plantSentinel(buf, tableAt + 2 * ENTRY);
    const r = scanSongTable(buf, { minSongsInTable: 2 });
    expect(r).not.toBeNull();
    if (r !== null) expect(r.entryCount).toBe(2);
  });

  it('throws on invalid minSongsInTable=0', () => {
    expect(() =>
      scanSongTable(new Uint8Array(100), { minSongsInTable: 0 }),
    ).toThrow();
  });

  it('throws when maxSongsInTable < minSongsInTable', () => {
    expect(() =>
      scanSongTable(new Uint8Array(100), {
        minSongsInTable: 3,
        maxSongsInTable: 2,
      }),
    ).toThrow();
  });
});
