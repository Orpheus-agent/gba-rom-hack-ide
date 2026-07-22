import { describe, expect, it } from 'vitest';
import { CoverageMap } from '../coverage/index.js';
import { loadRomFromBytes } from '../rom/index.js';
import { GBA_ROM_BASE_ADDRESS } from '../pointers/index.js';
import { encodeString, STRING_TERMINATOR } from '../text/codec.js';
import {
  TEXT_POINTER_TABLES_DETECTOR_ID,
  textPointerTablesDetector,
} from './text-pointer-tables-system.js';

function plantText(buf: Uint8Array, offset: number, text: string): number {
  const encoded = encodeString(text);
  buf.set(encoded, offset);
  buf[offset + encoded.length] = STRING_TERMINATOR;
  return offset + encoded.length + 1;
}

function plantTextPointerTable(
  buf: Uint8Array,
  tableOffset: number,
  count: number,
  textRegionStart: number,
  textsPerEntry: string[] = [],
): { tableEndExclusive: number; textRegionEndExclusive: number } {
  let textCursor = textRegionStart;
  for (let i = 0; i < count; i++) {
    const text =
      textsPerEntry[i] ?? `MOVE ${String(i).padStart(3, '0')} DESCRIPTION`;
    const textAddr = (GBA_ROM_BASE_ADDRESS + textCursor) >>> 0;
    const ptrSlot = tableOffset + i * 4;
    buf[ptrSlot + 0] = textAddr & 0xff;
    buf[ptrSlot + 1] = (textAddr >>> 8) & 0xff;
    buf[ptrSlot + 2] = (textAddr >>> 16) & 0xff;
    buf[ptrSlot + 3] = (textAddr >>> 24) & 0xff;
    textCursor = plantText(buf, textCursor, text);
  }
  return {
    tableEndExclusive: tableOffset + count * 4,
    textRegionEndExclusive: textCursor,
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

describe('textPointerTablesDetector', () => {
  it('exports the universal RomDetector contract', () => {
    expect(textPointerTablesDetector.id).toBe(TEXT_POINTER_TABLES_DETECTOR_ID);
    expect(typeof textPointerTablesDetector.name).toBe('string');
    expect(textPointerTablesDetector.phase).toBe(7);
    expect(typeof textPointerTablesDetector.detect).toBe('function');
  });

  it('returns not_detected when no tables are present', () => {
    const bytes = new Uint8Array(128 * 1024);
    plantMinimalHeader(bytes);
    fillNoise(bytes, 0xc0, bytes.length);
    const rom = loadRomFromBytes({ bytes, sourcePath: 'test://no-tables', synthetic: true });
    const cov = new CoverageMap(bytes.length);
    const r = textPointerTablesDetector.detect(rom, cov);
    expect(r.status).toBe('not_detected');
    if (r.status === 'not_detected') {
      expect(r.reason).toContain('No Gen-3 text-pointer tables');
    }
  });

  it('detects a planted 50-entry text-pointer table + registers coverage', () => {
    const bytes = new Uint8Array(128 * 1024);
    plantMinimalHeader(bytes);
    fillNoise(bytes, 0xc0, bytes.length);
    const planted = plantTextPointerTable(bytes, 0x1000, 50, 0x2000);
    fillNoise(bytes, planted.tableEndExclusive, 0x2000);
    fillNoise(bytes, planted.textRegionEndExclusive, bytes.length);
    const rom = loadRomFromBytes({ bytes, sourcePath: 'test://tables', synthetic: true });
    const cov = new CoverageMap(bytes.length);
    const r = textPointerTablesDetector.detect(rom, cov);
    expect(r.status).toBe('detected');
    if (r.status === 'detected') {
      expect(r.data.tableCount).toBe(1);
      expect(r.data.totalPointerEntries).toBe(50);
      expect(r.data.tables[0]?.entryCount).toBe(50);
      expect(r.data.tables[0]?.tableOffset).toBe(0x1000);
      // sampleNames lifted from the largest (only) table's first 8;
      // iter 90 prefixes with the classified kind in [brackets].
      expect(r.data.sampleNames.length).toBe(8);
      expect(r.data.sampleNames[0]).toContain('MOVE 000 DESCRIPTION');
      expect(r.data.sampleNames[0]).toMatch(/^\[\w+\]/);
    }
    const report = cov.report();
    const regions = report.regions.filter((rgn) =>
      rgn.provenance?.includes(TEXT_POINTER_TABLES_DETECTOR_ID),
    );
    expect(regions.length).toBe(1);
    expect(regions[0]?.start).toBe(0x1000);
    expect(regions[0]?.probableClass).toBe('pointer-network');
  });

  it('detects multiple tables + sampleNames comes from the LARGEST', () => {
    const bytes = new Uint8Array(256 * 1024);
    plantMinimalHeader(bytes);
    fillNoise(bytes, 0xc0, bytes.length);
    // Smaller table at 0x1000: 15 entries, custom strings starting "SMALL".
    const smallTexts: string[] = [];
    for (let i = 0; i < 15; i++) smallTexts.push(`SMALL TABLE ENTRY ${String(i)}`);
    const small = plantTextPointerTable(bytes, 0x1000, 15, 0x2000, smallTexts);
    fillNoise(bytes, small.tableEndExclusive, 0x2000);
    fillNoise(bytes, small.textRegionEndExclusive, 0x10000);
    // Larger table at 0x10000: 60 entries, custom strings starting "BIG".
    const bigTexts: string[] = [];
    for (let i = 0; i < 60; i++) bigTexts.push(`BIG TABLE ENTRY ${String(i)}`);
    const big = plantTextPointerTable(bytes, 0x10000, 60, 0x12000, bigTexts);
    fillNoise(bytes, big.tableEndExclusive, 0x12000);
    fillNoise(bytes, big.textRegionEndExclusive, bytes.length);
    const rom = loadRomFromBytes({ bytes, sourcePath: 'test://multi', synthetic: true });
    const cov = new CoverageMap(bytes.length);
    const r = textPointerTablesDetector.detect(rom, cov);
    expect(r.status).toBe('detected');
    if (r.status === 'detected') {
      expect(r.data.tableCount).toBe(2);
      expect(r.data.totalPointerEntries).toBe(75);
      // tables[0] is the largest (60-entry BIG); sampleNames from it,
      // iter 90 prefixed with classified kind label.
      expect(r.data.tables[0]?.entryCount).toBe(60);
      expect(r.data.sampleNames[0]).toContain('BIG TABLE ENTRY 0');
      expect(r.data.sampleNames[0]).toMatch(/^\[\w+\]/);
      expect(r.data.tables[1]?.entryCount).toBe(15);
    }
  });

  it('confidence scales: ≥3 tables AND largest ≥100 entries → 0.95', () => {
    const bytes = new Uint8Array(512 * 1024);
    plantMinimalHeader(bytes);
    fillNoise(bytes, 0xc0, bytes.length);
    // Plant 3 tables, the first with ≥100 entries.
    const t1 = plantTextPointerTable(bytes, 0x1000, 120, 0x4000);
    fillNoise(bytes, t1.tableEndExclusive, 0x4000);
    fillNoise(bytes, t1.textRegionEndExclusive, 0x20000);
    const t2 = plantTextPointerTable(bytes, 0x20000, 30, 0x22000);
    fillNoise(bytes, t2.tableEndExclusive, 0x22000);
    fillNoise(bytes, t2.textRegionEndExclusive, 0x40000);
    const t3 = plantTextPointerTable(bytes, 0x40000, 20, 0x42000);
    fillNoise(bytes, t3.tableEndExclusive, 0x42000);
    fillNoise(bytes, t3.textRegionEndExclusive, bytes.length);
    const rom = loadRomFromBytes({ bytes, sourcePath: 'test://3-tables', synthetic: true });
    const cov = new CoverageMap(bytes.length);
    const r = textPointerTablesDetector.detect(rom, cov);
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
    const planted = plantTextPointerTable(bytes, 0x1000, 30, 0x2000);
    fillNoise(bytes, planted.tableEndExclusive, 0x2000);
    fillNoise(bytes, planted.textRegionEndExclusive, bytes.length);
    const rom = loadRomFromBytes({ bytes, sourcePath: 'test://frozen', synthetic: true });
    const cov = new CoverageMap(bytes.length);
    const r = textPointerTablesDetector.detect(rom, cov);
    if (r.status === 'detected') {
      expect(Object.isFrozen(r.data)).toBe(true);
      expect(Object.isFrozen(r.data.tables)).toBe(true);
      expect(Object.isFrozen(r.data.sampleNames)).toBe(true);
    }
  });
});
