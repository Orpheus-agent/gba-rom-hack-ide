/**
 * Parser + serializer for the modern rh-hideout `trainers.party` format
 * (used by pokeemerald-expansion / pokefirered-expansion, compiled by
 * `tools/trainerproc`). This is the human-readable SOURCE OF TRUTH for
 * trainers in expansion projects - unlike the old `trainers.h` /
 * `trainer_parties.h` C-struct format that `scan/trainers.ts` reads.
 *
 * Format (one trainer):
 *
 *   === TRAINER_YOUNGSTER_BEN ===
 *   Name: BEN
 *   Class: Youngster
 *   Pic: Youngster
 *   Gender: Male
 *   Music: Male
 *   Double Battle: No
 *   AI: Check Bad Move
 *
 *   Rattata
 *   Level: 11
 *   IVs: 0 HP / 0 Atk / 0 Def / 0 SpA / 0 SpD / 0 Spe
 *   - Tackle
 *   - Tail Whip
 *
 *   Ekans @ Oran Berry
 *   Level: 11
 *   Ability: Intimidate
 *   - Wrap
 *
 * Everything is plain names (no SPECIES_/MOVE_ constants), so the editor
 * round-trips names straight back to disk. We preserve any header/mon
 * key lines we don't explicitly model (`extraHeaderLines` / `mon.extraLines`)
 * so a save never drops data we didn't understand.
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';

export interface PartyMon {
  /** Species display name exactly as written, e.g. "Rattata", "Mr. Mime". */
  species: string;
  /** Held item display name from "Species @ Item", or null. */
  heldItem: string | null;
  level: number | null;
  /** Raw value text for IVs/EVs (preserved verbatim), or null if absent. */
  ivs: string | null;
  evs: string | null;
  ability: string | null;
  nature: string | null;
  /** Move display names, in order (the `- Move` lines). */
  moves: string[];
  /** Any other `Key: Value` lines on this mon we don't model - preserved. */
  extraLines: string[];
}

export interface PartyTrainer {
  /** The `TRAINER_*` id. */
  id: string;
  name: string | null;
  className: string | null;
  /** Raw header `Key: Value` lines (Name/Class/Pic/Gender/Music/AI/…). */
  headerLines: string[];
  party: PartyMon[];
}

const TRAINER_HEADER_RE = /^===\s*(TRAINER_[A-Za-z0-9_]+)\s*===\s*$/;
const KEY_VALUE_RE = /^([A-Za-z][A-Za-z0-9 _/]*?):\s*(.*)$/;
const MOVE_RE = /^-\s*(.+?)\s*$/;

function isBlank(line: string): boolean {
  return line.trim().length === 0;
}

/** Parse a held-item suffix: "Ekans @ Oran Berry" → ["Ekans", "Oran Berry"]. */
function splitHeldItem(speciesLine: string): { species: string; heldItem: string | null } {
  const at = speciesLine.indexOf(' @ ');
  if (at === -1) return { species: speciesLine.trim(), heldItem: null };
  return {
    species: speciesLine.slice(0, at).trim(),
    heldItem: speciesLine.slice(at + 3).trim() || null,
  };
}

/** Parse the whole file into trainers. Tolerant of CRLF and stray blank lines. */
export function parseTrainersParty(source: string): PartyTrainer[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const trainers: PartyTrainer[] = [];

  let current: PartyTrainer | null = null;
  let currentMon: PartyMon | null = null;
  let inHeader = false; // true while reading the trainer's header key lines

  const pushMon = (): void => {
    if (current && currentMon) current.party.push(currentMon);
    currentMon = null;
  };
  const pushTrainer = (): void => {
    pushMon();
    if (current) trainers.push(current);
    current = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, '');
    const headerMatch = TRAINER_HEADER_RE.exec(line);
    if (headerMatch) {
      pushTrainer();
      current = {
        id: headerMatch[1]!,
        name: null,
        className: null,
        headerLines: [],
        party: [],
      };
      currentMon = null;
      inHeader = true;
      continue;
    }
    if (!current) continue; // skip preamble before the first trainer

    if (isBlank(line)) {
      // Blank line ends the header (first blank) and separates mons.
      if (inHeader) inHeader = false;
      pushMon();
      continue;
    }

    if (inHeader) {
      const kv = KEY_VALUE_RE.exec(line);
      if (kv) {
        const key = kv[1]!.trim();
        const value = kv[2]!.trim();
        if (key === 'Name') current.name = value;
        else if (key === 'Class') current.className = value;
        current.headerLines.push(line.trim());
      } else {
        current.headerLines.push(line.trim());
      }
      continue;
    }

    // Mon body.
    const move = MOVE_RE.exec(line);
    if (move) {
      if (currentMon) currentMon.moves.push(move[1]!.trim());
      continue;
    }
    const kv = KEY_VALUE_RE.exec(line);
    if (kv && currentMon) {
      const key = kv[1]!.trim();
      const value = kv[2]!.trim();
      switch (key) {
        case 'Level':
          currentMon.level = Number.parseInt(value, 10);
          break;
        case 'IVs':
          currentMon.ivs = value;
          break;
        case 'EVs':
          currentMon.evs = value;
          break;
        case 'Ability':
          currentMon.ability = value;
          break;
        case 'Nature':
          currentMon.nature = value;
          break;
        default:
          currentMon.extraLines.push(line.trim());
      }
      continue;
    }

    // Otherwise this is a species header line starting a new mon.
    pushMon();
    const { species, heldItem } = splitHeldItem(line.trim());
    currentMon = {
      species,
      heldItem,
      level: null,
      ivs: null,
      evs: null,
      ability: null,
      nature: null,
      moves: [],
      extraLines: [],
    };
  }
  pushTrainer();
  return trainers;
}

/** Serialize one mon back to `.party` lines (order matches trainerproc input). */
export function serializeMon(mon: PartyMon): string[] {
  const out: string[] = [];
  out.push(mon.heldItem ? `${mon.species} @ ${mon.heldItem}` : mon.species);
  if (mon.level !== null && Number.isFinite(mon.level)) out.push(`Level: ${mon.level}`);
  if (mon.ability) out.push(`Ability: ${mon.ability}`);
  if (mon.ivs) out.push(`IVs: ${mon.ivs}`);
  if (mon.evs) out.push(`EVs: ${mon.evs}`);
  if (mon.nature) out.push(`Nature: ${mon.nature}`);
  for (const extra of mon.extraLines) out.push(extra);
  for (const mv of mon.moves) out.push(`- ${mv}`);
  return out;
}

/** Serialize a full trainer block (header + party) back to `.party` text. */
export function serializeTrainer(trainer: PartyTrainer): string {
  const out: string[] = [];
  out.push(`=== ${trainer.id} ===`);
  for (const h of trainer.headerLines) out.push(h);
  for (const mon of trainer.party) {
    out.push('');
    out.push(...serializeMon(mon));
  }
  return out.join('\n');
}

export interface TrainersPartyResult {
  readonly trainers: ReadonlyArray<PartyTrainer>;
  readonly byId: ReadonlyMap<string, PartyTrainer>;
  readonly sourcePath: string | null;
  readonly warnings: ReadonlyArray<string>;
}

/** Locate + read `src/data/trainers.party` and parse it. */
export async function readTrainersParty(projectRoot: string): Promise<TrainersPartyResult> {
  const sourcePath = path.join(projectRoot, 'src', 'data', 'trainers.party');
  let source: string;
  try {
    source = await fsp.readFile(sourcePath, 'utf8');
  } catch {
    return {
      trainers: [],
      byId: new Map(),
      sourcePath: null,
      warnings: [`No src/data/trainers.party at ${sourcePath} (not an expansion .party project).`],
    };
  }
  const trainers = parseTrainersParty(source);
  const byId = new Map(trainers.map((t) => [t.id, t] as const));
  return { trainers, byId, sourcePath, warnings: [] };
}
