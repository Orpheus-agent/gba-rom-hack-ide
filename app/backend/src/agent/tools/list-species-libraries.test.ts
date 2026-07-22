import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { ProjectManifest } from '@rom-editor/shared';
import { writeManifest } from '../../scan/manifest-io.js';
import { listSpeciesLibraries } from './list-species-libraries.js';

function manifestForSpecies(projectRoot: string, displayName: string, speciesCount: number): ProjectManifest {
  return {
    schemaVersion: 1,
    generatedAtUtc: '2026-05-22T00:00:00.000Z',
    projectRoot,
    identity: {
      kind: 'patch',
      confidence: 1,
      displayName,
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
    speciesLearnsets: Array.from({ length: speciesCount }, (_, i) => ({
      id: `l${i + 1}`,
      speciesIndex: i + 1,
      arrayFileOffset: 0,
      pointerRaw: 0,
      pointerFileOffset: 0,
      moves: [{ level: 1, move: 33 }],
    })) as unknown as NonNullable<ProjectManifest['speciesLearnsets']>,
  };
}

describe('listSpeciesLibraries', () => {
  let root: string;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(tmpdir(), 'list-libs-'));
  });
  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  it('returns empty when the managed root is empty', async () => {
    const result = await listSpeciesLibraries(
      { projectRoot: '/ignored' },
      { managedRootOverride: root },
    );
    expect(result.libraries).toEqual([]);
  });

  it('discovers manifests under managed-root and reports their species counts', async () => {
    const a = path.join(root, 'projA');
    const b = path.join(root, 'projB');
    await fsp.mkdir(a, { recursive: true });
    await fsp.mkdir(b, { recursive: true });
    await writeManifest(a, manifestForSpecies(a, 'Pokémon Test A', 100));
    await writeManifest(b, manifestForSpecies(b, 'Pokémon Test B', 25));

    const result = await listSpeciesLibraries(
      { projectRoot: '/ignored' },
      { managedRootOverride: root },
    );
    expect(result.libraries).toHaveLength(2);
    // Sorted by species count desc.
    expect(result.libraries[0]?.sourceDisplayName).toBe('Pokémon Test A');
    expect(result.libraries[0]?.counts.species).toBe(100);
    expect(result.libraries[0]?.counts.learnsets).toBe(100);
    expect(result.libraries[1]?.sourceDisplayName).toBe('Pokémon Test B');
    expect(result.libraries[1]?.counts.species).toBe(25);
  });

  it('skips directories that have no species data', async () => {
    const empty = path.join(root, 'projEmpty');
    await fsp.mkdir(empty, { recursive: true });
    await writeManifest(empty, {
      schemaVersion: 1,
      generatedAtUtc: '2026-05-22T00:00:00.000Z',
      projectRoot: empty,
      identity: {
        kind: 'patch',
        confidence: 1,
        displayName: 'Empty Project',
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
    });
    const result = await listSpeciesLibraries(
      { projectRoot: '/ignored' },
      { managedRootOverride: root },
    );
    expect(result.libraries).toEqual([]);
  });
});
