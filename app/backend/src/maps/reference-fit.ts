/**
 * Reference-image → map-layout tile fitting.
 *
 * A GBA map is not a freeform image: it's a grid of indices into a fixed
 * vocabulary of 16×16 metatiles (each carrying its own collision/behavior).
 * "Turn this town picture into a map" therefore reduces to: for every 16×16
 * cell of the reference, pick the metatile from the chosen tileset whose
 * rendered pixels match best. Output is a legal metatile grid by construction - 
 * no illegal art can appear, because every cell is an existing metatile.
 *
 * Matching is two-stage:
 *   1. exact - hash the cell's pixels and look up an identical metatile (this
 *      is the common case when the reference was itself rendered from the
 *      tileset, e.g. a Porymap/HMA export);
 *   2. nearest - fall back to the minimum sum-of-absolute-difference metatile
 *      for cells that don't match exactly (recolours, anti-aliasing, a
 *      hand-drawn reference).
 *
 * This module is deliberately pure (no I/O beyond the tileset render it is
 * handed) so it can be round-trip verified: render a real map → fit it back →
 * the reconstruction must be pixel-identical.
 */
import type { LayoutData } from '@rom-editor/shared';
import {
  composeMetatile,
  loadTilesetByName,
  readTilesetSources,
  NUM_METATILES_IN_PRIMARY,
  type TilesetData,
} from '../scan/tileset-render.js';

const METATILE_PX = 16;
const RGBA = 4;
const CELL_BYTES = METATILE_PX * METATILE_PX * RGBA; // 1024

export interface VocabEntry {
  readonly metatileId: number;
  readonly rgba: Uint8ClampedArray; // 16×16×4
  readonly hash: number; // FNV-1a over rgba
}

export interface TilesetVocabulary {
  readonly entries: readonly VocabEntry[];
  /** metatileId → rgba, for stitching a grid back to pixels. */
  readonly byId: ReadonlyMap<number, Uint8ClampedArray>;
  /** hash → metatileIds sharing that hash (collision-safe exact lookup). */
  readonly byHash: ReadonlyMap<number, number[]>;
  readonly primaryCount: number;
  readonly secondaryCount: number;
}

/** FNV-1a (32-bit) over a byte buffer. */
function fnv1a(bytes: Uint8ClampedArray): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]!;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Render every metatile of a primary(+secondary) tileset pair into a lookup
 *  vocabulary. Secondary metatile ids start at NUM_METATILES_IN_PRIMARY (640),
 *  matching composeMetatile's addressing. */
export function buildVocabularyFromTilesets(
  primary: TilesetData,
  secondary: TilesetData | null,
): TilesetVocabulary {
  const primaryCount = Math.floor(primary.metatiles.length / 16);
  const secondaryCount = secondary ? Math.floor(secondary.metatiles.length / 16) : 0;
  const entries: VocabEntry[] = [];
  const byId = new Map<number, Uint8ClampedArray>();
  const byHash = new Map<number, number[]>();

  const add = (metatileId: number): void => {
    const rgba = composeMetatile(metatileId, primary, secondary);
    const hash = fnv1a(rgba);
    entries.push({ metatileId, rgba, hash });
    byId.set(metatileId, rgba);
    const bucket = byHash.get(hash);
    if (bucket) bucket.push(metatileId);
    else byHash.set(hash, [metatileId]);
  };

  for (let id = 0; id < primaryCount; id++) add(id);
  for (let i = 0; i < secondaryCount; i++) add(NUM_METATILES_IN_PRIMARY + i);

  return { entries, byId, byHash, primaryCount, secondaryCount };
}

/** Load the tileset pair named by a layout (or any explicit pair of C names)
 *  and render its vocabulary. */
export async function renderTilesetVocabulary(
  projectRoot: string,
  primaryTileset: string | null,
  secondaryTileset: string | null,
): Promise<TilesetVocabulary | null> {
  const sources = await readTilesetSources(projectRoot);
  const primary = await loadTilesetByName(projectRoot, primaryTileset, 'primary', sources);
  if (!primary) return null;
  const secondary = await loadTilesetByName(projectRoot, secondaryTileset, 'secondary', sources);
  return buildVocabularyFromTilesets(primary, secondary);
}

/** Copy the 16×16 RGBA block at cell (cx,cy) out of a full image buffer. */
function extractCell(
  pixels: Uint8ClampedArray,
  imgW: number,
  cx: number,
  cy: number,
): Uint8ClampedArray {
  const cell = new Uint8ClampedArray(CELL_BYTES);
  const x0 = cx * METATILE_PX;
  const y0 = cy * METATILE_PX;
  for (let y = 0; y < METATILE_PX; y++) {
    const srcRow = ((y0 + y) * imgW + x0) * RGBA;
    cell.set(pixels.subarray(srcRow, srcRow + METATILE_PX * RGBA), y * METATILE_PX * RGBA);
  }
  return cell;
}

/** Sum of absolute RGB differences between two 16×16 cells (alpha ignored). */
function cellSad(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  let sad = 0;
  for (let i = 0; i < CELL_BYTES; i += RGBA) {
    sad += Math.abs(a[i]! - b[i]!) + Math.abs(a[i + 1]! - b[i + 1]!) + Math.abs(a[i + 2]! - b[i + 2]!);
  }
  return sad;
}

function bytesEqual(a: Uint8ClampedArray, b: Uint8ClampedArray): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export interface FitCell {
  readonly metatileId: number;
  readonly exact: boolean;
  readonly error: number; // 0 for exact; SAD for nearest
}

export interface FitResult {
  readonly cols: number;
  readonly rows: number;
  /** metatileId per cell, row-major (cols×rows). */
  readonly grid: number[];
  readonly cells: FitCell[];
  readonly exactCells: number;
  readonly approxCells: number;
  /** mean per-cell SAD across approximate cells (0 if all exact). */
  readonly meanApproxError: number;
  readonly worstError: number;
  /** Cells whose nearest match is still far (likely missing-from-tileset art). */
  readonly poorCells: number;
}

export interface FitOptions {
  /** A cell whose nearest SAD exceeds this is flagged "poor" (default 4000 ≈
   *  ~5 LSB/channel over 256 px). Tune per use. */
  readonly poorThreshold?: number;
}

/**
 * Fit a reference RGBA image to a metatile vocabulary. The image's dimensions
 * are floored to whole 16px cells. Returns a metatile-id grid plus per-cell
 * match quality so the caller can render a diff and target manual fix-ups.
 */
export function fitImageToVocabulary(
  pixels: Uint8ClampedArray,
  imgW: number,
  imgH: number,
  vocab: TilesetVocabulary,
  options: FitOptions = {},
): FitResult {
  const poorThreshold = options.poorThreshold ?? 4000;
  const cols = Math.floor(imgW / METATILE_PX);
  const rows = Math.floor(imgH / METATILE_PX);
  const grid: number[] = new Array<number>(cols * rows).fill(0);
  const cells: FitCell[] = [];
  let exactCells = 0;
  let approxCells = 0;
  let approxErrorSum = 0;
  let worstError = 0;
  let poorCells = 0;

  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const cell = extractCell(pixels, imgW, cx, cy);
      const hash = fnv1a(cell);
      let chosen = -1;
      let exact = false;

      const bucket = vocab.byHash.get(hash);
      if (bucket) {
        for (const id of bucket) {
          if (bytesEqual(cell, vocab.byId.get(id)!)) {
            chosen = id;
            exact = true;
            break;
          }
        }
      }

      let error = 0;
      if (!exact) {
        // Nearest by SAD over the whole vocabulary.
        let best = Infinity;
        for (const e of vocab.entries) {
          const d = cellSad(cell, e.rgba);
          if (d < best) {
            best = d;
            chosen = e.metatileId;
            if (d === 0) break;
          }
        }
        error = best;
        approxCells += 1;
        approxErrorSum += best;
        if (best > poorThreshold) poorCells += 1;
      } else {
        exactCells += 1;
      }

      if (error > worstError) worstError = error;
      const idx = cy * cols + cx;
      grid[idx] = chosen < 0 ? 0 : chosen;
      cells.push({ metatileId: grid[idx]!, exact, error });
    }
  }

  return {
    cols,
    rows,
    grid,
    cells,
    exactCells,
    approxCells,
    meanApproxError: approxCells > 0 ? approxErrorSum / approxCells : 0,
    worstError,
    poorCells,
  };
}

/** Stitch a metatile-id grid back into a full RGBA image using the vocabulary - 
 *  the inverse of fitImageToVocabulary, for render-and-diff verification. */
export function stitchGridToRgba(
  grid: readonly number[],
  cols: number,
  rows: number,
  vocab: TilesetVocabulary,
): { width: number; height: number; pixels: Uint8ClampedArray } {
  const width = cols * METATILE_PX;
  const height = rows * METATILE_PX;
  const pixels = new Uint8ClampedArray(width * height * RGBA);
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const id = grid[cy * cols + cx] ?? 0;
      const tile = vocab.byId.get(id);
      if (!tile) continue;
      const x0 = cx * METATILE_PX;
      const y0 = cy * METATILE_PX;
      for (let y = 0; y < METATILE_PX; y++) {
        const dstRow = ((y0 + y) * width + x0) * RGBA;
        pixels.set(tile.subarray(y * METATILE_PX * RGBA, (y + 1) * METATILE_PX * RGBA), dstRow);
      }
    }
  }
  return { width, height, pixels };
}

/** Render a decomp LayoutData's metatile grid to a full RGBA image (used to
 *  produce a ground-truth "reference" from an existing map). */
export function renderLayoutToRgba(
  layout: LayoutData,
  vocab: TilesetVocabulary,
): { width: number; height: number; pixels: Uint8ClampedArray } {
  const grid = layout.cells.map((c) => c.metatileId);
  return stitchGridToRgba(grid, layout.width, layout.height, vocab);
}
