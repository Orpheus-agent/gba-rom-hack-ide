import { describe, expect, it } from 'vitest';
import type { Asset, ProjectManifest, ScriptStep } from '@rom-editor/shared';
import { emptyManifest } from '@rom-editor/shared';
import { findAssetReferences } from './assetReferences';

function asset(id: string, kind: Asset['kind'], relativePath: string): Asset {
  return { id, name: id, kind, relativePath, metadata: {} };
}

function step(id: string, kind: ScriptStep['kind'], params: Record<string, unknown>): ScriptStep {
  return { id, kind, params };
}

function makeManifest(): ProjectManifest {
  const base = emptyManifest('/tmp/x', '2026-05-16T00:00:00Z');
  return {
    ...base,
    assets: [
      asset('asset_tileset_route101', 'tileset', 'graphics/tilesets/route101/tiles.png'),
      asset('asset_music_littleroot', 'music', 'sound/songs/littleroot.aif'),
      asset('asset_npc_mom', 'overworld_sprite', 'graphics/object_events/pics/may.png'),
      asset('asset_portrait_oak', 'portrait', 'graphics/portraits/oak.png'),
      asset('asset_se_door', 'sound', 'sound/sound_effects/door.wav'),
      asset('asset_orphan', 'ui_graphic', 'graphics/misc/orphan.png'),
    ],
    maps: [
      {
        id: 'LittlerootTown',
        name: 'LittlerootTown',
        group: 'town',
        dimensions: { width: 20, height: 20 },
        tilesetIds: ['asset_tileset_route101'],
        warpIds: [],
        scriptIds: [],
        objectEventIds: [],
        encounterTableIds: [],
        musicId: 'asset_music_littleroot',
        metadata: {},
      },
    ],
    objectEvents: [
      {
        id: 'objectEvent_LittlerootTown_0',
        name: 'objectEvent_LittlerootTown_0',
        mapId: 'LittlerootTown',
        coord: { x: 5, y: 4 },
        elevation: 3,
        kind: 'npc',
        graphicsId: 'asset_npc_mom',
        movementType: 'WANDER_AROUND',
        scriptId: 'LittlerootTown_Mom',
        flagId: null,
        trainerType: null,
        metadata: {},
      },
    ],
    dialogue: [
      {
        id: 'Text_OakIntro',
        name: 'Text_OakIntro',
        speakerName: 'Oak',
        portraitAssetId: 'asset_portrait_oak',
        text: 'Hello there!',
        choices: [],
      },
    ],
    scriptSteps: [
      step('Script#0', 'play_sound', {
        macro: 'playse',
        args: ['asset_se_door'],
        soundId: 'asset_se_door',
      }),
    ],
  };
}

describe('findAssetReferences', () => {
  it('returns all-empty lists for an asset with no references', () => {
    const r = findAssetReferences(makeManifest(), 'asset_orphan');
    expect(r.maps).toEqual([]);
    expect(r.objectEvents).toEqual([]);
    expect(r.dialogueNodes).toEqual([]);
    expect(r.scriptSteps).toEqual([]);
  });

  it('surfaces a Map reference with role=tileset when the asset is in tilesetIds', () => {
    const r = findAssetReferences(makeManifest(), 'asset_tileset_route101');
    expect(r.maps).toHaveLength(1);
    expect(r.maps[0]?.map.id).toBe('LittlerootTown');
    expect(r.maps[0]?.role).toBe('tileset');
  });

  it('surfaces a Map reference with role=music when the asset is the map music', () => {
    const r = findAssetReferences(makeManifest(), 'asset_music_littleroot');
    expect(r.maps).toHaveLength(1);
    expect(r.maps[0]?.role).toBe('music');
  });

  it('surfaces an ObjectEvent reference via graphicsId', () => {
    const r = findAssetReferences(makeManifest(), 'asset_npc_mom');
    expect(r.objectEvents).toHaveLength(1);
    expect(r.objectEvents[0]?.id).toBe('objectEvent_LittlerootTown_0');
  });

  it('surfaces a DialogueNode reference via portraitAssetId', () => {
    const r = findAssetReferences(makeManifest(), 'asset_portrait_oak');
    expect(r.dialogueNodes).toHaveLength(1);
    expect(r.dialogueNodes[0]?.id).toBe('Text_OakIntro');
  });

  it('surfaces a ScriptStep reference via params.soundId (playse / playbgm / playfanfare)', () => {
    const r = findAssetReferences(makeManifest(), 'asset_se_door');
    expect(r.scriptSteps).toHaveLength(1);
    expect(r.scriptSteps[0]?.id).toBe('Script#0');
  });
});
