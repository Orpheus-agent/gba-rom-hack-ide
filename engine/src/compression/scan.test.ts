import { describe, expect, it } from 'vitest';
import { dedupeOverlappingBlocks, findLz77Candidates } from './scan.js';
import { encodeLz77Literal } from './lz77.js';

describe('findLz77Candidates', () => {
  it('returns empty array for all-zero buffer', () => {
    expect(findLz77Candidates(new Uint8Array(1024))).toEqual([]);
  });

  it('finds a single planted LZ77 block at a stride-aligned offset', () => {
    const buf = Buffer.alloc(1024);
    const compressed = encodeLz77Literal(Buffer.from('test payload bytes'));
    Buffer.from(compressed).copy(buf, 0x100);
    const blocks = findLz77Candidates(buf);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.start).toBe(0x100);
    expect(blocks[0]?.uncompressedSize).toBe(18);
    expect(blocks[0]?.compressedLength).toBe(compressed.length);
  });

  it('finds multiple planted blocks', () => {
    const buf = Buffer.alloc(2048);
    const c1 = encodeLz77Literal(Buffer.from('first'));
    const c2 = encodeLz77Literal(Buffer.from('second block of data'));
    Buffer.from(c1).copy(buf, 0x100);
    Buffer.from(c2).copy(buf, 0x400);
    const blocks = findLz77Candidates(buf);
    expect(blocks).toHaveLength(2);
    expect(blocks.map((b) => b.start)).toEqual([0x100, 0x400]);
  });

  it('does NOT find a planted block at a misaligned offset (default stride=4)', () => {
    const buf = Buffer.alloc(1024);
    const compressed = encodeLz77Literal(Buffer.from('test'));
    Buffer.from(compressed).copy(buf, 0x101); // 1-byte misaligned
    expect(findLz77Candidates(buf)).toHaveLength(0);
  });

  it('honors stride=1 (finds misaligned block)', () => {
    const buf = Buffer.alloc(1024);
    const compressed = encodeLz77Literal(Buffer.from('test'));
    Buffer.from(compressed).copy(buf, 0x101);
    const blocks = findLz77Candidates(buf, { stride: 1 });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.start).toBe(0x101);
  });

  it('honors minCompressedLength filter', () => {
    const buf = Buffer.alloc(1024);
    const compressed = encodeLz77Literal(new Uint8Array([0x42]));
    Buffer.from(compressed).copy(buf, 0x100);
    // The 1-byte payload compresses to header(4) + flag(1) + literal(1) = 6 bytes.
    expect(findLz77Candidates(buf, { minCompressedLength: 5 })).toHaveLength(1);
    expect(findLz77Candidates(buf, { minCompressedLength: 7 })).toHaveLength(0);
  });

  it('honors maxBlocks cap', () => {
    const buf = Buffer.alloc(8192);
    const compressed = encodeLz77Literal(Buffer.from('block'));
    for (let i = 0; i < 5; i++) {
      Buffer.from(compressed).copy(buf, i * 256);
    }
    expect(findLz77Candidates(buf, { maxBlocks: 3 })).toHaveLength(3);
  });

  it('rejects invalid stride', () => {
    expect(() => findLz77Candidates(new Uint8Array(16), { stride: 0 })).toThrow();
  });

  it('rejects invalid window bounds', () => {
    expect(() =>
      findLz77Candidates(new Uint8Array(16), { startOffset: -1 }),
    ).toThrow();
    expect(() =>
      findLz77Candidates(new Uint8Array(16), { endOffsetExclusive: 100 }),
    ).toThrow();
  });
});

describe('dedupeOverlappingBlocks', () => {
  it('keeps a single block', () => {
    const block = { start: 0, compressedLength: 10, uncompressedSize: 5, endExclusive: 10 };
    expect(dedupeOverlappingBlocks([block])).toEqual([block]);
  });

  it('drops overlapping blocks keeping the earlier start', () => {
    const a = { start: 0, compressedLength: 20, uncompressedSize: 10, endExclusive: 20 };
    const b = { start: 5, compressedLength: 20, uncompressedSize: 10, endExclusive: 25 }; // overlaps
    expect(dedupeOverlappingBlocks([a, b])).toEqual([a]);
  });

  it('keeps non-overlapping blocks', () => {
    const a = { start: 0, compressedLength: 10, uncompressedSize: 5, endExclusive: 10 };
    const b = { start: 20, compressedLength: 10, uncompressedSize: 5, endExclusive: 30 };
    expect(dedupeOverlappingBlocks([a, b])).toEqual([a, b]);
  });

  it('prefers the LONGER block when two share a start', () => {
    const short = { start: 0, compressedLength: 8, uncompressedSize: 4, endExclusive: 8 };
    const long = { start: 0, compressedLength: 16, uncompressedSize: 8, endExclusive: 16 };
    expect(dedupeOverlappingBlocks([short, long])).toEqual([long]);
  });

  it('returns empty for empty input', () => {
    expect(dedupeOverlappingBlocks([])).toEqual([]);
  });
});
