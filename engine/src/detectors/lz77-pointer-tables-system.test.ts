import { describe, expect, it } from 'vitest';
import { CoverageMap } from '../coverage/index.js';
import { loadRomFromBytes } from '../rom/index.js';
import { GBA_ROM_BASE_ADDRESS } from '../pointers/index.js';
import { LZ77_HEADER_FIRST_BYTE } from '../compression/lz77.js';
import {
  LZ77_POINTER_TABLES_DETECTOR_ID,
  lz77PointerTablesDetector,
} from './lz77-pointer-tables-system.js';

function plantLz77Block(
  buf: Uint8Array,
  offset: number,
  decompressedSize: number,
  payloadBytes: number = 16,
): number {
  buf[offset] = LZ77_HEADER_FIRST_BYTE;
  buf[offset + 1] = decompressedSize & 0xff;
  buf[offset + 2] = (decompressedSize >>> 8) & 0xff;
  buf[offset + 3] = (decompressedSize >>> 16) & 0xff;
  for (let i = 0; i < payloadBytes; i++) {
    buf[offset + 4 + i] = (i * 7 + 1) & 0xff;
  }
  return offset + 4 + payloadBytes;
}

function plantLz77PointerTable(
  buf: Uint8Array,
  tableOffset: number,
  count: number,
  lz77RegionStart: number,
  decompSize: number = 256,
): { tableEndExclusive: number; lz77RegionEndExclusive: number } {
  let cursor = lz77RegionStart;
  for (let i = 0; i < count; i++) {
    const blockAddr = (GBA_ROM_BASE_ADDRESS + cursor) >>> 0;
    const slot = tableOffset + i * 4;
    buf[slot + 0] = blockAddr & 0xff;
    buf[slot + 1] = (blockAddr >>> 8) & 0xff;
    buf[slot + 2] = (blockAddr >>> 16) & 0xff;
    buf[slot + 3] = (blockAddr >>> 24) & 0xff;
    cursor = plantLz77Block(buf, cursor, decompSize);
  }
  return {
    tableEndExclusive: tableOffset + count * 4,
    lz77RegionEndExclusive: cursor,
  };
}

function plantMinimalHeader(buf: Uint8Array): void {
  buf[0xb2] = 0x96;
}

function fillNoise(buf: Uint8Array, fromOffset: number, toOffsetExclusive: number): void {
  for (let i = fromOffset; i < toOffsetExclusive; i++) {
    buf[i] = 0xff;
  }
}

describe('lz77PointerTablesDetector', () => {
  it('exports the universal RomDetector contract', () => {
    expect(lz77PointerTablesDetector.id).toBe(LZ77_POINTER_TABLES_DETECTOR_ID);
    expect(typeof lz77PointerTablesDetector.name).toBe('string');
    expect(lz77PointerTablesDetector.phase).toBe(8);
    expect(typeof lz77PointerTablesDetector.detect).toBe('function');
  });

  it('returns not_detected when no tables are present', () => {
    const bytes = new Uint8Array(128 * 1024);
    plantMinimalHeader(bytes);
    fillNoise(bytes, 0xc0, bytes.length);
    const rom = loadRomFromBytes({ bytes, sourcePath: 'test://no-lz77', synthetic: true });
    const cov = new CoverageMap(bytes.length);
    const r = lz77PointerTablesDetector.detect(rom, cov);
    expect(r.status).toBe('not_detected');
    if (r.status === 'not_detected') {
      expect(r.reason).toContain('No Gen-3 LZ77-pointer tables');
    }
  });

  it('detects a 50-entry planted LZ77-pointer table + registers coverage', () => {
    const bytes = new Uint8Array(128 * 1024);
    plantMinimalHeader(bytes);
    fillNoise(bytes, 0xc0, bytes.length);
    const planted = plantLz77PointerTable(bytes, 0x1000, 50, 0x2000, 1024);
    fillNoise(bytes, planted.tableEndExclusive, 0x2000);
    fillNoise(bytes, planted.lz77RegionEndExclusive, bytes.length);
    const rom = loadRomFromBytes({ bytes, sourcePath: 'test://tables', synthetic: true });
    const cov = new CoverageMap(bytes.length);
    const r = lz77PointerTablesDetector.detect(rom, cov);
    expect(r.status).toBe('detected');
    if (r.status === 'detected') {
      expect(r.data.tableCount).toBe(1);
      expect(r.data.totalPointerEntries).toBe(50);
      expect(r.data.tables[0]?.entryCount).toBe(50);
      expect(r.data.sampleNames.length).toBe(8);
      // First entry's sampleName should mention 0x002000 + decompressed=1024.
      expect(r.data.sampleNames[0]).toContain('0x002000');
      expect(r.data.sampleNames[0]).toContain('decompressed=1024');
    }
    const report = cov.report();
    const regions = report.regions.filter((rgn) =>
      rgn.provenance?.includes(LZ77_POINTER_TABLES_DETECTOR_ID),
    );
    expect(regions.length).toBe(1);
    expect(regions[0]?.probableClass).toBe('pointer-network');
  });

  it('detects multiple tables + sampleNames comes from the LARGEST', () => {
    const bytes = new Uint8Array(256 * 1024);
    plantMinimalHeader(bytes);
    fillNoise(bytes, 0xc0, bytes.length);
    const small = plantLz77PointerTable(bytes, 0x1000, 15, 0x2000, 64);
    fillNoise(bytes, small.tableEndExclusive, 0x2000);
    fillNoise(bytes, small.lz77RegionEndExclusive, 0x10000);
    const big = plantLz77PointerTable(bytes, 0x10000, 60, 0x12000, 2048);
    fillNoise(bytes, big.tableEndExclusive, 0x12000);
    fillNoise(bytes, big.lz77RegionEndExclusive, bytes.length);
    const rom = loadRomFromBytes({ bytes, sourcePath: 'test://multi', synthetic: true });
    const cov = new CoverageMap(bytes.length);
    const r = lz77PointerTablesDetector.detect(rom, cov);
    expect(r.status).toBe('detected');
    if (r.status === 'detected') {
      expect(r.data.tableCount).toBe(2);
      expect(r.data.totalPointerEntries).toBe(75);
      expect(r.data.tables[0]?.entryCount).toBe(60);
      // sampleNames from largest (decompSize=2048).
      expect(r.data.sampleNames[0]).toContain('decompressed=2048');
    }
  });

  it('confidence ≥3 tables AND largest ≥100 entries → 0.95', () => {
    const bytes = new Uint8Array(512 * 1024);
    plantMinimalHeader(bytes);
    fillNoise(bytes, 0xc0, bytes.length);
    const t1 = plantLz77PointerTable(bytes, 0x1000, 120, 0x4000);
    fillNoise(bytes, t1.tableEndExclusive, 0x4000);
    fillNoise(bytes, t1.lz77RegionEndExclusive, 0x20000);
    const t2 = plantLz77PointerTable(bytes, 0x20000, 30, 0x22000);
    fillNoise(bytes, t2.tableEndExclusive, 0x22000);
    fillNoise(bytes, t2.lz77RegionEndExclusive, 0x40000);
    const t3 = plantLz77PointerTable(bytes, 0x40000, 20, 0x42000);
    fillNoise(bytes, t3.tableEndExclusive, 0x42000);
    fillNoise(bytes, t3.lz77RegionEndExclusive, bytes.length);
    const rom = loadRomFromBytes({ bytes, sourcePath: 'test://3-tables', synthetic: true });
    const cov = new CoverageMap(bytes.length);
    const r = lz77PointerTablesDetector.detect(rom, cov);
    expect(r.status).toBe('detected');
    if (r.status === 'detected') {
      expect(r.data.tableCount).toBe(3);
      expect(r.confidence).toBe(0.95);
    }
  });

  it('result.data + tables array + sampleNames are frozen', () => {
    const bytes = new Uint8Array(128 * 1024);
    plantMinimalHeader(bytes);
    fillNoise(bytes, 0xc0, bytes.length);
    const planted = plantLz77PointerTable(bytes, 0x1000, 30, 0x2000);
    fillNoise(bytes, planted.tableEndExclusive, 0x2000);
    fillNoise(bytes, planted.lz77RegionEndExclusive, bytes.length);
    const rom = loadRomFromBytes({ bytes, sourcePath: 'test://frozen', synthetic: true });
    const cov = new CoverageMap(bytes.length);
    const r = lz77PointerTablesDetector.detect(rom, cov);
    if (r.status === 'detected') {
      expect(Object.isFrozen(r.data)).toBe(true);
      expect(Object.isFrozen(r.data.tables)).toBe(true);
      expect(Object.isFrozen(r.data.sampleNames)).toBe(true);
    }
  });
});
