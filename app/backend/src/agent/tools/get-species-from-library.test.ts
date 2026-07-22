import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { ProjectManifest } from '@rom-editor/shared';
import { writeManifest } from '../../scan/manifest-io.js';
import { getSpeciesFromLibrary } from './get-species-from-library.js';

function manifestWithSpecies(projectRoot: string, speciesIds: number[]): ProjectManifest {
  return {
    schemaVersion: 1,
    generatedAtUtc: '2026-05-22T00:00:00.000Z',
    projectRoot,
    identity: {
      kind: 'patch',
      confidence: 1,
      displayName: 'Pokémon Test',
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
    speciesLearnsets: speciesIds.map((idx) => ({
      id: `l${idx}`,
      speciesIndex: idx,
      arrayFileOffset: 0,
      pointerRaw: 0,
      pointerFileOffset: 0,
      moves: [{ level: 1, move: 33 }],
    })) as unknown as NonNullable<ProjectManifest['speciesLearnsets']>,
  };
}

describe('getSpeciesFromLibrary', () => {
  let root: string;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(tmpdir(), 'get-species-'));
  });
  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  it('returns source_manifest_missing when no manifest at the path', async () => {
    const result = await getSpeciesFromLibrary(
      { projectRoot: '/ignored' },
      { sourceProjectRoot: root },
    );
    expect(result.available).toBe(false);
    expect(result.reason).toBe('source_manifest_missing');
    expect(result.entries).toEqual([]);
  });

  it('returns no_species_data when the manifest has no species', async () => {
    await writeManifest(root, manifestWithSpecies(root, []));
    const result = await getSpeciesFromLibrary(
      { projectRoot: '/ignored' },
      { sourceProjectRoot: root },
    );
    expect(result.available).toBe(false);
    expect(result.reason).toBe('no_species_data');
    expect(result.sourceDisplayName).toBe('Pokémon Test');
  });

  it('returns all species when speciesIds is omitted', async () => {
    await writeManifest(root, manifestWithSpecies(root, [1, 2, 3, 4, 5]));
    const result = await getSpeciesFromLibrary(
      { projectRoot: '/ignored' },
      { sourceProjectRoot: root },
    );
    expect(result.available).toBe(true);
    expect(result.entries.length).toBe(5);
    expect(result.totalSpeciesInLibrary).toBe(5);
    expect(result.message).toContain('all species');
  });

  it('filters by speciesIds when provided', async () => {
    await writeManifest(root, manifestWithSpecies(root, [1, 4, 7, 25]));
    const result = await getSpeciesFromLibrary(
      { projectRoot: '/ignored' },
      { sourceProjectRoot: root, speciesIds: [4, 25] },
    );
    expect(result.available).toBe(true);
    expect(result.entries.map((e) => e.speciesIndex).sort((a, b) => a - b)).toEqual([4, 25]);
    expect(result.totalSpeciesInLibrary).toBe(4);
  });

  it('reports missing-id count when some requested ids are not in the library', async () => {
    await writeManifest(root, manifestWithSpecies(root, [1, 2, 3]));
    const result = await getSpeciesFromLibrary(
      { projectRoot: '/ignored' },
      { sourceProjectRoot: root, speciesIds: [1, 99, 100] },
    );
    expect(result.available).toBe(true);
    expect(result.entries.length).toBe(1);
    expect(result.message).toMatch(/2 requested ids? not present/);
  });
});
