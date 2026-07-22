import { describe, expect, it } from 'vitest';
import type { ProjectManifest, ScriptStep } from '@rom-editor/shared';
import { emptyManifest } from '@rom-editor/shared';
import { findEntityReferences } from './entityReferences';

function step(id: string, kind: ScriptStep['kind'], params: Record<string, unknown>): ScriptStep {
  return { id, kind, params };
}

function makeManifest(): ProjectManifest {
  const base = emptyManifest('/tmp/x', '2026-05-16T00:00:00Z');
  return {
    ...base,
    maps: [
      {
        id: 'Town', name: 'Town', group: 'town',
        dimensions: { width: 10, height: 10 },
        tilesetIds: ['asset_tiles'], warpIds: [], scriptIds: [], objectEventIds: [],
        encounterTableIds: [], musicId: 'asset_song', metadata: {},
      },
      {
        id: 'Route1', name: 'Route1', group: 'route',
        dimensions: { width: 30, height: 8 },
        tilesetIds: [], warpIds: [], scriptIds: [], objectEventIds: [],
        encounterTableIds: [], musicId: null, metadata: {},
      },
    ],
    warps: [
      {
        id: 'warp_town_to_route',
        name: 'warp_town_to_route',
        fromMapId: 'Town',
        fromCoord: { x: 5, y: 9 },
        toMapId: 'Route1',
        toCoord: { x: 0, y: 4 },
      },
    ],
    objectEvents: [
      {
        id: 'obj_mom',
        name: 'obj_mom',
        mapId: 'Town',
        coord: { x: 4, y: 4 },
        elevation: 3,
        kind: 'npc',
        graphicsId: 'asset_npc',
        movementType: 'WANDER',
        scriptId: 'TownMom',
        flagId: 'FLAG_HIDE_MOM',
        trainerType: null,
        metadata: {},
      },
    ],
    triggers: [
      {
        id: 'trig_intro',
        name: 'trig_intro',
        kind: 'on_enter',
        mapId: 'Town',
        coord: { x: 1, y: 1 },
        conditionExpression: null,
        scriptStepIds: ['TownIntro#0', 'TownIntro#1'],
      },
    ],
    flags: [
      { id: 'FLAG_HIDE_MOM', name: 'FLAG_HIDE_MOM', scope: 'global', defaultValue: false, description: null, engineValue: '0x801' },
    ],
    variables: [
      { id: 'VAR_INTRO', name: 'VAR_INTRO', scope: 'global', defaultValue: 0, description: null, engineValue: '0x4001' },
    ],
    dialogue: [
      {
        id: 'Text_MomHi',
        name: 'Text_MomHi',
        speakerName: 'Mom',
        portraitAssetId: 'asset_portrait',
        text: 'Hi!',
        choices: [
          { label: 'Continue', nextDialogueId: null, setsFlagIds: ['FLAG_HIDE_MOM'] },
        ],
      },
    ],
    scriptSteps: [
      step('TownIntro#0', 'dialogue', { macro: 'msgbox', args: ['Text_MomHi'], text: 'Text_MomHi' }),
      step('TownIntro#1', 'set_flag', { macro: 'setflag', args: ['FLAG_HIDE_MOM'], flag: 'FLAG_HIDE_MOM' }),
      step('TownMom#0', 'set_variable', { macro: 'setvar', args: ['VAR_INTRO', '1'], variable: 'VAR_INTRO', value: '1' }),
    ],
    assets: [
      { id: 'asset_tiles', name: 'asset_tiles', kind: 'tileset', relativePath: 'graphics/tilesets/town.png', metadata: {} },
      { id: 'asset_song', name: 'asset_song', kind: 'music', relativePath: 'sound/songs/town.aif', metadata: {} },
      { id: 'asset_npc', name: 'asset_npc', kind: 'overworld_sprite', relativePath: 'graphics/object_events/mom.png', metadata: {} },
      { id: 'asset_portrait', name: 'asset_portrait', kind: 'portrait', relativePath: 'graphics/portraits/mom.png', metadata: {} },
    ],
    encounterTables: [
      { id: 'enc_route1', name: 'enc_route1', mapId: 'Route1', type: 'grass', encounterRate: 30, slots: [] },
    ],
  };
}

describe('findEntityReferences', () => {
  it('returns found=false for unknown entity ids', () => {
    const r = findEntityReferences(makeManifest(), 'map', 'NoSuchMap');
    expect(r.found).toBe(false);
    expect(r.inbound).toEqual([]);
    expect(r.outbound).toEqual([]);
  });

  it('reports inbound warps + outbound warps/objects/triggers/tilesets/music for a map', () => {
    const r = findEntityReferences(makeManifest(), 'map', 'Town');
    expect(r.found).toBe(true);
    // Outbound: warp out, object event, trigger, tileset asset, music asset
    expect(r.outbound.map((l) => l.id)).toEqual(
      expect.arrayContaining(['warp_town_to_route', 'obj_mom', 'trig_intro', 'asset_tiles', 'asset_song']),
    );
    // Inbound: route1's warp doesn't lead back to town in this fixture, so empty.
    expect(r.inbound).toEqual([]);

    // Route1 has inbound warp from town and outbound encounter table.
    const r2 = findEntityReferences(makeManifest(), 'map', 'Route1');
    expect(r2.inbound.map((l) => l.id)).toContain('warp_town_to_route');
    expect(r2.outbound.map((l) => l.id)).toContain('enc_route1');
  });

  it('reports inbound for a flag (object events, script steps, dialogue choices)', () => {
    const r = findEntityReferences(makeManifest(), 'flag', 'FLAG_HIDE_MOM');
    const ids = r.inbound.map((l) => l.id);
    expect(ids).toContain('obj_mom');
    expect(ids).toContain('TownIntro#1');
    expect(ids).toContain('Text_MomHi');
  });

  it('reports asset references (maps as tileset/music + object events + dialogue portrait)', () => {
    const tiles = findEntityReferences(makeManifest(), 'asset', 'asset_tiles');
    expect(tiles.inbound.map((l) => l.id)).toContain('Town');
    const npc = findEntityReferences(makeManifest(), 'asset', 'asset_npc');
    expect(npc.inbound.map((l) => l.id)).toContain('obj_mom');
    const portrait = findEntityReferences(makeManifest(), 'asset', 'asset_portrait');
    expect(portrait.inbound.map((l) => l.id)).toContain('Text_MomHi');
  });

  it('reports outbound for an object event (its map / flag / script first step / graphics)', () => {
    const r = findEntityReferences(makeManifest(), 'object_event', 'obj_mom');
    const ids = r.outbound.map((l) => l.id);
    expect(ids).toEqual(expect.arrayContaining(['Town', 'FLAG_HIDE_MOM', 'TownMom#0', 'asset_npc']));
  });

  it('reports outbound for a trigger (its map + script steps)', () => {
    const r = findEntityReferences(makeManifest(), 'trigger', 'trig_intro');
    const ids = r.outbound.map((l) => l.id);
    expect(ids).toEqual(expect.arrayContaining(['Town', 'TownIntro#0', 'TownIntro#1']));
  });

  it('reports inbound for a variable (script steps that touch it)', () => {
    const r = findEntityReferences(makeManifest(), 'variable', 'VAR_INTRO');
    expect(r.inbound.map((l) => l.id)).toContain('TownMom#0');
  });

  it('reports both inbound (parent trigger + object script) and outbound (dialogue/flag/variable) for a script step', () => {
    const r = findEntityReferences(makeManifest(), 'script_step', 'TownIntro#0');
    expect(r.inbound.map((l) => l.id)).toContain('trig_intro');
    expect(r.outbound.map((l) => l.id)).toContain('Text_MomHi');
  });
});
