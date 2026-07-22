/**
 * Decomp Wild-Encounter slot editor (Game Data engine, A4).
 *
 * Source of truth is `src/data/wild_encounters.json` (the build regenerates
 * wild_encounters.h from it). `scan/encounters.ts` already READS this file into
 * manifest.encounterTables; this module EDITS a single slot (species / level
 * range) IN PLACE so the 735 KB hand-formatted JSON keeps its exact shape and
 * the diff stays tiny (one mons[] element).
 *
 * A table id from the reader is `<base_label>_<type>` (type ∈ grass/water/
 * fishing/rock_smash). We reverse that to (base_label, json key), bound the
 * search to the one encounter object (base_label is unique), brace-match into
 * `<key>.mons[slotIndex]`, and splice the field value.
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { matchBracket } from './struct-block.js';

const ENC_REL = 'src/data/wild_encounters.json';

/** EncounterTableType → wild_encounters.json key (inverse of encounters.ts). */
const TYPE_TO_KEY: Record<string, string> = {
  grass: 'land_mons',
  water: 'water_mons',
  fishing: 'fishing_mons',
  rock_smash: 'rock_smash_mons',
};

/** Longest-first so `_rock_smash` is matched before any shorter overlap. */
const TYPE_SUFFIXES = ['rock_smash', 'fishing', 'water', 'grass'] as const;

function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Split a reader table id `<base_label>_<type>` into its parts. */
export function parseEncounterTableId(
  tableId: string,
): { baseLabel: string; type: string } | null {
  for (const t of TYPE_SUFFIXES) {
    if (tableId.endsWith(`_${t}`)) {
      return { baseLabel: tableId.slice(0, tableId.length - t.length - 1), type: t };
    }
  }
  return null;
}

export interface EncounterSlotEdit {
  speciesId?: string;
  minLevel?: number;
  maxLevel?: number;
}

export interface EncounterEditResult {
  readonly before: string;
  readonly after: string;
}

export async function editEncounterSlot(
  projectRoot: string,
  tableId: string,
  slotIndex: number,
  edit: EncounterSlotEdit,
): Promise<EncounterEditResult> {
  const parsed = parseEncounterTableId(tableId);
  if (!parsed) throw new Error(`Unrecognized encounter table id '${tableId}'`);
  const key = TYPE_TO_KEY[parsed.type];
  if (!key) throw new Error(`Unsupported encounter type '${parsed.type}'`);

  const abs = path.join(projectRoot, ENC_REL);
  const text = await fsp.readFile(abs, 'utf8');

  // 1) Locate the encounter object via its unique base_label, and bound the
  //    search to before the next base_label so we never cross into a sibling.
  const blRe = new RegExp(`"base_label"\\s*:\\s*"${esc(parsed.baseLabel)}"`, 'g');
  const blM = blRe.exec(text);
  if (!blM) throw new Error(`Encounter '${parsed.baseLabel}' not found in wild_encounters.json`);
  const regionStart = blM.index;
  const nextM = blRe.exec(text);
  const regionEnd = nextM ? nextM.index : text.length;

  // 2) The `<key>: { … }` table object within this encounter.
  const tkM = new RegExp(`"${key}"\\s*:\\s*\\{`).exec(text.slice(regionStart, regionEnd));
  if (!tkM) throw new Error(`Encounter '${parsed.baseLabel}' has no ${key} table`);
  const tkOpen = regionStart + tkM.index + tkM[0].length - 1;
  const tkClose = matchBracket(text, tkOpen, '{', '}');
  if (tkClose === -1) throw new Error(`Malformed ${key} object for '${parsed.baseLabel}'`);

  // 3) Its `mons: [ … ]` array.
  const monsM = /"mons"\s*:\s*\[/.exec(text.slice(tkOpen, tkClose + 1));
  if (!monsM) throw new Error(`${key} for '${parsed.baseLabel}' has no mons array`);
  const monsOpen = tkOpen + monsM.index + monsM[0].length - 1;
  const monsClose = matchBracket(text, monsOpen, '[', ']');
  if (monsClose === -1) throw new Error(`Malformed mons array for '${parsed.baseLabel}'`);

  // 4) The slotIndex-th `{ … }` element of the array.
  let i = monsOpen + 1;
  let count = 0;
  let elemStart = -1;
  let elemEnd = -1;
  while (i < monsClose) {
    if (text[i] === '{') {
      const close = matchBracket(text, i, '{', '}');
      if (close === -1) break;
      if (count === slotIndex) {
        elemStart = i;
        elemEnd = close;
        break;
      }
      count += 1;
      i = close + 1;
    } else {
      i += 1;
    }
  }
  if (elemStart < 0) {
    throw new Error(`Slot ${slotIndex} not found in ${tableId} (has ${count} slots)`);
  }

  // 5) Splice the requested fields inside that element only.
  const before = text.slice(elemStart, elemEnd + 1);
  let elem = before;
  const setNum = (e: string, field: string, val: number): string =>
    e.replace(new RegExp(`("${field}"\\s*:\\s*)-?\\d+`), `$1${String(val)}`);
  const setStr = (e: string, field: string, val: string): string =>
    e.replace(new RegExp(`("${field}"\\s*:\\s*")[^"]*(")`), `$1${val}$2`);
  if (edit.minLevel !== undefined) elem = setNum(elem, 'min_level', edit.minLevel);
  if (edit.maxLevel !== undefined) elem = setNum(elem, 'max_level', edit.maxLevel);
  if (edit.speciesId !== undefined) elem = setStr(elem, 'species', edit.speciesId);

  if (elem === before) return { before, after: elem }; // nothing changed
  const next = text.slice(0, elemStart) + elem + text.slice(elemEnd + 1);
  const tmp = `${abs}.tmp`;
  await fsp.writeFile(tmp, next, 'utf8');
  await fsp.rename(tmp, abs);
  return { before, after: elem };
}
