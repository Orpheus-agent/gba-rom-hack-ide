import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { extractEncounters, parseEncounters } from './encounters.js';

const minimalGrass = {
  wild_encounter_groups: [
    {
      label: 'gWildMonHeaders',
      for_maps: true,
      fields: [
        { type: 'land_mons', encounter_rates: [20, 20, 10, 10, 10, 10, 5, 5, 4, 4, 1, 1] },
      ],
      encounters: [
        {
          map: 'MAP_ROUTE101',
          base_label: 'gRoute101',
          land_mons: {
            encounter_rate: 20,
            mons: [
              { min_level: 2, max_level: 2, species: 'SPECIES_POOCHYENA' },
              { min_level: 2, max_level: 3, species: 'SPECIES_ZIGZAGOON' },
            ],
          },
          water_mons: null,
          fishing_mons: null,
          rock_smash_mons: null,
        },
      ],
    },
  ],
};

describe('extractEncounters', () => {
  it('produces one EncounterTable per non-null slot type and links to the map', () => {
    const result = extractEncounters(minimalGrass);
    expect(result.tables).toHaveLength(1);
    const t = result.tables[0];
    if (!t) throw new Error('table missing');
    expect(t.id).toBe('gRoute101_grass');
    expect(t.type).toBe('grass');
    expect(t.mapId).toBe('MAP_ROUTE101');
    expect(t.encounterRate).toBe(20);
    expect(t.slots).toHaveLength(2);
    expect(t.slots[0]?.speciesId).toBe('SPECIES_POOCHYENA');
    expect(t.slots[0]?.minLevel).toBe(2);
    expect(t.slots[0]?.maxLevel).toBe(2);
    // First slot's weight comes from fields[0].encounter_rates[0] = 20
    expect(t.slots[0]?.weight).toBe(20);
    expect(t.slots[1]?.weight).toBe(20);
  });

  it('records map → tableIds linkage for MapNode.encounterTableIds wiring', () => {
    const result = extractEncounters(minimalGrass);
    expect(result.tablesByMap.get('MAP_ROUTE101')).toEqual(['gRoute101_grass']);
  });

  it('emits multiple tables when several slot types are present on one map', () => {
    const data = {
      wild_encounter_groups: [
        {
          fields: [
            { type: 'land_mons', encounter_rates: [50] },
            { type: 'water_mons', encounter_rates: [60] },
            { type: 'fishing_mons', encounter_rates: [70] },
          ],
          encounters: [
            {
              map: 'MAP_ROUTE102',
              base_label: 'gRoute102',
              land_mons: {
                encounter_rate: 20,
                mons: [{ min_level: 5, max_level: 5, species: 'SPECIES_ZIGZAGOON' }],
              },
              water_mons: {
                encounter_rate: 4,
                mons: [{ min_level: 10, max_level: 12, species: 'SPECIES_MARILL' }],
              },
              fishing_mons: {
                encounter_rate: 30,
                mons: [{ min_level: 5, max_level: 10, species: 'SPECIES_GOLDEEN' }],
              },
              rock_smash_mons: null,
            },
          ],
        },
      ],
    };
    const result = extractEncounters(data);
    expect(result.tables).toHaveLength(3);
    const types = result.tables.map((t) => t.type).sort();
    expect(types).toEqual(['fishing', 'grass', 'water']);
    expect(result.tablesByMap.get('MAP_ROUTE102')).toHaveLength(3);
  });

  it('skips empty or absent mons arrays and emits no table for them', () => {
    const data = {
      wild_encounter_groups: [
        {
          fields: [],
          encounters: [
            {
              map: 'MAP_TEST',
              base_label: 'gTest',
              land_mons: { encounter_rate: 0, mons: [] },
              water_mons: null,
              fishing_mons: null,
              rock_smash_mons: null,
            },
          ],
        },
      ],
    };
    const result = extractEncounters(data);
    expect(result.tables).toHaveLength(0);
  });

  it('skips slots with no species (malformed entries) without aborting the table', () => {
    const data = {
      wild_encounter_groups: [
        {
          fields: [{ type: 'land_mons', encounter_rates: [20, 20] }],
          encounters: [
            {
              map: 'MAP_TEST',
              base_label: 'gTest',
              land_mons: {
                encounter_rate: 10,
                mons: [
                  { min_level: 2, max_level: 2, species: 'SPECIES_POOCHYENA' },
                  { min_level: 2, max_level: 2 }, // missing species
                ],
              },
            },
          ],
        },
      ],
    };
    const result = extractEncounters(data);
    expect(result.tables).toHaveLength(1);
    expect(result.tables[0]?.slots).toHaveLength(1);
    expect(result.tables[0]?.slots[0]?.speciesId).toBe('SPECIES_POOCHYENA');
  });

  it('warns when root or wild_encounter_groups are missing', () => {
    const r1 = extractEncounters(null);
    expect(r1.warnings.length).toBeGreaterThan(0);
    const r2 = extractEncounters({});
    expect(r2.warnings.length).toBeGreaterThan(0);
  });

  it('uses base_label for id stability when same map has multiple encounter table variants', () => {
    // Same logical map but two base_labels (e.g., morning/evening variants in some forks).
    const data = {
      wild_encounter_groups: [
        {
          fields: [{ type: 'land_mons', encounter_rates: [20] }],
          encounters: [
            {
              map: 'MAP_FOREST',
              base_label: 'gForestDay',
              land_mons: {
                encounter_rate: 25,
                mons: [{ min_level: 3, max_level: 4, species: 'SPECIES_TAILLOW' }],
              },
            },
            {
              map: 'MAP_FOREST',
              base_label: 'gForestNight',
              land_mons: {
                encounter_rate: 25,
                mons: [{ min_level: 3, max_level: 4, species: 'SPECIES_HOOTHOOT' }],
              },
            },
          ],
        },
      ],
    };
    const result = extractEncounters(data);
    expect(result.tables.map((t) => t.id).sort()).toEqual([
      'gForestDay_grass',
      'gForestNight_grass',
    ]);
    expect(result.tablesByMap.get('MAP_FOREST')).toEqual(['gForestDay_grass', 'gForestNight_grass']);
  });
});

describe('parseEncounters (on-disk)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'rom-editor-encounters-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads src/data/wild_encounters.json when present', async () => {
    mkdirSync(path.join(dir, 'src', 'data'), { recursive: true });
    writeFileSync(
      path.join(dir, 'src', 'data', 'wild_encounters.json'),
      JSON.stringify(minimalGrass),
    );
    const result = await parseEncounters(dir);
    expect(result.tables).toHaveLength(1);
    expect(result.warnings).toHaveLength(0);
  });

  it('falls back to data/wild_encounters.json when src/data/ variant is absent', async () => {
    mkdirSync(path.join(dir, 'data'), { recursive: true });
    writeFileSync(path.join(dir, 'data', 'wild_encounters.json'), JSON.stringify(minimalGrass));
    const result = await parseEncounters(dir);
    expect(result.tables).toHaveLength(1);
  });

  it('warns when no wild_encounters.json is found', async () => {
    const result = await parseEncounters(dir);
    expect(result.tables).toHaveLength(0);
    expect(result.warnings.some((w) => /No wild_encounters\.json/.test(w))).toBe(true);
  });

  it('warns when wild_encounters.json is malformed', async () => {
    mkdirSync(path.join(dir, 'src', 'data'), { recursive: true });
    writeFileSync(path.join(dir, 'src', 'data', 'wild_encounters.json'), '{not valid');
    const result = await parseEncounters(dir);
    expect(result.tables).toHaveLength(0);
    expect(result.warnings.some((w) => /Could not parse/.test(w))).toBe(true);
  });
});
