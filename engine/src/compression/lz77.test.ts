import { describe, expect, it } from 'vitest';
import {
  LZ77_HEADER_FIRST_BYTE,
  LZ77_MAX_UNCOMPRESSED_BYTES,
  encodeLz77Literal,
  readLz77,
} from './lz77.js';

describe('encodeLz77Literal + readLz77 round-trip', () => {
  it('round-trips a small ASCII string', () => {
    const input = Buffer.from('Hello, GBA cart!', 'ascii');
    const compressed = encodeLz77Literal(input);
    const r = readLz77(compressed, 0);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.uncompressedSize).toBe(input.length);
      expect(Buffer.from(r.decompressedBytes)).toEqual(input);
    }
  });

  it('round-trips a single byte', () => {
    const input = new Uint8Array([0x42]);
    const compressed = encodeLz77Literal(input);
    const r = readLz77(compressed, 0);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.uncompressedSize).toBe(1);
      expect(r.decompressedBytes[0]).toBe(0x42);
    }
  });

  it('round-trips exactly 8 bytes (one full flag group)', () => {
    const input = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const compressed = encodeLz77Literal(input);
    const r = readLz77(compressed, 0);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(Buffer.from(r.decompressedBytes)).toEqual(Buffer.from(input));
    }
  });

  it('round-trips 100 random-ish bytes', () => {
    const input = new Uint8Array(100);
    for (let i = 0; i < 100; i++) input[i] = (i * 17 + 3) & 0xff;
    const compressed = encodeLz77Literal(input);
    const r = readLz77(compressed, 0);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(Buffer.from(r.decompressedBytes)).toEqual(Buffer.from(input));
    }
  });

  it('round-trips at a non-zero offset', () => {
    const input = Buffer.from([0x11, 0x22, 0x33, 0x44]);
    const compressed = encodeLz77Literal(input);
    const buf = Buffer.alloc(1024);
    Buffer.from(compressed).copy(buf, 0x100);
    const r = readLz77(buf, 0x100);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(Buffer.from(r.decompressedBytes)).toEqual(input);
    }
  });
});

describe('readLz77 - failure modes', () => {
  it('fails too_short when fewer than 4 bytes available', () => {
    const r = readLz77(new Uint8Array(2), 0);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failure.kind).toBe('too_short');
    }
  });

  it('fails wrong_header_type when first byte is not LZ77', () => {
    const buf = new Uint8Array(16);
    buf[0] = 0x20; // type=2 (Huffman per BIOS), not LZ77
    const r = readLz77(buf, 0);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failure.kind).toBe('wrong_header_type');
    }
  });

  it('fails zero_uncompressed_size when header claims 0', () => {
    const buf = new Uint8Array(16);
    buf[0] = LZ77_HEADER_FIRST_BYTE;
    // bytes 1-3 = 0
    const r = readLz77(buf, 0);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failure.kind).toBe('zero_uncompressed_size');
    }
  });

  it('fails oversize when header claims > max allowed', () => {
    const buf = new Uint8Array(16);
    buf[0] = LZ77_HEADER_FIRST_BYTE;
    buf[1] = 0xff;
    buf[2] = 0xff;
    buf[3] = 0xff; // 16 MiB - 1, well past 4 MiB cap
    const r = readLz77(buf, 0);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failure.kind).toBe('oversize');
      if (r.failure.kind === 'oversize') {
        expect(r.failure.maxAllowed).toBe(LZ77_MAX_UNCOMPRESSED_BYTES);
      }
    }
  });

  it('fails compressed_data_truncated when stream ends mid-decode', () => {
    // Plant a valid header claiming 16 bytes output but only provide 5
    // bytes of compressed data (header + 1 flag byte = 5 → can't fulfill).
    const buf = Buffer.alloc(8);
    buf[0] = LZ77_HEADER_FIRST_BYTE;
    buf[1] = 0x10; // 16 bytes uncompressed
    buf[2] = 0x00;
    buf[3] = 0x00;
    buf[4] = 0x00; // flag byte: all literals
    // No literal bytes follow - truncated.
    const r = readLz77(buf, 0);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failure.kind).toBe('compressed_data_truncated');
    }
  });

  it('fails back_reference_underflow when displacement > current output position', () => {
    // Header: 4 bytes output. Then flag = 0x80 (first chunk is a
    // back-reference). Then back-ref (length=4, displacement=5) → tries
    // to copy from position -1.
    const buf = Buffer.alloc(8);
    buf[0] = LZ77_HEADER_FIRST_BYTE;
    buf[1] = 0x04;
    buf[2] = 0x00;
    buf[3] = 0x00;
    buf[4] = 0x80; // flag: backref+seven literals (we'll never reach the literals)
    // length=4 → (length-3)=1 → b0 high nibble = 1
    // displacement=5 → -1 from the formula → (displacement-1)=4 → low byte=4, high nibble=0
    buf[5] = 0x10; // high nibble 1, low nibble 0
    buf[6] = 0x04; // displacement low byte
    const r = readLz77(buf, 0);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failure.kind).toBe('back_reference_underflow');
    }
  });
});

describe('readLz77 - back-reference RLE behavior', () => {
  it('handles displacement=1 length>1 as byte-repeat (canonical LZ77 RLE)', () => {
    // Build manually: header claims 9 output bytes. First byte literal=0xAA.
    // Then back-ref length=8 displacement=1 → repeats 0xAA 8 times.
    // Flag byte 0b01000000 - chunk 0 = literal, chunk 1 = back-ref.
    const buf = new Uint8Array(8);
    buf[0] = LZ77_HEADER_FIRST_BYTE;
    buf[1] = 9;
    buf[2] = 0;
    buf[3] = 0;
    buf[4] = 0b01000000;
    buf[5] = 0xaa; // literal
    // length=8 → (length-3)=5 → high nibble = 5
    // displacement=1 → (displacement-1)=0 → low byte=0, high nibble=0
    buf[6] = 0x50;
    buf[7] = 0x00;
    const r = readLz77(buf, 0);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.uncompressedSize).toBe(9);
      expect(Array.from(r.decompressedBytes)).toEqual([0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa]);
    }
  });
});

describe('encodeLz77Literal - invariants', () => {
  it('always starts with the LZ77 header byte', () => {
    const compressed = encodeLz77Literal(new Uint8Array([1, 2, 3]));
    expect(compressed[0]).toBe(LZ77_HEADER_FIRST_BYTE);
  });

  it('reports the correct uncompressed size in the header', () => {
    const compressed = encodeLz77Literal(new Uint8Array(258));
    expect(compressed[1]).toBe(258 & 0xff); // 0x02
    expect(compressed[2]).toBe(0x01);
    expect(compressed[3]).toBe(0x00);
  });

  it('throws on oversized input', () => {
    // We can't actually allocate LZ77_MAX_UNCOMPRESSED_BYTES + 1 cheaply,
    // so simulate via a small TypedArray with overridden length. Easier:
    // create a 4 MiB + 1 buffer directly (small enough for a test box).
    const big = new Uint8Array(LZ77_MAX_UNCOMPRESSED_BYTES + 1);
    expect(() => encodeLz77Literal(big)).toThrow();
  });
});
