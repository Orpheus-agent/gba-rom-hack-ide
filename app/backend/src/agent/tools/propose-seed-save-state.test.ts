import { promises as fsp } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { ProjectManifest, MapNode, Flag, Variable } from '@rom-editor/shared';
import { writeManifest } from '../../scan/manifest-io.js';
import { proposeSeedSaveState } from './propose-seed-save-state.js';
import type { ToolContext } from '../types.js';

function fakeManifest(overrides: Partial<ProjectManifest> = {}): ProjectManifest {
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
    ...overrides,
  };
}

function fakeMap(id: string): MapNode {
  return {
    id,
    name: id,
    metadata: {},
    group: 'town',
    dimensions: { width: 20, height: 20 },
    tilesetIds: [],
    warpIds: [],
    scriptIds: [],
    objectEventIds: [],
    encounterTableIds: [],
    musicId: null,
    connections: [],
  };
}

function fakeFlag(name: string, hex: string): Flag {
  return {
    id: name,
    name,
    scope: 'global',
    defaultValue: false,
    description: null,
    engineValue: hex,
  };
}

function fakeVar(name: string, hex: string): Variable {
  return {
    id: name,
    name,
    scope: 'global',
    defaultValue: 0,
    description: null,
    engineValue: hex,
  };
}

describe('propose_seed_save_state (Phase 4.1E)', () => {
  let projectRoot: string;
  let ctx: ToolContext;

  beforeEach(async () => {
    projectRoot = mkdtempSync(path.join(tmpdir(), 'rom-editor-seed-savestate-'));
    ctx = { projectRoot } satisfies ToolContext;
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('refuses when no manifest exists', async () => {
    const result = await proposeSeedSaveState(ctx, {
      name: 'x',
      startingMapId: 'pallet_town',
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/No manifest/);
  });

  it('rejects an unknown map id', async () => {
    await writeManifest(projectRoot, fakeManifest({ maps: [fakeMap('pallet_town')] }));
    const result = await proposeSeedSaveState(ctx, {
      name: 'x',
      startingMapId: 'nowhere',
    });
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.includes('unknown_map'))).toBe(true);
  });

  it('rejects an unknown flag id', async () => {
    await writeManifest(
      projectRoot,
      fakeManifest({
        maps: [fakeMap('pallet_town')],
        flags: [fakeFlag('FLAG_KNOWN', '0x100')],
      }),
    );
    const result = await proposeSeedSaveState(ctx, {
      name: 'x',
      startingMapId: 'pallet_town',
      initialFlags: [0x200],
    });
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.includes('unknown_flag'))).toBe(true);
  });

  it('rejects an unknown var id', async () => {
    await writeManifest(
      projectRoot,
      fakeManifest({
        maps: [fakeMap('pallet_town')],
        variables: [fakeVar('VAR_KNOWN', '0x4000')],
      }),
    );
    const result = await proposeSeedSaveState(ctx, {
      name: 'x',
      startingMapId: 'pallet_town',
      initialVars: [{ varId: 0x40d0, value: 3 }],
    });
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.includes('unknown_var'))).toBe(true);
  });

  it('rejects an unknown trigger script', async () => {
    await writeManifest(
      projectRoot,
      fakeManifest({
        maps: [fakeMap('pallet_town')],
        scriptSteps: [
          {
            id: 'known_script__0',
            kind: 'dialogue',
            params: { dialogueText: 'hi' },
          },
        ],
      }),
    );
    const result = await proposeSeedSaveState(ctx, {
      name: 'x',
      startingMapId: 'pallet_town',
      triggerScriptId: 'unknown_script',
    });
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.includes('unknown_script'))).toBe(true);
  });

  it('succeeds when every reference resolves + persists the recipe', async () => {
    await writeManifest(
      projectRoot,
      fakeManifest({
        maps: [fakeMap('pallet_town')],
        flags: [fakeFlag('FLAG_RECEIVED_COSMOG', '0x820')],
        variables: [fakeVar('VAR_RA_EMO_LOG', '0x40D0')],
        scriptSteps: [
          {
            id: 'cosmog_handoff__0',
            kind: 'dialogue',
            params: { dialogueText: 'Take this Cosmog.' },
          },
        ],
      }),
    );
    const result = await proposeSeedSaveState(ctx, {
      name: 'cosmog-handoff',
      notes: 'after Oak hands over Cosmog',
      startingMapId: 'pallet_town',
      startingPosition: { x: 4, y: 5, facing: 'down' },
      initialFlags: [0x820],
      initialVars: [{ varId: 0x40d0, value: 3 }],
      triggerScriptId: 'cosmog_handoff',
      skipIntro: true,
    });
    expect(result.ok).toBe(true);
    expect(result.recipeId).toBeTruthy();
    expect(result.deepLink).toMatch(/^editor:\/\/scene-boot\//);

    // Confirm the recipe is persisted via the store's index file.
    const idx = path.join(projectRoot, '.editor', 'scene-boots', 'index.json');
    const persisted = JSON.parse(await fsp.readFile(idx, 'utf-8')) as {
      schemaVersion: number;
      recipes: { id: string; name: string }[];
    };
    expect(persisted.recipes).toHaveLength(1);
    expect(persisted.recipes[0]!.name).toBe('cosmog-handoff');
  });

  it('collects multiple validation issues in one response', async () => {
    await writeManifest(
      projectRoot,
      fakeManifest({
        maps: [fakeMap('pallet_town')],
        flags: [fakeFlag('FLAG_KNOWN', '0x100')],
        variables: [fakeVar('VAR_KNOWN', '0x4000')],
      }),
    );
    const result = await proposeSeedSaveState(ctx, {
      name: 'x',
      startingMapId: 'nowhere',
      initialFlags: [0x200, 0x300],
      initialVars: [{ varId: 0x40d0, value: 1 }],
      triggerScriptId: 'no_such_script',
    });
    expect(result.ok).toBe(false);
    // At least one each of unknown_map / unknown_flag / unknown_var / unknown_script.
    expect(result.issues.some((i) => i.startsWith('unknown_map'))).toBe(true);
    expect(result.issues.some((i) => i.startsWith('unknown_flag'))).toBe(true);
    expect(result.issues.some((i) => i.startsWith('unknown_var'))).toBe(true);
    expect(result.issues.some((i) => i.startsWith('unknown_script'))).toBe(true);
  });
});
