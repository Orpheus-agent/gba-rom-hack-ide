/**
 * Decomp metatile compositor - turns a map's metatile ids into real RGBA
 * pixels so the editor can render the actual game world (not grey placeholders).
 *
 * Works entirely from decomp source files (no PNG decode, no ROM):
 *   - tiles.4bpp        raw 8×8 4bpp tile graphics (32 bytes/tile)
 *   - metatiles.bin     8 × uint16 per metatile (4 bottom + 4 top subtiles);
 *                       each entry = tileId(0..9) | flipX(10) | flipY(11) | pal(12..15)
 *   - palettes/NN.pal   JASC-PAL text, 16 RGB colors each
 *
 * A map references a primary + secondary tileset. The split constants (FireRed):
 *   metatile/tile id < 640 → primary, else secondary (minus 640)
 *   palette index   < 7   → primary, else secondary
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { LayoutData } from '@rom-editor/shared';
import { graphics } from '@rom-introspection/engine';

const TILE_BYTES = 32; // 8×8 pixels @ 4bpp
const NUM_TILES_IN_PRIMARY = 640;
export const NUM_METATILES_IN_PRIMARY = 640;
const NUM_PALS_IN_PRIMARY = 7;
const METATILE_STRIDE = 16; // 8 subtiles × 2 bytes

export interface RgbColor {
  r: number;
  g: number;
  b: number;
}

export interface TilesetData {
  tiles: Buffer;
  metatiles: Buffer;
  /** 16 palettes, each up to 16 colors. Empty slots = []. */
  palettes: RgbColor[][];
}

async function readMaybe(p: string): Promise<Buffer | null> {
  try {
    return await fsp.readFile(p);
  } catch {
    return null;
  }
}

/** Parse a JASC-PAL file (header lines + "R G B" rows) into RGB colors. */
export function parseJascPal(text: string): RgbColor[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  // [0]=JASC-PAL, [1]=0100, [2]=count, [3..]=colors
  const out: RgbColor[] = [];
  for (let i = 3; i < lines.length; i++) {
    const m = /^(\d+)\s+(\d+)\s+(\d+)$/.exec(lines[i]!);
    if (m) out.push({ r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) });
  }
  return out;
}

/**
 * Recover a tiles.4bpp-equivalent buffer (32 bytes/tile of palette indices)
 * from an indexed tiles.png. Many tilesets ship tiles.png but NOT tiles.4bpp
 * (the .4bpp is a build artifact). Tiles are 8×8 blocks in a 16-wide grid; we
 * reverse-map each pixel's RGBA back to its palette index via the PNG's PLTE.
 */
function pngToIndexed4bpp(png: Uint8Array): Buffer | null {
  let decoded: ReturnType<typeof graphics.decodePng>;
  try {
    decoded = graphics.decodePng(png);
  } catch {
    return null;
  }
  const { width, height, pixels, palette } = decoded;
  if (!palette) return null; // need an indexed source to recover slot indices
  const rev = new Map<number, number>();
  palette.forEach((c, i) => {
    const key = ((c[0] << 24) | (c[1] << 16) | (c[2] << 8) | c[3]) >>> 0;
    if (!rev.has(key)) rev.set(key, i);
  });
  const tilesPerRow = Math.floor(width / 8);
  const tileRows = Math.floor(height / 8);
  const out = Buffer.alloc(tilesPerRow * tileRows * TILE_BYTES);
  for (let t = 0; t < tilesPerRow * tileRows; t++) {
    const bx = (t % tilesPerRow) * 8;
    const by = Math.floor(t / tilesPerRow) * 8;
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const o = ((by + y) * width + (bx + x)) * 4;
        const key =
          ((pixels[o]! << 24) | (pixels[o + 1]! << 16) | (pixels[o + 2]! << 8) | pixels[o + 3]!) >>> 0;
        const idx = rev.get(key) ?? 0;
        const off = t * TILE_BYTES + y * 4 + (x >> 1);
        const nib = (x & 1) === 1 ? (idx & 0x0f) << 4 : idx & 0x0f;
        out[off] = (out[off]! | nib) & 0xff;
      }
    }
  }
  return out;
}

/**
 * Load tiles + palettes + metatiles, each from a possibly-different directory.
 * Tilesets can share another tileset's graphics (e.g. SilphCo uses
 * Condominiums' tiles/palettes but its own metatiles), so the three live apart.
 */
export async function loadTilesetComponents(
  tilesDir: string,
  palettesDir: string,
  metatilesDir: string,
): Promise<TilesetData | null> {
  const metatiles = await readMaybe(path.join(metatilesDir, 'metatiles.bin'));
  if (!metatiles) return null;
  // Prefer raw 4bpp; fall back to decoding tiles.png (always present - .4bpp is
  // only generated for some tilesets).
  let tiles = await readMaybe(path.join(tilesDir, 'tiles.4bpp'));
  if (!tiles) {
    const png = await readMaybe(path.join(tilesDir, 'tiles.png'));
    if (png) tiles = pngToIndexed4bpp(png);
  }
  if (!tiles) return null;
  const palettes: RgbColor[][] = [];
  for (let i = 0; i < 16; i++) {
    const buf = await readMaybe(path.join(palettesDir, 'palettes', `${String(i).padStart(2, '0')}.pal`));
    palettes.push(buf ? parseJascPal(buf.toString('utf8')) : []);
  }
  return { tiles, metatiles, palettes };
}

/** Single-dir convenience (tiles + palettes + metatiles all in one folder). */
export async function loadTileset(absDir: string): Promise<TilesetData | null> {
  return loadTilesetComponents(absDir, absDir, absDir);
}

/** Read pixel (x,y) of a 4bpp tile → palette index 0..15. */
function tilePixel(tiles: Buffer, tileId: number, x: number, y: number): number {
  const off = tileId * TILE_BYTES + y * 4 + (x >> 1);
  if (off < 0 || off >= tiles.length) return 0;
  const byte = tiles[off]!;
  return (x & 1) === 1 ? (byte >> 4) & 0x0f : byte & 0x0f;
}

/**
 * Compose one metatile id into a 16×16 RGBA buffer (1024 bytes). Draws the
 * bottom layer opaque, then the top layer with palette index 0 transparent.
 */
export function composeMetatile(
  metatileId: number,
  primary: TilesetData,
  secondary: TilesetData | null,
): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(16 * 16 * 4);
  const inPrimary = metatileId < NUM_METATILES_IN_PRIMARY;
  const mtSet = inPrimary ? primary : secondary;
  if (!mtSet) return rgba;
  const localMt = inPrimary ? metatileId : metatileId - NUM_METATILES_IN_PRIMARY;
  const base = localMt * METATILE_STRIDE;
  if (base + METATILE_STRIDE > mtSet.metatiles.length) return rgba;

  for (let layer = 0; layer < 2; layer++) {
    for (let sub = 0; sub < 4; sub++) {
      const off = base + (layer * 4 + sub) * 2;
      const entry = mtSet.metatiles[off]! | (mtSet.metatiles[off + 1]! << 8);
      const tileId = entry & 0x03ff;
      const flipX = (entry >> 10) & 1;
      const flipY = (entry >> 11) & 1;
      const palNum = (entry >> 12) & 0x0f;

      const tileInPrimary = tileId < NUM_TILES_IN_PRIMARY;
      const tSet = tileInPrimary ? primary : secondary;
      if (!tSet) continue;
      const localTile = tileInPrimary ? tileId : tileId - NUM_TILES_IN_PRIMARY;

      const palSet = palNum < NUM_PALS_IN_PRIMARY ? primary : secondary;
      const pal = palSet?.palettes[palNum] ?? [];

      const ox = (sub % 2) * 8;
      const oy = ((sub / 2) | 0) * 8;
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
          const sx = flipX ? 7 - x : x;
          const sy = flipY ? 7 - y : y;
          const idx = tilePixel(tSet.tiles, localTile, sx, sy);
          if (layer === 1 && idx === 0) continue; // top layer: 0 = transparent
          const c = pal[idx] ?? { r: 0, g: 0, b: 0 };
          const d = ((oy + y) * 16 + (ox + x)) * 4;
          rgba[d] = c.r;
          rgba[d + 1] = c.g;
          rgba[d + 2] = c.b;
          rgba[d + 3] = 255;
        }
      }
    }
  }
  return rgba;
}

/** "gTileset_PewterCity" → "pewter_city". Fallback heuristic only - the
 *  canonical mapping comes from readTilesetDirMap (handles digits/quirks). */
export function tilesetNameToDir(name: string): string {
  return name
    .replace(/^gTileset_/, '')
    .replace(/([a-z])([A-Z0-9])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([0-9])([A-Za-z])/g, '$1_$2')
    .toLowerCase();
}

interface TilesetComponents {
  readonly tiles: string;
  readonly palettes: string;
  readonly metatiles: string;
}

/** Where each tileset's components live + a symbol→dir map. */
export interface TilesetSources {
  readonly components: Map<string, TilesetComponents>;
  readonly symbolDir: Map<string, string>;
}

/**
 * Parse src/data/tilesets/ to learn (a) which symbols supply each tileset's
 * tiles/palettes/metatiles (headers.h) and (b) where each symbol's data lives
 * (graphics.h tiles INCBIN + metatiles.h metatiles INCBIN). This captures
 * graphics sharing - e.g. gTileset_SilphCo borrows gTilesetTiles_Condominiums.
 */
export async function readTilesetSources(projectRoot: string): Promise<TilesetSources> {
  const base = path.join(projectRoot, 'src', 'data', 'tilesets');
  const components = new Map<string, TilesetComponents>();
  const symbolDir = new Map<string, string>();

  const headers = await readMaybe(path.join(base, 'headers.h'));
  if (headers) {
    const text = headers.toString('utf8');
    const re = /gTileset_(\w+)\s*=\s*\{([\s\S]*?)\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const body = m[2]!;
      const tiles = /\.tiles\s*=\s*gTilesetTiles_(\w+)/.exec(body)?.[1];
      const palettes = /\.palettes\s*=\s*gTilesetPalettes_(\w+)/.exec(body)?.[1];
      const metatiles = /\.metatiles\s*=\s*gMetatiles_(\w+)/.exec(body)?.[1];
      if (tiles && palettes && metatiles) components.set(m[1]!, { tiles, palettes, metatiles });
    }
  }
  const addDirs = (text: string, re: RegExp): void => {
    const g = new RegExp(re.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = g.exec(text)) !== null) {
      if (!symbolDir.has(m[1]!)) symbolDir.set(m[1]!, path.join(projectRoot, m[2]!));
    }
  };
  const gfx = await readMaybe(path.join(base, 'graphics.h'));
  if (gfx) {
    addDirs(gfx.toString('utf8'), /gTilesetTiles_(\w+)\[\]\s*=\s*INCBIN_\w+\("(data\/tilesets\/[^"]+)\/tiles\.[^"]+"\)/);
  }
  const meta = await readMaybe(path.join(base, 'metatiles.h'));
  if (meta) {
    addDirs(meta.toString('utf8'), /gMetatiles_(\w+)\[\]\s*=\s*INCBIN_U16\("(data\/tilesets\/[^"]+)\/metatiles\.bin"\)/);
  }
  return { components, symbolDir };
}

/** Load a tileset by its C name, resolving shared graphics via the source maps. */
export async function loadTilesetByName(
  projectRoot: string,
  name: string | null,
  preferred: 'primary' | 'secondary',
  sources: TilesetSources,
): Promise<TilesetData | null> {
  if (!name) return null;
  const suffix = name.replace(/^gTileset_/, '');
  const comp = sources.components.get(suffix);
  if (comp) {
    const tilesDir = sources.symbolDir.get(comp.tiles);
    const palettesDir = sources.symbolDir.get(comp.palettes) ?? tilesDir;
    const metatilesDir = sources.symbolDir.get(comp.metatiles);
    if (tilesDir && palettesDir && metatilesDir) {
      const t = await loadTilesetComponents(tilesDir, palettesDir, metatilesDir);
      if (t) return t;
    }
  }
  // Fallbacks: same-dir via the metatiles symbol, then the snake_case guess.
  const sameDir = sources.symbolDir.get(suffix);
  if (sameDir) {
    const t = await loadTileset(sameDir);
    if (t) return t;
  }
  const snake = tilesetNameToDir(name);
  const order: Array<'primary' | 'secondary'> =
    preferred === 'primary' ? ['primary', 'secondary'] : ['secondary', 'primary'];
  for (const folder of order) {
    const t = await loadTileset(path.join(projectRoot, 'data', 'tilesets', folder, snake));
    if (t) return t;
  }
  return null;
}

/**
 * Compose every metatile id used by a layout into RGBA pixel buffers (16×16,
 * 1024 bytes each, R,G,B,A order). Returns metatileId → Buffer. Empty if the
 * primary tileset can't be located.
 */
export async function renderLayoutMetatiles(
  projectRoot: string,
  layout: LayoutData,
): Promise<Map<number, Buffer>> {
  const sources = await readTilesetSources(projectRoot);
  const primary = await loadTilesetByName(projectRoot, layout.primaryTileset, 'primary', sources);
  const secondary = await loadTilesetByName(projectRoot, layout.secondaryTileset, 'secondary', sources);
  const out = new Map<number, Buffer>();
  if (!primary) return out;
  const used = new Set<number>();
  for (const c of layout.cells) used.add(c.metatileId);
  for (const id of used) {
    const rgba = composeMetatile(id, primary, secondary);
    out.set(id, Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength));
  }
  return out;
}
