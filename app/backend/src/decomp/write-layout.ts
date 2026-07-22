/**
 * Write a decomp-native map layout: the blockdata (`map.bin`), the border
 * (`border.bin`), and an entry in the central `data/layouts/layouts.json`.
 *
 * Blockdata cell = little-endian u16: `metatileId(bits 0-9) | collision(10-11) |
 * elevation(12-15)` - matching the decoder in app/backend/src/scan/layouts.ts.
 * No `.inc`/`.h` edits: `layouts.inc`/`layouts_table.inc`/`include/constants/
 * layouts.h` are all auto-generated from layouts.json by tools/mapjson.
 */
import path from 'node:path';
import { writeFileAtomic, readJsonFile, stringifyDecompJson } from './decomp-write-util.js';

export interface LayoutCellSpec {
  readonly metatileId: number;
  /** 0 = passable, 1 = blocked (BW movement-permission bit). Default 0. */
  readonly collision?: number;
  /** Default 3 (normal ground). */
  readonly elevation?: number;
}

export interface WriteLayoutSpec {
  /** e.g. "LAYOUT_NUVEMA_TOWN". */
  readonly id: string;
  /** e.g. "NuvemaTown_Layout". */
  readonly name: string;
  /** Directory under data/layouts/, e.g. "NuvemaTown". */
  readonly dir: string;
  readonly width: number;
  readonly height: number;
  readonly primaryTileset: string; // gTileset_*
  readonly secondaryTileset: string; // gTileset_*
  /** width*height cells, row-major. */
  readonly cells: ReadonlyArray<LayoutCellSpec>;
  readonly borderWidth?: number; // default 2
  readonly borderHeight?: number; // default 2
  /** borderWidth*borderHeight metatile ids; default all 0. */
  readonly border?: ReadonlyArray<number>;
}

interface LayoutsJson {
  layouts_table_label: string;
  layouts: Array<Record<string, unknown>>;
}

function encodeCellU16(c: LayoutCellSpec): number {
  return ((c.metatileId & 0x3ff) | ((c.collision ?? 0) << 10) | ((c.elevation ?? 3) << 12)) & 0xffff;
}

export interface WriteLayoutResult {
  readonly layoutDir: string;
  readonly addedToIndex: boolean;
  readonly cellCount: number;
}

export async function writeDecompLayout(
  projectRoot: string,
  spec: WriteLayoutSpec,
): Promise<WriteLayoutResult> {
  if (spec.cells.length !== spec.width * spec.height) {
    throw new Error(
      `writeDecompLayout: cells length ${String(spec.cells.length)} != ${String(spec.width)}*${String(spec.height)}`,
    );
  }
  const bw = spec.borderWidth ?? 2;
  const bh = spec.borderHeight ?? 2;
  const dirRel = `data/layouts/${spec.dir}`;

  // map.bin
  const map = Buffer.alloc(spec.cells.length * 2);
  spec.cells.forEach((c, i) => map.writeUInt16LE(encodeCellU16(c), i * 2));
  await writeFileAtomic(path.join(projectRoot, dirRel, 'map.bin'), map);

  // border.bin
  const border = spec.border ?? new Array<number>(bw * bh).fill(0);
  const bbuf = Buffer.alloc(border.length * 2);
  border.forEach((b, i) => bbuf.writeUInt16LE(b & 0xffff, i * 2));
  await writeFileAtomic(path.join(projectRoot, dirRel, 'border.bin'), bbuf);

  // layouts.json
  const ljPath = path.join(projectRoot, 'data', 'layouts', 'layouts.json');
  const lj = await readJsonFile<LayoutsJson>(ljPath);
  const blockdata = `${dirRel}/map.bin`;
  // Idempotent: drop any prior entry for THIS id or THIS dir (re-authoring a
  // layout - or changing its id - replaces cleanly instead of duplicating).
  const beforeLen = lj.layouts.length;
  lj.layouts = lj.layouts.filter((l) => l['id'] !== spec.id && l['blockdata_filepath'] !== blockdata);
  const replaced = lj.layouts.length !== beforeLen;
  lj.layouts.push({
    id: spec.id,
    name: spec.name,
    width: spec.width,
    height: spec.height,
    border_width: bw,
    border_height: bh,
    primary_tileset: spec.primaryTileset,
    secondary_tileset: spec.secondaryTileset,
    border_filepath: `${dirRel}/border.bin`,
    blockdata_filepath: blockdata,
  });
  await writeFileAtomic(ljPath, stringifyDecompJson(lj));

  return { layoutDir: dirRel, addedToIndex: !replaced, cellCount: spec.cells.length };
}
