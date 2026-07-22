import { describe, expect, it } from 'vitest';
import { CoverageMap } from '../coverage/index.js';
import { GBA_ROM_BASE_ADDRESS } from '../pointers/index.js';
import { loadRomFromBytes } from '../rom/loader.js';
import {
  AUDIO_SYSTEM_DETECTOR_ID,
  audioSystemDetector,
  type AudioSystemReport,
} from './audio-system.js';

/** Plant a minimal 1-track SongHeader at `at`. Writes 12 bytes. */
function plantSongHeader(buf: Buffer, at: number, voiceGroupAt = 0x100): void {
  buf[at + 0x00] = 1;
  buf[at + 0x01] = 0;
  buf[at + 0x02] = 0x80;
  buf[at + 0x03] = 0;
  buf.writeUInt32LE((GBA_ROM_BASE_ADDRESS + voiceGroupAt) >>> 0, at + 0x04);
  buf.writeUInt32LE((GBA_ROM_BASE_ADDRESS + voiceGroupAt + 0x100) >>> 0, at + 0x08);
}

describe('audioSystemDetector', () => {
  it('has stable id, name, phase=5', () => {
    expect(audioSystemDetector.id).toBe(AUDIO_SYSTEM_DETECTOR_ID);
    expect(audioSystemDetector.phase).toBe(5);
    expect(audioSystemDetector.name.length).toBeGreaterThan(0);
  });

  it('returns not_detected for an all-zero ROM (no songs)', async () => {
    const rom = loadRomFromBytes({ bytes: Buffer.alloc(8192) });
    const coverage = new CoverageMap(rom.byteLength);
    const result = audioSystemDetector.detect(rom, coverage);
    expect(result.status).toBe('not_detected');
    if (result.status === 'not_detected') {
      expect(result.reason.length).toBeGreaterThan(0);
      expect(result.evidence.length).toBeGreaterThan(0);
    }
  });

  it('returns detected with a planted 3-song table', async () => {
    const buf = Buffer.alloc(0x4000);
    const tableAt = 0x500;
    const songOffsets = [0x1000, 0x1100, 0x1200];
    for (const off of songOffsets) plantSongHeader(buf, off);
    for (let i = 0; i < 3; i++) {
      buf.writeUInt32LE((GBA_ROM_BASE_ADDRESS + songOffsets[i]!) >>> 0, tableAt + i * 8);
      buf.writeUInt16LE(i, tableAt + i * 8 + 4);
      buf.writeUInt16LE(i * 2, tableAt + i * 8 + 6);
    }
    // Sentinel at offset tableAt + 3*8 = 0x518. Bytes are already 0.

    const rom = loadRomFromBytes({ bytes: buf });
    const coverage = new CoverageMap(rom.byteLength);
    const result = audioSystemDetector.detect(rom, coverage);
    expect(result.status).toBe('detected');
    if (result.status === 'detected') {
      const data = result.data as AudioSystemReport;
      expect(data.songCount).toBe(3);
      expect(data.songTable.tableStart).toBe(tableAt);
      expect(data.songTable.sentinelTerminated).toBe(true);
      expect(data.songTable.entries[0]?.ms).toBe(0);
      expect(data.songTable.entries[1]?.ms).toBe(1);
    }
  });

  it('registers song table + each song header as audio coverage', async () => {
    const buf = Buffer.alloc(0x4000);
    const tableAt = 0x500;
    const songOffsets = [0x1000, 0x1100, 0x1200];
    for (const off of songOffsets) plantSongHeader(buf, off);
    for (let i = 0; i < 3; i++) {
      buf.writeUInt32LE((GBA_ROM_BASE_ADDRESS + songOffsets[i]!) >>> 0, tableAt + i * 8);
    }
    const rom = loadRomFromBytes({ bytes: buf });
    const coverage = new CoverageMap(rom.byteLength);
    audioSystemDetector.detect(rom, coverage);
    const audioRegions = coverage.report().regions.filter(
      (r) => r.kind === 'classified' && r.probableClass === 'audio',
    );
    // 1 region for the table + 3 regions for the 3 song headers = 4
    expect(audioRegions.length).toBe(4);
    const tableRegion = audioRegions.find((r) => r.start === tableAt);
    expect(tableRegion).toBeDefined();
  });
});
