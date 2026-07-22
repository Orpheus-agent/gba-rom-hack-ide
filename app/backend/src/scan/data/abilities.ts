/**
 * Decomp Abilities editor (Game Data engine, A6). Source: src/data/abilities.h - 
 * `[ABILITY_X] = { .name = _("…"), .description = …, .aiRating = N }`. The
 * ability's *effect* is C logic (battle engine) - only name/description/aiRating
 * are data-editable here; behavior changes go through the agent.
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { parseBlocks, editBlockInPlace, unquote } from './struct-block.js';

const ABILITIES_REL = 'src/data/abilities.h';

export interface AbilityDetail {
  id: string;
  name: string;
  description: string;
  aiRating: number;
}

export async function readAbilities(projectRoot: string): Promise<AbilityDetail[]> {
  const text = await fsp.readFile(path.join(projectRoot, ABILITIES_REL), 'utf8').catch(() => '');
  return parseBlocks(text, 'ABILITY_').map((b) => {
    const n = Number.parseInt(b.fields['aiRating'] ?? '', 10);
    return {
      id: b.id,
      name: unquote(b.fields['name']) || prettyAbility(b.id),
      description: unquote(b.fields['description']),
      aiRating: Number.isFinite(n) ? n : 0,
    };
  });
}

export type AbilityEdit = Partial<Pick<AbilityDetail, 'name' | 'description' | 'aiRating'>>;

export interface AbilityEditResult {
  readonly before: string;
  readonly after: string;
}

export async function editAbility(
  projectRoot: string,
  id: string,
  edit: AbilityEdit,
): Promise<AbilityEditResult> {
  const abs = path.join(projectRoot, ABILITIES_REL);
  const text = await fsp.readFile(abs, 'utf8');
  const raw: Record<string, string> = {};
  if (edit.name !== undefined) raw['name'] = `_(${JSON.stringify(edit.name)})`;
  if (edit.description !== undefined) raw['description'] = `COMPOUND_STRING(${JSON.stringify(edit.description)})`;
  if (edit.aiRating !== undefined) raw['aiRating'] = String(edit.aiRating);
  const res = editBlockInPlace(text, id, raw);
  if (!res) throw new Error(`Ability ${id} not found`);
  const tmp = `${abs}.tmp`;
  await fsp.writeFile(tmp, res.next, 'utf8');
  await fsp.rename(tmp, abs);
  return { before: res.before, after: res.after };
}

function prettyAbility(id: string): string {
  return id
    .replace(/^ABILITY_/, '')
    .toLowerCase()
    .replace(/(^|_)(\w)/g, (_a, _b, c: string) => (_b ? ' ' : '') + c.toUpperCase());
}
