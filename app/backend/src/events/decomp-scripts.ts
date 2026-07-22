/**
 * Decomp script creation - generate + append event scripts (and their text) to
 * a map's `data/maps/<Map>/scripts.inc`, and append new trainers to
 * `src/data/trainers.party`. This is what makes a freshly-added NPC actually DO
 * something (talk / battle) on a decomp project - the binary path's
 * propose_add_script_for_trainer relocates bytecode in .gba free space; decomp
 * keeps scripts as assembler source, so creation is a structured text append.
 *
 * Labels follow the map's existing convention `<MapDir>_EventScript_<Part>` /
 * `<MapDir>_Text_<Part>`. Text uses the standard `Label::\n\t.string "…$"`.
 * Appended at the end of the file - assembler label resolution is
 * order-independent, so the rest of the file is untouched (clean diff).
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';

function mapPrefix(sourceDir: string): string {
  return path.basename(sourceDir);
}

/** Turn free text into a CamelCase identifier fragment (`"new guy" → "NewGuy"`). */
function labelPart(s: string): string {
  const parts = s.replace(/[^A-Za-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
  const camel = parts.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('');
  return /^[A-Za-z]/.test(camel) ? camel : `Npc${camel}`;
}

/** Escape a user string for a single `.string "…$"` line. */
function gameString(s: string): string {
  return s.replace(/[\\"]/g, '').replace(/[\r\n]+/g, ' ').trim() || '...';
}

async function readOrEmpty(abs: string): Promise<string> {
  try {
    return await fsp.readFile(abs, 'utf8');
  } catch {
    return '';
  }
}

async function appendAtomic(abs: string, text: string): Promise<{ before: string; after: string }> {
  const before = await readOrEmpty(abs);
  const sep = before.length === 0 || before.endsWith('\n') ? '' : '\n';
  const after = before + sep + text;
  const tmp = `${abs}.tmp`;
  await fsp.writeFile(tmp, after, 'utf8');
  await fsp.rename(tmp, abs);
  return { before, after };
}

const OPPONENTS_REL = 'include/constants/opponents.h';

/** Declare a new `TRAINER_*` constant in the `enum TrainerID` in
 *  include/constants/opponents.h. trainers.party REFERENCES these constants - 
 *  it does not create them - so every new `=== TRAINER_X ===` block needs a
 *  matching enum member or the generated gTrainers C fails to compile
 *  ("'TRAINER_X' undeclared"). Inserts just before the first explicitly-valued
 *  trainer (the high specials like `TRAINER_EREADER = 1021`) so the new entry
 *  takes the next sequential id. Idempotent. */
export async function declareTrainerConstant(
  projectRoot: string,
  trainerId: string,
): Promise<{ added: boolean; before: string; after: string }> {
  const abs = path.join(projectRoot, OPPONENTS_REL);
  const before = await readOrEmpty(abs);
  if (!before) return { added: false, before, after: before };
  if (new RegExp(`\\b${trainerId}\\b`).test(before)) {
    return { added: false, before, after: before };
  }
  const lines = before.split(/\r?\n/);
  // Insert just BEFORE the `TRAINERS_COUNT,` sentinel: gTrainers is sized
  // [DIFFICULTY_COUNT][TRAINERS_COUNT], so the new trainer must be counted (get
  // an id < TRAINERS_COUNT) or its gTrainers initializer exceeds the array
  // bounds. The sentinel also sits before the explicitly-valued specials, so
  // this is the one correct spot. Fall back to the first `= …` trainer / `};`.
  let insertAt = lines.findIndex((l) => /^\s*TRAINERS_COUNT\s*,?\s*$/.test(l));
  if (insertAt === -1) insertAt = lines.findIndex((l) => /^\s*TRAINER_\w+\s*=/.test(l));
  if (insertAt === -1) insertAt = lines.findIndex((l) => /^\};/.test(l));
  if (insertAt === -1) return { added: false, before, after: before };
  lines.splice(insertAt, 0, `    ${trainerId},`);
  const after = lines.join('\n');
  const tmp = `${abs}.tmp`;
  await fsp.writeFile(tmp, after, 'utf8');
  await fsp.rename(tmp, abs);
  return { added: true, before, after };
}

/** Pick a `<Part>` such that `<prefix>_EventScript_<Part>` is unused. */
function uniquePart(scriptsText: string, prefix: string, basePart: string): string {
  let part = basePart;
  let i = 2;
  while (scriptsText.includes(`${prefix}_EventScript_${part}::`)) {
    part = `${basePart}${String(i)}`;
    i += 1;
  }
  return part;
}

export interface TalkScriptResult {
  readonly scriptLabel: string;
  readonly before: string;
  readonly after: string;
}

/** Append a "lock / faceplayer / msgbox / release / end" talk script + its
 *  text to the map's scripts.inc. Returns the new script label to bind to an
 *  object event's `script` field. */
export async function addTalkScript(
  projectRoot: string,
  sourceDir: string,
  baseName: string,
  message: string,
): Promise<TalkScriptResult> {
  const abs = path.join(projectRoot, sourceDir, 'scripts.inc');
  const existing = await readOrEmpty(abs);
  const prefix = mapPrefix(sourceDir);
  const part = uniquePart(existing, prefix, labelPart(baseName));
  const scriptLabel = `${prefix}_EventScript_${part}`;
  const textLabel = `${prefix}_Text_${part}`;
  const block =
    `\n${scriptLabel}::\n` +
    `\tlock\n\tfaceplayer\n` +
    `\tmsgbox ${textLabel}, MSGBOX_NPC\n` +
    `\trelease\n\tend\n\n` +
    `${textLabel}::\n\t.string "${gameString(message)}$"\n`;
  const { before, after } = await appendAtomic(abs, block);
  return { scriptLabel, before, after };
}

export interface TrainerScriptResult {
  readonly scriptLabel: string;
  readonly trainerId: string;
  readonly constantAdded: boolean;
  readonly scriptsBefore: string;
  readonly scriptsAfter: string;
  readonly partyBefore: string;
  readonly partyAfter: string;
}

export interface AddTrainerOptions {
  baseName: string;
  trainerName?: string;
  species?: string;
  level?: number;
  intro?: string;
  defeat?: string;
  postBattle?: string;
}

/** Append a new trainer to trainers.party (default 1-mon team, valid generic
 *  Class/Pic/Music) AND a `trainerbattle_single` script + its 3 text labels to
 *  the map's scripts.inc. Returns the trainerId + script label to bind. */
export async function addTrainerNpcScript(
  projectRoot: string,
  sourceDir: string,
  opts: AddTrainerOptions,
): Promise<TrainerScriptResult> {
  const prefix = mapPrefix(sourceDir);
  const upper = (s: string): string =>
    s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[^A-Za-z0-9]+/g, '_').toUpperCase().replace(/^_+|_+$/g, '');

  // 1) trainers.party - claim a unique TRAINER_* id.
  const partyAbs = path.join(projectRoot, 'src', 'data', 'trainers.party');
  const partyText = await readOrEmpty(partyAbs);
  const baseId = `TRAINER_${upper(prefix)}_${upper(labelPart(opts.baseName))}`;
  let trainerId = baseId;
  let n = 2;
  while (partyText.includes(`=== ${trainerId} ===`)) {
    trainerId = `${baseId}_${String(n)}`;
    n += 1;
  }
  const species = (opts.species ?? '').trim() || 'Rattata';
  const level = opts.level ?? 5;
  // Trainer names are capped at TRAINER_NAME_LENGTH (10 in FRLG/Emerald);
  // trainerName[] is [LENGTH + 1], so an over-length name overflows the array
  // ("excess elements in array initializer"). Trim trailing space from the cut.
  const trainerName = ((opts.trainerName ?? 'Trainer').slice(0, 10).trim() || 'Trainer');
  const trainerBlock =
    `\n=== ${trainerId} ===\n` +
    `Name: ${trainerName}\n` +
    `Class: Youngster\nPic: Youngster\nGender: Male\nMusic: Male\nDouble Battle: No\nAI: Basic Trainer\n\n` +
    `${species}\nLevel: ${String(level)}\n`;
  const party = await appendAtomic(partyAbs, trainerBlock);

  // 1b) Declare the constant in opponents.h - trainers.party references it.
  const constant = await declareTrainerConstant(projectRoot, trainerId);

  // 2) scripts.inc - trainerbattle script + intro/defeat/post text.
  const scriptsAbs = path.join(projectRoot, sourceDir, 'scripts.inc');
  const existing = await readOrEmpty(scriptsAbs);
  const part = uniquePart(existing, prefix, labelPart(opts.baseName));
  const scriptLabel = `${prefix}_EventScript_${part}`;
  const introLabel = `${prefix}_Text_${part}Intro`;
  const defeatLabel = `${prefix}_Text_${part}Defeat`;
  const postLabel = `${prefix}_Text_${part}PostBattle`;
  const block =
    `\n${scriptLabel}::\n` +
    `\ttrainerbattle_single ${trainerId}, ${introLabel}, ${defeatLabel}\n` +
    `\tmsgbox ${postLabel}, MSGBOX_AUTOCLOSE\n\tend\n\n` +
    `${introLabel}::\n\t.string "${gameString(opts.intro ?? "Let's battle!")}$"\n\n` +
    `${defeatLabel}::\n\t.string "${gameString(opts.defeat ?? 'You won!')}$"\n\n` +
    `${postLabel}::\n\t.string "${gameString(opts.postBattle ?? 'That was a great battle!')}$"\n`;
  const scripts = await appendAtomic(scriptsAbs, block);

  return {
    scriptLabel,
    trainerId,
    constantAdded: constant.added,
    scriptsBefore: scripts.before,
    scriptsAfter: scripts.after,
    partyBefore: party.before,
    partyAfter: party.after,
  };
}
