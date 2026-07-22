import { promises as fsp } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ProjectManifest, Trainer } from '@rom-editor/shared';
import { writeManifest } from '../../scan/manifest-io.js';
import { proposeTrainerParty } from './propose-trainer-party.js';

/** Minimal manifest factory with optional name tables for the
 *  Phase 4.3G symbolic-accept tests. */
function manifest(over: Partial<ProjectManifest> = {}): ProjectManifest {
  return {
    schemaVersion: 1,
    generatedAtUtc: '2026-05-27T00:00:00.000Z',
    projectRoot: '/x',
    identity: {
      kind: 'patch',
      confidence: 1,
      displayName: 'fake',
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
    ...over,
  };
}

function fakeTrainer(): Trainer {
  return {
    id: 'binary_trainer_1',
    name: 'Test Trainer',
    className: null,
    metadata: { partyFlags: 0x01 }, // CUSTOM_MOVES, no HELD_ITEM
    party: [
      {
        speciesId: 'species_1',
        level: 5,
        moveIds: ['move_33', 'move_45', 'move_0', 'move_0'],
        heldItemId: null,
        fileOffset: 0x100,
      },
    ],
  } as unknown as Trainer;
}

function fakeProposalFetch(): {
  fetchFn: typeof fetch;
  captured: () => { description: string; edits: unknown[] } | null;
} {
  let body: { description: string; edits: unknown[] } | null = null;
  const fetchFn = vi.fn().mockImplementation(async (_url: unknown, init: { body: string }) => {
    body = JSON.parse(init.body) as { description: string; edits: unknown[] };
    return {
      ok: true,
      status: 200,
      json: async () => ({
        id: 'patch_fake',
        projectId: 'p',
        description: body!.description,
        edits: body!.edits,
        status: 'pending',
        createdAtUtc: '2026-05-27T00:00:00.000Z',
      }),
      text: async () => '',
    };
  }) as unknown as typeof fetch;
  return { fetchFn, captured: () => body };
}

describe('proposeTrainerParty (Phase 4.3G symbolic accept)', () => {
  let root: string;

  beforeEach(async () => {
    root = mkdtempSync(path.join(tmpdir(), 'propose-trainer-party-'));
    // Fake ROM file the tool requires.
    await fsp.writeFile(path.join(root, 'test.gba'), Buffer.alloc(0x200, 0));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('resolves a species NAME to its numeric id via manifest.speciesNames', async () => {
    await writeManifest(
      root,
      manifest({
        trainers: [fakeTrainer()],
        speciesNames: [
          { id: 'species_25', speciesIndex: 25, name: 'PIKACHU', sourceTableOffset: 0 },
        ],
      }),
    );
    const { fetchFn } = fakeProposalFetch();
    const result = await proposeTrainerParty(
      { projectRoot: root, baseUrl: 'http://127.0.0.1:8717' },
      {
        trainerId: 'binary_trainer_1',
        members: [{ slotIndex: 0, speciesId: 'PIKACHU' }],
      },
      { fetchFn },
    );
    expect(result.skipped).toHaveLength(0);
    expect(result.editedMemberCount).toBeGreaterThan(0);
  });

  it('falls back to case-insensitive name matching', async () => {
    await writeManifest(
      root,
      manifest({
        trainers: [fakeTrainer()],
        speciesNames: [
          { id: 'species_25', speciesIndex: 25, name: 'PIKACHU', sourceTableOffset: 0 },
        ],
      }),
    );
    const { fetchFn } = fakeProposalFetch();
    const result = await proposeTrainerParty(
      { projectRoot: root, baseUrl: 'http://127.0.0.1:8717' },
      {
        trainerId: 'binary_trainer_1',
        members: [{ slotIndex: 0, speciesId: 'Pikachu' }],
      },
      { fetchFn },
    );
    expect(result.skipped).toHaveLength(0);
  });

  it('accepts a SPECIES_ prefixed input', async () => {
    await writeManifest(
      root,
      manifest({
        trainers: [fakeTrainer()],
        speciesNames: [
          { id: 'species_25', speciesIndex: 25, name: 'PIKACHU', sourceTableOffset: 0 },
        ],
      }),
    );
    const { fetchFn } = fakeProposalFetch();
    const result = await proposeTrainerParty(
      { projectRoot: root, baseUrl: 'http://127.0.0.1:8717' },
      {
        trainerId: 'binary_trainer_1',
        members: [{ slotIndex: 0, speciesId: 'SPECIES_PIKACHU' }],
      },
      { fetchFn },
    );
    expect(result.skipped).toHaveLength(0);
  });

  it('skips a member when species name is unresolvable + records the reason', async () => {
    await writeManifest(
      root,
      manifest({
        trainers: [fakeTrainer()],
        speciesNames: [],
      }),
    );
    const { fetchFn } = fakeProposalFetch();
    const result = await proposeTrainerParty(
      { projectRoot: root, baseUrl: 'http://127.0.0.1:8717' },
      {
        trainerId: 'binary_trainer_1',
        members: [{ slotIndex: 0, speciesId: 'PIKACHU' }],
      },
      { fetchFn },
    );
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.reason).toMatch(/Couldn't resolve species "PIKACHU"/);
  });

  it('resolves move names alongside species', async () => {
    await writeManifest(
      root,
      manifest({
        trainers: [fakeTrainer()],
        speciesNames: [
          { id: 'species_25', speciesIndex: 25, name: 'PIKACHU', sourceTableOffset: 0 },
        ],
        moveNames: [
          { id: 'move_33', moveIndex: 33, name: 'TACKLE', sourceTableOffset: 0 },
          { id: 'move_84', moveIndex: 84, name: 'THUNDERSHOCK', sourceTableOffset: 0 },
          { id: 'move_85', moveIndex: 85, name: 'THUNDERBOLT', sourceTableOffset: 0 },
          { id: 'move_0', moveIndex: 0, name: 'NONE', sourceTableOffset: 0 },
        ],
      }),
    );
    const { fetchFn } = fakeProposalFetch();
    const result = await proposeTrainerParty(
      { projectRoot: root, baseUrl: 'http://127.0.0.1:8717' },
      {
        trainerId: 'binary_trainer_1',
        members: [
          {
            slotIndex: 0,
            speciesId: 'Pikachu',
            moveIds: ['Tackle', 'Thunderbolt', 'Thundershock', 'NONE'],
          },
        ],
      },
      { fetchFn },
    );
    expect(result.skipped).toHaveLength(0);
  });

  it('numeric ids still work alongside symbolic strings', async () => {
    await writeManifest(
      root,
      manifest({
        trainers: [fakeTrainer()],
      }),
    );
    const { fetchFn } = fakeProposalFetch();
    const result = await proposeTrainerParty(
      { projectRoot: root, baseUrl: 'http://127.0.0.1:8717' },
      {
        trainerId: 'binary_trainer_1',
        members: [{ slotIndex: 0, speciesId: 25, level: 50 }],
      },
      { fetchFn },
    );
    expect(result.skipped).toHaveLength(0);
    expect(result.editedMemberCount).toBeGreaterThan(0);
  });
});
