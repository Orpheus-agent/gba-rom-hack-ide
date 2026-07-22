import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { addTalkScript, addTrainerNpcScript } from './decomp-scripts.js';

describe('decomp-scripts', () => {
  let dir: string;
  const sourceDir = 'data/maps/PalletTown';

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'rom-editor-scripts-'));
    mkdirSync(path.join(dir, sourceDir), { recursive: true });
    mkdirSync(path.join(dir, 'src', 'data'), { recursive: true });
    mkdirSync(path.join(dir, 'include', 'constants'), { recursive: true });
    writeFileSync(path.join(dir, sourceDir, 'scripts.inc'), 'PalletTown_EventScript_Existing::\n\tend\n');
    writeFileSync(path.join(dir, 'src', 'data', 'trainers.party'), '=== TRAINER_NONE ===\nName: None\n');
    writeFileSync(
      path.join(dir, 'include', 'constants', 'opponents.h'),
      'enum TrainerID\n{\n    TRAINER_NONE,\n    TRAINER_YOUNGSTER_BEN,\n    TRAINERS_COUNT,\n\n    // Special Trainer Ids.\n    TRAINER_EREADER = 1021,\n};\n',
    );
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('addTalkScript generates a msgbox script + text and returns the label', async () => {
    const r = await addTalkScript(dir, sourceDir, 'New Guy', 'Hi "there"!');
    expect(r.scriptLabel).toBe('PalletTown_EventScript_NewGuy');
    const inc = readFileSync(path.join(dir, sourceDir, 'scripts.inc'), 'utf8');
    expect(inc).toContain('PalletTown_EventScript_NewGuy::');
    expect(inc).toContain('\tmsgbox PalletTown_Text_NewGuy, MSGBOX_NPC');
    expect(inc).toContain('PalletTown_Text_NewGuy::');
    // Quotes are stripped so the .string stays valid.
    expect(inc).toContain('.string "Hi there!$"');
    // Existing content preserved.
    expect(inc).toContain('PalletTown_EventScript_Existing::');
  });

  it('uniquifies the label when it already exists', async () => {
    await addTalkScript(dir, sourceDir, 'Guy', 'one');
    const r2 = await addTalkScript(dir, sourceDir, 'Guy', 'two');
    expect(r2.scriptLabel).toBe('PalletTown_EventScript_Guy2');
  });

  it('addTrainerNpcScript appends a trainers.party block + a trainerbattle script', async () => {
    const r = await addTrainerNpcScript(dir, sourceDir, {
      baseName: 'Rival Kid',
      trainerName: 'Joey',
      species: 'Pidgey',
      level: 7,
    });
    expect(r.trainerId).toBe('TRAINER_PALLET_TOWN_RIVAL_KID');
    expect(r.scriptLabel).toBe('PalletTown_EventScript_RivalKid');
    const party = readFileSync(path.join(dir, 'src', 'data', 'trainers.party'), 'utf8');
    expect(party).toContain('=== TRAINER_PALLET_TOWN_RIVAL_KID ===');
    expect(party).toContain('Name: Joey');
    expect(party).toContain('Class: Youngster');
    expect(party).toMatch(/Pidgey\nLevel: 7/);
    expect(party).toContain('=== TRAINER_NONE ==='); // existing preserved
    const inc = readFileSync(path.join(dir, sourceDir, 'scripts.inc'), 'utf8');
    expect(inc).toContain(
      '\ttrainerbattle_single TRAINER_PALLET_TOWN_RIVAL_KID, PalletTown_Text_RivalKidIntro, PalletTown_Text_RivalKidDefeat',
    );
    expect(inc).toContain('PalletTown_Text_RivalKidIntro::');
    // The constant MUST be declared in opponents.h or the build fails
    // ('TRAINER_X undeclared'). It goes in the normal block, above the specials.
    expect(party).toContain('Name: Joey');
    expect(r.constantAdded).toBe(true);
    const opp = readFileSync(path.join(dir, 'include', 'constants', 'opponents.h'), 'utf8');
    // MUST be a counted trainer (immediately before TRAINERS_COUNT), else its
    // gTrainers[][TRAINERS_COUNT] initializer index exceeds the array bounds.
    expect(opp).toMatch(/TRAINER_PALLET_TOWN_RIVAL_KID,\n\s*TRAINERS_COUNT,/);
  });

  it('caps the trainer name at TRAINER_NAME_LENGTH (10) so trainerName[] never overflows', async () => {
    await addTrainerNpcScript(dir, sourceDir, { baseName: 'Big', trainerName: 'Youngster Joey Junior' });
    const party = readFileSync(path.join(dir, 'src', 'data', 'trainers.party'), 'utf8');
    // "Youngster Joey Junior".slice(0,10).trim() === "Youngster"
    expect(party).toContain('Name: Youngster\n');
    for (const m of party.matchAll(/^Name: (.*)$/gm)) {
      expect(m[1]!.length).toBeLessThanOrEqual(10);
    }
  });
});
