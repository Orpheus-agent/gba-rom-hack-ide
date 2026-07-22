import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { LayoutCellDecoded, LayoutData } from '@rom-editor/shared';

/** Pokemerald metatile cell encoding (16-bit little-endian):
 *    bits 0..9   metatile id        (0..1023)
 *    bits 10..11 collision attribute (0..3)
 *    bits 12..15 elevation          (0..15)
 *  Decoded into LayoutCellDecoded.
 */
export function decodeCell(raw: number): LayoutCellDecoded {
  return {
    metatileId: raw & 0x03ff,
    collision: (raw >> 10) & 0x03,
    elevation: (raw >> 12) & 0x0f,
  };
}

export function decodeMapBin(buffer: Buffer, width: number, height: number): LayoutCellDecoded[] {
  const cells: LayoutCellDecoded[] = [];
  const expected = width * height * 2;
  const len = Math.min(buffer.length, expected);
  for (let i = 0; i + 1 < len; i += 2) {
    // little-endian uint16
    const raw = buffer[i]! | (buffer[i + 1]! << 8);
    cells.push(decodeCell(raw));
  }
  // Pad with zero cells if the file is shorter than expected (defensive).
  while (cells.length < width * height) {
    cells.push({ metatileId: 0, collision: 0, elevation: 0 });
  }
  return cells.slice(0, width * height);
}

interface RawLayoutJson {
  id?: unknown;
  name?: unknown;
  width?: unknown;
  height?: unknown;
  border_width?: unknown;
  border_height?: unknown;
  primary_tileset?: unknown;
  secondary_tileset?: unknown;
  blockdata_filepath?: unknown;
}

export class LayoutParseError extends Error {
  constructor(message: string, public readonly code: 'layout_parse_failed') {
    super(message);
    this.name = 'LayoutParseError';
  }
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function asInt(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string') {
    const n = Number.parseInt(v, 10);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/** The standard pret structure stores all layouts in one central manifest,
 *  `data/layouts/layouts.json`, with a `layouts` array - not per-directory
 *  `layout.json` files. Read it (returns null if absent/invalid). */
async function readLayoutsManifest(projectRoot: string): Promise<RawLayoutJson[] | null> {
  const p = path.join(projectRoot, 'data', 'layouts', 'layouts.json');
  try {
    const json = JSON.parse(await fsp.readFile(p, 'utf8')) as { layouts?: unknown };
    return Array.isArray(json.layouts) ? (json.layouts as RawLayoutJson[]) : null;
  } catch {
    return null;
  }
}

/** "data/layouts/Route3/map.bin" → "Route3". */
function dirFromBlockdataPath(p: string | null): string | null {
  if (!p) return null;
  const m = /data[\\/]+layouts[\\/]+([^\\/]+)[\\/]/.exec(p);
  return m?.[1] ?? null;
}

/**
 * Parses a layout into a typed `LayoutData`. Prefers a per-directory
 * `data/layouts/<dir>/layout.json` (Porymap-style projects); falls back to the
 * matching entry in the central `data/layouts/layouts.json` (standard pret
 * structure - pokefirered/pokeemerald). The blockdata (`map.bin`) decodes the
 * same way regardless.
 */
export async function parseLayoutDir(
  projectRoot: string,
  layoutDir: string,
): Promise<LayoutData> {
  let source = path.join('data', 'layouts', layoutDir, 'layout.json').replace(/\\/g, '/');
  let o: RawLayoutJson | null = null;
  try {
    o = JSON.parse(await fsp.readFile(path.join(projectRoot, source), 'utf8')) as RawLayoutJson;
  } catch {
    const manifest = await readLayoutsManifest(projectRoot);
    const entry = manifest?.find(
      (e) => dirFromBlockdataPath(asString(e?.blockdata_filepath)) === layoutDir,
    );
    if (entry) {
      o = entry;
      source = 'data/layouts/layouts.json';
    }
  }
  if (o === null) {
    throw new LayoutParseError(
      `No layout.json in data/layouts/${layoutDir} and no matching entry in data/layouts/layouts.json`,
      'layout_parse_failed',
    );
  }
  const width = asInt(o.width);
  const height = asInt(o.height);
  if (width === null || height === null || width <= 0 || height <= 0) {
    throw new LayoutParseError(
      `${source}: width/height missing or invalid`,
      'layout_parse_failed',
    );
  }
  const id = asString(o.id) ?? `LAYOUT_${layoutDir.toUpperCase()}`;
  const name = asString(o.name) ?? id;
  const borderWidth = asInt(o.border_width) ?? 0;
  const borderHeight = asInt(o.border_height) ?? 0;
  const primaryTileset = asString(o.primary_tileset);
  const secondaryTileset = asString(o.secondary_tileset);

  const blockdataRel = asString(o.blockdata_filepath);
  let cells: LayoutCellDecoded[] = [];
  if (blockdataRel) {
    const blockdataAbs = path.isAbsolute(blockdataRel)
      ? blockdataRel
      : path.join(projectRoot, blockdataRel);
    try {
      const buf = await fsp.readFile(blockdataAbs);
      cells = decodeMapBin(buf, width, height);
    } catch (e) {
      throw new LayoutParseError(
        `Could not read blockdata ${blockdataRel}: ${e instanceof Error ? e.message : String(e)}`,
        'layout_parse_failed',
      );
    }
  } else {
    // No blockdata: emit zero cells so width/height still drive the canvas.
    for (let i = 0; i < width * height; i++) {
      cells.push({ metatileId: 0, collision: 0, elevation: 0 });
    }
  }

  return {
    id,
    name,
    width,
    height,
    borderWidth,
    borderHeight,
    primaryTileset,
    secondaryTileset,
    cells,
    sourceLayoutJsonPath: source,
  };
}

/**
 * Resolves a layout id (e.g. "LAYOUT_LITTLEROOT_TOWN") to its source directory
 * under `data/layouts/`. Walks every layout.json to build an id→dir map; the
 * pokeemerald convention of `data/layouts/<PascalName>/` doesn't reliably
 * derive from the id, so we read each layout.json explicitly.
 */
export async function findLayoutDirById(
  projectRoot: string,
  layoutId: string,
): Promise<string | null> {
  // Standard pret structure: a central data/layouts/layouts.json whose entries
  // carry the id + the blockdata path (from which the dir name derives).
  const manifest = await readLayoutsManifest(projectRoot);
  if (manifest) {
    const entry = manifest.find((e) => asString(e?.id) === layoutId);
    if (entry) {
      const dir = dirFromBlockdataPath(asString(entry.blockdata_filepath));
      if (dir) return dir;
    }
  }

  // Fallback: Porymap-style per-directory layout.json files.
  const layoutsRoot = path.join(projectRoot, 'data', 'layouts');
  let dirents;
  try {
    dirents = await fsp.readdir(layoutsRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const d of dirents) {
    if (!d.isDirectory()) continue;
    const layoutJsonPath = path.join(layoutsRoot, d.name, 'layout.json');
    try {
      const raw = await fsp.readFile(layoutJsonPath, 'utf8');
      const parsed = JSON.parse(raw) as { id?: unknown };
      if (typeof parsed.id === 'string' && parsed.id === layoutId) {
        return d.name;
      }
    } catch {
      // Skip dirs without a parseable layout.json.
    }
  }
  return null;
}
