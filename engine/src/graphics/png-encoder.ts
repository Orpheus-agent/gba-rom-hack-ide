/**
 * Minimal PNG encoder (Phase 4.2C).
 *
 * Inverse of png-decoder.ts. Writes 8-bit RGBA PNGs only - that's the
 * sweet spot for the Pokémon-sprite endpoint:
 *
 *   - GBA 4bpp tiles → indexed pixels → RGBA via palette lookup
 *     (already produced by the decode pipeline)
 *   - Endpoint encodes RGBA → PNG bytes for the frontend's
 *     <PokemonSprite> component
 *
 * Round-trips against the existing decoder: every byte that comes
 * out of `encodeRgbaPng` decodes back to the same RGBA pixels via
 * `decodePng`.
 *
 * Encoded structure:
 *
 *   8-byte signature
 *   IHDR chunk    (13 bytes payload - width, height, bitDepth=8, colorType=6, etc.)
 *   IDAT chunk    (zlib-compressed filtered pixel data; filter=None per scanline)
 *   IEND chunk    (0-byte payload)
 *
 * Compression: `node:zlib.deflateSync`. Fast and matches the decoder's
 * `inflateSync`. We don't tune filter heuristics - every scanline gets
 * filter type 0 (None) since the sprite payload is small and the IDAT
 * overhead is minor.
 */

import { deflateSync } from 'node:zlib';
import { crc32 } from '../patch/bps.js';

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export class PngEncodeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`PngEncodeError[${code}]: ${message}`);
    this.name = 'PngEncodeError';
    this.code = code;
  }
}

/** Write a u32 big-endian into the destination at the given offset. */
function writeU32BE(dst: Uint8Array, offset: number, value: number): void {
  dst[offset + 0] = (value >>> 24) & 0xff;
  dst[offset + 1] = (value >>> 16) & 0xff;
  dst[offset + 2] = (value >>> 8) & 0xff;
  dst[offset + 3] = value & 0xff;
}

/** Build a single PNG chunk: [length BE u32][type 4-byte ASCII][payload][crc BE u32]
 *  CRC covers (type + payload). */
function buildChunk(type: string, payload: Uint8Array): Uint8Array {
  if (type.length !== 4) throw new Error('PNG chunk type must be exactly 4 ASCII chars');
  const out = new Uint8Array(4 + 4 + payload.length + 4);
  writeU32BE(out, 0, payload.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(payload, 8);
  const crcInput = out.subarray(4, 8 + payload.length);
  const crc = crc32(crcInput);
  writeU32BE(out, 8 + payload.length, crc);
  return out;
}

/** Encode 8-bit RGBA pixels into a PNG byte stream.
 *
 *  `pixels` must be width × height × 4 bytes (row-major, no padding).
 *  Throws PngEncodeError on shape mismatch. */
export function encodeRgbaPng(
  pixels: Uint8Array,
  width: number,
  height: number,
): Uint8Array {
  if (!Number.isInteger(width) || width <= 0 || width > 0x7fffffff) {
    throw new PngEncodeError('bad_width', `width ${String(width)} is not a positive 31-bit integer`);
  }
  if (!Number.isInteger(height) || height <= 0 || height > 0x7fffffff) {
    throw new PngEncodeError('bad_height', `height ${String(height)} is not a positive 31-bit integer`);
  }
  const expected = width * height * 4;
  if (pixels.byteLength !== expected) {
    throw new PngEncodeError(
      'bad_pixel_count',
      `expected ${String(expected)} pixel bytes for ${String(width)}×${String(height)} RGBA, got ${String(pixels.byteLength)}`,
    );
  }

  // IHDR payload: 13 bytes
  //   width u32 BE     (4)
  //   height u32 BE    (4)
  //   bitDepth u8      (1) = 8
  //   colorType u8     (1) = 6 (RGBA)
  //   compression u8   (1) = 0
  //   filter u8        (1) = 0
  //   interlace u8     (1) = 0
  const ihdr = new Uint8Array(13);
  writeU32BE(ihdr, 0, width);
  writeU32BE(ihdr, 4, height);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  // Filter scanlines (filter=0 None) then deflate.
  const stride = width * 4;
  const filtered = new Uint8Array(height * (1 + stride));
  for (let y = 0; y < height; y++) {
    const dstRowStart = y * (1 + stride);
    filtered[dstRowStart] = 0; // filter type = None
    filtered.set(
      pixels.subarray(y * stride, (y + 1) * stride),
      dstRowStart + 1,
    );
  }
  const idatPayload = deflateSync(filtered);

  const ihdrChunk = buildChunk('IHDR', ihdr);
  const idatChunk = buildChunk('IDAT', new Uint8Array(idatPayload));
  const iendChunk = buildChunk('IEND', new Uint8Array(0));

  const out = new Uint8Array(
    PNG_SIGNATURE.length + ihdrChunk.length + idatChunk.length + iendChunk.length,
  );
  let off = 0;
  out.set(PNG_SIGNATURE, off);
  off += PNG_SIGNATURE.length;
  out.set(ihdrChunk, off);
  off += ihdrChunk.length;
  out.set(idatChunk, off);
  off += idatChunk.length;
  out.set(iendChunk, off);
  return out;
}
