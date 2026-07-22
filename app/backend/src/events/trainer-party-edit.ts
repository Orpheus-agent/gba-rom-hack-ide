/**
 * Decomp trainer-party editing for expansion `.party` projects.
 *
 *  - resolveTrainerIdFromScripts(): NPC object-event has a script label
 *    (e.g. "Route3_EventScript_Ben"); the trainer it battles is named in
 *    that script via a `trainerbattle*` macro → TRAINER_*. We read the
 *    map's `scripts.inc`/`.pory` and pull the constant out.
 *  - getTrainerParty(): parse the trainer's block from trainers.party.
 *  - editTrainerParty(): re-serialize the (edited) block and splice it
 *    back into src/data/trainers.party atomically, preserving every other
 *    trainer untouched. Returns before/after text for the op-log.
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import {
  readTrainersParty,
  serializeTrainer,
  type PartyTrainer,
} from '../scan/trainers-party.js';

const TRAINERBATTLE_RE = /trainerbattle\w*\s+(TRAINER_[A-Za-z0-9_]+)/;

async function tryRead(p: string): Promise<string | null> {
  try {
    return await fsp.readFile(p, 'utf8');
  } catch {
    return null;
  }
}

/** Derive the map-dir prefix from a script label: "Route3_EventScript_Ben" → "Route3". */
function dirFromScriptLabel(label: string): string | null {
  const m = /^([A-Za-z0-9]+?)_(?:EventScript|Script|Text|Movement|MapScript)/.exec(label);
  return m?.[1] ?? null;
}

/** Read a script source, find the label's block, return the first TRAINER_* it battles. */
function trainerInScriptBody(source: string, scriptLabel: string): string | null {
  // Find `Label:` or `Label::` and read until the next top-level label / EOF.
  const labelRe = new RegExp(`^${scriptLabel}::?\\s*$`, 'm');
  const m = labelRe.exec(source);
  if (!m) return null;
  const start = m.index + m[0].length;
  // Next label line (`SomethingElse:` at column 0) bounds the block.
  const rest = source.slice(start);
  const nextLabel = /^\w+::?\s*$/m.exec(rest);
  const body = nextLabel ? rest.slice(0, nextLabel.index) : rest;
  const tb = TRAINERBATTLE_RE.exec(body);
  return tb?.[1] ?? null;
}

export interface ResolveOptions {
  /** The map's source dir relative to projectRoot, e.g. "data/maps/Route3". */
  readonly mapSourceDir?: string | null;
}

/** Resolve the TRAINER_* id an NPC battles, from its script label. */
export async function resolveTrainerIdFromScripts(
  projectRoot: string,
  scriptLabel: string,
  options: ResolveOptions = {},
): Promise<string | null> {
  const candidates: string[] = [];
  // Expansions centralize trainer-battle scripts under data/scripts/ (e.g.
  // data/scripts/trainers.inc) - check those first.
  const scriptsDir = path.join(projectRoot, 'data', 'scripts');
  try {
    for (const f of await fsp.readdir(scriptsDir)) {
      if (f.endsWith('.inc') || f.endsWith('.pory')) candidates.push(path.join(scriptsDir, f));
    }
  } catch {
    /* no data/scripts dir */
  }
  // The map's own script files (decomp uses scripts.inc/events.inc/scripts.pory).
  const mapDirs = new Set<string>();
  if (options.mapSourceDir) mapDirs.add(path.join(projectRoot, options.mapSourceDir));
  const derived = dirFromScriptLabel(scriptLabel);
  if (derived) mapDirs.add(path.join(projectRoot, 'data', 'maps', derived));
  for (const d of mapDirs) {
    for (const fname of ['scripts.inc', 'events.inc', 'scripts.pory']) {
      candidates.push(path.join(d, fname));
    }
  }
  for (const file of candidates) {
    const src = await tryRead(file);
    if (src && src.includes(scriptLabel)) {
      const id = trainerInScriptBody(src, scriptLabel);
      if (id) return id;
    }
  }

  // Fallback: scan every map's script files for the label.
  const mapsDir = path.join(projectRoot, 'data', 'maps');
  let dirents: string[] = [];
  try {
    dirents = await fsp.readdir(mapsDir);
  } catch {
    return null;
  }
  for (const dir of dirents) {
    for (const fname of ['scripts.inc', 'events.inc', 'scripts.pory']) {
      const src = await tryRead(path.join(mapsDir, dir, fname));
      if (src && src.includes(scriptLabel)) {
        const id = trainerInScriptBody(src, scriptLabel);
        if (id) return id;
      }
    }
  }
  return null;
}

export async function getTrainerParty(
  projectRoot: string,
  trainerId: string,
): Promise<PartyTrainer | null> {
  const { byId } = await readTrainersParty(projectRoot);
  return byId.get(trainerId) ?? null;
}

/** Replace the `=== TRAINER_X ===` block in `source` with `newBlock`. */
function spliceTrainerBlock(source: string, trainerId: string, newBlock: string): string | null {
  const lines = source.split('\n');
  const headerRe = new RegExp(`^===\\s*${trainerId}\\s*===\\s*$`);
  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (headerRe.test(lines[i]!)) {
      startIdx = i;
      break;
    }
  }
  if (startIdx === -1) return null;
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (/^===\s*TRAINER_[A-Za-z0-9_]+\s*===\s*$/.test(lines[i]!)) {
      endIdx = i;
      break;
    }
  }
  // Preserve trailing blank lines that separated this block from the next.
  const tail = endIdx;
  const newLines = newBlock.split('\n');
  // Keep exactly one blank line before the next `===` block if there was one.
  const before = lines.slice(0, startIdx);
  const after = lines.slice(tail);
  const needsGap = after.length > 0 && after[0]!.trim() !== '';
  const merged = [...before, ...newLines, ...(needsGap ? [''] : []), ...after];
  return merged.join('\n');
}

export interface EditTrainerPartyResult {
  readonly sourcePath: string;
  readonly trainerId: string;
  readonly before: string;
  readonly after: string;
}

/**
 * Persist an edited party for `trainerId` into src/data/trainers.party.
 * `editedParty` is the new party list; header/name/class are preserved
 * from the on-disk trainer.
 */
export async function editTrainerParty(
  projectRoot: string,
  trainerId: string,
  editedParty: PartyTrainer['party'],
): Promise<EditTrainerPartyResult> {
  const sourcePath = path.join(projectRoot, 'src', 'data', 'trainers.party');
  const source = await fsp.readFile(sourcePath, 'utf8');
  const { byId } = await readTrainersParty(projectRoot);
  const existing = byId.get(trainerId);
  if (!existing) {
    throw new Error(`Trainer ${trainerId} not found in trainers.party`);
  }
  const edited: PartyTrainer = { ...existing, party: editedParty };
  const newBlock = serializeTrainer(edited);

  // Capture the old block text (for op-log before/after) by splicing twice.
  const oldBlockText = serializeTrainer(existing);
  const next = spliceTrainerBlock(source, trainerId, newBlock);
  if (next === null) {
    throw new Error(`Could not locate the ${trainerId} block to rewrite.`);
  }

  const tmp = `${sourcePath}.tmp`;
  await fsp.writeFile(tmp, next, 'utf8');
  await fsp.rename(tmp, sourcePath);

  return { sourcePath, trainerId, before: oldBlockText, after: newBlock };
}

/** Set or replace a `Key: Value` header line in a trainer's headerLines array. */
function setHeaderLine(headerLines: string[], key: string, value: string): string[] {
  const re = new RegExp(`^${key}:\\s`);
  const idx = headerLines.findIndex((l) => re.test(l));
  const line = `${key}: ${value}`;
  if (idx >= 0) {
    const next = [...headerLines];
    next[idx] = line;
    return next;
  }
  return [...headerLines, line];
}

export interface ReskinSpec {
  /** New display name (replaces the `Name:` header). Omit to keep. */
  readonly name?: string;
  /** New trainer class (must be an existing class). Omit to keep. */
  readonly className?: string;
  /** New trainer pic constant (must be valid). Omit to keep - safest. */
  readonly pic?: string;
  readonly party: PartyTrainer['party'];
}

/**
 * "Reskin" an EXISTING trainer slot: swap its party and optionally rename it,
 * reusing the slot id (zero net-new TRAINER_* → no trainer-flag cost). The
 * trainerbattle script keeps referencing the original `trainerId`. By default
 * only Name + party change; Class/Pic are preserved (changing Pic to an invalid
 * constant would break the build, so callers opt in explicitly).
 */
export async function reskinTrainer(
  projectRoot: string,
  trainerId: string,
  spec: ReskinSpec,
): Promise<EditTrainerPartyResult> {
  const sourcePath = path.join(projectRoot, 'src', 'data', 'trainers.party');
  const source = await fsp.readFile(sourcePath, 'utf8');
  const { byId } = await readTrainersParty(projectRoot);
  const existing = byId.get(trainerId);
  if (!existing) {
    throw new Error(`Trainer ${trainerId} not found in trainers.party`);
  }
  let headerLines = existing.headerLines;
  if (spec.name !== undefined) headerLines = setHeaderLine(headerLines, 'Name', spec.name);
  if (spec.className !== undefined) headerLines = setHeaderLine(headerLines, 'Class', spec.className);
  if (spec.pic !== undefined) headerLines = setHeaderLine(headerLines, 'Pic', spec.pic);
  const edited: PartyTrainer = {
    ...existing,
    name: spec.name ?? existing.name,
    className: spec.className ?? existing.className,
    headerLines,
    party: spec.party,
  };
  const newBlock = serializeTrainer(edited);
  const oldBlockText = serializeTrainer(existing);
  const next = spliceTrainerBlock(source, trainerId, newBlock);
  if (next === null) {
    throw new Error(`Could not locate the ${trainerId} block to rewrite.`);
  }
  const tmp = `${sourcePath}.tmp`;
  await fsp.writeFile(tmp, next, 'utf8');
  await fsp.rename(tmp, sourcePath);
  return { sourcePath, trainerId, before: oldBlockText, after: newBlock };
}
