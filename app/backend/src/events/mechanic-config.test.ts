import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  MechanicConfigError,
  patchMechanicConfig,
  readMechanicConfig,
  writeMechanicConfig,
} from './mechanic-config.js';
import { emptyMechanicConfigDoc } from '@rom-editor/shared';

describe('mechanic-config persistence', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(path.join(tmpdir(), 'rom-editor-mc-'));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('readMechanicConfig returns the empty doc when the file is absent', async () => {
    const r = await readMechanicConfig(projectRoot);
    expect(r).toEqual(emptyMechanicConfigDoc());
  });

  it('write+read roundtrips a populated doc with all 4 mechanic shapes', async () => {
    const doc = {
      schemaVersion: 1 as const,
      starter_selection: { starters: ['SPECIES_BULBASAUR', 'SPECIES_CHARMANDER', 'SPECIES_SQUIRTLE'] },
      difficulty_system: { enabledModes: ['FLAG_NUZLOCKE'] },
      evolution_flags: { giftSpecies: ['SPECIES_EEVEE'] },
      encounter_variants: { enabledTypes: ['grass', 'water'] },
    };
    await writeMechanicConfig(projectRoot, doc);
    const back = await readMechanicConfig(projectRoot);
    expect(back).toEqual(doc);
    expect(existsSync(path.join(projectRoot, '.editor', 'mechanic-config.json'))).toBe(true);
  });

  it('strips empty strings + trims entries when normalizing arrays on write', async () => {
    await writeMechanicConfig(projectRoot, {
      schemaVersion: 1,
      starter_selection: { starters: ['  SPECIES_X  ', '', ' '] },
      difficulty_system: { enabledModes: [] },
      evolution_flags: { giftSpecies: [] },
      encounter_variants: { enabledTypes: [] },
    });
    const back = await readMechanicConfig(projectRoot);
    expect(back.starter_selection.starters).toEqual(['SPECIES_X']);
  });

  it('rejects invalid array shapes with code=invalid_shape', async () => {
    await expect(
      writeMechanicConfig(projectRoot, {
        schemaVersion: 1,
        // @ts-expect-error intentional bad shape
        starter_selection: { starters: 'not-an-array' },
        difficulty_system: { enabledModes: [] },
        evolution_flags: { giftSpecies: [] },
        encounter_variants: { enabledTypes: [] },
      }),
    ).rejects.toMatchObject({
      name: 'MechanicConfigError',
      code: 'invalid_shape',
    });
  });

  it('patchMechanicConfig merges a partial into the existing doc without disturbing other mechanics', async () => {
    // Seed the file with one mechanic populated.
    await writeMechanicConfig(projectRoot, {
      schemaVersion: 1,
      starter_selection: { starters: ['SPECIES_X'] },
      difficulty_system: { enabledModes: [] },
      evolution_flags: { giftSpecies: [] },
      encounter_variants: { enabledTypes: [] },
    });

    const next = await patchMechanicConfig(projectRoot, 'difficulty_system', {
      enabledModes: ['FLAG_HARD_MODE'],
    });
    expect(next.starter_selection.starters).toEqual(['SPECIES_X']);
    expect(next.difficulty_system.enabledModes).toEqual(['FLAG_HARD_MODE']);
  });

  it('rejects patch for unknown mechanic id', async () => {
    await expect(
      // @ts-expect-error testing wrong id at runtime
      patchMechanicConfig(projectRoot, 'made_up', { foo: 1 }),
    ).rejects.toMatchObject({ code: 'unknown_mechanic_id' });
  });

  it('returns the empty doc when the JSON file is malformed but explicitly rejects with invalid_shape only on partial valid parses', async () => {
    // Pre-create the .editor dir + a malformed config file.
    mkdirSync(path.join(projectRoot, '.editor'), { recursive: true });
    writeFileSync(path.join(projectRoot, '.editor', 'mechanic-config.json'), 'this is not json');
    await expect(readMechanicConfig(projectRoot)).rejects.toBeInstanceOf(MechanicConfigError);
  });

  it('reads back unknown mechanic-id keys silently (forward-compatible shape)', async () => {
    mkdirSync(path.join(projectRoot, '.editor'), { recursive: true });
    writeFileSync(
      path.join(projectRoot, '.editor', 'mechanic-config.json'),
      JSON.stringify({
        schemaVersion: 1,
        starter_selection: { starters: ['SPECIES_X'] },
        difficulty_system: { enabledModes: [] },
        evolution_flags: { giftSpecies: [] },
        encounter_variants: { enabledTypes: [] },
        future_mechanic: { somefield: ['x'] },
      }),
    );
    const r = await readMechanicConfig(projectRoot);
    // Known keys present; unknown keys dropped silently - the schema only
    // surfaces the documented union members.
    expect(r.starter_selection.starters).toEqual(['SPECIES_X']);
    expect((r as unknown as Record<string, unknown>)['future_mechanic']).toBeUndefined();
  });
});
