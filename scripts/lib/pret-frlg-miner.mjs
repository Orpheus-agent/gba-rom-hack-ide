/**
 * Phase 8B-1 - pret/pokefirered tileset + adjacency miner.
 *
 * Reads a checked-out pret/pokefirered tree and emits a
 * Tile-Intel IR corpus. The output JSON has the shape defined in
 * `app/shared/src/tile-intel-ir.ts` (TileIntelIRCorpus →
 * TileIntelIRTileset[] + TileIntelIRMapAdjacency[]).
 *
 * Where the data lives in pret:
 *   - data/tilesets/{primary,secondary}/<slug>/
 *       tiles.png - 4-bit colormap PNG, 16 tiles wide
 *       palettes/<NN>.pal - JASC PAL, 16 colors each (NN: 00..15)
 *       metatiles.bin - 16 bytes/metatile, N metatiles
 *       metatile_attributes.bin - 4 bytes/metatile (FRLG)
 *   - data/layouts/<name>/
 *       map.bin - width × height × 2 bytes of u16
 *                              metatile-ids (low 10 bits = id, high
 *                              6 = collision+elevation)
 *   - data/layouts/layouts.json
 *       per-layout {name, width, height, primary_tileset,
 *       secondary_tileset, blockdata_filepath}
 *
 * Symbol → directory: `gTileset_General` → `primary/general`;
 * `gTileset_PalletTown` → `secondary/pallet_town`. The primary vs.
 * secondary classification is read from `src/data/tilesets/headers.h`.
 *
 * The miner never invokes the GBA assembler - it reads the source
 * tree's binary + image artifacts directly. This makes it
 * idempotent: rerunning produces identical IR if the source tree
 * hasn't moved.
 */

import { createHash } from 'node:crypto';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// Engine import (lazy: only when this module is actually used so the
// skeleton can run on machines that don't have the engine built).
// ---------------------------------------------------------------------------

async function loadEngine() {
  // Engine compiles to dist; backend resolves via the package's
  // `main` field. For a script at the repo root we resolve the path
  // explicitly to avoid relying on workspace symlinks.
  const enginePath = resolve('engine/dist/index.js');
  if (!existsSync(enginePath)) {
    throw new Error(
      `engine/dist not built - run \`cd engine && npm run build\` first ` +
        `(missing: ${enginePath})`,
    );
  }
  return import(`file://${enginePath.replaceAll('\\', '/')}`);
}

// ---------------------------------------------------------------------------
// Symbol → directory mapping
// ---------------------------------------------------------------------------

/** `gTileset_PalletTown` → `pallet_town`; `gTileset_GenericBuilding1`
 *  → `generic_building1`. Pret directories all snake-case. */
export function symbolToSlug(symbol) {
  const stripped = symbol.replace(/^gTileset_/, '');
  return stripped
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-zA-Z])(\d)/g, '$1_$2')
    .toLowerCase();
}

/** Read `src/data/tilesets/headers.h` to learn whether each
 *  gTileset_X is primary (isSecondary = FALSE) or secondary. The
 *  miner uses this to resolve the directory under
 *  `data/tilesets/{primary,secondary}/`. */
export function readTilesetHeaders(pretRoot) {
  const path = join(pretRoot, 'src/data/tilesets/headers.h');
  if (!existsSync(path)) {
    throw new Error(`tileset headers not found: ${path}`);
  }
  const text = readFileSync(path, 'utf8');
  // Each block: `const struct Tileset gTileset_NAME = { ... }`
  // We extract the symbol name + the `.isSecondary = TRUE|FALSE`
  // line. (`.isCompressed` is documented but irrelevant for source-
  // level mining - the source files are already decompressed.)
  const entries = new Map(); // slug -> { symbol, isSecondary, isCompressed }
  const blockRe = /const struct Tileset (gTileset_\w+)\s*=\s*\{([^}]+)\}/g;
  let match;
  while ((match = blockRe.exec(text)) !== null) {
    const symbol = match[1];
    const body = match[2];
    const isSecondary = /\.isSecondary\s*=\s*TRUE/.test(body);
    const isCompressed = /\.isCompressed\s*=\s*TRUE/.test(body);
    entries.set(symbol, { symbol, slug: symbolToSlug(symbol), isSecondary, isCompressed });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// JASC palette
// ---------------------------------------------------------------------------

/** Parse a JASC-PAL text file → array of 16 BGR555 u16 values. */
export function parseJascPal(text) {
  const lines = text.split(/\r?\n/);
  // header: 'JASC-PAL\n0100\n16\n' then 16 'R G B' lines
  let i = 0;
  // skip leading blanks
  while (i < lines.length && !lines[i].trim()) i++;
  if (!lines[i] || !lines[i].startsWith('JASC')) {
    throw new Error('expected JASC-PAL header');
  }
  i++; // JASC-PAL
  i++; // 0100
  i++; // 16
  const out = [];
  for (let p = 0; p < 16 && i < lines.length; p++, i++) {
    const parts = lines[i].trim().split(/\s+/);
    if (parts.length < 3) break;
    const r = Number(parts[0]) & 0xff;
    const g = Number(parts[1]) & 0xff;
    const b = Number(parts[2]) & 0xff;
    // BGR555: bits 0-4 = R/8, 5-9 = G/8, 10-14 = B/8
    const r5 = (r >>> 3) & 0x1f;
    const g5 = (g >>> 3) & 0x1f;
    const b5 = (b >>> 3) & 0x1f;
    out.push((b5 << 10) | (g5 << 5) | r5);
  }
  // pad to 16 if the file was short
  while (out.length < 16) out.push(0);
  return out;
}

/** Convert a u16 BGR555 array (length 16) → raw 32-byte buffer (low
 *  byte first per GBA). */
export function bgr555ToBytes(palette) {
  const bytes = Buffer.alloc(32);
  for (let i = 0; i < 16; i++) {
    bytes[i * 2] = palette[i] & 0xff;
    bytes[i * 2 + 1] = (palette[i] >>> 8) & 0xff;
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// 4bpp tile pixel extraction from a PNG-loaded indexed image
// ---------------------------------------------------------------------------

/** Slice a w×h palette-indexed-pixel buffer into 8×8 tiles laid out
 *  in tilesPerRow columns. Returns an array of Uint8Array(64). */
export function sliceIndexedToTiles(indexed, width, height, tilesPerRow = width / 8) {
  const tilesAcross = Math.floor(width / 8);
  const tilesDown = Math.floor(height / 8);
  const tiles = [];
  for (let ty = 0; ty < tilesDown; ty++) {
    for (let tx = 0; tx < tilesAcross; tx++) {
      const tile = new Uint8Array(64);
      for (let py = 0; py < 8; py++) {
        for (let px = 0; px < 8; px++) {
          tile[py * 8 + px] = indexed[(ty * 8 + py) * width + (tx * 8 + px)];
        }
      }
      tiles.push(tile);
    }
  }
  return tiles;
}

// ---------------------------------------------------------------------------
// Metatile composition parser
// ---------------------------------------------------------------------------

/** Decode one 16-byte metatile composition into 8 typed slot objects.
 *  Quad order: layer-0 [NW, NE, SW, SE] then layer-1 [NW, NE, SW, SE]. */
export function decodeMetatileSlots(buffer, offset) {
  const slots = [];
  for (let i = 0; i < 8; i++) {
    const word = buffer.readUInt16LE(offset + i * 2);
    const layer = i < 4 ? 0 : 1;
    const quad = i % 4;
    slots.push({
      layer,
      quad,
      tileIndex: word & 0x3ff,
      hflip: (word & 0x400) !== 0,
      vflip: (word & 0x800) !== 0,
      paletteIndex: (word >>> 12) & 0xf,
    });
  }
  return slots;
}

/** Decode one 4-byte FRLG attribute word.
 *  Layout:
 *    bits 0-8:    behavior   (9)
 *    bits 9-13:   terrain    (5)
 *    bits 24-26:  encounter  (3)
 *    bits 27-28:  layer      (2)  */
export function decodeFrlgAttribute(buffer, offset) {
  const word = buffer.readUInt32LE(offset);
  return {
    behaviorId: word & 0x1ff,
    terrainType: (word >>> 9) & 0x1f,
    encounterType: (word >>> 24) & 0x7,
    layerType: (word >>> 27) & 0x3,
  };
}

/** Decode one 2-byte RSE (Ruby/Sapphire/Emerald) attribute word.
 *  Layout:
 *    bits 0-7:    behavior   (8 - RSE caps at 256 behaviors vs FRLG's 512)
 *    bits 12-13:  layer      (2)
 *  Terrain + encounter fields don't exist in RSE; we report them as 0
 *  so downstream code can treat both families uniformly. */
export function decodeRseAttribute(buffer, offset) {
  const word = buffer.readUInt16LE(offset);
  return {
    behaviorId: word & 0xff,
    terrainType: 0,
    encounterType: 0,
    layerType: (word >>> 12) & 0x3,
  };
}

/** Per-family config used by `readPretTileset` + `minePretCorpus`. */
const FAMILY_CONFIGS = {
  frlg: {
    family: 'frlg',
    slugPrefix: 'pret-frlg',
    attributeBytesPerMetatile: 4,
    decodeAttribute: decodeFrlgAttribute,
    /** FRLG metatile-id partition: primary = 0..0x1FF, secondary = 0x200..0x3FF. */
    primaryMetatileMax: 0x200,
  },
  rse: {
    family: 'rse',
    slugPrefix: 'pret-rse',
    attributeBytesPerMetatile: 2,
    decodeAttribute: decodeRseAttribute,
    /** RSE metatile-id partition: primary = 0..0x1FF, secondary = 0x200..0x3FF.
     *  Same shape as FRLG even though the engine differs elsewhere. */
    primaryMetatileMax: 0x200,
  },
};

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

export function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/** Cheap 64-bit perceptual hash for an 8×8 tile (indexed pixels):
 *  flip each pixel to "above-mean" vs "below-mean" yielding 64 bits.
 *  Good enough for fuzzy-dedup at corpus-builder time; the sidecar
 *  later uses CLIP for true similarity. */
export function phash8x8Indexed(pixels) {
  let sum = 0;
  for (const p of pixels) sum += p;
  const mean = sum / pixels.length;
  let bits = 0n;
  for (let i = 0; i < 64; i++) {
    if (pixels[i] >= mean) bits |= 1n << BigInt(i);
  }
  return bits.toString(16).padStart(16, '0');
}

/** Same approach for a 16×16 RGBA image: compute mean luminance,
 *  threshold each pixel into a 256-bit hash. We truncate to 64 bits
 *  by sampling every 4th pixel - keeps the storage cost equal to
 *  the tile pHash. */
export function phash16x16Rgba(rgba) {
  const w = 16,
    h = 16;
  // luminance = 0.299R + 0.587G + 0.114B
  const lums = new Float32Array(w * h);
  let total = 0;
  for (let i = 0; i < w * h; i++) {
    const r = rgba[i * 4];
    const g = rgba[i * 4 + 1];
    const b = rgba[i * 4 + 2];
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    lums[i] = lum;
    total += lum;
  }
  const mean = total / (w * h);
  let bits = 0n;
  // Sample every 4th pixel - 64 samples from a 256-pixel grid.
  for (let i = 0; i < 64; i++) {
    const idx = i * 4;
    if (lums[idx] >= mean) bits |= 1n << BigInt(i);
  }
  return bits.toString(16).padStart(16, '0');
}

// ---------------------------------------------------------------------------
// Metatile compositor
// ---------------------------------------------------------------------------

/** Render a metatile to a 16×16 RGBA buffer from its 8 slots, the
 *  tile-table, and the 16 palettes (each as a 16-color RGBA u32
 *  array). Returns Uint8Array of length 16*16*4 = 1024. */
export function composeMetatileRgba(slots, tiles, paletteBgr555) {
  const out = new Uint8Array(16 * 16 * 4);
  // Convert all 16 palettes to RGBA u32 once
  const palettesRgba = paletteBgr555.map((pal) =>
    pal.map((bgr555) => {
      const r5 = bgr555 & 0x1f;
      const g5 = (bgr555 >>> 5) & 0x1f;
      const b5 = (bgr555 >>> 10) & 0x1f;
      const r = (r5 << 3) | (r5 >>> 2);
      const g = (g5 << 3) | (g5 >>> 2);
      const b = (b5 << 3) | (b5 >>> 2);
      return [r, g, b];
    }),
  );
  for (const slot of slots) {
    if (slot.tileIndex >= tiles.length) continue;
    const tile = tiles[slot.tileIndex];
    if (!tile) continue;
    const palette = palettesRgba[slot.paletteIndex];
    const baseX = slot.quad % 2 === 0 ? 0 : 8;
    const baseY = slot.quad < 2 ? 0 : 8;
    for (let py = 0; py < 8; py++) {
      for (let px = 0; px < 8; px++) {
        const sx = slot.hflip ? 7 - px : px;
        const sy = slot.vflip ? 7 - py : py;
        const colorIndex = tile[sy * 8 + sx];
        // Transparent for layer-0 vs layer-1 differs in real game;
        // for our compose we treat color index 0 of any non-base
        // palette as transparent (only on layer 1).
        if (slot.layer === 1 && colorIndex === 0) continue;
        const [r, g, b] = palette[colorIndex];
        const i = ((baseY + py) * 16 + (baseX + px)) * 4;
        out[i] = r;
        out[i + 1] = g;
        out[i + 2] = b;
        out[i + 3] = 255;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tileset reader
// ---------------------------------------------------------------------------

/** Read one tileset's source files. Returns the per-tileset payload
 *  that goes into the IR. */
export async function readPretTileset(pretRoot, header, source, sourceCommit, engine, familyConfig = FAMILY_CONFIGS.frlg) {
  const subdir = header.isSecondary ? 'secondary' : 'primary';
  const tsDir = join(pretRoot, 'data/tilesets', subdir, header.slug);
  if (!existsSync(tsDir)) {
    return { error: `tileset directory missing: ${tsDir}`, slug: header.slug };
  }
  // ---- Palettes ----
  const palDir = join(tsDir, 'palettes');
  const palettes = [];
  const paletteBgr555s = [];
  for (let i = 0; i < 16; i++) {
    const palPath = join(palDir, `${String(i).padStart(2, '0')}.pal`);
    if (!existsSync(palPath)) {
      // Some primary tilesets only ship a subset; fill with black.
      paletteBgr555s.push(new Array(16).fill(0));
      palettes.push({
        paletteIndex: i,
        bgr555Hex: '0'.repeat(64),
        medianCut5: ['#000000'],
        dominantHue: null,
        luminanceAvg: 0,
      });
      continue;
    }
    const palText = readFileSync(palPath, 'utf8');
    const bgr555 = parseJascPal(palText);
    paletteBgr555s.push(bgr555);
    const paletteBytes = bgr555ToBytes(bgr555);
    // 5-color median cut: dumb approximation - sample 5 evenly-spaced
    // entries that aren't all-black. The CLIP layer in 8D-2 replaces
    // this with the real median-cut clustering.
    const nonZero = paletteBytes
      .reduce((acc, b, idx) => {
        if (idx % 2 === 0) {
          const w = paletteBytes[idx] | (paletteBytes[idx + 1] << 8);
          if (w !== 0) acc.push(w);
        }
        return acc;
      }, [])
      .slice(0, 5);
    const top5Hex = (nonZero.length > 0 ? nonZero : [0]).map((bgr555) => {
      const r = (bgr555 & 0x1f) << 3;
      const g = ((bgr555 >>> 5) & 0x1f) << 3;
      const b = ((bgr555 >>> 10) & 0x1f) << 3;
      return (
        '#' +
        r.toString(16).padStart(2, '0') +
        g.toString(16).padStart(2, '0') +
        b.toString(16).padStart(2, '0')
      );
    });
    // Average luminance for the palette.
    let totalLum = 0;
    for (const color of bgr555) {
      const r = (color & 0x1f) << 3;
      const g = ((color >>> 5) & 0x1f) << 3;
      const b = ((color >>> 10) & 0x1f) << 3;
      totalLum += 0.299 * r + 0.587 * g + 0.114 * b;
    }
    palettes.push({
      paletteIndex: i,
      bgr555Hex: paletteBytes.toString('hex'),
      medianCut5: top5Hex,
      dominantHue: null,
      luminanceAvg: Math.min(255, Math.max(0, Math.round(totalLum / 16))),
    });
  }
  // ---- Tiles (tiles.png → indexed pixels) ----
  const pngPath = join(tsDir, 'tiles.png');
  if (!existsSync(pngPath)) {
    return { error: `tiles.png missing: ${pngPath}`, slug: header.slug };
  }
  const pngBytes = readFileSync(pngPath);
  const png = engine.graphics.decodePng(new Uint8Array(pngBytes));
  // pret's tiles.png is palette-indexed 4-bit. The engine's
  // decodePng returns RGBA pixels by default. We need raw indices to
  // store in the IR - re-derive from the palette + rgba round-trip,
  // OR re-parse via a smaller helper.  For the IR's pixelBytesHex we
  // can use either; the canonical decision is: store the indexed
  // pixels relative to the FIRST palette (palette 0) since that's
  // the most common authoring palette.
  // The engine's decodePng emits RGBA; for indexed PNGs the
  // alphaIndex / palette is also exposed. Easiest path: re-derive
  // indices by matching RGBA to palette 0.
  const rgba = png.pixels;
  // Convert palette 0 to RGBA u32 lookup for matching.
  const pal0 = paletteBgr555s[0].map((bgr555) => {
    const r5 = bgr555 & 0x1f;
    const g5 = (bgr555 >>> 5) & 0x1f;
    const b5 = (bgr555 >>> 10) & 0x1f;
    return ((r5 << 3) | (r5 >>> 2)) |
      (((g5 << 3) | (g5 >>> 2)) << 8) |
      (((b5 << 3) | (b5 >>> 2)) << 16) |
      (0xff << 24);
  });
  const indexed = new Uint8Array(png.width * png.height);
  for (let i = 0; i < indexed.length; i++) {
    const r = rgba[i * 4];
    const g = rgba[i * 4 + 1];
    const b = rgba[i * 4 + 2];
    const a = rgba[i * 4 + 3];
    const packed = (r | (g << 8) | (b << 16) | (a << 24)) >>> 0;
    let best = 0;
    let bestDelta = Infinity;
    for (let k = 0; k < 16; k++) {
      if (pal0[k] === packed) {
        best = k;
        bestDelta = 0;
        break;
      }
      const dr = ((pal0[k] & 0xff) - r) ** 2;
      const dg = (((pal0[k] >>> 8) & 0xff) - g) ** 2;
      const db = (((pal0[k] >>> 16) & 0xff) - b) ** 2;
      const delta = dr + dg + db;
      if (delta < bestDelta) {
        bestDelta = delta;
        best = k;
      }
    }
    indexed[i] = best;
  }
  const tiles = sliceIndexedToTiles(indexed, png.width, png.height, png.width / 8);
  const irTiles = tiles.map((pixels, idx) => {
    const buf = Buffer.from(pixels);
    const ph = phash8x8Indexed(pixels);
    return {
      tileIndex: idx,
      pixelBytesHex: buf.toString('hex'),
      pixelHashHex: sha256Hex(buf),
      paletteNeutralHashHex: sha256Hex(buf), // same since pixels are palette-indexed
      phashHex: ph,
      isBlank: pixels.every((p) => p === 0),
      isHorizontallySymmetric: isHSymmetric(pixels),
      isVerticallySymmetric: isVSymmetric(pixels),
    };
  });

  // ---- Metatiles ----
  const metatilesPath = join(tsDir, 'metatiles.bin');
  const attrsPath = join(tsDir, 'metatile_attributes.bin');
  if (!existsSync(metatilesPath) || !existsSync(attrsPath)) {
    return { error: 'metatiles.bin or metatile_attributes.bin missing', slug: header.slug };
  }
  const metatilesBuf = readFileSync(metatilesPath);
  const attrsBuf = readFileSync(attrsPath);
  const metatileCount = metatilesBuf.length / 16;
  if (!Number.isInteger(metatileCount)) {
    return {
      error: `metatiles.bin not multiple of 16 (${metatilesBuf.length}b)`,
      slug: header.slug,
    };
  }
  const attrBytes = familyConfig.attributeBytesPerMetatile;
  if (attrsBuf.length < metatileCount * attrBytes) {
    return {
      error: `metatile_attributes.bin too short (${attrsBuf.length}b for ${metatileCount} metatiles × ${attrBytes}B)`,
      slug: header.slug,
    };
  }
  const irMetatiles = [];
  for (let m = 0; m < metatileCount; m++) {
    const slots = decodeMetatileSlots(metatilesBuf, m * 16);
    const attrs = familyConfig.decodeAttribute(attrsBuf, m * attrBytes);
    const rgba = composeMetatileRgba(slots, tiles, paletteBgr555s);
    const ph = phash16x16Rgba(rgba);
    irMetatiles.push({
      metatileIndex: m,
      attrRawHex: attrsBuf.subarray(m * attrBytes, m * attrBytes + attrBytes).toString('hex'),
      behaviorId: attrs.behaviorId,
      terrainType: attrs.terrainType,
      encounterType: attrs.encounterType,
      layerType: attrs.layerType,
      composition: slots,
      renderedHashHex: sha256Hex(Buffer.from(rgba)),
      phashHex: ph,
    });
  }

  // ---- Content hash for the whole tileset ----
  const slug = `${familyConfig.slugPrefix}-${header.isSecondary ? 'secondary' : 'primary'}-${header.slug}`;
  return {
    slug,
    displayName:
      header.slug
        .split('_')
        .map((s) => s[0].toUpperCase() + s.slice(1))
        .join(' ') + (header.isSecondary ? ' (secondary)' : ' (primary)'),
    source,
    sourceCommit,
    attribution:
      source === 'pret-emerald'
        ? 'pret/pokeemerald (MIT)'
        : 'pret/pokefirered (MIT)',
    licenseSpdx: 'MIT',
    family: familyConfig.family,
    isSecondary: header.isSecondary,
    isCompressed: header.isCompressed,
    tileCount: tiles.length,
    metatileCount: irMetatiles.length,
    palettes,
    tiles: irTiles,
    metatiles: irMetatiles,
  };
}

function isHSymmetric(pixels) {
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 4; x++) {
      if (pixels[y * 8 + x] !== pixels[y * 8 + (7 - x)]) return false;
    }
  }
  return true;
}

function isVSymmetric(pixels) {
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 8; x++) {
      if (pixels[y * 8 + x] !== pixels[(7 - y) * 8 + x]) return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Adjacency mining
// ---------------------------------------------------------------------------

/** Walk every cell of a layout's map.bin grid and tabulate
 *  4-directional + 4-diagonal co-occurrence between metatile ids.
 *  Returns the observation array ready for the IR. */
/** Phase 8C-4 - walk a width × height grid with a 3×3 sliding window,
 *  hash each window's canonical (tileset_slug, metatile_index) tuple
 *  sequence, count occurrences. Returns patterns that appear ≥ minCount
 *  times on this map. Cross-map aggregation happens in the Python ingest
 *  pass - we emit per-map raw frequencies here. */
export function mine3x3Patterns(grid, width, height, primarySlug, secondarySlug, minCount = 2) {
  if (width < 3 || height < 3) return [];

  function tilesetForMetatile(id) {
    return id < 0x200 ? primarySlug : secondarySlug;
  }
  function metatileLocalIndex(id) {
    return id < 0x200 ? id : id - 0x200;
  }

  const counts = new Map(); // key → { cells: [{tilesetSlug, metatileIndex}, ...9], count }
  for (let y = 0; y < height - 2; y++) {
    for (let x = 0; x < width - 2; x++) {
      const cells = [];
      const keyParts = [];
      for (let dy = 0; dy < 3; dy++) {
        for (let dx = 0; dx < 3; dx++) {
          const id = grid[(y + dy) * width + (x + dx)];
          const ts = tilesetForMetatile(id);
          const idx = metatileLocalIndex(id);
          cells.push({ tilesetSlug: ts, metatileIndex: idx });
          keyParts.push(`${ts}#${idx}`);
        }
      }
      const key = keyParts.join('|');
      const existing = counts.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        counts.set(key, { cells, count: 1 });
      }
    }
  }
  const out = [];
  for (const { cells, count } of counts.values()) {
    if (count >= minCount) {
      out.push({ shape: '3x3', width: 3, height: 3, cells, frequency: count });
    }
  }
  return out;
}

export function mineLayoutAdjacency(mapBytes, width, height, primarySlug, secondarySlug) {
  // map.bin u16: low 10 bits = metatile id, high 6 = collision/elevation.
  const grid = new Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const word = mapBytes.readUInt16LE(i * 2);
    grid[i] = word & 0x3ff;
  }
  // Aggregate (a, b, dir) → count
  const counts = new Map();
  const directions = [
    { dx: 0, dy: -1, code: 0 }, // N
    { dx: 1, dy: -1, code: 1 }, // NE
    { dx: 1, dy: 0, code: 2 }, // E
    { dx: 1, dy: 1, code: 3 }, // SE
    { dx: 0, dy: 1, code: 4 }, // S
    { dx: -1, dy: 1, code: 5 }, // SW
    { dx: -1, dy: 0, code: 6 }, // W
    { dx: -1, dy: -1, code: 7 }, // NW
  ];
  function tilesetForMetatile(id) {
    // FRLG: primary owns 0..511, secondary owns 512..1023.
    return id < 0x200 ? primarySlug : secondarySlug;
  }
  function metatileLocalIndex(id) {
    return id < 0x200 ? id : id - 0x200;
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const a = grid[y * width + x];
      for (const d of directions) {
        const nx = x + d.dx;
        const ny = y + d.dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const b = grid[ny * width + nx];
        const tsA = tilesetForMetatile(a);
        const tsB = tilesetForMetatile(b);
        const key = `${tsA}#${metatileLocalIndex(a)}|${tsB}#${metatileLocalIndex(b)}|${d.code}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
  }
  const observations = [];
  for (const [key, frequency] of counts) {
    const [aPart, bPart, dir] = key.split('|');
    const [tsA, idxA] = aPart.split('#');
    const [tsB, idxB] = bPart.split('#');
    observations.push({
      tilesetSlugA: tsA,
      metatileIndexA: Number(idxA),
      tilesetSlugB: tsB,
      metatileIndexB: Number(idxB),
      direction: Number(dir),
      frequency,
    });
  }
  return observations;
}

// ---------------------------------------------------------------------------
// Top-level corpus mining
// ---------------------------------------------------------------------------

export async function mineFrlgCorpus(pretRoot, opts = {}) {
  return minePretCorpus(pretRoot, { ...opts, source: opts.source ?? 'pret-firered', family: 'frlg' });
}

/** Phase 8B-3 - pret/pokeemerald variant. Same on-disk layout but
 *  2-byte attribute words + RSE family tag. */
export async function mineEmeraldCorpus(pretRoot, opts = {}) {
  return minePretCorpus(pretRoot, { ...opts, source: opts.source ?? 'pret-emerald', family: 'rse' });
}

async function minePretCorpus(pretRoot, { source, family, sourceCommit = null, maxMaps = null }) {
  const familyConfig = FAMILY_CONFIGS[family];
  if (!familyConfig) throw new Error(`unknown family: ${family}`);
  const engine = await loadEngine();

  // 1. Read tileset headers to learn which tilesets exist + classification
  const headers = readTilesetHeaders(pretRoot);

  // 2. Resolve source commit if not provided
  if (!sourceCommit) {
    sourceCommit = gitHeadSha(pretRoot);
  }

  // 3. Read every tileset
  const tilesets = [];
  for (const h of headers.values()) {
    const ts = await readPretTileset(pretRoot, h, source, sourceCommit, engine, familyConfig);
    if (ts.error) {
      process.stderr.write(`[${h.slug}] skip: ${ts.error}\n`);
      continue;
    }
    tilesets.push(ts);
  }

  // 4. Read layouts.json and mine adjacency from every layout
  const layoutsJsonPath = join(pretRoot, 'data/layouts/layouts.json');
  if (!existsSync(layoutsJsonPath)) {
    throw new Error(`layouts.json missing: ${layoutsJsonPath}`);
  }
  const layoutsJson = JSON.parse(readFileSync(layoutsJsonPath, 'utf8'));
  const mapAdjacencies = [];
  const layouts = maxMaps ? layoutsJson.layouts.slice(0, maxMaps) : layoutsJson.layouts;
  for (const layout of layouts) {
    const primarySym = layout.primary_tileset;
    const secondarySym = layout.secondary_tileset;
    if (!primarySym || !secondarySym) continue;
    const primaryHeader = headers.get(primarySym);
    const secondaryHeader = headers.get(secondarySym);
    if (!primaryHeader || !secondaryHeader) continue;
    const primarySlug = `${familyConfig.slugPrefix}-primary-${primaryHeader.slug}`;
    const secondarySlug = `${familyConfig.slugPrefix}-secondary-${secondaryHeader.slug}`;
    const blockdataPath = join(pretRoot, layout.blockdata_filepath);
    if (!existsSync(blockdataPath)) continue;
    const mapBytes = readFileSync(blockdataPath);
    if (mapBytes.length < layout.width * layout.height * 2) continue;
    const observations = mineLayoutAdjacency(
      mapBytes,
      layout.width,
      layout.height,
      primarySlug,
      secondarySlug,
    );
    // Phase 8C-4 - extract grid + mine 3×3 patterns. Lift the grid
    // once here rather than duplicating the parse inside mine3x3Patterns.
    const grid = new Array(layout.width * layout.height);
    for (let i = 0; i < grid.length; i++) {
      grid[i] = mapBytes.readUInt16LE(i * 2) & 0x3ff;
    }
    const patterns = mine3x3Patterns(
      grid,
      layout.width,
      layout.height,
      primarySlug,
      secondarySlug,
      /* minCount */ 2,
    );
    mapAdjacencies.push({
      mapSlug:
        `${familyConfig.slugPrefix}-${layout.name.replace(/_Layout$/, '')}`
          .toLowerCase()
          .replace(/[^a-z0-9_-]/g, '-'),
      primaryTilesetSlug: primarySlug,
      secondaryTilesetSlug: secondarySlug,
      width: layout.width,
      height: layout.height,
      observations,
      patterns,
    });
  }

  return {
    schemaVersion: 1,
    generatedAtUtc: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    source,
    toolingVersion: '8B-3',
    tilesets,
    mapAdjacencies,
  };
}

function gitHeadSha(dir) {
  try {
    const result = spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (result.status === 0 && result.stdout) return result.stdout.trim();
  } catch {
    /* ignore */
  }
  return null;
}
