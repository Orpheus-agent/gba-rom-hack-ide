import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { Trainer, TrainerPartyMember } from '@rom-editor/shared';

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, '');
}

/** Walks `source` starting at `openIndex` (which must point to a `{`), returns
 *  the index immediately AFTER the matching `}`. Returns -1 if unbalanced. */
function findMatchingBrace(source: string, openIndex: number): number {
  if (source[openIndex] !== '{') return -1;
  let depth = 0;
  for (let i = openIndex; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

interface Block {
  readonly id: string;
  readonly body: string;
}

function extractBlocks(source: string, startRe: RegExp): Block[] {
  const blocks: Block[] = [];
  startRe.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = startRe.exec(source)) !== null) {
    const id = m[1];
    if (!id) continue;
    const openBrace = source.indexOf('{', m.index);
    if (openBrace === -1) continue;
    const after = findMatchingBrace(source, openBrace);
    if (after === -1) continue;
    blocks.push({ id, body: source.slice(openBrace + 1, after - 1) });
    startRe.lastIndex = after;
  }
  return blocks;
}

const TRAINER_BLOCK_RE = /\[\s*(TRAINER_[A-Za-z0-9_]+)\s*\]\s*=\s*(?=\{)/g;
// Match all party-array struct variants pokeemerald uses:
//   struct TrainerMon
//   struct TrainerMonItemDefaultMoves
//   struct TrainerMonNoItemCustomMoves
//   struct TrainerMonItemCustomMoves
//   (and forks that add their own variants)
const PARTY_BLOCK_RE =
  /(?:static\s+)?const\s+struct\s+TrainerMon[A-Za-z0-9_]*\s+(sParty_[A-Za-z0-9_]+)\s*\[\s*\]\s*=\s*(?=\{)/g;

const FIELD_CLASS = /\.\s*trainerClass\s*=\s*([A-Za-z0-9_]+)/;
const FIELD_NAME = /\.\s*trainerName\s*=\s*_\("([^"]*)"\)/;
const FIELD_AI = /\.\s*aiFlags\s*=\s*([^,\n]+)/;
const FIELD_DOUBLE = /\.\s*doubleBattle\s*=\s*(TRUE|FALSE)/;
const FIELD_PARTY_REF = /(sParty_[A-Za-z0-9_]+)/;

function parseAiFlags(raw: string): string[] {
  const cleaned = raw.replace(/\s+/g, '').replace(/\((.*)\)/, '$1');
  if (cleaned === '0' || cleaned === '') return [];
  return cleaned.split('|').filter((s) => s.length > 0);
}

interface RawTrainer {
  readonly id: string;
  readonly trainerClass: string | null;
  readonly name: string | null;
  readonly aiFlags: ReadonlyArray<string>;
  readonly doubleBattle: boolean;
  readonly partyVar: string | null;
}

function parseTrainerBody(id: string, body: string): RawTrainer {
  const classMatch = FIELD_CLASS.exec(body);
  const nameMatch = FIELD_NAME.exec(body);
  const aiMatch = FIELD_AI.exec(body);
  const doubleMatch = FIELD_DOUBLE.exec(body);
  const partyMatch = FIELD_PARTY_REF.exec(body);
  return {
    id,
    trainerClass: classMatch?.[1] ?? null,
    name: nameMatch?.[1] ?? null,
    aiFlags: aiMatch?.[1] ? parseAiFlags(aiMatch[1]) : [],
    doubleBattle: doubleMatch?.[1] === 'TRUE',
    partyVar: partyMatch?.[1] ?? null,
  };
}

const MON_FIELD_SPECIES = /\.\s*species\s*=\s*([A-Za-z0-9_]+)/;
const MON_FIELD_LVL = /\.\s*lvl\s*=\s*(\d+)/;
const MON_FIELD_LEVEL = /\.\s*level\s*=\s*(\d+)/;
const MON_FIELD_HELD = /\.\s*heldItem\s*=\s*([A-Za-z0-9_]+)/;
const MON_FIELD_MOVES = /\.\s*moves\s*=\s*\{([^}]*)\}/;

function parsePartyBody(body: string): TrainerPartyMember[] {
  // Each mon is wrapped in its own `{ ... }` at depth 1; pull them out by
  // brace-balancing from the body.
  const mons: TrainerPartyMember[] = [];
  let i = 0;
  while (i < body.length) {
    const open = body.indexOf('{', i);
    if (open === -1) break;
    const after = findMatchingBrace(body, open);
    if (after === -1) break;
    const monBody = body.slice(open + 1, after - 1);
    const species = MON_FIELD_SPECIES.exec(monBody)?.[1];
    const lvlText = MON_FIELD_LVL.exec(monBody)?.[1] ?? MON_FIELD_LEVEL.exec(monBody)?.[1];
    if (species && lvlText) {
      const heldItem = MON_FIELD_HELD.exec(monBody)?.[1] ?? null;
      const movesRaw = MON_FIELD_MOVES.exec(monBody)?.[1];
      const moveIds = movesRaw
        ? movesRaw
            .split(',')
            .map((s) => s.trim())
            .filter((s) => /^MOVE_[A-Z0-9_]+$/.test(s))
        : [];
      const heldItemId = heldItem && heldItem !== 'ITEM_NONE' ? heldItem : null;
      mons.push({
        speciesId: species,
        level: Number.parseInt(lvlText, 10),
        moveIds,
        heldItemId,
      });
    }
    i = after;
  }
  return mons;
}

export interface TrainersExtract {
  readonly trainers: ReadonlyArray<Trainer>;
  readonly warnings: ReadonlyArray<string>;
}

export function extractTrainers(trainersSource: string, partiesSource: string): TrainersExtract {
  const trainersClean = stripComments(trainersSource);
  const partiesClean = stripComments(partiesSource);
  const warnings: string[] = [];

  const trainerBlocks = extractBlocks(trainersClean, TRAINER_BLOCK_RE);
  const partyBlocks = extractBlocks(partiesClean, PARTY_BLOCK_RE);

  const partyByVar = new Map<string, ReadonlyArray<TrainerPartyMember>>();
  for (const b of partyBlocks) {
    partyByVar.set(b.id, parsePartyBody(b.body));
  }

  const trainers: Trainer[] = [];
  for (const tb of trainerBlocks) {
    const raw = parseTrainerBody(tb.id, tb.body);
    let party: ReadonlyArray<TrainerPartyMember> = [];
    if (raw.partyVar) {
      const parsed = partyByVar.get(raw.partyVar);
      if (parsed) {
        party = parsed;
      } else if (raw.id !== 'TRAINER_NONE') {
        warnings.push(
          `Trainer ${raw.id} references party variable ${raw.partyVar} which was not found in trainer_parties.h.`,
        );
      }
    }
    trainers.push({
      id: raw.id,
      name: raw.name && raw.name.length > 0 ? raw.name : raw.id,
      className: raw.trainerClass ?? 'TRAINER_CLASS_UNKNOWN',
      party,
      aiFlags: raw.aiFlags,
      mapId: null,
    });
  }

  trainers.sort((a, b) => a.id.localeCompare(b.id));
  return { trainers, warnings };
}

async function tryReadFile(p: string): Promise<string | null> {
  try {
    return await fsp.readFile(p, 'utf8');
  } catch {
    return null;
  }
}

export interface TrainersResult {
  readonly trainers: ReadonlyArray<Trainer>;
  readonly warnings: ReadonlyArray<string>;
}

export async function parseTrainers(projectRoot: string): Promise<TrainersResult> {
  const trainersPath = path.join(projectRoot, 'src', 'data', 'trainers.h');
  const partiesPath = path.join(projectRoot, 'src', 'data', 'trainer_parties.h');
  const warnings: string[] = [];

  const trainersSrc = await tryReadFile(trainersPath);
  const partiesSrc = await tryReadFile(partiesPath);

  if (!trainersSrc) {
    warnings.push(`No src/data/trainers.h at ${trainersPath} - trainers will not be indexed.`);
    return { trainers: [], warnings };
  }
  if (!partiesSrc) {
    warnings.push(
      `No src/data/trainer_parties.h at ${partiesPath} - trainer parties will be empty.`,
    );
  }

  const result = extractTrainers(trainersSrc, partiesSrc ?? '');
  return {
    trainers: result.trainers,
    warnings: [...warnings, ...result.warnings],
  };
}
