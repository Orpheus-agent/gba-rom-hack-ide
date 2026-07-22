/**
 * Tests for the PNG decoder. We build PNG byte buffers programmatically
 * via zlib + chunk-with-CRC32 so no fixture files are needed.
 */
import { describe, it, expect } from 'vitest';
import { deflateSync } from 'node:zlib';
import { decodePng, PngDecodeError } from './png-decoder.js';

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC32_TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC32_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function buildChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new Uint8Array(4);
  for (let i = 0; i < 4; i++) typeBytes[i] = type.charCodeAt(i);
  const chunk = new Uint8Array(8 + data.length + 4);
  // length BE
  chunk[0] = (data.length >>> 24) & 0xff;
  chunk[1] = (data.length >>> 16) & 0xff;
  chunk[2] = (data.length >>> 8) & 0xff;
  chunk[3] = data.length & 0xff;
  chunk.set(typeBytes, 4);
  chunk.set(data, 8);
  const crcInput = new Uint8Array(4 + data.length);
  crcInput.set(typeBytes, 0);
  crcInput.set(data, 4);
  const crc = crc32(crcInput);
  chunk[8 + data.length + 0] = (crc >>> 24) & 0xff;
  chunk[8 + data.length + 1] = (crc >>> 16) & 0xff;
  chunk[8 + data.length + 2] = (crc >>> 8) & 0xff;
  chunk[8 + data.length + 3] = crc & 0xff;
  return chunk;
}

function buildPng(opts: {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  plte?: Uint8Array;
  rawScanlines: Uint8Array;
}): Uint8Array {
  const ihdr = new Uint8Array(13);
  ihdr[0] = (opts.width >>> 24) & 0xff;
  ihdr[1] = (opts.width >>> 16) & 0xff;
  ihdr[2] = (opts.width >>> 8) & 0xff;
  ihdr[3] = opts.width & 0xff;
  ihdr[4] = (opts.height >>> 24) & 0xff;
  ihdr[5] = (opts.height >>> 16) & 0xff;
  ihdr[6] = (opts.height >>> 8) & 0xff;
  ihdr[7] = opts.height & 0xff;
  ihdr[8] = opts.bitDepth;
  ihdr[9] = opts.colorType;
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const idat = new Uint8Array(deflateSync(opts.rawScanlines));
  const parts: Uint8Array[] = [PNG_SIGNATURE, buildChunk('IHDR', ihdr)];
  if (opts.plte) parts.push(buildChunk('PLTE', opts.plte));
  parts.push(buildChunk('IDAT', idat));
  parts.push(buildChunk('IEND', new Uint8Array(0)));
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

describe('decodePng', () => {
  it('rejects non-PNG bytes', () => {
    expect(() => decodePng(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toThrow(PngDecodeError);
  });

  it('decodes a tiny 2×2 RGB 8-bit PNG', () => {
    // Scanlines: filter byte 0 (None) + 6 bytes (RGB × 2 px) per row.
    const raw = new Uint8Array(2 * (1 + 6));
    raw[0] = 0; // filter row 0
    raw.set([255, 0, 0, 0, 255, 0], 1);
    raw[7] = 0; // filter row 1
    raw.set([0, 0, 255, 255, 255, 255], 8);
    const png = buildPng({
      width: 2,
      height: 2,
      bitDepth: 8,
      colorType: 2, // RGB
      rawScanlines: raw,
    });
    const result = decodePng(png);
    expect(result.width).toBe(2);
    expect(result.height).toBe(2);
    expect(result.colorType).toBe(2);
    expect(Array.from(result.pixels)).toEqual([
      255, 0, 0, 255,
      0, 255, 0, 255,
      0, 0, 255, 255,
      255, 255, 255, 255,
    ]);
  });

  it('decodes a 2×2 RGBA 8-bit PNG', () => {
    const raw = new Uint8Array(2 * (1 + 8));
    raw[0] = 0;
    raw.set([255, 0, 0, 128, 0, 255, 0, 200], 1);
    raw[9] = 0;
    raw.set([0, 0, 255, 64, 255, 255, 255, 255], 10);
    const png = buildPng({
      width: 2,
      height: 2,
      bitDepth: 8,
      colorType: 6,
      rawScanlines: raw,
    });
    const r = decodePng(png);
    expect(r.pixels[3]).toBe(128);
    expect(r.pixels[7]).toBe(200);
    expect(r.pixels[11]).toBe(64);
  });

  it('decodes a 2×2 indexed PNG', () => {
    // Palette: red, green, blue, white (4 entries × 3 bytes).
    const plte = new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]);
    // Indexed 8-bit, one byte per pixel.
    const raw = new Uint8Array(2 * (1 + 2));
    raw[0] = 0;
    raw.set([0, 1], 1);
    raw[3] = 0;
    raw.set([2, 3], 4);
    const png = buildPng({
      width: 2,
      height: 2,
      bitDepth: 8,
      colorType: 3,
      plte,
      rawScanlines: raw,
    });
    const r = decodePng(png);
    expect(r.palette).not.toBeNull();
    expect(Array.from(r.pixels.slice(0, 4))).toEqual([255, 0, 0, 255]); // red
    expect(Array.from(r.pixels.slice(4, 8))).toEqual([0, 255, 0, 255]); // green
    expect(Array.from(r.pixels.slice(8, 12))).toEqual([0, 0, 255, 255]); // blue
    expect(Array.from(r.pixels.slice(12, 16))).toEqual([255, 255, 255, 255]); // white
  });

  it('decodes a 4×1 indexed 4-bit PNG (2 nibbles per byte)', () => {
    const plte = new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0]);
    // 4-bit packed: 4 pixels = 2 bytes. Pixels [0, 1, 2, 3] = bytes 0x01 (left nibble=0, right=1), 0x23.
    const raw = new Uint8Array([0, 0x01, 0x23]);
    const png = buildPng({
      width: 4,
      height: 1,
      bitDepth: 4,
      colorType: 3,
      plte,
      rawScanlines: raw,
    });
    const r = decodePng(png);
    expect(r.pixels[0]).toBe(255); // pixel 0 = red
    expect(r.pixels[4]).toBe(0); // pixel 1 = green's R
    expect(r.pixels[5]).toBe(255); // pixel 1 = green's G
    expect(r.pixels[8]).toBe(0); // pixel 2 = blue's R
    expect(r.pixels[10]).toBe(255); // pixel 2 = blue's B
    expect(r.pixels[12]).toBe(255); // pixel 3 = yellow's R
  });

  it('refuses interlaced PNGs with a typed error', () => {
    // Fudge an IHDR with interlace=1; everything else minimal.
    const ihdr = new Uint8Array(13);
    ihdr[3] = 1; // width=1
    ihdr[7] = 1; // height=1
    ihdr[8] = 8;
    ihdr[9] = 2;
    ihdr[12] = 1; // interlace=1
    const parts: Uint8Array[] = [PNG_SIGNATURE, buildChunk('IHDR', ihdr)];
    let total = 0;
    for (const p of parts) total += p.length;
    const png = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
      png.set(p, off);
      off += p.length;
    }
    expect(() => decodePng(png)).toThrow(/interlaced/);
  });

  it('refuses 16-bit PNGs (re-export at 8-bit)', () => {
    const ihdr = new Uint8Array(13);
    ihdr[3] = 1;
    ihdr[7] = 1;
    ihdr[8] = 16;
    ihdr[9] = 2;
    const parts: Uint8Array[] = [PNG_SIGNATURE, buildChunk('IHDR', ihdr)];
    let total = 0;
    for (const p of parts) total += p.length;
    const png = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
      png.set(p, off);
      off += p.length;
    }
    expect(() => decodePng(png)).toThrow(/16-bit/);
  });

  it('refuses bytes that aren\'t a PNG', () => {
    expect(() => decodePng(new Uint8Array(20))).toThrow(PngDecodeError);
  });
});
