/**
 * Palette quantizer (Phase 3.3).
 *
 * Reduces an RGBA pixel grid to a 16-color BGR555 palette + indexed-
 * pixel array. Used by sprite/tileset import to convert user-supplied
 * PNGs to the GBA-native indexed-palette format.
 *
 * Algorithm: median-cut quantization. Stable + deterministic - same
 * input always produces the same palette. The first palette slot is
 * always RESERVED for the "transparent" color (any pixel with alpha < 128
 * maps to index 0); the remaining 15 slots get the median-cut output.
 *
 * If the input has ≤ 16 distinct colors already, the quantizer skips
 * the cut and just packs them into the palette directly (lossless).
 *
 * Output palette is in BGR555 (GBA-native): 16 colors × 2 bytes each =
 * 32 bytes. Index 0 is the GBA's "transparent" color slot.
 */

import { PALETTE_4BPP_SIZE_BYTES } from './tile-pixels.js';

const PALETTE_SIZE = 16;
/** Pixels with alpha less than this are mapped to palette index 0
 *  (transparent). */
const TRANSPARENT_ALPHA_THRESHOLD = 128;

export interface QuantizeResult {
  /** 32-byte BGR555 palette ready to write to ROM. */
  readonly palette: Uint8Array;
  /** Indexed pixels, one byte per pixel (values 0..15). Length =
   *  widthPx × heightPx. */
  readonly indexed: Uint8Array;
  /** Number of distinct colors mapped (excludes the reserved transparent
   *  slot at index 0). */
  readonly colorCount: number;
}

export class PaletteQuantizerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaletteQuantizerError';
  }
}

/**
 * Quantize RGBA pixels to a 16-color palette + indexed image. Pixels
 * with alpha < 128 are mapped to index 0 (transparent); the remaining
 * pixels are clustered via median-cut into ≤ 15 colors.
 *
 * `pixels` is a flat array of u8 RGBA (R, G, B, A) bytes - length
 * 4 × widthPx × heightPx.
 */
export function quantizeRgbaToIndexed(
  pixels: Uint8Array,
  widthPx: number,
  heightPx: number,
): QuantizeResult {
  const totalPx = widthPx * heightPx;
  if (pixels.length !== totalPx * 4) {
    throw new PaletteQuantizerError(
      `quantizeRgbaToIndexed: pixels.length must be 4 × ${String(totalPx)}; got ${String(pixels.length)}`,
    );
  }

  // First pass: collect opaque pixels' RGB triples (drop alpha; only
  // alpha < threshold = transparent gets routed to slot 0).
  const opaqueRgb: number[][] = [];
  const transparentMask = new Uint8Array(totalPx); // 1 = transparent
  for (let i = 0; i < totalPx; i++) {
    const r = pixels[i * 4 + 0]!;
    const g = pixels[i * 4 + 1]!;
    const b = pixels[i * 4 + 2]!;
    const a = pixels[i * 4 + 3]!;
    if (a < TRANSPARENT_ALPHA_THRESHOLD) {
      transparentMask[i] = 1;
    } else {
      opaqueRgb.push([r, g, b, i]); // include pixel index for later mapping
    }
  }

  // Dedup distinct (r,g,b) colors among opaque pixels.
  const distinctMap = new Map<number, number>(); // packedRgb -> index in distinctColors
  const distinctColors: Array<[number, number, number]> = [];
  for (const px of opaqueRgb) {
    const key = (px[0]! << 16) | (px[1]! << 8) | px[2]!;
    if (!distinctMap.has(key)) {
      distinctMap.set(key, distinctColors.length);
      distinctColors.push([px[0]!, px[1]!, px[2]!]);
    }
  }

  // Build the palette. Slot 0 is the transparent color - by convention
  // use magenta-like (255, 0, 255) so debugging is obvious.
  const palette = new Uint8Array(PALETTE_4BPP_SIZE_BYTES);
  writeBgr555Color(palette, 0, 0xff, 0x00, 0xff);

  let representatives: Array<[number, number, number]>;
  if (distinctColors.length <= PALETTE_SIZE - 1) {
    // Lossless path: just pack the distinct colors.
    representatives = distinctColors;
  } else {
    representatives = medianCut(distinctColors, PALETTE_SIZE - 1);
  }
  for (let i = 0; i < representatives.length; i++) {
    const [r, g, b] = representatives[i]!;
    writeBgr555Color(palette, i + 1, r, g, b);
  }

  // Build the indexed pixel array. For each opaque pixel, find the
  // closest representative; transparent pixels get index 0.
  const indexed = new Uint8Array(totalPx);
  for (let i = 0; i < totalPx; i++) {
    if (transparentMask[i] === 1) {
      indexed[i] = 0;
      continue;
    }
    const r = pixels[i * 4 + 0]!;
    const g = pixels[i * 4 + 1]!;
    const b = pixels[i * 4 + 2]!;
    indexed[i] = findClosestPaletteIndex(r, g, b, representatives) + 1;
  }
  return Object.freeze({
    palette,
    indexed,
    colorCount: representatives.length,
  });
}

/** Median-cut: recursively splits color clusters along the channel with
 *  the largest range. Returns at most `paletteSize` representatives
 *  (one per cluster, computed as the cluster's mean color). */
function medianCut(
  colors: ReadonlyArray<readonly [number, number, number]>,
  paletteSize: number,
): Array<[number, number, number]> {
  if (colors.length === 0) return [];
  // Buckets: list of clusters; each cluster is a list of colors.
  let buckets: Array<Array<readonly [number, number, number]>> = [[...colors]];
  while (buckets.length < paletteSize) {
    // Find the bucket with the largest channel range and split it.
    let bestIdx = -1;
    let bestRange = -1;
    let bestChannel = 0;
    for (let i = 0; i < buckets.length; i++) {
      const bucket = buckets[i]!;
      if (bucket.length <= 1) continue;
      let rMin = 256, rMax = -1, gMin = 256, gMax = -1, bMin = 256, bMax = -1;
      for (const c of bucket) {
        if (c[0] < rMin) rMin = c[0];
        if (c[0] > rMax) rMax = c[0];
        if (c[1] < gMin) gMin = c[1];
        if (c[1] > gMax) gMax = c[1];
        if (c[2] < bMin) bMin = c[2];
        if (c[2] > bMax) bMax = c[2];
      }
      const rRange = rMax - rMin;
      const gRange = gMax - gMin;
      const bRange = bMax - bMin;
      const maxRange = Math.max(rRange, gRange, bRange);
      if (maxRange > bestRange) {
        bestRange = maxRange;
        bestIdx = i;
        bestChannel = rRange === maxRange ? 0 : gRange === maxRange ? 1 : 2;
      }
    }
    if (bestIdx < 0) break; // every bucket is singleton; nothing left to split
    const bucket = buckets[bestIdx]!;
    bucket.sort((a, b) => a[bestChannel]! - b[bestChannel]!);
    const mid = Math.floor(bucket.length / 2);
    const left = bucket.slice(0, mid);
    const right = bucket.slice(mid);
    buckets.splice(bestIdx, 1, left, right);
  }
  // Average each bucket to a single representative.
  return buckets.map((bucket) => {
    let sumR = 0, sumG = 0, sumB = 0;
    for (const c of bucket) {
      sumR += c[0]!;
      sumG += c[1]!;
      sumB += c[2]!;
    }
    return [
      Math.round(sumR / bucket.length),
      Math.round(sumG / bucket.length),
      Math.round(sumB / bucket.length),
    ] as [number, number, number];
  });
}

function findClosestPaletteIndex(
  r: number,
  g: number,
  b: number,
  representatives: ReadonlyArray<readonly [number, number, number]>,
): number {
  let bestIdx = 0;
  let bestDist = Number.POSITIVE_INFINITY;
  for (let i = 0; i < representatives.length; i++) {
    const [pr, pg, pb] = representatives[i]!;
    const dr = r - pr;
    const dg = g - pg;
    const db = b - pb;
    // Weighted Euclidean - green carries more perceptual weight.
    const d = dr * dr * 0.3 + dg * dg * 0.59 + db * db * 0.11;
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }
  return bestIdx;
}

/** Convert an 8-bit RGB triple to a BGR555 u16 and write it to slot
 *  `slotIndex` of the 32-byte palette buffer. */
function writeBgr555Color(
  palette: Uint8Array,
  slotIndex: number,
  r: number,
  g: number,
  b: number,
): void {
  const r5 = r >> 3;
  const g5 = g >> 3;
  const b5 = b >> 3;
  const u16 = (b5 << 10) | (g5 << 5) | r5;
  palette[slotIndex * 2 + 0] = u16 & 0xff;
  palette[slotIndex * 2 + 1] = (u16 >> 8) & 0xff;
}

/** Standalone RGB → BGR555 u16. Exported for callers that just need the
 *  conversion (e.g. setting a single palette entry). */
export function rgbToBgr555(r: number, g: number, b: number): number {
  return ((b >> 3) << 10) | ((g >> 3) << 5) | (r >> 3);
}
