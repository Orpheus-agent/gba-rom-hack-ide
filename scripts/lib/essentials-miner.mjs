/**
 * Phase 8E-1 - Pokémon Essentials tileset miner.
 *
 * Walks a Pokémon Essentials install (v21.x layout) and emits a
 * Tile-Intel IR corpus the sidecar can ingest.
 *
 * Essentials' tileset format (read from disk; no engine needed):
 *
 *   - `Graphics/Tilesets/<name>.png` - one PNG per tileset, 256 px
 *     wide, variable height. Each 32×32 cell is one "tile" in
 *     Essentials' map editor; we treat each cell as an atomic
 *     metatile in IR (composition=[], since Essentials cells aren't
 *     decomposable into the gen-3 8×8 quad layout).
 *
 *   - `Graphics/Autotiles/<name>.png` - autotile sheets, typically
 *     96×128. We slice these into 32×32 cells as well; the autotile
 *     "logic" (which cell to pick for a given corner) is left to
 *     the consuming map editor.
 *
 * Both directories are merged into a single IR corpus tagged
 * `source: 'essentials'`, `family: 'essentials'`, and the user
 * supplies attribution + license via CLI flags (Essentials' overall
 * license is hand-edited; the asset license is "Essentials team +
 * varies per artist" - we record `essentials-team` by default).
 *
 * Atomic cells means:
 *   - composition: []
 *   - tiles: one entry per 32×32 cell, pixelBytesHex stores the raw
 *     cell pixels at 8×8 resolution (the cell is 32×32 RGBA; we
 *     downsample to one 8×8 indexed tile for IR - purely a
 *     fingerprint, not a recomposable asset)
 *   - phash: 64-bit perceptual hash computed over the full 32×32
 *     RGBA cell (more robust than the 8×8 fingerprint)
 *
 * Palettes: we don't attempt to faithfully extract a 16-color
 * BGR555 palette (Essentials is true-color in many cases). We
 * synthesise a single 16-color median-cut palette per tileset so
 * the IR validates against the schema; downstream similarity
 * search still works because the per-cell perceptual hashes
 * carry the visual signal.
 */

import { createHash } from 'node:crypto';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, basename, resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Engine loader (shared shape with pret miner)
// ---------------------------------------------------------------------------

async function loadEngine() {
  const enginePath = resolve('engine/dist/index.js');
  if (!existsSync(enginePath)) {
    throw new Error(
      `engine/dist not built - run \`cd engine && npm run build\` first ` +
        `before mining (PNG decoder lives in @rom-introspection/engine).`,
    );
  }
  return import(`file://${enginePath.replaceAll('\\', '/')}`);
}

// ---------------------------------------------------------------------------
// Hashing helpers
// ---------------------------------------------------------------------------

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Compute a 64-bit perceptual hash of an arbitrary-size RGBA image.
 *  Mean-luminance comparison: downsample to 8×8 by averaging blocks,
 *  then output 1 bit per cell (above-mean or not). Cheap + robust. */
function phash64Rgba(rgba, width, height) {
  if (width <= 0 || height <= 0) return Buffer.alloc(8);
  const lumGrid = new Float32Array(64);
  for (let by = 0; by < 8; by++) {
    for (let bx = 0; bx < 8; bx++) {
      const x0 = Math.floor((bx * width) / 8);
      const x1 = Math.floor(((bx + 1) * width) / 8);
      const y0 = Math.floor((by * height) / 8);
      const y1 = Math.floor(((by + 1) * height) / 8);
      let lum = 0;
      let count = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * width + x) * 4;
          const r = rgba[i];
          const g = rgba[i + 1];
          const b = rgba[i + 2];
          lum += 0.299 * r + 0.587 * g + 0.114 * b;
          count++;
        }
      }
      lumGrid[by * 8 + bx] = count > 0 ? lum / count : 0;
    }
  }
  let total = 0;
  for (let i = 0; i < 64; i++) total += lumGrid[i];
  const mean = total / 64;
  const bits = Buffer.alloc(8);
  for (let i = 0; i < 64; i++) {
    if (lumGrid[i] > mean) {
      bits[i >>> 3] |= 1 << (i & 7);
    }
  }
  return bits;
}

/** Downsample an N×N RGBA cell into one 8×8 indexed (palette index)
 *  tile by nearest-neighbor + quantize-to-palette. Used purely as a
 *  fingerprint for the IR - Essentials cells are not 8×8 in source. */
function rgbaCellToIndexed8x8(rgba, cellSize, palette16Rgba) {
  const out = new Uint8Array(64);
  for (let ty = 0; ty < 8; ty++) {
    for (let tx = 0; tx < 8; tx++) {
      const sx = Math.floor(((tx + 0.5) * cellSize) / 8);
      const sy = Math.floor(((ty + 0.5) * cellSize) / 8);
      const idx = (sy * cellSize + sx) * 4;
      const r = rgba[idx];
      const g = rgba[idx + 1];
      const b = rgba[idx + 2];
      // Match to nearest palette entry.
      let best = 0;
      let bestDelta = Infinity;
      for (let k = 0; k < palette16Rgba.length; k++) {
        const p = palette16Rgba[k];
        const dr = (p & 0xff) - r;
        const dg = ((p >>> 8) & 0xff) - g;
        const db = ((p >>> 16) & 0xff) - b;
        const delta = dr * dr + dg * dg + db * db;
        if (delta < bestDelta) {
          bestDelta = delta;
          best = k;
        }
      }
      out[ty * 8 + tx] = best;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Palette extraction (median-cut)
// ---------------------------------------------------------------------------

/** Median-cut 16-color palette from RGBA pixels. Returns the palette
 *  as both BGR555 u16 (for IR bgr555Hex) and as RGBA u32 (for
 *  downstream quantization lookups). */
function medianCutPalette16(rgba) {
  // Collect unique-ish samples; uniform stride keeps the cost down.
  const samples = [];
  const stride = Math.max(1, Math.floor(rgba.length / (4 * 4096)));
  for (let i = 0; i < rgba.length; i += 4 * stride) {
    const r = rgba[i];
    const g = rgba[i + 1];
    const b = rgba[i + 2];
    const a = rgba[i + 3];
    if (a < 16) continue; // skip near-transparent samples
    samples.push([r, g, b]);
  }
  if (samples.length === 0) {
    // Fully transparent / no opaque samples → all-black palette.
    samples.push([0, 0, 0]);
  }

  const buckets = [samples];
  while (buckets.length < 16) {
    // Pick the bucket with the largest range to split.
    let maxRangeBucket = 0;
    let maxRange = -1;
    let splitAxis = 0;
    for (let bi = 0; bi < buckets.length; bi++) {
      const b = buckets[bi];
      let rMin = 255,
        rMax = 0,
        gMin = 255,
        gMax = 0,
        bMin = 255,
        bMax = 0;
      for (const [r, g, bl] of b) {
        if (r < rMin) rMin = r;
        if (r > rMax) rMax = r;
        if (g < gMin) gMin = g;
        if (g > gMax) gMax = g;
        if (bl < bMin) bMin = bl;
        if (bl > bMax) bMax = bl;
      }
      const rR = rMax - rMin,
        rG = gMax - gMin,
        rB = bMax - bMin;
      const range = Math.max(rR, rG, rB);
      if (range > maxRange && b.length > 1) {
        maxRange = range;
        maxRangeBucket = bi;
        splitAxis = rR >= rG && rR >= rB ? 0 : rG >= rB ? 1 : 2;
      }
    }
    if (maxRange <= 0) break; // all buckets are single-color
    const target = buckets[maxRangeBucket];
    target.sort((a, b) => a[splitAxis] - b[splitAxis]);
    const mid = Math.floor(target.length / 2);
    const left = target.slice(0, mid);
    const right = target.slice(mid);
    buckets[maxRangeBucket] = left;
    buckets.push(right);
  }

  // Average each bucket to produce the palette entries.
  const palette = [];
  for (const bucket of buckets) {
    let r = 0,
      g = 0,
      b = 0;
    for (const px of bucket) {
      r += px[0];
      g += px[1];
      b += px[2];
    }
    const n = bucket.length || 1;
    palette.push([
      Math.round(r / n),
      Math.round(g / n),
      Math.round(b / n),
    ]);
  }
  while (palette.length < 16) palette.push([0, 0, 0]);

  // Build BGR555 u16 array + RGBA u32 lookup.
  const bgr555 = new Uint16Array(16);
  const rgbaLookup = new Array(16);
  for (let i = 0; i < 16; i++) {
    const [r, g, b] = palette[i];
    const r5 = (r >>> 3) & 0x1f;
    const g5 = (g >>> 3) & 0x1f;
    const b5 = (b >>> 3) & 0x1f;
    bgr555[i] = r5 | (g5 << 5) | (b5 << 10);
    // Re-expand to RGBA so cell-pixel matching uses the same color
    // the BGR555 palette would render.
    const r8 = (r5 << 3) | (r5 >>> 2);
    const g8 = (g5 << 3) | (g5 >>> 2);
    const b8 = (b5 << 3) | (b5 >>> 2);
    rgbaLookup[i] =
      (r8 | (g8 << 8) | (b8 << 16) | (0xff << 24)) >>> 0;
  }
  return { bgr555, rgbaLookup };
}

// ---------------------------------------------------------------------------
// Slug + naming
// ---------------------------------------------------------------------------

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

// ---------------------------------------------------------------------------
// Per-PNG tileset extraction
// ---------------------------------------------------------------------------

/** IR's `metatileIndex` is u10 (0..1023). Essentials sheets like
 *  Outside.png can have ~4k cells. We chunk into pages of up to
 *  PAGE_MAX cells, emitting one tileset per page. */
const PAGE_MAX = 1024;

async function buildIrTilesetsFromPng({
  engine,
  pngPath,
  displayName,
  slugPrefix,
  source,
  family,
  isSecondary,
  licenseSpdx,
  attribution,
  cellSize,
  sourceCommit,
}) {
  if (!existsSync(pngPath)) return [];
  const pngBytes = readFileSync(pngPath);
  const png = engine.graphics.decodePng(new Uint8Array(pngBytes));
  const width = png.width;
  const height = png.height;
  if (width % cellSize !== 0 || height % cellSize !== 0) {
    console.warn(
      `  ! skipping ${pngPath}: ${width}x${height} is not divisible by ${cellSize}`,
    );
    return [];
  }
  const cols = width / cellSize;
  const rows = height / cellSize;
  const cellCount = cols * rows;
  if (cellCount === 0) return [];

  const { bgr555, rgbaLookup } = medianCutPalette16(png.pixels);

  // Compute per-cell rendered hash + phash + downsampled 8×8 indexed
  // pixels. We accumulate into a flat list and chunk later.
  const tilesAll = [];
  const metatilesAll = [];
  let cellIndex = 0;
  for (let ry = 0; ry < rows; ry++) {
    for (let rx = 0; rx < cols; rx++) {
      // Extract the cellSize × cellSize cell into a contiguous RGBA buf.
      const cell = Buffer.alloc(cellSize * cellSize * 4);
      for (let y = 0; y < cellSize; y++) {
        const srcOff = ((ry * cellSize + y) * width + rx * cellSize) * 4;
        const dstOff = y * cellSize * 4;
        png.pixels.copy
          ? png.pixels.copy(cell, dstOff, srcOff, srcOff + cellSize * 4)
          : copyBuffer(png.pixels, cell, srcOff, dstOff, cellSize * 4);
      }
      const renderedHash = sha256Hex(cell);
      const phashBytes = phash64Rgba(cell, cellSize, cellSize);
      const indexed8x8 = rgbaCellToIndexed8x8(cell, cellSize, rgbaLookup);
      const indexedBuf = Buffer.from(indexed8x8);
      tilesAll.push({
        tileIndex: cellIndex,
        pixelBytesHex: indexedBuf.toString('hex'),
        pixelHashHex: sha256Hex(indexedBuf),
        paletteNeutralHashHex: sha256Hex(indexedBuf),
        phashHex: phashBytes.toString('hex'),
        isBlank: indexed8x8.every((v) => v === indexed8x8[0]),
        isHorizontallySymmetric: false,
        isVerticallySymmetric: false,
      });
      metatilesAll.push({
        metatileIndex: cellIndex,
        // Essentials cells are atomic - no attribute byte. Behavior=0
        // means "passable open ground" by default; real walkability
        // is decided by the host map editor, not stored in the
        // PNG.
        attrRawHex: '00000000',
        behaviorId: 0,
        terrainType: 0,
        encounterType: 0,
        layerType: 0,
        composition: [],
        renderedHashHex: renderedHash,
        phashHex: phashBytes.toString('hex'),
      });
      cellIndex++;
    }
  }

  // Build palette payload (single palette for the whole sheet - the
  // schema expects up to 16).
  let totalLum = 0;
  for (const c of bgr555) {
    const r5 = c & 0x1f;
    const g5 = (c >>> 5) & 0x1f;
    const b5 = (c >>> 10) & 0x1f;
    const r = (r5 << 3) | (r5 >>> 2);
    const g = (g5 << 3) | (g5 >>> 2);
    const b = (b5 << 3) | (b5 >>> 2);
    totalLum += 0.299 * r + 0.587 * g + 0.114 * b;
  }
  const paletteBytes = Buffer.from(bgr555.buffer, bgr555.byteOffset, 32);
  const top5Hex = [];
  // Pick 5 most-saturated palette entries as a "median cut 5" hint.
  // (The IR's medianCut5 is informational + visualised by the
  // tileset library tab; v1 just samples uniformly.)
  for (let i = 0; i < 5; i++) {
    const slot = Math.floor((i * 16) / 5);
    const c = bgr555[slot];
    const r5 = c & 0x1f;
    const g5 = (c >>> 5) & 0x1f;
    const b5 = (c >>> 10) & 0x1f;
    const r = (r5 << 3) | (r5 >>> 2);
    const g = (g5 << 3) | (g5 >>> 2);
    const b = (b5 << 3) | (b5 >>> 2);
    top5Hex.push(
      '#' +
        [r, g, b]
          .map((v) => v.toString(16).padStart(2, '0'))
          .join(''),
    );
  }

  const baseSlug = `${slugPrefix}-${slugify(basename(pngPath, '.png'))}`;
  const pageCount = Math.ceil(tilesAll.length / PAGE_MAX);
  const out = [];
  for (let p = 0; p < pageCount; p++) {
    const start = p * PAGE_MAX;
    const end = Math.min(tilesAll.length, start + PAGE_MAX);
    const pageTiles = tilesAll.slice(start, end).map((t, i) => ({
      ...t,
      tileIndex: i,
    }));
    const pageMetatiles = metatilesAll.slice(start, end).map((m, i) => ({
      ...m,
      metatileIndex: i,
    }));
    const slug = pageCount === 1 ? baseSlug : `${baseSlug}-page-${p}`;
    const pageDisplayName =
      pageCount === 1 ? displayName : `${displayName} (page ${p + 1}/${pageCount})`;
    out.push({
      slug,
      displayName: pageDisplayName,
      source,
      sourceCommit: sourceCommit ?? null,
      attribution,
      licenseSpdx,
      family,
      isSecondary,
      isCompressed: false,
      tileCount: pageTiles.length,
      metatileCount: pageMetatiles.length,
      palettes: [
        {
          paletteIndex: 0,
          bgr555Hex: paletteBytes.toString('hex'),
          medianCut5: top5Hex,
          dominantHue: null,
          luminanceAvg: Math.min(255, Math.max(0, Math.round(totalLum / 16))),
        },
      ],
      tiles: pageTiles,
      metatiles: pageMetatiles,
    });
  }
  return out;
}

function copyBuffer(src, dst, srcStart, dstStart, length) {
  // Fallback for Uint8Array sources without a .copy() method.
  for (let i = 0; i < length; i++) {
    dst[dstStart + i] = src[srcStart + i];
  }
}

// ---------------------------------------------------------------------------
// Top-level: mine an Essentials install
// ---------------------------------------------------------------------------

/**
 * @param {object} opts
 * @param {string} opts.essentialsRoot - absolute path to the
 *   Essentials install (the directory containing `Graphics/`).
 * @param {string} [opts.attribution]
 * @param {string} [opts.licenseSpdx]
 * @param {string} [opts.sourceCommit]
 * @returns {Promise<{tilesets: object[]; mapAdjacencies: object[]}>}
 */
export async function mineEssentials({
  essentialsRoot,
  attribution = 'Pokémon Essentials team and contributing artists',
  licenseSpdx = 'unknown',
  sourceCommit = null,
}) {
  const engine = await loadEngine();
  if (!existsSync(essentialsRoot)) {
    throw new Error(`Essentials root does not exist: ${essentialsRoot}`);
  }
  const graphicsDir = join(essentialsRoot, 'Graphics');
  if (!existsSync(graphicsDir)) {
    throw new Error(`No Graphics/ in ${essentialsRoot}`);
  }

  const tilesets = [];

  // Stock tilesets: Graphics/Tilesets/*.png, cell size 32.
  const tilesetsDir = join(graphicsDir, 'Tilesets');
  if (existsSync(tilesetsDir) && statSync(tilesetsDir).isDirectory()) {
    const files = readdirSync(tilesetsDir).filter((f) =>
      f.toLowerCase().endsWith('.png'),
    );
    files.sort();
    console.log(`Mining ${files.length} tileset PNG(s) at 32×32 cells…`);
    for (const file of files) {
      const pages = await buildIrTilesetsFromPng({
        engine,
        pngPath: join(tilesetsDir, file),
        displayName: file.replace(/\.png$/i, ''),
        slugPrefix: 'essentials-tileset',
        source: 'essentials',
        family: 'essentials',
        isSecondary: false,
        licenseSpdx,
        attribution,
        cellSize: 32,
        sourceCommit,
      });
      tilesets.push(...pages);
    }
  }

  // Autotiles: Graphics/Autotiles/*.png - cell size 32 (each
  // autotile sheet is 96×128 = 3 cols × 4 rows; each cell is one
  // corner/edge variant). Tag as is_secondary=true so the library
  // browser can filter them.
  const autotilesDir = join(graphicsDir, 'Autotiles');
  if (existsSync(autotilesDir) && statSync(autotilesDir).isDirectory()) {
    const files = readdirSync(autotilesDir).filter((f) =>
      f.toLowerCase().endsWith('.png'),
    );
    files.sort();
    console.log(`Mining ${files.length} autotile PNG(s) at 32×32 cells…`);
    for (const file of files) {
      const pages = await buildIrTilesetsFromPng({
        engine,
        pngPath: join(autotilesDir, file),
        displayName: `Autotile: ${file.replace(/\.png$/i, '')}`,
        slugPrefix: 'essentials-autotile',
        source: 'essentials',
        family: 'essentials',
        isSecondary: true,
        licenseSpdx,
        attribution,
        cellSize: 32,
        sourceCommit,
      });
      tilesets.push(...pages);
    }
  }

  return { tilesets, mapAdjacencies: [] };
}
