/**
 * Decomp species-data parser + in-place editor (Game Data engine, A1).
 *
 * Source: src/data/pokemon/species_info/gen_*_families.h - one
 * `[SPECIES_X] = { .field = value, ... }` struct block per species. We parse
 * the high-value fields for display/editing and EDIT IN PLACE (replace just
 * the changed field's value within its block), so every unmodeled field, macro
 * line (SHADOW/OVERWORLD/FOOTPRINT), comment, and #if guard is preserved
 * verbatim - exactly the round-trip-safety the trainers.party editor gives.
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';

const SPECIES_DIR = path.join('src', 'data', 'pokemon', 'species_info');

/** A parsed species: modeled fields + the raw block for in-place editing. */
export interface SpeciesData {
  readonly id: string; // e.g. "SPECIES_BULBASAUR"
  readonly name: string; // from .speciesName _("...")
  readonly sourceRel: string; // gen_N_families.h relative path
  readonly fields: Record<string, string>; // key -> raw value text (trimmed)
}

async function listSpeciesFiles(projectRoot: string): Promise<string[]> {
  const dir = path.join(projectRoot, SPECIES_DIR);
  try {
    const entries = await fsp.readdir(dir);
    return entries
      .filter((f) => f.endsWith('_families.h'))
      .map((f) => path.join(SPECIES_DIR, f).replace(/\\/g, '/'));
  } catch {
    return [];
  }
}

/** Find the matching close char index for an open bracket at `open`. */
function matchBracket(text: string, open: number, openCh: string, closeCh: string): number {
  let depth = 0;
  let i = open;
  let inStr = false;
  for (; i < text.length; i++) {
    const c = text[i]!;
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === openCh) depth++;
    else if (c === closeCh) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Extract `.key = value` pairs from a struct-block body. Values run until a
 * top-level comma (depth 0 across () [] {} and outside string literals), so
 * multi-line strings / nested macros are captured whole.
 */
function parseFields(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i < body.length) {
    // Seek the next `.ident` that starts a field (at the body's top level).
    const dot = body.indexOf('.', i);
    if (dot === -1) break;
    const m = /^\.([A-Za-z_]\w*)\s*=/.exec(body.slice(dot));
    if (!m) {
      i = dot + 1;
      continue;
    }
    const key = m[1]!;
    let j = dot + m[0].length;
    // Read the value until a top-level comma.
    let depth = 0;
    let inStr = false;
    const start = j;
    for (; j < body.length; j++) {
      const c = body[j]!;
      if (inStr) {
        if (c === '\\') j++;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') depth--;
      else if (c === ',' && depth === 0) break;
    }
    out[key] = body.slice(start, j).trim();
    i = j + 1;
  }
  return out;
}

const SPECIES_BLOCK_RE = /\[(SPECIES_[A-Za-z0-9_]+)\]\s*=\s*\{/g;

/** Read every species across all gen_*_families.h files. */
export async function readSpecies(projectRoot: string): Promise<SpeciesData[]> {
  const files = await listSpeciesFiles(projectRoot);
  const out: SpeciesData[] = [];
  for (const rel of files) {
    let text: string;
    try {
      text = await fsp.readFile(path.join(projectRoot, rel), 'utf8');
    } catch {
      continue;
    }
    const re = new RegExp(SPECIES_BLOCK_RE.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const id = m[1]!;
      const openBrace = m.index + m[0].length - 1;
      const closeBrace = matchBracket(text, openBrace, '{', '}');
      if (closeBrace === -1) continue;
      const body = text.slice(openBrace + 1, closeBrace);
      const fields = parseFields(body);
      const name = unquoteName(fields['speciesName']) ?? prettifyId(id);
      out.push({ id, name, sourceRel: rel, fields });
      re.lastIndex = closeBrace;
    }
  }
  return out;
}

/** `_("Bulbasaur")` → "Bulbasaur"; COMPOUND_STRING("a" "b") → "ab". */
export function unquoteName(raw: string | undefined): string | null {
  if (!raw) return null;
  const parts = [...raw.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => x[1]!);
  if (parts.length === 0) return null;
  return parts.join('').replace(/\\n/g, ' ').replace(/\s+/g, ' ').trim();
}

function prettifyId(id: string): string {
  return id
    .replace(/^SPECIES_/, '')
    .toLowerCase()
    .replace(/(^|_)(\w)/g, (_a, _b, c: string) => (_b ? ' ' : '') + c.toUpperCase());
}

// ─────────────────────────── editable detail ───────────────────────────

/** The modeled, editable view of a species (everything else is preserved). */
export interface SpeciesDetail {
  id: string;
  name: string;
  sourceRel: string;
  baseHP: number;
  baseAttack: number;
  baseDefense: number;
  baseSpeed: number;
  baseSpAttack: number;
  baseSpDefense: number;
  type1: string;
  type2: string;
  abilities: [string, string, string];
  eggGroup1: string;
  eggGroup2: string;
  catchRate: number;
  eggCycles: number;
  height: number;
  weight: number;
  growthRate: string;
  bodyColor: string;
  friendship: string;
  speciesName: string;
  categoryName: string;
  description: string;
  /** Display-only context (not editable in A1). */
  genderRatio: string;
  expYield: string;
  evolutions: string;
}

function intField(fields: Record<string, string>, key: string): number {
  const n = Number.parseInt(fields[key] ?? '', 10);
  return Number.isFinite(n) ? n : 0;
}
function macroArgs(raw: string | undefined): string[] {
  const m = /\(([\s\S]*)\)/.exec(raw ?? '');
  return m ? m[1]!.split(',').map((s) => s.trim()).filter(Boolean) : [];
}
function braceArgs(raw: string | undefined): string[] {
  const m = /\{([\s\S]*)\}/.exec(raw ?? '');
  return m ? m[1]!.split(',').map((s) => s.trim()).filter(Boolean) : [];
}

export function toSpeciesDetail(s: SpeciesData): SpeciesDetail {
  const f = s.fields;
  const types = macroArgs(f['types']);
  const abil = braceArgs(f['abilities']);
  const eggs = macroArgs(f['eggGroups']);
  return {
    id: s.id,
    name: s.name,
    sourceRel: s.sourceRel,
    baseHP: intField(f, 'baseHP'),
    baseAttack: intField(f, 'baseAttack'),
    baseDefense: intField(f, 'baseDefense'),
    baseSpeed: intField(f, 'baseSpeed'),
    baseSpAttack: intField(f, 'baseSpAttack'),
    baseSpDefense: intField(f, 'baseSpDefense'),
    type1: types[0] ?? 'TYPE_NORMAL',
    type2: types[1] ?? types[0] ?? 'TYPE_NORMAL',
    abilities: [abil[0] ?? 'ABILITY_NONE', abil[1] ?? 'ABILITY_NONE', abil[2] ?? 'ABILITY_NONE'],
    eggGroup1: eggs[0] ?? 'EGG_GROUP_UNDISCOVERED',
    eggGroup2: eggs[1] ?? eggs[0] ?? 'EGG_GROUP_UNDISCOVERED',
    catchRate: intField(f, 'catchRate'),
    eggCycles: intField(f, 'eggCycles'),
    height: intField(f, 'height'),
    weight: intField(f, 'weight'),
    growthRate: f['growthRate'] ?? 'GROWTH_MEDIUM_FAST',
    bodyColor: f['bodyColor'] ?? 'BODY_COLOR_RED',
    friendship: f['friendship'] ?? 'STANDARD_FRIENDSHIP',
    speciesName: unquoteName(f['speciesName']) ?? s.name,
    categoryName: unquoteName(f['categoryName']) ?? '',
    description: descriptionText(f['description']),
    genderRatio: f['genderRatio'] ?? '',
    expYield: f['expYield'] ?? '',
    evolutions: f['evolutions'] ?? '',
  };
}

/** Keep description line breaks (each "..." literal is one line). */
function descriptionText(raw: string | undefined): string {
  if (!raw) return '';
  const parts = [...raw.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => x[1]!);
  return parts.join('').replace(/\\n/g, '\n');
}

/** Editable subset accepted by editSpecies (all optional). */
export type SpeciesEdit = Partial<
  Pick<
    SpeciesDetail,
    | 'baseHP' | 'baseAttack' | 'baseDefense' | 'baseSpeed' | 'baseSpAttack' | 'baseSpDefense'
    | 'type1' | 'type2' | 'eggGroup1' | 'eggGroup2'
    | 'catchRate' | 'eggCycles' | 'height' | 'weight'
    | 'growthRate' | 'bodyColor' | 'friendship'
    | 'speciesName' | 'categoryName' | 'description'
  > & { abilities: [string, string, string] }
>;

/** Build raw C value strings for each changed field. */
function buildRawEdits(d: SpeciesEdit): Record<string, string> {
  const r: Record<string, string> = {};
  const ints: Array<keyof SpeciesEdit> = [
    'baseHP', 'baseAttack', 'baseDefense', 'baseSpeed', 'baseSpAttack', 'baseSpDefense',
    'catchRate', 'eggCycles', 'height', 'weight',
  ];
  for (const k of ints) if (d[k] !== undefined) r[k] = String(d[k]);
  if (d.type1 && d.type2) r['types'] = `MON_TYPES(${d.type1}, ${d.type2})`;
  if (d.abilities) r['abilities'] = `{ ${d.abilities[0]}, ${d.abilities[1]}, ${d.abilities[2]} }`;
  if (d.eggGroup1 && d.eggGroup2) r['eggGroups'] = `MON_EGG_GROUPS(${d.eggGroup1}, ${d.eggGroup2})`;
  if (d.growthRate) r['growthRate'] = d.growthRate;
  if (d.bodyColor) r['bodyColor'] = d.bodyColor;
  if (d.friendship) r['friendship'] = d.friendship;
  if (d.speciesName !== undefined) r['speciesName'] = `_(${JSON.stringify(d.speciesName)})`;
  if (d.categoryName !== undefined) r['categoryName'] = `_(${JSON.stringify(d.categoryName)})`;
  if (d.description !== undefined) r['description'] = `COMPOUND_STRING(${JSON.stringify(d.description)})`;
  return r;
}

/** Field value spans (absolute file offsets) within a species block body. */
function fieldSpans(body: string, bodyOffset: number): Map<string, [number, number]> {
  const spans = new Map<string, [number, number]>();
  let i = 0;
  while (i < body.length) {
    const dot = body.indexOf('.', i);
    if (dot === -1) break;
    const m = /^\.([A-Za-z_]\w*)\s*=/.exec(body.slice(dot));
    if (!m) {
      i = dot + 1;
      continue;
    }
    let j = dot + m[0].length;
    while (j < body.length && /\s/.test(body[j]!)) j++;
    const start = j;
    let depth = 0;
    let inStr = false;
    for (; j < body.length; j++) {
      const c = body[j]!;
      if (inStr) {
        if (c === '\\') j++;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') depth--;
      else if (c === ',' && depth === 0) break;
    }
    spans.set(m[1]!, [bodyOffset + start, bodyOffset + j]);
    i = j + 1;
  }
  return spans;
}

export interface EditResult {
  readonly sourceRel: string;
  readonly before: string;
  readonly after: string;
}

/** Apply field edits to a species in place, preserving everything else. */
export async function editSpecies(
  projectRoot: string,
  speciesId: string,
  edit: SpeciesEdit,
): Promise<EditResult> {
  const all = await readSpecies(projectRoot);
  const target = all.find((s) => s.id === speciesId);
  if (!target) throw new Error(`Species ${speciesId} not found`);
  const abs = path.join(projectRoot, target.sourceRel);
  const text = await fsp.readFile(abs, 'utf8');

  const re = new RegExp(`\\[${speciesId}\\]\\s*=\\s*\\{`, 'g');
  const m = re.exec(text);
  if (!m) throw new Error(`Could not locate ${speciesId} block`);
  const openBrace = m.index + m[0].length - 1;
  const closeBrace = matchBracket(text, openBrace, '{', '}');
  if (closeBrace === -1) throw new Error(`Unbalanced braces for ${speciesId}`);
  const before = text.slice(m.index, closeBrace + 1);

  const spans = fieldSpans(text.slice(openBrace + 1, closeBrace), openBrace + 1);
  const raw = buildRawEdits(edit);
  // Apply edits from last offset to first so earlier offsets stay valid.
  const applicable = Object.keys(raw)
    .map((k) => ({ k, span: spans.get(k) }))
    .filter((x): x is { k: string; span: [number, number] } => !!x.span)
    .sort((a, b) => b.span[0] - a.span[0]);
  let next = text;
  for (const { k, span } of applicable) {
    next = next.slice(0, span[0]) + raw[k] + next.slice(span[1]);
  }

  // Recompute the after-block text (offsets shifted; re-locate).
  const re2 = new RegExp(`\\[${speciesId}\\]\\s*=\\s*\\{`, 'g');
  const m2 = re2.exec(next)!;
  const close2 = matchBracket(next, m2.index + m2[0].length - 1, '{', '}');
  const after = next.slice(m2.index, close2 + 1);

  const tmp = `${abs}.tmp`;
  await fsp.writeFile(tmp, next, 'utf8');
  await fsp.rename(tmp, abs);
  return { sourceRel: target.sourceRel, before, after };
}
