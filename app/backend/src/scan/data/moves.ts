/**
 * Decomp Moves editor (Game Data engine, A2). Source: src/data/moves_info.h - 
 * `[MOVE_X] = { .name, .power, .type, .accuracy, .pp, .priority, .category,
 * .target, .effect, .makesContact, … }`. Built on the shared struct-block engine.
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { parseBlocks, editBlockInPlace, unquote } from './struct-block.js';

const MOVES_REL = 'src/data/moves_info.h';

export interface MoveData {
  readonly id: string;
  readonly fields: Record<string, string>;
}

export async function readMoves(projectRoot: string): Promise<MoveData[]> {
  const text = await fsp.readFile(path.join(projectRoot, MOVES_REL), 'utf8').catch(() => '');
  return parseBlocks(text, 'MOVE_').map((b) => ({ id: b.id, fields: b.fields }));
}

export interface MoveDetail {
  id: string;
  name: string;
  power: number;
  type: string;
  accuracy: number;
  pp: number;
  priority: number;
  category: string;
  target: string;
  effect: string;
  makesContact: boolean;
  description: string;
}

function int(f: Record<string, string>, k: string): number {
  const n = Number.parseInt(f[k] ?? '', 10);
  return Number.isFinite(n) ? n : 0;
}

export function toMoveDetail(m: MoveData): MoveDetail {
  const f = m.fields;
  return {
    id: m.id,
    name: unquote(f['name']) || prettyMove(m.id),
    power: int(f, 'power'),
    type: f['type'] ?? 'TYPE_NORMAL',
    accuracy: int(f, 'accuracy'),
    pp: int(f, 'pp'),
    priority: int(f, 'priority'),
    category: f['category'] ?? 'DAMAGE_CATEGORY_STATUS',
    target: f['target'] ?? 'MOVE_TARGET_SELECTED',
    effect: f['effect'] ?? 'EFFECT_HIT',
    makesContact: /^\s*TRUE\s*$/.test(f['makesContact'] ?? ''),
    description: unquote(f['description']),
  };
}

export interface MoveEnums {
  readonly types: string[];
  readonly categories: string[];
  readonly targets: string[];
  readonly effects: string[];
}

/** Dropdown options = the distinct values that actually appear in the data. */
export function moveEnums(moves: MoveData[]): MoveEnums {
  const distinct = (k: string): string[] =>
    Array.from(new Set(moves.map((m) => m.fields[k]).filter((v): v is string => !!v))).sort();
  return {
    types: distinct('type'),
    categories: distinct('category'),
    targets: distinct('target'),
    effects: distinct('effect'),
  };
}

export type MoveEdit = Partial<Omit<MoveDetail, 'id'>>;

export interface MoveEditResult {
  readonly before: string;
  readonly after: string;
}

export async function editMove(
  projectRoot: string,
  id: string,
  edit: MoveEdit,
): Promise<MoveEditResult> {
  const abs = path.join(projectRoot, MOVES_REL);
  const text = await fsp.readFile(abs, 'utf8');
  const raw: Record<string, string> = {};
  if (edit.power !== undefined) raw['power'] = String(edit.power);
  if (edit.accuracy !== undefined) raw['accuracy'] = String(edit.accuracy);
  if (edit.pp !== undefined) raw['pp'] = String(edit.pp);
  if (edit.priority !== undefined) raw['priority'] = String(edit.priority);
  if (edit.type) raw['type'] = edit.type;
  if (edit.category) raw['category'] = edit.category;
  if (edit.target) raw['target'] = edit.target;
  if (edit.effect) raw['effect'] = edit.effect;
  if (edit.makesContact !== undefined) raw['makesContact'] = edit.makesContact ? 'TRUE' : 'FALSE';
  if (edit.name !== undefined) raw['name'] = `COMPOUND_STRING(${JSON.stringify(edit.name)})`;
  if (edit.description !== undefined) raw['description'] = `COMPOUND_STRING(${JSON.stringify(edit.description)})`;

  const res = editBlockInPlace(text, id, raw);
  if (!res) throw new Error(`Move ${id} not found in ${MOVES_REL}`);
  const tmp = `${abs}.tmp`;
  await fsp.writeFile(tmp, res.next, 'utf8');
  await fsp.rename(tmp, abs);
  return { before: res.before, after: res.after };
}

function prettyMove(id: string): string {
  return id
    .replace(/^MOVE_/, '')
    .toLowerCase()
    .replace(/(^|_)(\w)/g, (_a, _b, c: string) => (_b ? ' ' : '') + c.toUpperCase());
}
