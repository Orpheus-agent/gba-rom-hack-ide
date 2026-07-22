import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { ProjectManifest } from '@rom-editor/shared';
import { writeManifest } from '../scan/manifest-io.js';
import { getWorkspaceSummary } from './tools/get-workspace-summary.js';
import { findReferencesTo } from './tools/find-references-to.js';
import { readMap } from './tools/read-map.js';
import { readDecodedScript } from './tools/read-decoded-script.js';
import { listEntities } from './tools/list-entities.js';

function emptyManifest(projectRoot: string): ProjectManifest {
  return {
    schemaVersion: 1,
    generatedAtUtc: '2026-05-22T00:00:00.000Z',
    projectRoot,
    identity: {
      kind: 'decomp',
      confidence: 0.92,
      displayName: 'pokefirered (decomp)',
      baseGame: 'firered',
      fork: null,
      featureFlags: [],
      warnings: [],
      evidence: ['data/maps/PalletTown'],
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

/** Build a small, cross-referenced FRLG-shaped manifest fixture. */
function richManifest(projectRoot: string): ProjectManifest {
  const base = emptyManifest(projectRoot);
  return {
    ...base,
    maps: [
      {
        id: 'pallet_town',
        name: 'Pallet Town',
        group: 'town',
        dimensions: { width: 20, height: 18 },
        tilesetIds: ['tileset_general', 'tileset_pallet'],
        warpIds: ['warp_pallet_oak'],
        scriptIds: [],
        objectEventIds: ['npc_oak', 'npc_rival'],
        encounterTableIds: ['enc_pallet_grass'],
        musicId: 'mus_pallet',
        metadata: {},
        connections: [
          { direction: 2, offset: 0, destMapId: 'route_1', destMapGroup: 0, destMapNum: 1, fileOffset: 0x1000 },
        ],
      },
      {
        id: 'route_1',
        name: 'Route 1',
        group: 'route',
        dimensions: { width: 40, height: 60 },
        tilesetIds: ['tileset_general'],
        warpIds: [],
        scriptIds: [],
        objectEventIds: [],
        encounterTableIds: ['enc_route1_grass'],
        musicId: 'mus_route1',
        metadata: {},
      },
    ],
    warps: [
      {
        id: 'warp_pallet_oak',
        name: 'Oak Lab door',
        fromMapId: 'pallet_town',
        fromCoord: { x: 12, y: 12 },
        toMapId: 'oak_lab',
        toCoord: { x: 4, y: 7 },
      },
    ],
    triggers: [
      {
        id: 'trig_pallet_intro',
        name: 'Pallet intro trigger',
        kind: 'on_first_visit',
        mapId: 'pallet_town',
        coord: { x: 10, y: 10 },
        conditionExpression: null,
        scriptStepIds: ['PalletTown_Intro#0', 'PalletTown_Intro#1'],
      },
    ],
    objectEvents: [
      {
        id: 'npc_oak',
        name: 'Professor Oak',
        mapId: 'pallet_town',
        coord: { x: 8, y: 7 },
        elevation: 3,
        kind: 'npc',
        graphicsId: 'gfx_oak',
        movementType: 'face_down',
        scriptId: 'PalletTown_Oak_EventScript',
        flagId: 'flag_oak_intro_done',
        trainerType: null,
        metadata: {},
      },
      {
        id: 'npc_rival',
        name: 'Rival',
        mapId: 'pallet_town',
        coord: { x: 5, y: 12 },
        elevation: 3,
        kind: 'trainer',
        graphicsId: 'gfx_rival_blue',
        movementType: 'face_down',
        scriptId: 'PalletTown_Rival_EventScript',
        flagId: 'flag_rival_intro_done',
        trainerType: 'rival',
        metadata: {},
      },
    ],
    dialogue: [
      {
        id: 'dlg_oak_hello',
        name: 'Oak hello',
        speakerName: 'Professor Oak',
        portraitAssetId: 'portrait_oak',
        text: 'Welcome to the world of Pokémon!',
        choices: [
          { label: 'Continue', nextDialogueId: 'dlg_oak_next', setsFlagIds: ['flag_oak_intro_done'] },
        ],
      },
      { id: 'dlg_oak_next', name: 'Oak next', speakerName: 'Professor Oak', portraitAssetId: 'portrait_oak', text: 'My name is OAK!', choices: [] },
    ],
    flags: [
      { id: 'flag_oak_intro_done', name: 'Oak intro done', scope: 'global', defaultValue: false, description: null, engineValue: '0x800' },
      { id: 'flag_rival_intro_done', name: 'Rival intro done', scope: 'global', defaultValue: false, description: null, engineValue: '0x801' },
    ],
    variables: [
      { id: 'var_rival_name', name: 'Rival name', scope: 'global', defaultValue: 0, description: null, engineValue: '0x4001' },
    ],
    encounterTables: [
      {
        id: 'enc_pallet_grass',
        name: 'Pallet grass',
        mapId: 'pallet_town',
        type: 'grass',
        encounterRate: 25,
        slots: [
          { speciesId: 'SPECIES_PIDGEY', minLevel: 2, maxLevel: 4, weight: 50 },
          { speciesId: 'SPECIES_RATTATA', minLevel: 2, maxLevel: 4, weight: 50 },
        ],
      },
      {
        id: 'enc_route1_grass',
        name: 'Route 1 grass',
        mapId: 'route_1',
        type: 'grass',
        encounterRate: 25,
        slots: [{ speciesId: 'SPECIES_PIDGEY', minLevel: 3, maxLevel: 5, weight: 100 }],
      },
    ],
    trainers: [
      {
        id: 'trainer_rival_1',
        name: 'BLUE',
        className: 'PKMN TRAINER',
        party: [
          { speciesId: 'SPECIES_SQUIRTLE', level: 5, moveIds: [], heldItemId: null },
        ],
        aiFlags: [],
        mapId: 'pallet_town',
      },
    ],
    scriptSteps: [
      { id: 'PalletTown_Intro#0', kind: 'set_flag', params: { label: 'Set flag_oak_intro_done', flagId: 'flag_oak_intro_done' } },
      { id: 'PalletTown_Intro#1', kind: 'dialogue', params: { label: 'Welcome', dialogueId: 'dlg_oak_hello' } },
      { id: 'binary_script_0x16582f__0', kind: 'set_flag', params: { label: 'Set X', flagId: 'flag_oak_intro_done' } },
      { id: 'binary_script_0x16582f__1', kind: 'dialogue', params: { label: 'Hi', dialogueId: 'dlg_oak_hello' } },
      { id: 'binary_script_0x16582f__2', kind: 'start_battle', params: { label: 'Battle BLUE', trainerId: 'trainer_rival_1' } },
    ],
    assets: [
      { id: 'portrait_oak', name: 'Oak portrait', kind: 'portrait', relativePath: 'graphics/oak/portrait.png', metadata: {} },
      { id: 'tileset_general', name: 'General tileset', kind: 'tileset', relativePath: 'graphics/tilesets/general.png', metadata: {} },
    ],
  };
}

describe('get_workspace_summary tool', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await fsp.mkdtemp(path.join(tmpdir(), 'agent-test-'));
  });

  afterEach(async () => {
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  });

  it('reports manifest_not_found when no scan has been written', async () => {
    const result = await getWorkspaceSummary({ projectRoot: tmpRoot });
    expect(result.available).toBe(false);
    if (!result.available) {
      expect(result.reason).toBe('manifest_not_found');
      expect(result.projectRoot).toBe(tmpRoot);
    }
  });

  it('returns identity + counts from the manifest', async () => {
    const stubs = <T,>(n: number): readonly T[] =>
      Array.from({ length: n }, () => ({}) as unknown as T);
    const manifest = emptyManifest(tmpRoot);
    const populated: ProjectManifest = {
      ...manifest,
      maps: stubs<ProjectManifest['maps'][number]>(246),
      objectEvents: stubs<ProjectManifest['objectEvents'][number]>(842),
      dialogue: stubs<ProjectManifest['dialogue'][number]>(4200),
      trainers: stubs<ProjectManifest['trainers'][number]>(642),
    };
    await writeManifest(tmpRoot, populated);

    const result = await getWorkspaceSummary({ projectRoot: tmpRoot });
    expect(result.available).toBe(true);
    if (result.available) {
      expect(result.identity.kind).toBe('decomp');
      expect(result.identity.displayName).toBe('pokefirered (decomp)');
      expect(result.counts.maps).toBe(246);
      expect(result.counts.objectEvents).toBe(842);
      expect(result.counts.dialogue).toBe(4200);
      expect(result.counts.trainers).toBe(642);
      expect(result.counts.warps).toBe(0);
    }
  });
});

describe('find_references_to tool', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await fsp.mkdtemp(path.join(tmpdir(), 'agent-test-'));
    await writeManifest(tmpRoot, richManifest(tmpRoot));
  });

  afterEach(async () => {
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  });

  it('finds every entity that points at a map', async () => {
    const result = await findReferencesTo({ projectRoot: tmpRoot }, { kind: 'map', id: 'pallet_town' });
    if (!('references' in result)) throw new Error('expected references');
    const fields = new Set(result.references.map((r) => `${r.referrerKind}:${r.field}`));
    expect(fields.has('warp:fromMapId')).toBe(true);
    expect(fields.has('trigger:mapId')).toBe(true);
    expect(fields.has('objectEvent:mapId')).toBe(true);
    expect(fields.has('encounterTable:mapId')).toBe(true);
    expect(fields.has('trainer:mapId')).toBe(true);
    expect(result.summary).toContain('reference');
  });

  it('finds map-to-map connection references', async () => {
    const result = await findReferencesTo({ projectRoot: tmpRoot }, { kind: 'map', id: 'route_1' });
    if (!('references' in result)) throw new Error('expected references');
    const connHits = result.references.filter((r) => r.field.startsWith('connections['));
    expect(connHits.length).toBeGreaterThan(0);
  });

  it('finds NPC + scriptStep + dialogue-choice references to a flag', async () => {
    const result = await findReferencesTo({ projectRoot: tmpRoot }, { kind: 'flag', id: 'flag_oak_intro_done' });
    if (!('references' in result)) throw new Error('expected references');
    const kinds = new Set(result.references.map((r) => r.referrerKind));
    expect(kinds.has('objectEvent')).toBe(true);
    expect(kinds.has('scriptStep')).toBe(true);
    expect(kinds.has('dialogue')).toBe(true);
  });

  it('finds species references across encounter slots + trainer parties', async () => {
    const result = await findReferencesTo({ projectRoot: tmpRoot }, { kind: 'species', id: 'SPECIES_SQUIRTLE' });
    if (!('references' in result)) throw new Error('expected references');
    expect(result.references.some((r) => r.referrerKind === 'trainer' && r.field.startsWith('party'))).toBe(true);
  });

  it('returns empty references + zero-summary when nothing matches', async () => {
    const result = await findReferencesTo({ projectRoot: tmpRoot }, { kind: 'flag', id: 'flag_does_not_exist' });
    if (!('references' in result)) throw new Error('expected references');
    expect(result.references).toHaveLength(0);
    expect(result.summary).toContain('No references');
  });

  it('reports manifest_not_found when no scan exists', async () => {
    const empty = await fsp.mkdtemp(path.join(tmpdir(), 'agent-empty-'));
    try {
      const result = await findReferencesTo({ projectRoot: empty }, { kind: 'map', id: 'pallet_town' });
      expect('available' in result && result.available === false).toBe(true);
    } finally {
      await fsp.rm(empty, { recursive: true, force: true });
    }
  });
});

describe('read_map tool', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await fsp.mkdtemp(path.join(tmpdir(), 'agent-test-'));
    await writeManifest(tmpRoot, richManifest(tmpRoot));
  });

  afterEach(async () => {
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  });

  it('returns map header + child entities for a known map', async () => {
    const result = await readMap({ projectRoot: tmpRoot }, { mapId: 'pallet_town' });
    expect(result.available).toBe(true);
    if (result.available) {
      expect(result.map.name).toBe('Pallet Town');
      expect(result.warps.map((w) => w.id)).toContain('warp_pallet_oak');
      expect(result.triggers.map((t) => t.id)).toContain('trig_pallet_intro');
      expect(result.objectEvents.map((o) => o.id).sort()).toEqual(['npc_oak', 'npc_rival']);
      expect(result.encounterTables.map((e) => e.id)).toContain('enc_pallet_grass');
      expect(result.trainersOnMap.map((t) => t.id)).toContain('trainer_rival_1');
      expect(result.connections[0]?.destMapId).toBe('route_1');
    }
  });

  it('returns map_not_found for an unknown id', async () => {
    const result = await readMap({ projectRoot: tmpRoot }, { mapId: 'no_such_map' });
    expect(result.available).toBe(false);
    if (!result.available) expect(result.reason).toBe('map_not_found');
  });
});

describe('read_decoded_script tool', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await fsp.mkdtemp(path.join(tmpdir(), 'agent-test-'));
    await writeManifest(tmpRoot, richManifest(tmpRoot));
  });

  afterEach(async () => {
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  });

  it('returns one step on exact-id match', async () => {
    const result = await readDecodedScript({ projectRoot: tmpRoot }, { scriptId: 'PalletTown_Intro#0' });
    expect(result.available).toBe(true);
    if (result.available) {
      expect(result.matchMode).toBe('exact');
      expect(result.steps).toHaveLength(1);
      expect(result.steps[0]?.label).toBe('Set flag_oak_intro_done');
    }
  });

  it('returns ordered chain for a decomp-style #N convention', async () => {
    const result = await readDecodedScript({ projectRoot: tmpRoot }, { scriptId: 'PalletTown_Intro' });
    expect(result.available).toBe(true);
    if (result.available) {
      expect(result.matchMode).toBe('chain');
      expect(result.steps.map((s) => s.id)).toEqual(['PalletTown_Intro#0', 'PalletTown_Intro#1']);
    }
  });

  it('returns ordered chain for a binary-rom __N convention', async () => {
    const result = await readDecodedScript({ projectRoot: tmpRoot }, { scriptId: 'binary_script_0x16582f' });
    expect(result.available).toBe(true);
    if (result.available) {
      expect(result.matchMode).toBe('chain');
      expect(result.steps).toHaveLength(3);
      expect(result.steps[2]?.kind).toBe('start_battle');
    }
  });

  it('reports script_not_found for unknown ids', async () => {
    const result = await readDecodedScript({ projectRoot: tmpRoot }, { scriptId: 'unknown_script' });
    expect(result.available).toBe(false);
    if (!result.available) expect(result.reason).toBe('script_not_found');
  });
});

describe('list_entities tool', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await fsp.mkdtemp(path.join(tmpdir(), 'agent-test-'));
    await writeManifest(tmpRoot, richManifest(tmpRoot));
  });

  afterEach(async () => {
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  });

  it('lists maps with extras', async () => {
    const result = await listEntities({ projectRoot: tmpRoot }, { kind: 'map' });
    expect(result.available).toBe(true);
    if (result.available) {
      expect(result.total).toBe(2);
      expect(result.items.map((i) => i.id).sort()).toEqual(['pallet_town', 'route_1']);
      expect(result.items[0]?.extras).toHaveProperty('group');
    }
  });

  it('filters case-insensitively by name', async () => {
    const result = await listEntities({ projectRoot: tmpRoot }, { kind: 'trainer', filter: 'BLUE' });
    expect(result.available).toBe(true);
    if (result.available) {
      expect(result.total).toBe(1);
      expect(result.items[0]?.name).toBe('BLUE');
    }
  });

  it('paginates with limit + offset', async () => {
    const result = await listEntities({ projectRoot: tmpRoot }, { kind: 'scriptStep', limit: 2, offset: 1 });
    expect(result.available).toBe(true);
    if (result.available) {
      expect(result.items).toHaveLength(2);
      expect(result.offset).toBe(1);
      expect(result.hasMore).toBe(true);
    }
  });
});
