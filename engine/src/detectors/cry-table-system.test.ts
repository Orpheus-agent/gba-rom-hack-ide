import { describe, expect, it } from 'vitest';
import { CoverageMap } from '../coverage/index.js';
import { loadRomFromBytes } from '../rom/index.js';
import { GBA_ROM_BASE_ADDRESS } from '../pointers/index.js';
import { CRY_ENTRY_SIZE_BYTES } from '../audio/cry-table.js';
import { CRY_TABLE_DETECTOR_ID, cryTableDetector } from './cry-table-system.js';

function plantCryTable(buf: Uint8Array, offset: number, count: number): void {
  for (let i = 0; i < count; i++) {
    const start = offset + i * CRY_ENTRY_SIZE_BYTES;
    buf[start + 0] = 0x00;
    buf[start + 1] = 60;
    buf[start + 2] = 0;
    buf[start + 3] = 0;
    const wavAddr = (GBA_ROM_BASE_ADDRESS + 0x4000 + i * 0x10) >>> 0;
    buf[start + 4] = wavAddr & 0xff;
    buf[start + 5] = (wavAddr >>> 8) & 0xff;
    buf[start + 6] = (wavAddr >>> 16) & 0xff;
    buf[start + 7] = (wavAddr >>> 24) & 0xff;
    buf[start + 8] = 5;
    buf[start + 9] = 10;
    buf[start + 10] = 60;
    buf[start + 11] = 15;
  }
}

function plantMinimalHeader(buf: Uint8Array): void {
  buf[0xb2] = 0x96;
}

function fillNoise(buf: Uint8Array, fromOffset: number, toOffsetExclusive: number): void {
  for (let i = fromOffset; i < toOffsetExclusive; i++) {
    buf[i] = 0xff;
  }
}

describe('cryTableDetector', () => {
  it('exports the universal RomDetector contract', () => {
    expect(cryTableDetector.id).toBe(CRY_TABLE_DETECTOR_ID);
    expect(typeof cryTableDetector.name).toBe('string');
    expect(cryTableDetector.phase).toBe(9);
    expect(typeof cryTableDetector.detect).toBe('function');
  });

  it('returns not_detected when no anchor matches', () => {
    const bytes = new Uint8Array(64 * 1024);
    plantMinimalHeader(bytes);
    fillNoise(bytes, 0xc0, bytes.length);
    const rom = loadRomFromBytes({ bytes, sourcePath: 'test://no-cries', synthetic: true });
    const cov = new CoverageMap(bytes.length);
    const r = cryTableDetector.detect(rom, cov);
    expect(r.status).toBe('not_detected');
    if (r.status === 'not_detected') {
      expect(r.reason).toContain('No Gen-3 gCryTable');
    }
  });

  it('detects a 200-entry planted cry table + registers coverage', () => {
    const bytes = new Uint8Array(64 * 1024);
    plantMinimalHeader(bytes);
    fillNoise(bytes, 0xc0, bytes.length);
    plantCryTable(bytes, 0x1000, 200);
    fillNoise(bytes, 0x1000 + 200 * CRY_ENTRY_SIZE_BYTES, bytes.length);
    const rom = loadRomFromBytes({ bytes, sourcePath: 'test://cries', synthetic: true });
    const cov = new CoverageMap(bytes.length);
    const r = cryTableDetector.detect(rom, cov);
    expect(r.status).toBe('detected');
    if (r.status === 'detected') {
      expect(r.data.tableOffset).toBe(0x1000);
      expect(r.data.entryCount).toBe(200);
      expect(r.data.tableByteLength).toBe(200 * CRY_ENTRY_SIZE_BYTES);
      // sampleNames length capped at 16 (preview)
      expect(r.data.sampleNames.length).toBe(16);
      // First entry's sampleNames should be the wav offset 0x4000 as hex.
      expect(r.data.sampleNames[0]).toBe('0x004000');
      expect(r.data.sampleNames[1]).toBe('0x004010');
    }
    const report = cov.report();
    const regions = report.regions.filter((rgn) =>
      rgn.provenance?.includes(CRY_TABLE_DETECTOR_ID),
    );
    expect(regions.length).toBe(1);
    expect(regions[0]?.start).toBe(0x1000);
    expect(regions[0]?.probableClass).toBe('table');
  });

  it('confidence scales with entry count (>= 300 → 0.95)', () => {
    const bytes = new Uint8Array(128 * 1024);
    plantMinimalHeader(bytes);
    fillNoise(bytes, 0xc0, bytes.length);
    plantCryTable(bytes, 0x1000, 350);
    fillNoise(bytes, 0x1000 + 350 * CRY_ENTRY_SIZE_BYTES, bytes.length);
    const rom = loadRomFromBytes({ bytes, sourcePath: 'test://350', synthetic: true });
    const cov = new CoverageMap(bytes.length);
    const r = cryTableDetector.detect(rom, cov);
    expect(r.status).toBe('detected');
    if (r.status === 'detected') {
      expect(r.confidence).toBe(0.95);
    }
  });

  it('result.data is frozen + sampleNames includes silent placeholder for NULL wav', () => {
    const bytes = new Uint8Array(64 * 1024);
    plantMinimalHeader(bytes);
    fillNoise(bytes, 0xc0, bytes.length);
    plantCryTable(bytes, 0x1000, 200);
    // Zero the very first entry's wav pointer so sampleNames[0] = '(silent)'.
    for (let i = 4; i < 8; i++) bytes[0x1000 + i] = 0;
    fillNoise(bytes, 0x1000 + 200 * CRY_ENTRY_SIZE_BYTES, bytes.length);
    const rom = loadRomFromBytes({ bytes, sourcePath: 'test://frozen', synthetic: true });
    const cov = new CoverageMap(bytes.length);
    const r = cryTableDetector.detect(rom, cov);
    expect(r.status).toBe('detected');
    if (r.status === 'detected') {
      expect(Object.isFrozen(r.data)).toBe(true);
      expect(Object.isFrozen(r.data.sampleNames)).toBe(true);
      expect(r.data.sampleNames[0]).toBe('(silent)');
      expect(r.data.sampleNames[1]).toBe('0x004010');
    }
  });
});
