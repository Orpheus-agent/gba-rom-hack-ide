/**
 * Decomp Level-up Learnsets editor (Game Data engine, A3). Movesets live in
 * `src/data/pokemon/level_up_learnsets/gen_<N>.h` as
 *   static const struct LevelUpMove sBulbasaurLevelUpLearnset[] = {
 *       LEVEL_UP_MOVE( 1, MOVE_TACKLE), …, LEVEL_UP_END };
 * The active gen is chosen by `P_LVL_UP_LEARNSETS` in include/config/pokemon.h
 * (GEN_LATEST → the GEN_N in include/config/general.h). We parse that one file
 * and edit a single LEVEL_UP_MOVE entry's level / move IN PLACE so the rest of
 * the (large) file - comments, #if family guards, padding - is preserved.
 *
 * v1 edits existing entries (swap the move, change the level). Adding/removing
 * entries is a future enhancement (insert/delete with comma + LEVEL_UP_END
 * bookkeeping); for now that goes through the agent.
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { matchBracket } from './struct-block.js';

const LEARNSET_DIR = 'src/data/pokemon/level_up_learnsets';

/** Resolve the active learnset gen file from the project's config. */
export async function activeLearnsetFile(projectRoot: string): Promise<string> {
  const dir = path.join(projectRoot, LEARNSET_DIR);
  let gen = 9;
  try {
    const cfg = await fsp.readFile(path.join(projectRoot, 'include/config/pokemon.h'), 'utf8');
    const m = /#define\s+P_LVL_UP_LEARNSETS\s+(GEN_\w+)/.exec(cfg);
    if (m) {
      if (m[1] === 'GEN_LATEST') {
        const gen2 = await fsp
          .readFile(path.join(projectRoot, 'include/config/general.h'), 'utf8')
          .catch(() => '');
        const lm = /#define\s+GEN_LATEST\s+GEN_(\d+)/.exec(gen2);
        if (lm) gen = Number.parseInt(lm[1]!, 10);
      } else {
        const dm = /GEN_(\d+)/.exec(m[1]!);
        if (dm) gen = Number.parseInt(dm[1]!, 10);
      }
    }
  } catch {
    // config absent - fall through to the directory scan below.
  }
  const candidate = path.join(dir, `gen_${String(gen)}.h`);
  try {
    await fsp.access(candidate);
    return candidate;
  } catch {
    // Resolved gen file missing - pick the highest gen_N.h present.
    try {
      const files = await fsp.readdir(dir);
      const gens = files
        .map((f) => /^gen_(\d+)\.h$/.exec(f))
        .filter((x): x is RegExpExecArray => x !== null)
        .map((x) => Number.parseInt(x[1]!, 10))
        .sort((a, b) => b - a);
      if (gens.length > 0) return path.join(dir, `gen_${String(gens[0])}.h`);
    } catch {
      /* fall through */
    }
    return candidate;
  }
}

export interface LearnsetMoveEntry {
  level: number;
  move: string; // MOVE_* constant
}

export interface Learnset {
  id: string; // symbol, e.g. sBulbasaurLevelUpLearnset
  name: string; // friendly, e.g. "Bulbasaur"
  moves: LearnsetMoveEntry[];
}

const ARRAY_RE = /static\s+const\s+struct\s+LevelUpMove\s+(s\w+LevelUpLearnset)\s*\[\]\s*=\s*\{/g;
const ENTRY_RE = /LEVEL_UP_MOVE\(\s*(\d+)\s*,\s*(MOVE_\w+)\s*\)/g;

function prettyLearnset(symbol: string): string {
  return symbol
    .replace(/^s/, '')
    .replace(/LevelUpLearnset$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim();
}

export async function readLearnsets(projectRoot: string): Promise<Learnset[]> {
  const file = await activeLearnsetFile(projectRoot);
  const text = await fsp.readFile(file, 'utf8').catch(() => '');
  const out: Learnset[] = [];
  ARRAY_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ARRAY_RE.exec(text)) !== null) {
    const open = m.index + m[0].length - 1;
    const close = matchBracket(text, open, '{', '}');
    if (close === -1) continue;
    const body = text.slice(open + 1, close);
    const moves: LearnsetMoveEntry[] = [];
    ENTRY_RE.lastIndex = 0;
    let e: RegExpExecArray | null;
    while ((e = ENTRY_RE.exec(body)) !== null) {
      moves.push({ level: Number.parseInt(e[1]!, 10), move: e[2]! });
    }
    out.push({ id: m[1]!, name: prettyLearnset(m[1]!), moves });
    ARRAY_RE.lastIndex = close;
  }
  return out;
}

export interface LearnsetEntryEdit {
  level?: number;
  move?: string;
}

export interface LearnsetEditResult {
  readonly before: string;
  readonly after: string;
}

export async function editLearnsetMove(
  projectRoot: string,
  learnsetId: string,
  entryIndex: number,
  edit: LearnsetEntryEdit,
): Promise<LearnsetEditResult> {
  const file = await activeLearnsetFile(projectRoot);
  const text = await fsp.readFile(file, 'utf8');
  const arrRe = new RegExp(
    `static\\s+const\\s+struct\\s+LevelUpMove\\s+${learnsetId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\[\\]\\s*=\\s*\\{`,
  );
  const m = arrRe.exec(text);
  if (!m) throw new Error(`Learnset ${learnsetId} not found`);
  const open = m.index + m[0].length - 1;
  const close = matchBracket(text, open, '{', '}');
  if (close === -1) throw new Error(`Malformed learnset ${learnsetId}`);

  // Find the entryIndex-th LEVEL_UP_MOVE within the array body.
  const bodyStart = open + 1;
  const entryRe = /LEVEL_UP_MOVE\(\s*(\d+)\s*,\s*(MOVE_\w+)\s*\)/g;
  entryRe.lastIndex = 0;
  let count = 0;
  let target: RegExpExecArray | null = null;
  let e: RegExpExecArray | null;
  const body = text.slice(bodyStart, close);
  while ((e = entryRe.exec(body)) !== null) {
    if (count === entryIndex) {
      target = e;
      break;
    }
    count += 1;
  }
  if (!target) throw new Error(`Entry ${entryIndex} not found in ${learnsetId} (has ${count})`);

  const callStart = bodyStart + target.index;
  const callEnd = callStart + target[0].length; // exclusive
  const before = text.slice(callStart, callEnd);
  let call = before;
  if (edit.level !== undefined) {
    call = call.replace(/(\(\s*)\d+/, `$1${String(edit.level)}`);
  }
  if (edit.move !== undefined) {
    call = call.replace(/MOVE_\w+/, edit.move);
  }
  if (call === before) return { before, after: call };
  const next = text.slice(0, callStart) + call + text.slice(callEnd);
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, next, 'utf8');
  await fsp.rename(tmp, file);
  return { before, after: call };
}
