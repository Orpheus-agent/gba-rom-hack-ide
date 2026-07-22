/**
 * Minimal PNG decoder (Phase 3.3).
 *
 * Decodes the subset of PNGs commonly produced by image editors for
 * GBA sprite/tileset import:
 *
 *   - Color types 2 (RGB), 3 (indexed-palette), 6 (RGBA), 0 (greyscale),
 *     4 (greyscale + alpha).
 *   - Bit depth 8 (we support indexed 1/2/4 too for compactness).
 *   - No interlacing (Adam7 NOT supported - image tools default to
 *     none-interlaced; if the user supplied an interlaced PNG, we
 *     throw a typed error and they re-export).
 *
 * Returns RGBA pixels in row-major u8 order regardless of source
 * color type - caller doesn't need to know the input format.
 *
 * Dependencies: `node:zlib.inflateSync` for IDAT decompression. The
 * engine package already imports `node:fs` so this is consistent with
 * the runtime target.
 */

import { inflateSync } from 'node:zlib';

/** PNG file signature: \x89 P N G \r \n \x1A \n */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export class PngDecodeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`PngDecodeError[${code}]: ${message}`);
    this.name = 'PngDecodeError';
    this.code = code;
  }
}

export interface DecodedPng {
  readonly width: number;
  readonly height: number;
  /** RGBA pixels in row-major order. Length = 4 × width × height. */
  readonly pixels: Uint8Array;
  /** Source bit depth (1/2/4/8/16). Surfaced for caller diagnostics. */
  readonly bitDepth: number;
  /** Source color type (0/2/3/4/6). */
  readonly colorType: number;
  /** When the source was an indexed PNG, the original 16-color (or
   *  fewer) palette in RGBA form. Caller can prefer this over running
   *  the quantizer. Null for non-indexed PNGs. */
  readonly palette: ReadonlyArray<readonly [number, number, number, number]> | null;
}

/** Decode a PNG byte buffer to RGBA pixels. */
export function decodePng(bytes: Uint8Array): DecodedPng {
  // Signature check
  if (bytes.length < 8) {
    throw new PngDecodeError('too_short', `PNG must be at least 8 bytes for the signature; got ${String(bytes.length)}`);
  }
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i]) {
      throw new PngDecodeError('bad_signature', `byte ${String(i)}: expected 0x${PNG_SIGNATURE[i]!.toString(16)}, got 0x${bytes[i]!.toString(16)}`);
    }
  }

  // Parse chunks.
  let cursor = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlaceMethod = 0;
  let plte: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idatChunks: Uint8Array[] = [];

  while (cursor < bytes.length) {
    if (cursor + 8 > bytes.length) {
      throw new PngDecodeError('truncated_chunk_header', `cursor ${String(cursor)} + 8 > buffer length ${String(bytes.length)}`);
    }
    const length = readU32Be(bytes, cursor);
    cursor += 4;
    const type = readChunkType(bytes, cursor);
    cursor += 4;
    if (cursor + length + 4 > bytes.length) {
      throw new PngDecodeError('truncated_chunk_body', `chunk ${type} at ${String(cursor - 4)} declares length ${String(length)} but buffer has ${String(bytes.length - cursor - 4)} bytes`);
    }
    const data = bytes.subarray(cursor, cursor + length);
    cursor += length;
    cursor += 4; // skip CRC (we don't validate; image tools produce correct CRCs)

    if (type === 'IHDR') {
      if (length !== 13) {
        throw new PngDecodeError('bad_ihdr_length', `IHDR length must be 13; got ${String(length)}`);
      }
      width = readU32Be(data, 0);
      height = readU32Be(data, 4);
      bitDepth = data[8]!;
      colorType = data[9]!;
      interlaceMethod = data[12]!;
      if (interlaceMethod !== 0) {
        throw new PngDecodeError(
          'interlaced',
          'Adam7-interlaced PNGs aren\'t supported. Re-export as non-interlaced (most image tools default to this).',
        );
      }
    } else if (type === 'PLTE') {
      if (length % 3 !== 0) {
        throw new PngDecodeError('bad_plte_length', `PLTE length must be a multiple of 3; got ${String(length)}`);
      }
      plte = data;
    } else if (type === 'tRNS') {
      trns = data;
    } else if (type === 'IDAT') {
      idatChunks.push(new Uint8Array(data));
    } else if (type === 'IEND') {
      break;
    }
    // Ignore other chunks (tEXt, gAMA, etc.) - not relevant for pixel data.
  }

  if (width === 0 || height === 0) {
    throw new PngDecodeError('no_ihdr', 'IHDR chunk missing or malformed');
  }
  // Bit-depth / color-type validation BEFORE IDAT inflation so a
  // bit-depth-mismatched file reports the actual reason rather than a
  // generic "no IDAT" downstream.
  if (bitDepth === 16) {
    throw new PngDecodeError('unsupported_bit_depth', '16-bit PNGs aren\'t supported; re-export at 8-bit');
  }
  if (bitDepth !== 8 && bitDepth !== 1 && bitDepth !== 2 && bitDepth !== 4) {
    throw new PngDecodeError('unsupported_bit_depth', `bit depth ${String(bitDepth)} not supported`);
  }
  if (colorType !== 3 && bitDepth !== 8) {
    throw new PngDecodeError('bit_depth_for_non_indexed', `bit depth ${String(bitDepth)} requires color type 3 (indexed); got ${String(colorType)}`);
  }
  if (idatChunks.length === 0) {
    throw new PngDecodeError('no_idat', 'no IDAT chunks found');
  }

  // Concat IDAT + inflate.
  let totalIdatLength = 0;
  for (const c of idatChunks) totalIdatLength += c.length;
  const idatCombined = new Uint8Array(totalIdatLength);
  {
    let off = 0;
    for (const c of idatChunks) {
      idatCombined.set(c, off);
      off += c.length;
    }
  }
  let inflated: Uint8Array;
  try {
    inflated = new Uint8Array(inflateSync(idatCombined));
  } catch (e) {
    throw new PngDecodeError('inflate_failed', e instanceof Error ? e.message : String(e));
  }

  // Compute bytes per pixel after unpacking (RGBA always 4-byte for our
  // output; here we figure out the source's bytes-per-scanline first).
  const channels = colorTypeChannels(colorType);
  if (channels === 0) {
    throw new PngDecodeError('unsupported_color_type', `color type ${String(colorType)} not supported`);
  }

  const bitsPerPixel = bitDepth * channels;
  const bytesPerScanline = Math.ceil((bitsPerPixel * width) / 8);
  const expectedInflated = (1 + bytesPerScanline) * height; // 1 filter byte per scanline
  if (inflated.length !== expectedInflated) {
    throw new PngDecodeError(
      'wrong_inflated_size',
      `inflated to ${String(inflated.length)} bytes; expected ${String(expectedInflated)} (= (1 + ${String(bytesPerScanline)}) × ${String(height)})`,
    );
  }

  // Apply PNG filtering to each scanline + assemble the unfiltered
  // byte stream.
  const filterUnit = Math.ceil(bitsPerPixel / 8); // bytes per filter "left pixel" reference
  const unfiltered = new Uint8Array(bytesPerScanline * height);
  for (let y = 0; y < height; y++) {
    const filterByte = inflated[y * (1 + bytesPerScanline)]!;
    const rowSrc = inflated.subarray(
      y * (1 + bytesPerScanline) + 1,
      y * (1 + bytesPerScanline) + 1 + bytesPerScanline,
    );
    const rowDst = unfiltered.subarray(y * bytesPerScanline, (y + 1) * bytesPerScanline);
    const upRow = y === 0 ? null : unfiltered.subarray((y - 1) * bytesPerScanline, y * bytesPerScanline);
    applyFilter(filterByte, rowSrc, rowDst, upRow, filterUnit);
  }

  // Now unpack bits + convert to RGBA.
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dstOff = (y * width + x) * 4;
      let r = 0, g = 0, b = 0, a = 255;
      if (colorType === 3) {
        // indexed
        const palIdx = readPixelBits(unfiltered, y, x, bitDepth, bytesPerScanline);
        if (plte === null) {
          throw new PngDecodeError('indexed_no_plte', 'indexed PNG (color type 3) requires PLTE chunk');
        }
        r = plte[palIdx * 3 + 0] ?? 0;
        g = plte[palIdx * 3 + 1] ?? 0;
        b = plte[palIdx * 3 + 2] ?? 0;
        a = trns !== null && palIdx < trns.length ? trns[palIdx]! : 255;
      } else if (colorType === 2) {
        // RGB 8-bit
        const off = y * bytesPerScanline + x * 3;
        r = unfiltered[off]!;
        g = unfiltered[off + 1]!;
        b = unfiltered[off + 2]!;
      } else if (colorType === 6) {
        // RGBA 8-bit
        const off = y * bytesPerScanline + x * 4;
        r = unfiltered[off]!;
        g = unfiltered[off + 1]!;
        b = unfiltered[off + 2]!;
        a = unfiltered[off + 3]!;
      } else if (colorType === 0) {
        // greyscale 8-bit
        const off = y * bytesPerScanline + x;
        r = g = b = unfiltered[off]!;
      } else if (colorType === 4) {
        // greyscale + alpha 8-bit
        const off = y * bytesPerScanline + x * 2;
        r = g = b = unfiltered[off]!;
        a = unfiltered[off + 1]!;
      }
      out[dstOff] = r;
      out[dstOff + 1] = g;
      out[dstOff + 2] = b;
      out[dstOff + 3] = a;
    }
  }

  // Extract palette for callers that prefer indexed.
  const paletteOut: Array<readonly [number, number, number, number]> | null = (() => {
    if (plte === null) return null;
    const colors: Array<[number, number, number, number]> = [];
    for (let i = 0; i < plte.length; i += 3) {
      const a = trns !== null && i / 3 < trns.length ? trns[i / 3]! : 255;
      colors.push([plte[i]!, plte[i + 1]!, plte[i + 2]!, a]);
    }
    return colors;
  })();

  return Object.freeze({
    width,
    height,
    pixels: out,
    bitDepth,
    colorType,
    palette: paletteOut,
  });
}

function readU32Be(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset]! << 24) |
      (bytes[offset + 1]! << 16) |
      (bytes[offset + 2]! << 8) |
      bytes[offset + 3]!) >>>
    0
  );
}

function readChunkType(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(bytes[offset]!, bytes[offset + 1]!, bytes[offset + 2]!, bytes[offset + 3]!);
}

function colorTypeChannels(colorType: number): number {
  switch (colorType) {
    case 0: return 1; // greyscale
    case 2: return 3; // RGB
    case 3: return 1; // indexed (each pixel is a single palette index)
    case 4: return 2; // greyscale + alpha
    case 6: return 4; // RGBA
    default: return 0;
  }
}

/** Apply one PNG filter line. Filters per RFC 2083:
 *  0 = None, 1 = Sub, 2 = Up, 3 = Average, 4 = Paeth.
 *  `filterUnit` is the byte-stride used by Sub/Avg/Paeth for the "left"
 *  pixel reference (bits-per-pixel rounded up to a byte). */
function applyFilter(
  filterByte: number,
  src: Uint8Array,
  dst: Uint8Array,
  up: Uint8Array | null,
  filterUnit: number,
): void {
  switch (filterByte) {
    case 0: // None
      dst.set(src);
      break;
    case 1: // Sub: dst[i] = src[i] + dst[i - filterUnit]
      for (let i = 0; i < src.length; i++) {
        const left = i >= filterUnit ? dst[i - filterUnit]! : 0;
        dst[i] = (src[i]! + left) & 0xff;
      }
      break;
    case 2: // Up: dst[i] = src[i] + up[i]
      for (let i = 0; i < src.length; i++) {
        const upByte = up !== null ? up[i]! : 0;
        dst[i] = (src[i]! + upByte) & 0xff;
      }
      break;
    case 3: // Average: dst[i] = src[i] + floor((left + up) / 2)
      for (let i = 0; i < src.length; i++) {
        const left = i >= filterUnit ? dst[i - filterUnit]! : 0;
        const upByte = up !== null ? up[i]! : 0;
        dst[i] = (src[i]! + Math.floor((left + upByte) / 2)) & 0xff;
      }
      break;
    case 4: // Paeth
      for (let i = 0; i < src.length; i++) {
        const left = i >= filterUnit ? dst[i - filterUnit]! : 0;
        const upByte = up !== null ? up[i]! : 0;
        const upLeft = i >= filterUnit && up !== null ? up[i - filterUnit]! : 0;
        dst[i] = (src[i]! + paethPredictor(left, upByte, upLeft)) & 0xff;
      }
      break;
    default:
      throw new PngDecodeError('bad_filter', `unknown PNG filter type ${String(filterByte)}`);
  }
}

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function readPixelBits(
  unfiltered: Uint8Array,
  y: number,
  x: number,
  bitDepth: number,
  bytesPerScanline: number,
): number {
  if (bitDepth === 8) {
    return unfiltered[y * bytesPerScanline + x]!;
  }
  if (bitDepth === 4) {
    const byte = unfiltered[y * bytesPerScanline + (x >> 1)]!;
    return (x & 1) === 0 ? (byte >> 4) & 0x0f : byte & 0x0f;
  }
  if (bitDepth === 2) {
    const byte = unfiltered[y * bytesPerScanline + (x >> 2)]!;
    const shift = 6 - (x & 3) * 2;
    return (byte >> shift) & 0x03;
  }
  if (bitDepth === 1) {
    const byte = unfiltered[y * bytesPerScanline + (x >> 3)]!;
    const shift = 7 - (x & 7);
    return (byte >> shift) & 0x01;
  }
  throw new PngDecodeError('unsupported_bit_depth', `bit depth ${String(bitDepth)}`);
}
