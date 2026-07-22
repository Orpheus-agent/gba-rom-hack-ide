/**
 * Decomp Items editor (Game Data engine, A5). Source: src/data/items.h - 
 * `[ITEM_X] = { .name = ITEM_NAME("…"), .price = N, .description = COMPOUND_STRING(…),
 * .pocket = POCKET_*, … }`. We edit the safe, near-universal, plain-data fields:
 * name, description, price, pocket. The item's *effect* (fieldUseFunc /
 * battleUsage / effect) is C logic - that goes through the agent (Substrate H).
 *
 * `price` is kept as a raw string so conditional expressions some items use
 * (e.g. `(I_PRICE >= GEN_7) ? 200 : 300`) round-trip untouched unless the user
 * deliberately overwrites them. All 874 vanilla items use the ITEM_NAME wrapper.
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { parseBlocks, editBlockInPlace, unquote } from './struct-block.js';

const ITEMS_REL = 'src/data/items.h';

export interface ItemDetail {
  id: string;
  name: string;
  description: string;
  /** Raw value text - usually an integer, occasionally a `?:` expression. */
  price: string;
  /** POCKET_* token (POCKET_ITEMS / POCKET_KEY_ITEMS / …). */
  pocket: string;
}

export async function readItems(projectRoot: string): Promise<ItemDetail[]> {
  const text = await fsp
    .readFile(path.join(projectRoot, ITEMS_REL), 'utf8')
    .catch(() => '');
  return parseBlocks(text, 'ITEM_').map((b) => ({
    id: b.id,
    name: unquote(b.fields['name']) || prettyItem(b.id),
    description: unquote(b.fields['description']),
    price: (b.fields['price'] ?? '').trim(),
    pocket: (b.fields['pocket'] ?? '').trim(),
  }));
}

/** Data-driven enum lists for the editor dropdowns (distinct on-disk values). */
export function itemEnums(items: ReadonlyArray<ItemDetail>): { pockets: string[] } {
  const pockets = new Set<string>();
  for (const it of items) if (it.pocket) pockets.add(it.pocket);
  return { pockets: [...pockets].sort() };
}

export type ItemEdit = Partial<Pick<ItemDetail, 'name' | 'description' | 'price' | 'pocket'>>;

export interface ItemEditResult {
  readonly before: string;
  readonly after: string;
}

export async function editItem(
  projectRoot: string,
  id: string,
  edit: ItemEdit,
): Promise<ItemEditResult> {
  const abs = path.join(projectRoot, ITEMS_REL);
  const text = await fsp.readFile(abs, 'utf8');
  const raw: Record<string, string> = {};
  if (edit.name !== undefined) raw['name'] = `ITEM_NAME(${JSON.stringify(edit.name)})`;
  if (edit.description !== undefined) {
    raw['description'] = `COMPOUND_STRING(${JSON.stringify(edit.description)})`;
  }
  // price is written verbatim - the user owns its exact text (number or expr).
  if (edit.price !== undefined) raw['price'] = edit.price.trim();
  if (edit.pocket !== undefined) raw['pocket'] = edit.pocket.trim();
  const res = editBlockInPlace(text, id, raw);
  if (!res) throw new Error(`Item ${id} not found`);
  const tmp = `${abs}.tmp`;
  await fsp.writeFile(tmp, res.next, 'utf8');
  await fsp.rename(tmp, abs);
  return { before: res.before, after: res.after };
}

function prettyItem(id: string): string {
  return id
    .replace(/^ITEM_/, '')
    .toLowerCase()
    .replace(/(^|_)(\w)/g, (_a, _b, c: string) => (_b ? ' ' : '') + c.toUpperCase());
}
