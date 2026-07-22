import { describe, expect, it } from 'vitest';
import { colorTypeLabel, isPng, parsePngHeader } from './png-header.js';

// Build a minimal valid PNG header (33 bytes) for testing without external deps.
function makePngHeader({
  width = 16,
  height = 16,
  bitDepth = 8,
  colorType = 3,
}: {
  width?: number;
  height?: number;
  bitDepth?: number;
  colorType?: 0 | 2 | 3 | 4 | 6;
}): Buffer {
  const buf = Buffer.alloc(33);
  // Magic signature
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  // IHDR length (always 13)
  buf.writeUInt32BE(13, 8);
  // Chunk type "IHDR"
  buf.write('IHDR', 12, 4, 'ascii');
  // Width / height
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  // Bit depth / color type
  buf.writeUInt8(bitDepth, 24);
  buf.writeUInt8(colorType, 25);
  // Compression / filter / interlace
  buf.writeUInt8(0, 26);
  buf.writeUInt8(0, 27);
  buf.writeUInt8(0, 28);
  // CRC (anything; we don't validate it)
  buf.writeUInt32BE(0, 29);
  return buf;
}

describe('isPng', () => {
  it('returns true for a buffer starting with the PNG signature', () => {
    expect(isPng(makePngHeader({}))).toBe(true);
  });

  it('returns false for a non-PNG buffer', () => {
    const notPng = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]); // JPEG SOI
    expect(isPng(notPng)).toBe(false);
  });

  it('returns false for an empty buffer', () => {
    expect(isPng(Buffer.alloc(0))).toBe(false);
  });
});

describe('parsePngHeader', () => {
  it('extracts width / height / bitDepth / colorType from a valid PNG IHDR', () => {
    const r = parsePngHeader(makePngHeader({ width: 32, height: 64, bitDepth: 4, colorType: 3 }));
    expect(r).toEqual({ width: 32, height: 64, bitDepth: 4, colorType: 3 });
  });

  it('returns null when the buffer is not a PNG', () => {
    const notPng = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    expect(parsePngHeader(notPng)).toBeNull();
  });

  it('returns null when the buffer is truncated mid-IHDR', () => {
    const buf = makePngHeader({}).subarray(0, 20);
    expect(parsePngHeader(buf)).toBeNull();
  });

  it('returns null when the chunk type after signature is not IHDR', () => {
    const buf = makePngHeader({});
    buf.write('IDAT', 12, 4, 'ascii');
    expect(parsePngHeader(buf)).toBeNull();
  });

  it('returns null for zero-dimension PNGs', () => {
    expect(parsePngHeader(makePngHeader({ width: 0, height: 16 }))).toBeNull();
    expect(parsePngHeader(makePngHeader({ width: 16, height: 0 }))).toBeNull();
  });

  it('returns null for an illegal colorType byte', () => {
    const buf = makePngHeader({});
    buf.writeUInt8(7, 25); // 7 is not a valid PNG colorType
    expect(parsePngHeader(buf)).toBeNull();
  });
});

describe('colorTypeLabel', () => {
  it('maps every legal colorType to a stable human label', () => {
    expect(colorTypeLabel(0)).toBe('grayscale');
    expect(colorTypeLabel(2)).toBe('RGB');
    expect(colorTypeLabel(3)).toBe('indexed');
    expect(colorTypeLabel(4)).toBe('grayscale+alpha');
    expect(colorTypeLabel(6)).toBe('RGBA');
  });
});
