/**
 * Write a decomp-native tileset from a section of RGBA pixels (e.g. a crop of
 * ETS v2.5.png). MVP approach, chosen to minimize toolchain dependencies:
 *   - quantize the section to a single ≤16-colour palette (median-cut),
 *   - cut 8×8 tiles (deduped) → raw `tiles.4bpp` (isCompressed = FALSE, so we
 *     INCBIN the .4bpp directly - no gbagfx PNG step, no smol compressor, no
 *     tileset_rules.mk entry),
 *   - one metatile per 16×16 block, flat layer-0 (collision/elevation live in
 *     the layout cell, so flat metatiles are fully walkable),
 *   - emit metatiles.bin + metatile_attributes.bin + 16 palette files,
 *   - append the three C references (headers.h / graphics.h / metatiles.h).
 *
 * Primary by default (tileId = local index, palette slot 0) - simplest. Pass
 * isSecondary to place tiles at 640+local / palette slot 7.
 *
 * Caller supplies the section pixels (decode + crop the PNG upstream so this
 * module stays free of image-format concerns).
 */
import path from 'node:path';
import { writeFileAtomic, fileExists } from './decomp-write-util.js';
import { promises as fsp } from 'node:fs';

const TILES_PRIMARY_MAX = 640;
const TILES_SECONDARY_MAX = 1024 - 640;
const METATILES_PRIMARY_MAX = 640;
const METATILES_SECONDARY_MAX = 1024 - 640;

export interface WriteTilesetSpec {
  /** PascalCase name → gTileset_<name>, e.g. "BwNuvema". */
  readonly name: string;
  /** snake_case dir under data/tilesets/<primary|secondary>/, e.g. "bw_nuvema". */
  readonly dir: string;
  readonly isSecondary?: boolean;
  /** Section pixels, RGBA row-major. width/height must be multiples of 16. */
  readonly pixels: Uint8Array;
  readonly width: number;
  readonly height: number;
  /** Optional per-metatile behavior override: local metatileId → MB_* name
   *  (e.g. 'MB_TALL_GRASS', 'MB_REGULAR_WARP'). Resolved against the project's
   *  include/constants/metatile_behaviors.h enum and packed into the
   *  metatile-attributes behavior field (bits 0-8). Default behavior is
   *  MB_NORMAL (0). Layer type stays NORMAL. */
  readonly behaviors?: ReadonlyMap<number, string>;
}

/** Parse the positional `enum { MB_NORMAL, ... }` in metatile_behaviors.h →
 *  name→value (handles `= N` overrides + // and /* *​/ comments). */
async function resolveBehaviorValues(projectRoot: string): Promise<Map<string, number>> {
  const text = await fsp.readFile(
    path.join(projectRoot, 'include', 'constants', 'metatile_behaviors.h'),
    'utf8',
  );
  const body = /enum\s*\w*\s*\{([\s\S]*?)\}/.exec(text)?.[1] ?? '';
  const cleaned = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const out = new Map<string, number>();
  let counter = 0;
  for (const rawTok of cleaned.split(',')) {
    const tok = rawTok.trim();
    if (!tok) continue;
    const m = /^(MB_\w+)\s*(?:=\s*(0x[0-9a-fA-F]+|\d+))?/.exec(tok);
    if (!m) continue;
    if (m[2] !== undefined) counter = m[2].startsWith('0x') ? parseInt(m[2], 16) : parseInt(m[2], 10);
    out.set(m[1]!, counter);
    counter += 1;
  }
  return out;
}

export interface WriteTilesetResult {
  readonly name: string;
  readonly tileCount: number;
  readonly metatileCount: number;
  readonly paletteColors: number;
  readonly dirRel: string;
}

interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** Round to GBA 5-bit-per-channel space (the palette's real precision). */
function quant5(v: number): number {
  const c = v >> 3;
  return (c << 3) | (c >> 2);
}

/** Median-cut quantization of the section's opaque pixels to ≤16 colours. */
function buildPalette(pixels: Uint8Array): Rgb[] {
  const counts = new Map<number, number>();
  for (let i = 0; i < pixels.length; i += 4) {
    if ((pixels[i + 3] ?? 255) < 128) continue; // skip transparent
    const r = quant5(pixels[i] ?? 0);
    const g = quant5(pixels[i + 1] ?? 0);
    const b = quant5(pixels[i + 2] ?? 0);
    const key = (r << 16) | (g << 8) | b;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const colors = [...counts.keys()].map((k) => ({ r: (k >> 16) & 0xff, g: (k >> 8) & 0xff, b: k & 0xff }));
  if (colors.length === 0) return [{ r: 0, g: 0, b: 0 }];
  if (colors.length <= 16) return colors;

  // Median cut: split the box with the largest channel range until 16 boxes.
  let boxes: Rgb[][] = [colors];
  while (boxes.length < 16) {
    let bestIdx = -1;
    let bestRange = -1;
    let bestAxis: 'r' | 'g' | 'b' = 'r';
    boxes.forEach((box, idx) => {
      if (box.length < 2) return;
      for (const axis of ['r', 'g', 'b'] as const) {
        let lo = 255;
        let hi = 0;
        for (const c of box) {
          lo = Math.min(lo, c[axis]);
          hi = Math.max(hi, c[axis]);
        }
        if (hi - lo > bestRange) {
          bestRange = hi - lo;
          bestIdx = idx;
          bestAxis = axis;
        }
      }
    });
    if (bestIdx < 0) break;
    const box = boxes[bestIdx]!;
    box.sort((a, b) => a[bestAxis] - b[bestAxis]);
    const mid = box.length >> 1;
    boxes = boxes.flatMap((b, i) => (i === bestIdx ? [box.slice(0, mid), box.slice(mid)] : [b]));
  }
  return boxes.map((box) => {
    let r = 0;
    let g = 0;
    let b = 0;
    for (const c of box) {
      r += c.r;
      g += c.g;
      b += c.b;
    }
    const n = box.length || 1;
    return { r: quant5(Math.round(r / n)), g: quant5(Math.round(g / n)), b: quant5(Math.round(b / n)) };
  });
}

function nearestIndex(pal: Rgb[], r: number, g: number, b: number): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < pal.length; i++) {
    const p = pal[i]!;
    const d = (p.r - r) ** 2 + (p.g - g) ** 2 + (p.b - b) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** Encode a 16-colour palette as a 32-byte .gbapal (BGR555, little-endian). */
function encodeGbapal(pal: Rgb[]): Buffer {
  const buf = Buffer.alloc(32);
  for (let i = 0; i < 16; i++) {
    const c = pal[i] ?? { r: 0, g: 0, b: 0 };
    const u16 = (((c.b >> 3) & 31) << 10) | (((c.g >> 3) & 31) << 5) | ((c.r >> 3) & 31);
    buf.writeUInt16LE(u16 & 0xffff, i * 2);
  }
  return buf;
}

export async function writeDecompTileset(
  projectRoot: string,
  spec: WriteTilesetSpec,
): Promise<WriteTilesetResult> {
  if (spec.width % 16 !== 0 || spec.height % 16 !== 0) {
    throw new Error(`writeDecompTileset: section ${String(spec.width)}x${String(spec.height)} not a multiple of 16`);
  }
  const isSecondary = spec.isSecondary ?? false;
  const pal = buildPalette(spec.pixels);
  const tilesX = spec.width / 8;
  const tilesY = spec.height / 8;
  const W = spec.width;

  // Index every pixel, then cut + dedupe 8×8 tiles.
  const tileBytes: Buffer[] = [];
  const tileKeyToIndex = new Map<string, number>();
  const tileIndexAt: number[] = new Array<number>(tilesX * tilesY).fill(0);

  for (let ty = 0; ty < tilesY; ty++) {
    for (let tx = 0; tx < tilesX; tx++) {
      const tile = Buffer.alloc(32);
      for (let py = 0; py < 8; py++) {
        for (let px = 0; px < 8; px++) {
          const sx = tx * 8 + px;
          const sy = ty * 8 + py;
          const o = (sy * W + sx) * 4;
          const a = spec.pixels[o + 3] ?? 255;
          const idx =
            a < 128 ? 0 : nearestIndex(pal, spec.pixels[o] ?? 0, spec.pixels[o + 1] ?? 0, spec.pixels[o + 2] ?? 0);
          const byteOff = py * 4 + (px >> 1);
          if ((px & 1) === 0) tile[byteOff] = (tile[byteOff]! & 0xf0) | (idx & 0x0f);
          else tile[byteOff] = (tile[byteOff]! & 0x0f) | ((idx & 0x0f) << 4);
        }
      }
      const key = tile.toString('latin1');
      let ti = tileKeyToIndex.get(key);
      if (ti === undefined) {
        ti = tileBytes.length;
        tileBytes.push(tile);
        tileKeyToIndex.set(key, ti);
      }
      tileIndexAt[ty * tilesX + tx] = ti;
    }
  }

  const tileMax = isSecondary ? TILES_SECONDARY_MAX : TILES_PRIMARY_MAX;
  if (tileBytes.length > tileMax) {
    throw new Error(`writeDecompTileset: ${String(tileBytes.length)} unique tiles > ${String(tileMax)} (pick a smaller section)`);
  }

  // Metatiles: one per 16×16 block, flat layer-0.
  const mtX = spec.width / 16;
  const mtY = spec.height / 16;
  const metatileCount = mtX * mtY;
  const mtMax = isSecondary ? METATILES_SECONDARY_MAX : METATILES_PRIMARY_MAX;
  if (metatileCount > mtMax) {
    throw new Error(`writeDecompTileset: ${String(metatileCount)} metatiles > ${String(mtMax)} (pick a smaller section)`);
  }
  const tileBase = isSecondary ? 640 : 0;
  const palNum = isSecondary ? 7 : 0;
  const metatiles = Buffer.alloc(metatileCount * 16);
  const attrs = Buffer.alloc(metatileCount * 4); // all 0 = MB_NORMAL, NORMAL layer
  if (spec.behaviors && spec.behaviors.size > 0) {
    const mb = await resolveBehaviorValues(projectRoot);
    for (const [mtId, behaviorName] of spec.behaviors) {
      const v = mb.get(behaviorName);
      if (v === undefined) throw new Error(`writeDecompTileset: unknown behavior '${behaviorName}'`);
      if (mtId >= 0 && mtId < metatileCount) attrs.writeUInt32LE(v & 0x1ff, mtId * 4); // behavior bits 0-8
    }
  }
  const tileAt = (tx: number, ty: number): number => tileIndexAt[ty * tilesX + tx] ?? 0;
  for (let my = 0; my < mtY; my++) {
    for (let mx = 0; mx < mtX; mx++) {
      const mi = my * mtX + mx;
      const subs = [
        tileAt(mx * 2, my * 2),
        tileAt(mx * 2 + 1, my * 2),
        tileAt(mx * 2, my * 2 + 1),
        tileAt(mx * 2 + 1, my * 2 + 1),
      ];
      for (let s = 0; s < 4; s++) {
        const entry = ((tileBase + subs[s]!) & 0x3ff) | (palNum << 12);
        metatiles.writeUInt16LE(entry & 0xffff, mi * 16 + s * 2);
      }
      // layer1 (bytes 8..15) left 0 → transparent
    }
  }

  // Write binaries.
  const sub = isSecondary ? 'secondary' : 'primary';
  const dirRel = `data/tilesets/${sub}/${spec.dir}`;
  await writeFileAtomic(path.join(projectRoot, dirRel, 'tiles.4bpp'), Buffer.concat(tileBytes));
  await writeFileAtomic(path.join(projectRoot, dirRel, 'metatiles.bin'), metatiles);
  await writeFileAtomic(path.join(projectRoot, dirRel, 'metatile_attributes.bin'), attrs);
  const palBuf = encodeGbapal(pal);
  const zero = Buffer.alloc(32);
  for (let i = 0; i < 16; i++) {
    await writeFileAtomic(
      path.join(projectRoot, dirRel, 'palettes', `${String(i).padStart(2, '0')}.gbapal`),
      i === palNum ? palBuf : zero,
    );
  }

  await appendTilesetCRefs(projectRoot, spec.name, dirRel, isSecondary);

  return { name: spec.name, tileCount: tileBytes.length, metatileCount, paletteColors: pal.length, dirRel };
}

/** Write the gTileset_<Name> struct + INCBIN references, REPLACING any existing
 *  refs for this tileset (so re-running with a changed dir / isSecondary / format
 *  produces consistent refs instead of leaving stale ones - e.g. after a
 *  primary→secondary move). `compressed` controls isCompressed + the .lz suffix. */
async function appendTilesetCRefs(
  projectRoot: string,
  name: string,
  dirRel: string,
  isSecondary: boolean,
  compressed = false,
): Promise<void> {
  const headersPath = path.join(projectRoot, 'src', 'data', 'tilesets', 'headers.h');
  const graphicsPath = path.join(projectRoot, 'src', 'data', 'tilesets', 'graphics.h');
  const metatilesPath = path.join(projectRoot, 'src', 'data', 'tilesets', 'metatiles.h');
  const strip = (s: string, re: RegExp): string => s.replace(re, '').replace(/\n{3,}/g, '\n\n');

  let headers = await fsp.readFile(headersPath, 'utf8');
  headers = strip(headers, new RegExp(`\\n*const struct Tileset gTileset_${name} =\\s*\\{[\\s\\S]*?\\};\\n`));
  headers +=
    `\nconst struct Tileset gTileset_${name} =\n{\n` +
    `    .isCompressed = ${compressed ? 'TRUE' : 'FALSE'},\n` +
    `    .isSecondary = ${isSecondary ? 'TRUE' : 'FALSE'},\n` +
    `    .tiles = gTilesetTiles_${name},\n` +
    `    .palettes = gTilesetPalettes_${name},\n` +
    `    .metatiles = gMetatiles_${name},\n` +
    `    .metatileAttributes = gMetatileAttributes_${name},\n` +
    `    .callback = NULL,\n};\n`;
  await fsp.writeFile(headersPath, headers, 'utf8');

  let graphics = await fsp.readFile(graphicsPath, 'utf8');
  graphics = strip(graphics, new RegExp(`\\n*const u32 gTilesetTiles_${name}\\[\\][^;]*;\\n`));
  graphics = strip(graphics, new RegExp(`\\n*const u16 gTilesetPalettes_${name}\\[\\]\\[16\\] =\\s*\\{[\\s\\S]*?\\};\\n`));
  let gblock = `\nconst u32 gTilesetTiles_${name}[] = INCBIN_U32("${dirRel}/tiles.4bpp${compressed ? '.lz' : ''}");\n`;
  gblock += `const u16 gTilesetPalettes_${name}[][16] =\n{\n`;
  for (let i = 0; i < 16; i++) gblock += `\tINCBIN_U16("${dirRel}/palettes/${String(i).padStart(2, '0')}.gbapal"),\n`;
  gblock += `};\n`;
  await fsp.writeFile(graphicsPath, graphics + gblock, 'utf8');

  let metatiles = await fsp.readFile(metatilesPath, 'utf8');
  metatiles = strip(metatiles, new RegExp(`\\n*const u16 gMetatiles_${name}\\[\\][^;]*;\\n`));
  metatiles = strip(metatiles, new RegExp(`\\n*const u32 gMetatileAttributes_${name}\\[\\][^;]*;\\n`));
  metatiles +=
    `\nconst u16 gMetatiles_${name}[] = INCBIN_U16("${dirRel}/metatiles.bin");\n` +
    `const u32 gMetatileAttributes_${name}[] = INCBIN_U32("${dirRel}/metatile_attributes.bin");\n`;
  await fsp.writeFile(metatilesPath, metatiles, 'utf8');

  void fileExists;
}
