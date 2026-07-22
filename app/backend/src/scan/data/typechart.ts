/**
 * Decomp Type-chart editor (Game Data engine, A8). Source: src/data/types_info.h
 * `gTypeEffectivenessTable[N][N]` - rows `[TYPE_X] = {cell, cell, …}` where each
 * cell is the attacker(row)→defender(col) multiplier. The matrix is self-
 * describing: row order == column order == the `[TYPE_X]` labels in file order.
 *
 * Cells are 6-char tokens (`______`=1×, `X(2.0)`, `X(0.5)`, `X(0.0)`) plus a few
 * gen-conditional macros (FIR_RS/PSN_RS/BUG_RS/PSY_RS/STL_RS). We read them to
 * numeric multipliers and edit one cell IN PLACE, writing a 6-char token so the
 * file's column alignment is preserved. Editing a conditional-macro cell
 * replaces it with a plain multiplier (the user is overriding the matchup).
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';

const TYPES_REL = 'src/data/types_info.h';

// Gen-conditional macros → their modern (B_UPDATED_TYPE_MATCHUPS) value.
const RS_MACROS: Record<string, number> = {
  STL_RS: 1, // Ghost/Dark → Steel (1× in Gen 6+)
  PSN_RS: 0.5, // Bug → Poison (0.5× in Gen 2+)
  BUG_RS: 1, // Poison → Bug (1× in Gen 2+)
  PSY_RS: 2, // Ghost → Psychic (2× in Gen 2+)
  FIR_RS: 0.5, // Ice → Fire (0.5× in Gen 2+)
};

const ROW_RE = /\[(TYPE_[A-Z0-9_]+)\]\s*=\s*\{([^}]*)\}/g;

function cellToMult(token: string): number | null {
  const t = token.trim();
  if (t === '______') return 1;
  const m = /^X\(\s*(\d+(?:\.\d+)?)\s*\)$/.exec(t);
  if (m) return Number.parseFloat(m[1]!);
  if (t in RS_MACROS) return RS_MACROS[t]!;
  return null; // unknown macro - left as-is, shown as neutral, not editable-safe
}

function multToCell(mult: number): string {
  if (mult === 1) return '______';
  return `X(${mult.toFixed(1)})`;
}

export interface TypeChart {
  /** Type order (rows == columns), e.g. ['TYPE_NONE','TYPE_NORMAL',…]. */
  types: string[];
  /** matrix[attackerIndex][defenderIndex] = multiplier (null = unknown macro). */
  matrix: Array<Array<number | null>>;
}

export async function readTypeChart(projectRoot: string): Promise<TypeChart> {
  const text = await fsp.readFile(path.join(projectRoot, TYPES_REL), 'utf8').catch(() => '');
  // Only parse rows inside the gTypeEffectivenessTable initializer (the type
  // INFO blocks further down also use `[TYPE_X] = {`, but those contain `.name`
  // etc., not bare multiplier cells - guard by requiring the table to precede).
  const tableStart = text.indexOf('gTypeEffectivenessTable');
  const tableEnd = tableStart >= 0 ? text.indexOf('\n};', tableStart) : -1;
  const region = tableStart >= 0 && tableEnd >= 0 ? text.slice(tableStart, tableEnd) : '';
  const types: string[] = [];
  const matrix: Array<Array<number | null>> = [];
  ROW_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ROW_RE.exec(region)) !== null) {
    types.push(m[1]!);
    matrix.push(m[2]!.split(',').map((c) => cellToMult(c)));
  }
  return { types, matrix };
}

export interface TypeChartEditResult {
  readonly before: string;
  readonly after: string;
}

export async function editTypeChartCell(
  projectRoot: string,
  attacker: string,
  defenderIndex: number,
  multiplier: number,
): Promise<TypeChartEditResult> {
  const abs = path.join(projectRoot, TYPES_REL);
  const text = await fsp.readFile(abs, 'utf8');
  const rowRe = new RegExp(
    `\\[${attacker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]\\s*=\\s*\\{([^}]*)\\}`,
  );
  const m = rowRe.exec(text);
  if (!m) throw new Error(`Type row ${attacker} not found`);
  const bodyStart = m.index + m[0].indexOf('{') + 1;
  const body = m[1]!;
  // Walk comma-separated cells, tracking each cell's offset within `body`.
  const cells: Array<{ start: number; end: number }> = [];
  let cur = 0;
  for (let i = 0; i <= body.length; i++) {
    if (i === body.length || body[i] === ',') {
      cells.push({ start: cur, end: i });
      cur = i + 1;
    }
  }
  if (defenderIndex < 0 || defenderIndex >= cells.length) {
    throw new Error(`Defender index ${defenderIndex} out of range (${cells.length} cells)`);
  }
  const cell = cells[defenderIndex]!;
  // Preserve surrounding whitespace: replace only the trimmed token.
  const raw = body.slice(cell.start, cell.end);
  const lead = raw.length - raw.trimStart().length;
  const trail = raw.length - raw.trimEnd().length;
  const tokenStart = bodyStart + cell.start + lead;
  const tokenEnd = bodyStart + cell.end - trail;
  const before = text.slice(tokenStart, tokenEnd);
  const after = multToCell(multiplier);
  if (before === after) return { before, after };
  const next = text.slice(0, tokenStart) + after + text.slice(tokenEnd);
  const tmp = `${abs}.tmp`;
  await fsp.writeFile(tmp, next, 'utf8');
  await fsp.rename(tmp, abs);
  return { before, after };
}
