import { describe, it, expect } from 'vitest';
import type { ProjectManifest } from '@rom-editor/shared';
import { buildSpeciesLibrary, summarizeSpeciesLibrary } from './species-library.js';

function emptyManifest(projectRoot: string): ProjectManifest {
  return {
    schemaVersion: 1,
    generatedAtUtc: '2026-05-22T00:00:00.000Z',
    projectRoot,
    identity: {
      kind: 'patch',
      confidence: 1,
      displayName: 'Pokémon Test Hack',
      baseGame: 'firered',
      fork: null,
      featureFlags: [],
      warnings: [],
      evidence: [],
    },
    buildProfile: null,
    maps: [],
    warps: [],
    triggers: [],
    objectEvents: [],
    dialogue: [],
    flags: [],
    variables: [],
    encounterTables: [],
    trainers: [],
    scriptSteps: [],
    assets: [],
  };
}

describe('buildSpeciesLibrary', () => {
  it('returns empty library for a barebones manifest', () => {
    const lib = buildSpeciesLibrary(emptyManifest('/x'));
    expect(lib.species).toHaveLength(0);
    expect(lib.moveNames).toHaveLength(0);
    expect(lib.sourceDisplayName).toBe('Pokémon Test Hack');
    expect(lib.sourceProjectKind).toBe('patch');
  });

  it('denormalizes species + learnsets + evolutions + move names', () => {
    const m = emptyManifest('/x');
    const populated: ProjectManifest = {
      ...m,
      speciesNames: [
        { id: 'binary_species_name_1', speciesIndex: 1, name: 'BULBASAUR', sourceTableOffset: 0 },
        { id: 'binary_species_name_2', speciesIndex: 2, name: 'IVYSAUR', sourceTableOffset: 0 },
      ],
      species: [
        {
          id: 'binary_species_data_1',
          speciesIndex: 1,
          baseHP: 45, baseAttack: 49, baseDefense: 49, baseSpeed: 45, baseSpAttack: 65, baseSpDefense: 65,
          type1: 12, type2: 3, catchRate: 45, expYield: 64, item1: 0, item2: 0,
          genderRatio: 31, eggCycles: 20, friendship: 70, growthRate: 3,
          eggGroup1: 1, eggGroup2: 7, ability1: 65, ability2: 0,
          safariZoneFleeRate: 0, sourceFileOffset: 0,
          type1Name: 'GRASS', type2Name: 'POISON',
          ability1Name: 'OVERGROW',
        } as unknown as NonNullable<ProjectManifest['species']>[number],
      ],
      moveNames: [
        { id: 'binary_move_name_33', moveIndex: 33, name: 'TACKLE', sourceTableOffset: 0 },
        { id: 'binary_move_name_45', moveIndex: 45, name: 'GROWL', sourceTableOffset: 0 },
      ],
      speciesLearnsets: [
        {
          id: 'binary_species_learnset_1',
          speciesIndex: 1,
          arrayFileOffset: 0,
          pointerRaw: 0,
          pointerFileOffset: 0,
          moves: [
            { level: 1, move: 33 },
            { level: 4, move: 45 },
          ],
        } as unknown as NonNullable<ProjectManifest['speciesLearnsets']>[number],
      ],
      speciesEvolutions: [
        {
          id: 'binary_species_evo_1',
          speciesIndex: 1,
          slots: [{ method: 4, param: 16, targetSpecies: 2, fileOffset: 0, targetSpeciesName: 'IVYSAUR' }],
          sourceFileOffset: 0,
        } as unknown as NonNullable<ProjectManifest['speciesEvolutions']>[number],
      ],
    };
    const lib = buildSpeciesLibrary(populated);
    expect(lib.species.length).toBe(2); // species 1 (full data) + species 2 (only known via evolution target)
    const bulb = lib.species.find((s) => s.speciesIndex === 1);
    expect(bulb).toBeDefined();
    expect(bulb!.name).toBe('BULBASAUR');
    expect(bulb!.baseStats?.hp).toBe(45);
    expect(bulb!.type1Name).toBe('GRASS');
    expect(bulb!.type2Name).toBe('POISON');
    expect(bulb!.ability1Name).toBe('OVERGROW');
    expect(bulb!.learnset).toEqual([
      { level: 1, moveIndex: 33, moveName: 'TACKLE' },
      { level: 4, moveIndex: 45, moveName: 'GROWL' },
    ]);
    expect(bulb!.evolutions).toEqual([
      { method: 4, param: 16, targetSpeciesIndex: 2, targetSpeciesName: 'IVYSAUR' },
    ]);
    expect(lib.moveNames).toEqual([
      { moveIndex: 33, name: 'TACKLE' },
      { moveIndex: 45, name: 'GROWL' },
    ]);
  });

  it('falls back to placeholder names when speciesNames are partial', () => {
    const m = emptyManifest('/x');
    const populated: ProjectManifest = {
      ...m,
      speciesLearnsets: [
        {
          id: 'binary_species_learnset_99',
          speciesIndex: 99,
          arrayFileOffset: 0,
          pointerRaw: 0,
          pointerFileOffset: 0,
          moves: [{ level: 1, move: 33 }],
        } as unknown as NonNullable<ProjectManifest['speciesLearnsets']>[number],
      ],
    };
    const lib = buildSpeciesLibrary(populated);
    expect(lib.species[0]?.name).toBe('species_99');
    expect(lib.species[0]?.speciesIndex).toBe(99);
  });
});

describe('summarizeSpeciesLibrary', () => {
  it('counts populated learnsets and evolutions', () => {
    const lib = buildSpeciesLibrary({
      ...emptyManifest('/x'),
      speciesLearnsets: [
        {
          id: 'l1',
          speciesIndex: 1,
          arrayFileOffset: 0,
          pointerRaw: 0,
          pointerFileOffset: 0,
          moves: [{ level: 1, move: 33 }],
        } as unknown as NonNullable<ProjectManifest['speciesLearnsets']>[number],
        {
          id: 'l2',
          speciesIndex: 2,
          arrayFileOffset: 0,
          pointerRaw: 0,
          pointerFileOffset: 0,
          moves: [],
        } as unknown as NonNullable<ProjectManifest['speciesLearnsets']>[number],
      ],
      speciesEvolutions: [
        {
          id: 'e1',
          speciesIndex: 1,
          slots: [{ method: 4, param: 16, targetSpecies: 2, fileOffset: 0 }],
          sourceFileOffset: 0,
        } as unknown as NonNullable<ProjectManifest['speciesEvolutions']>[number],
      ],
    });
    const summary = summarizeSpeciesLibrary(lib);
    expect(summary.counts.species).toBe(2);
    expect(summary.counts.learnsets).toBe(1); // only species 1 has non-empty moves
    expect(summary.counts.evolutions).toBe(1);
  });
});
