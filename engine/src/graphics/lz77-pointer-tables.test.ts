import { describe, expect, it } from 'vitest';
import {
  LZ77_POINTER_TABLE_ANCHOR_CONFIRMATION_ENTRIES,
  LZ77_POINTER_TABLE_MIN_PAYLOAD_BYTES,
  LZ77_POINTER_TABLE_MIN_VALID_ENTRIES,
  findLz77PointerTables,
} from './lz77-pointer-tables.js';
import { GBA_ROM_BASE_ADDRESS } from '../pointers/index.js';
import { LZ77_HEADER_FIRST_BYTE } from '../compression/lz77.js';

/** Plant an LZ77 header at `offset` with declared decompressed size,
 *  followed by `payloadBytes` bytes of dummy compressed payload. */
function plantLz77Block(
  buf: Uint8Array,
  offset: number,
  decompressedSize: number,
  payloadBytes: number = 16,
): number {
  buf[offset] = LZ77_HEADER_FIRST_BYTE; // 0x10
  buf[offset + 1] = decompressedSize & 0xff;
  buf[offset + 2] = (decompressedSize >>> 8) & 0xff;
  buf[offset + 3] = (decompressedSize >>> 16) & 0xff;
  for (let i = 0; i < payloadBytes; i++) {
    buf[offset + 4 + i] = (i * 7 + 1) & 0xff;
  }
  return offset + 4 + payloadBytes;
}

/** Plant a pointer table of `count` u32 entries at `tableOffset`. Each
 *  entry points to a planted LZ77 block in the `lz77RegionStart..` area. */
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
    buf[i] = 0xff; // 0xFF as type-byte rejects (LZ77 requires 0x10); 0xFF high byte rejects pointer.
  }
}

describe('lz77-pointer-tables constants', () => {
  it('exports a 10-entry anchor confirmation threshold', () => {
    expect(LZ77_POINTER_TABLE_ANCHOR_CONFIRMATION_ENTRIES).toBe(10);
  });
  it('exports a 10-entry minimum-valid-entries threshold', () => {
    expect(LZ77_POINTER_TABLE_MIN_VALID_ENTRIES).toBe(10);
  });
  it('exports an 8-byte minimum-payload requirement', () => {
    expect(LZ77_POINTER_TABLE_MIN_PAYLOAD_BYTES).toBe(8);
  });
});

describe('findLz77PointerTables', () => {
  it('returns empty on a tiny ROM', () => {
    const bytes = new Uint8Array(0x100);
    plantMinimalHeader(bytes);
    expect(findLz77PointerTables(bytes)).toEqual([]);
  });

  it('returns empty when no LZ77-pointer tables are present', () => {
    const bytes = new Uint8Array(128 * 1024);
    plantMinimalHeader(bytes);
    fillNoise(bytes, 0xc0, bytes.length);
    expect(findLz77PointerTables(bytes)).toEqual([]);
  });

  it('detects a 30-entry planted LZ77-pointer table', () => {
    const bytes = new Uint8Array(128 * 1024);
    plantMinimalHeader(bytes);
    fillNoise(bytes, 0xc0, bytes.length);
    const tableOffset = 0x1000;
    const lz77RegionStart = 0x2000;
    plantLz77PointerTable(bytes, tableOffset, 30, lz77RegionStart);
    fillNoise(bytes, tableOffset + 30 * 4, lz77RegionStart);
    const tables = findLz77PointerTables(bytes);
    expect(tables.length).toBe(1);
    expect(tables[0]?.tableOffset).toBe(tableOffset);
    expect(tables[0]?.entryCount).toBe(30);
    expect(tables[0]?.samplePreview.length).toBe(8);
    expect(tables[0]?.samplePreview[0]?.targetOffset).toBe(lz77RegionStart);
    expect(tables[0]?.samplePreview[0]?.decompressedSize).toBe(256);
  });

  it('returns empty when planted entries are below MIN_VALID_ENTRIES floor', () => {
    const bytes = new Uint8Array(128 * 1024);
    plantMinimalHeader(bytes);
    fillNoise(bytes, 0xc0, bytes.length);
    plantLz77PointerTable(bytes, 0x1000, 5, 0x2000);
    fillNoise(bytes, 0x1000 + 5 * 4, 0x2000);
    expect(findLz77PointerTables(bytes)).toEqual([]);
  });

  it('detects multiple tables sorted by entryCount desc', () => {
    const bytes = new Uint8Array(256 * 1024);
    plantMinimalHeader(bytes);
    fillNoise(bytes, 0xc0, bytes.length);
    const small = plantLz77PointerTable(bytes, 0x1000, 15, 0x2000, 128);
    fillNoise(bytes, small.tableEndExclusive, 0x2000);
    fillNoise(bytes, small.lz77RegionEndExclusive, 0x10000);
    const big = plantLz77PointerTable(bytes, 0x10000, 50, 0x12000, 512);
    fillNoise(bytes, big.tableEndExclusive, 0x12000);
    fillNoise(bytes, big.lz77RegionEndExclusive, bytes.length);
    const tables = findLz77PointerTables(bytes);
    expect(tables.length).toBe(2);
    expect(tables[0]?.entryCount).toBe(50);
    expect(tables[1]?.entryCount).toBe(15);
  });

  it('rejects pointers whose target byte 0 is NOT the LZ77 header byte', () => {
    const bytes = new Uint8Array(128 * 1024);
    plantMinimalHeader(bytes);
    fillNoise(bytes, 0xc0, bytes.length);
    plantLz77PointerTable(bytes, 0x1000, 30, 0x2000);
    // Corrupt every planted LZ77 block's byte 0 (was 0x10) to 0x20.
    for (let i = 0; i < 30; i++) {
      // Each block starts at lz77RegionStart + i * (4 + 16) per default planting.
      const blockStart = 0x2000 + i * (4 + 16);
      bytes[blockStart] = 0x20;
    }
    expect(findLz77PointerTables(bytes)).toEqual([]);
  });

  it('rejects pointers with decompressed size = 0 in LZ77 header', () => {
    const bytes = new Uint8Array(128 * 1024);
    plantMinimalHeader(bytes);
    fillNoise(bytes, 0xc0, bytes.length);
    plantLz77PointerTable(bytes, 0x1000, 30, 0x2000);
    // Zero out every planted block's decompressed-size field.
    for (let i = 0; i < 30; i++) {
      const blockStart = 0x2000 + i * (4 + 16);
      bytes[blockStart + 1] = 0;
      bytes[blockStart + 2] = 0;
      bytes[blockStart + 3] = 0;
    }
    expect(findLz77PointerTables(bytes)).toEqual([]);
  });

  it('rejects pointers outside ROM space (high byte != 0x08/0x09)', () => {
    const bytes = new Uint8Array(128 * 1024);
    plantMinimalHeader(bytes);
    fillNoise(bytes, 0xc0, bytes.length);
    plantLz77PointerTable(bytes, 0x1000, 30, 0x2000);
    for (let i = 0; i < 30; i++) {
      bytes[0x1000 + i * 4 + 3] = 0x03; // EWRAM not ROM
    }
    expect(findLz77PointerTables(bytes)).toEqual([]);
  });

  it('frozen output structure', () => {
    const bytes = new Uint8Array(128 * 1024);
    plantMinimalHeader(bytes);
    fillNoise(bytes, 0xc0, bytes.length);
    plantLz77PointerTable(bytes, 0x1000, 30, 0x2000);
    fillNoise(bytes, 0x1000 + 30 * 4, 0x2000);
    const tables = findLz77PointerTables(bytes);
    expect(Object.isFrozen(tables)).toBe(true);
    expect(Object.isFrozen(tables[0])).toBe(true);
    expect(Object.isFrozen(tables[0]?.samplePreview)).toBe(true);
    expect(Object.isFrozen(tables[0]?.samplePreview[0])).toBe(true);
  });
});
