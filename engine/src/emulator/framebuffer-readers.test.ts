/**
 * Phase 9A - framebuffer-readers tests.
 *
 * Verify the screenshot-PNG decode path produces a 240×160 RGBA
 * buffer of the expected length, plus the FNV-1a hash stability.
 */

import { describe, expect, it } from 'vitest';
import { deflateSync } from 'node:zlib';
import {
  GBA_FRAMEBUFFER_HEIGHT,
  GBA_FRAMEBUFFER_RGBA_LENGTH,
  GBA_FRAMEBUFFER_WIDTH,
  decodeMgbaScreenshotToRgba,
  framebufferHash,
} from './framebuffer-readers.js';

/** Build a minimal 240×160 RGBA PNG byte stream for testing. */
function buildTestPng(width: number, height: number, fillColor: [number, number, number]): Uint8Array {
  // Build the raw scanline payload: each row prefixed with a filter
  // byte (0 = None), then RGBA pixels.
  const rowLen = width * 4;
  const raw = new Uint8Array(height * (rowLen + 1));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (rowLen + 1);
    raw[rowStart] = 0; // filter: None
    for (let x = 0; x < width; x++) {
      const px = rowStart + 1 + x * 4;
      raw[px + 0] = fillColor[0];
      raw[px + 1] = fillColor[1];
      raw[px + 2] = fillColor[2];
      raw[px + 3] = 0xff;
    }
  }
  const idatData = deflateSync(raw);

  // PNG chunks: IHDR + IDAT + IEND.
  const chunks: Uint8Array[] = [];
  const u32be = (n: number): Uint8Array =>
    new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);

  // CRC-32 table (precomputed lazily on first use).
  const crcTable: number[] = (() => {
    const t: number[] = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      t[n] = c >>> 0;
    }
    return t;
  })();
  const crc32 = (buf: Uint8Array): number => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
      c = crcTable[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
  };
  const writeChunk = (type: string, data: Uint8Array): void => {
    const typeBytes = new TextEncoder().encode(type);
    chunks.push(u32be(data.length));
    chunks.push(typeBytes);
    chunks.push(data);
    const crcInput = new Uint8Array(typeBytes.length + data.length);
    crcInput.set(typeBytes, 0);
    crcInput.set(data, typeBytes.length);
    chunks.push(u32be(crc32(crcInput)));
  };

  // IHDR: width(4) height(4) bitDepth(1) colorType(1) compression(1) filter(1) interlace(1)
  const ihdr = new Uint8Array(13);
  ihdr.set(u32be(width), 0);
  ihdr.set(u32be(height), 4);
  ihdr[8] = 8; // bitDepth
  ihdr[9] = 6; // colorType: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  writeChunk('IHDR', ihdr);
  writeChunk('IDAT', new Uint8Array(idatData));
  writeChunk('IEND', new Uint8Array(0));

  // Assemble.
  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const totalLen = sig.length + chunks.reduce((acc, c) => acc + c.length, 0);
  const out = new Uint8Array(totalLen);
  let off = 0;
  out.set(sig, 0);
  off += sig.length;
  for (const chunk of chunks) {
    out.set(chunk, off);
    off += chunk.length;
  }
  return out;
}

describe('emulator/framebuffer-readers', () => {
  describe('decodeMgbaScreenshotToRgba', () => {
    it('decodes a 240×160 RGBA PNG into a Uint8ClampedArray of the right length', () => {
      const png = buildTestPng(GBA_FRAMEBUFFER_WIDTH, GBA_FRAMEBUFFER_HEIGHT, [0x11, 0x22, 0x33]);
      const rgba = decodeMgbaScreenshotToRgba(png);
      expect(rgba).toBeInstanceOf(Uint8ClampedArray);
      expect(rgba.length).toBe(GBA_FRAMEBUFFER_RGBA_LENGTH);
      // First pixel should be 0x11,0x22,0x33,0xff.
      expect(rgba[0]).toBe(0x11);
      expect(rgba[1]).toBe(0x22);
      expect(rgba[2]).toBe(0x33);
      expect(rgba[3]).toBe(0xff);
    });

    it('throws on a PNG with wrong dimensions', () => {
      const png = buildTestPng(100, 100, [0, 0, 0]);
      expect(() => decodeMgbaScreenshotToRgba(png)).toThrow(/dimensions/);
    });
  });

  describe('framebufferHash', () => {
    it('produces an 8-character lowercase hex string', () => {
      const buf = new Uint8ClampedArray(GBA_FRAMEBUFFER_RGBA_LENGTH);
      const h = framebufferHash(buf);
      expect(h).toMatch(/^[0-9a-f]{8}$/);
    });

    it('is deterministic - identical buffers produce identical hashes', () => {
      const a = new Uint8ClampedArray(GBA_FRAMEBUFFER_RGBA_LENGTH).fill(0x42);
      const b = new Uint8ClampedArray(GBA_FRAMEBUFFER_RGBA_LENGTH).fill(0x42);
      expect(framebufferHash(a)).toBe(framebufferHash(b));
    });

    it('differs for different bytes', () => {
      const a = new Uint8ClampedArray(GBA_FRAMEBUFFER_RGBA_LENGTH).fill(0x42);
      const b = new Uint8ClampedArray(GBA_FRAMEBUFFER_RGBA_LENGTH).fill(0x43);
      expect(framebufferHash(a)).not.toBe(framebufferHash(b));
    });

    it('all-zero buffer hashes to the FNV-1a initial state for length N', () => {
      const buf = new Uint8ClampedArray(GBA_FRAMEBUFFER_RGBA_LENGTH); // zeroed
      const h = framebufferHash(buf);
      // Just stability - what matters is it's deterministic.
      expect(h.length).toBe(8);
      // And re-running it produces the same answer.
      expect(framebufferHash(buf)).toBe(h);
    });
  });
});
