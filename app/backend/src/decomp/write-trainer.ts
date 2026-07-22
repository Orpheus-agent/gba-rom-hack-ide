/**
 * Create a NEW decomp trainer: append a block to src/data/trainers.party and
 * declare its TRAINER_* constant before TRAINERS_COUNT in opponents.h.
 * Reuses serializeTrainer (scan/trainers-party.ts) and declareTrainerConstant
 * (events/decomp-scripts.ts). The existing editTrainerParty only mutates an
 * EXISTING block; this is the creation path the bulk xlsx import needs.
 *
 * Caller is responsible for the ≤25-net-new-trainer flag ceiling / Kanto-slot
 * reuse (see opponents.h TRAINER_FLAGS_END) - this writer does not police it.
 */
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { writeFileAtomic } from './decomp-write-util.js';
import { serializeTrainer, type PartyTrainer, type PartyMon } from '../scan/trainers-party.js';
import { declareTrainerConstant } from '../events/decomp-scripts.js';

export interface TrainerHeaderOpts {
  readonly name: string;
  readonly className: string; // e.g. "Youngster" - must be a valid TRAINER_CLASS display name
  readonly pic: string; // e.g. "Youngster"
  readonly gender: 'Male' | 'Female';
  readonly music: string; // encounter music type, e.g. "Male"
  readonly doubleBattle?: boolean;
  readonly ai?: string; // e.g. "Basic Trainer"
}

/** Assemble a PartyTrainer (header lines + party) from structured inputs. */
export function buildPartyTrainer(
  id: string,
  header: TrainerHeaderOpts,
  party: PartyMon[],
): PartyTrainer {
  const headerLines = [
    `Name: ${header.name}`,
    `Class: ${header.className}`,
    `Pic: ${header.pic}`,
    `Gender: ${header.gender}`,
    `Music: ${header.music}`,
    `Double Battle: ${header.doubleBattle ? 'Yes' : 'No'}`,
    `AI: ${header.ai ?? 'Basic Trainer'}`,
  ];
  return { id, name: header.name, className: header.className, headerLines, party };
}

export interface WriteTrainerResult {
  readonly id: string;
  readonly appended: boolean;
  readonly constantAdded: boolean;
}

export async function writeDecompTrainer(
  projectRoot: string,
  trainer: PartyTrainer,
): Promise<WriteTrainerResult> {
  const partyPath = path.join(projectRoot, 'src', 'data', 'trainers.party');
  const cur = await fsp.readFile(partyPath, 'utf8');
  let appended = false;
  if (!cur.includes(`=== ${trainer.id} ===`)) {
    const sep = cur.endsWith('\n') ? '\n' : '\n\n';
    await writeFileAtomic(partyPath, cur + sep + serializeTrainer(trainer) + '\n');
    appended = true;
  }
  const c = await declareTrainerConstant(projectRoot, trainer.id);
  return { id: trainer.id, appended, constantAdded: c.added };
}
