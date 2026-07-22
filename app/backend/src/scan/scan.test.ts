import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scanProject, readManifest, writeManifest, manifestPathFor } from './index.js';
import { decompScanner } from './decomp.js';
import { detectProject } from '../detect/index.js';
import type { ProjectIdentity } from '@rom-editor/shared';

function makeTempDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'rom-editor-scan-'));
}

function buildDecompFixture(root: string): void {
  writeFileSync(path.join(root, 'Makefile'), 'all:\n\techo build\n');
  writeFileSync(path.join(root, 'pokeemerald.ld'), '/* linker */\n');
  mkdirSync(path.join(root, 'include'));
  mkdirSync(path.join(root, 'src'));
  mkdirSync(path.join(root, 'data'));
  mkdirSync(path.join(root, 'sound'));

  // Three maps:
  //  - LittlerootTown with full map.json
  //  - Route101 with full map.json
  //  - BareMap with NO map.json (directory-only)
  mkdirSync(path.join(root, 'data', 'maps', 'LittlerootTown'), { recursive: true });
  writeFileSync(
    path.join(root, 'data', 'maps', 'LittlerootTown', 'map.json'),
    JSON.stringify({
      id: 'MAP_LITTLEROOT_TOWN',
      name: 'LITTLEROOT_TOWN',
      layout: 'LAYOUT_LITTLEROOT_TOWN',
      music: 'MUS_LITTLEROOT_TOWN',
      region_map_section: 'MAPSEC_LITTLEROOT_TOWN',
      requires_flash: false,
      weather: 'WEATHER_NONE',
      map_type: 'MAP_TYPE_TOWN',
      battle_scene: 'MAP_BATTLE_SCENE_NORMAL',
      connections: null,
      object_events: [{ id: 'o1' }, { id: 'o2' }, { id: 'o3' }],
      warp_events: [{ id: 'w1' }, { id: 'w2' }],
      coord_events: [],
      bg_events: [{ id: 'b1' }],
    }),
  );
  mkdirSync(path.join(root, 'data', 'maps', 'Route101'), { recursive: true });
  writeFileSync(
    path.join(root, 'data', 'maps', 'Route101', 'map.json'),
    JSON.stringify({
      id: 'MAP_ROUTE101',
      name: 'ROUTE101',
      layout: 'LAYOUT_ROUTE101',
      music: 'MUS_ROUTE101',
      map_type: 'MAP_TYPE_ROUTE',
      object_events: [],
      warp_events: [],
      coord_events: [],
      bg_events: [],
    }),
  );
  mkdirSync(path.join(root, 'data', 'maps', 'BareMap'), { recursive: true });
  // No map.json in BareMap
}

describe('decompScanner', () => {
  let dir: string;
  let identity: ProjectIdentity;

  beforeEach(async () => {
    dir = makeTempDir();
    buildDecompFixture(dir);
    identity = await detectProject(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('supports decomp and hybrid identities', () => {
    expect(decompScanner.supports({ ...identity, kind: 'decomp' })).toBe(true);
    expect(decompScanner.supports({ ...identity, kind: 'hybrid' })).toBe(true);
    expect(decompScanner.supports({ ...identity, kind: 'patch' })).toBe(false);
    expect(decompScanner.supports({ ...identity, kind: 'unknown' })).toBe(false);
  });

  it('emits one MapNode per data/maps/ subdirectory', async () => {
    const result = await decompScanner.scan(dir, identity);
    expect(result.manifest.maps).toHaveLength(3);
    const ids = result.manifest.maps.map((m) => m.id).sort();
    expect(ids).toEqual(['MAP_BAREMAP', 'MAP_LITTLEROOT_TOWN', 'MAP_ROUTE101']);
  });

  it('parses map.json into MapNode fields with correct group mapping', async () => {
    const result = await decompScanner.scan(dir, identity);
    const town = result.manifest.maps.find((m) => m.id === 'MAP_LITTLEROOT_TOWN');
    expect(town).toBeDefined();
    expect(town?.name).toBe('LITTLEROOT_TOWN');
    expect(town?.group).toBe('town');
    expect(town?.musicId).toBe('MUS_LITTLEROOT_TOWN');
    expect(town?.metadata['layout']).toBe('LAYOUT_LITTLEROOT_TOWN');
    expect(town?.metadata['object_event_count']).toBe(3);
    expect(town?.metadata['warp_event_count']).toBe(2);
    expect(town?.metadata['region_map_section']).toBe('MAPSEC_LITTLEROOT_TOWN');

    const route = result.manifest.maps.find((m) => m.id === 'MAP_ROUTE101');
    expect(route?.group).toBe('route');
  });

  it('falls back to directory-name id for a map without map.json (no warning)', async () => {
    const result = await decompScanner.scan(dir, identity);
    const bare = result.manifest.maps.find((m) => m.id === 'MAP_BAREMAP');
    expect(bare).toBeDefined();
    expect(bare?.name).toBe('BareMap');
    expect(bare?.group).toBe('unknown');
    expect(bare?.metadata['sourceDir']).toBe('data/maps/BareMap');
    // No warning for an absent map.json - that's a normal case in some forks.
    expect(result.warnings.some((w) => /BareMap/.test(w))).toBe(false);
  });

  it('records a warning for a malformed map.json without aborting the scan', async () => {
    const broken = path.join(dir, 'data', 'maps', 'BrokenMap');
    mkdirSync(broken);
    writeFileSync(path.join(broken, 'map.json'), '{not valid json');
    const result = await decompScanner.scan(dir, identity);
    expect(result.warnings.some((w) => /BrokenMap/.test(w))).toBe(true);
    // Scan still produced a MapNode for BrokenMap (fallback to dirname)
    const brokenNode = result.manifest.maps.find((m) => m.id === 'MAP_BROKENMAP');
    expect(brokenNode).toBeDefined();
    // Other maps still present
    expect(result.manifest.maps.length).toBeGreaterThanOrEqual(4);
  });

  it('emits a warning (not throw) when data/maps/ is absent entirely', async () => {
    const emptyDir = makeTempDir();
    try {
      writeFileSync(path.join(emptyDir, 'Makefile'), '');
      writeFileSync(path.join(emptyDir, 'pokeemerald.ld'), '');
      mkdirSync(path.join(emptyDir, 'src'));
      mkdirSync(path.join(emptyDir, 'include'));
      mkdirSync(path.join(emptyDir, 'data'));
      const id = await detectProject(emptyDir);
      const result = await decompScanner.scan(emptyDir, id);
      expect(result.manifest.maps).toHaveLength(0);
      expect(result.warnings.some((w) => /No data\/maps\//.test(w))).toBe(true);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it('produces a manifest whose identity field reflects the detected identity', async () => {
    const result = await decompScanner.scan(dir, identity);
    expect(result.manifest.identity.kind).toBe('decomp');
    expect(result.manifest.identity.baseGame).toBe('pokeemerald');
  });

  it('sorts maps by id for stable serialization', async () => {
    const result = await decompScanner.scan(dir, identity);
    const ids = result.manifest.maps.map((m) => m.id);
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
  });

  describe('event extraction', () => {
    it('emits Warps with both endpoints resolved (bidirectional traversal)', async () => {
      // Add a second map with a warp back into LittlerootTown
      const houseDir = path.join(dir, 'data', 'maps', 'BrendansHouse');
      mkdirSync(houseDir, { recursive: true });
      writeFileSync(
        path.join(houseDir, 'map.json'),
        JSON.stringify({
          id: 'MAP_BRENDANS_HOUSE',
          name: 'BRENDANS_HOUSE',
          map_type: 'MAP_TYPE_INDOOR',
          object_events: [],
          warp_events: [
            { x: 4, y: 8, elevation: 0, dest_map: 'MAP_LITTLEROOT_TOWN', dest_warp_id: '0' },
          ],
          coord_events: [],
          bg_events: [],
        }),
      );
      // Give LittlerootTown a warp into the house at index 0
      writeFileSync(
        path.join(dir, 'data', 'maps', 'LittlerootTown', 'map.json'),
        JSON.stringify({
          id: 'MAP_LITTLEROOT_TOWN',
          name: 'LITTLEROOT_TOWN',
          map_type: 'MAP_TYPE_TOWN',
          object_events: [],
          warp_events: [
            { x: 10, y: 12, elevation: 0, dest_map: 'MAP_BRENDANS_HOUSE', dest_warp_id: '0' },
          ],
          coord_events: [],
          bg_events: [],
        }),
      );

      const result = await decompScanner.scan(dir, identity);
      expect(result.manifest.warps.length).toBe(2);
      const outbound = result.manifest.warps.find((w) => w.fromMapId === 'MAP_LITTLEROOT_TOWN');
      const inbound = result.manifest.warps.find((w) => w.fromMapId === 'MAP_BRENDANS_HOUSE');
      expect(outbound).toBeDefined();
      expect(inbound).toBeDefined();
      expect(outbound?.toMapId).toBe('MAP_BRENDANS_HOUSE');
      expect(inbound?.toMapId).toBe('MAP_LITTLEROOT_TOWN');
      // Outbound warp's destination coord should equal inbound warp's from coord
      expect(outbound?.toCoord).toEqual({ x: 4, y: 8 });
      expect(inbound?.toCoord).toEqual({ x: 10, y: 12 });
      // MapNode.warpIds is populated
      const town = result.manifest.maps.find((m) => m.id === 'MAP_LITTLEROOT_TOWN');
      expect(town?.warpIds).toHaveLength(1);
      expect(town?.warpIds[0]).toBe('MAP_LITTLEROOT_TOWN_warp_0');
    });

    it('warns when a warp references an unknown destination map', async () => {
      writeFileSync(
        path.join(dir, 'data', 'maps', 'LittlerootTown', 'map.json'),
        JSON.stringify({
          id: 'MAP_LITTLEROOT_TOWN',
          name: 'LITTLEROOT_TOWN',
          map_type: 'MAP_TYPE_TOWN',
          object_events: [],
          warp_events: [{ x: 1, y: 2, dest_map: 'MAP_DOES_NOT_EXIST', dest_warp_id: '0' }],
          coord_events: [],
          bg_events: [],
        }),
      );
      const result = await decompScanner.scan(dir, identity);
      expect(result.warnings.some((w) => /MAP_DOES_NOT_EXIST/.test(w))).toBe(true);
      const w = result.manifest.warps.find((w2) => w2.fromMapId === 'MAP_LITTLEROOT_TOWN');
      expect(w?.toMapId).toBe('MAP_DOES_NOT_EXIST');
      expect(w?.toCoord).toEqual({ x: 0, y: 0 });
    });

    it('emits Triggers from coord_events with on_enter kind + condition', async () => {
      writeFileSync(
        path.join(dir, 'data', 'maps', 'LittlerootTown', 'map.json'),
        JSON.stringify({
          id: 'MAP_LITTLEROOT_TOWN',
          name: 'LITTLEROOT_TOWN',
          map_type: 'MAP_TYPE_TOWN',
          object_events: [],
          warp_events: [],
          coord_events: [
            {
              type: 'trigger',
              x: 7,
              y: 8,
              elevation: 0,
              var: 'VAR_INTRO_STATE',
              var_value: '1',
              script: 'IntroScript',
            },
          ],
          bg_events: [],
        }),
      );
      const result = await decompScanner.scan(dir, identity);
      const trigger = result.manifest.triggers.find((t) => t.id === 'MAP_LITTLEROOT_TOWN_coord_0');
      expect(trigger).toBeDefined();
      expect(trigger?.kind).toBe('on_enter');
      expect(trigger?.mapId).toBe('MAP_LITTLEROOT_TOWN');
      expect(trigger?.coord).toEqual({ x: 7, y: 8 });
      expect(trigger?.conditionExpression).toBe('VAR_INTRO_STATE == 1');
      expect(trigger?.name).toBe('IntroScript');
    });

    it('emits Triggers from bg_events with on_interact kind + optional facing condition', async () => {
      writeFileSync(
        path.join(dir, 'data', 'maps', 'LittlerootTown', 'map.json'),
        JSON.stringify({
          id: 'MAP_LITTLEROOT_TOWN',
          name: 'LITTLEROOT_TOWN',
          map_type: 'MAP_TYPE_TOWN',
          object_events: [],
          warp_events: [],
          coord_events: [],
          bg_events: [
            {
              type: 'sign',
              x: 4,
              y: 5,
              elevation: 0,
              player_facing_dir: 'BG_EVENT_PLAYER_FACING_NORTH',
              script: 'RouteSignScript',
            },
            {
              type: 'sign',
              x: 9,
              y: 5,
              elevation: 0,
              player_facing_dir: 'BG_EVENT_PLAYER_FACING_ANY',
              script: 'OtherSign',
            },
          ],
        }),
      );
      const result = await decompScanner.scan(dir, identity);
      const triggers = result.manifest.triggers.filter((t) => t.kind === 'on_interact');
      expect(triggers).toHaveLength(2);
      const directional = triggers.find((t) => t.id.endsWith('bg_0'));
      const omnidir = triggers.find((t) => t.id.endsWith('bg_1'));
      expect(directional?.conditionExpression).toBe('facing == BG_EVENT_PLAYER_FACING_NORTH');
      expect(omnidir?.conditionExpression).toBeNull();
    });

    it('emits ObjectEvents with kind=trainer/npc inferred from trainer_type and script', async () => {
      writeFileSync(
        path.join(dir, 'data', 'maps', 'LittlerootTown', 'map.json'),
        JSON.stringify({
          id: 'MAP_LITTLEROOT_TOWN',
          name: 'LITTLEROOT_TOWN',
          map_type: 'MAP_TYPE_TOWN',
          warp_events: [],
          coord_events: [],
          bg_events: [],
          object_events: [
            {
              graphics_id: 'OBJ_EVENT_GFX_LITTLE_BOY_1',
              x: 11,
              y: 6,
              elevation: 3,
              movement_type: 'MOVEMENT_TYPE_FACE_DOWN',
              movement_range_x: 0,
              movement_range_y: 0,
              trainer_type: 'TRAINER_TYPE_NONE',
              trainer_sight_or_berry_tree_id: '0',
              script: 'LittlerootTown_EventScript_Boy',
              flag: 'FLAG_HIDE_LITTLEROOT_INTRO_BOY',
            },
            {
              graphics_id: 'OBJ_EVENT_GFX_YOUNGSTER',
              x: 5,
              y: 7,
              elevation: 3,
              movement_type: 'MOVEMENT_TYPE_LOOK_AROUND',
              trainer_type: 'TRAINER_TYPE_NORMAL',
              trainer_sight_or_berry_tree_id: '4',
              script: 'Trainer_LittlerootTown_BattleYoungster',
              flag: '0',
            },
            {
              graphics_id: 'OBJ_EVENT_GFX_ITEM_BALL',
              x: 3,
              y: 9,
              elevation: 3,
              movement_type: 'MOVEMENT_TYPE_NONE',
              trainer_type: 'TRAINER_TYPE_NONE',
              script: 'LittlerootTown_EventScript_ItemPotion',
              flag: 'FLAG_ITEM_LITTLEROOT_POTION',
            },
          ],
        }),
      );
      const result = await decompScanner.scan(dir, identity);
      expect(result.manifest.objectEvents).toHaveLength(3);
      const npc = result.manifest.objectEvents.find((o) => o.id.endsWith('obj_0'));
      const trainer = result.manifest.objectEvents.find((o) => o.id.endsWith('obj_1'));
      const item = result.manifest.objectEvents.find((o) => o.id.endsWith('obj_2'));
      expect(npc?.kind).toBe('npc');
      expect(npc?.graphicsId).toBe('OBJ_EVENT_GFX_LITTLE_BOY_1');
      expect(npc?.scriptId).toBe('LittlerootTown_EventScript_Boy');
      expect(npc?.flagId).toBe('FLAG_HIDE_LITTLEROOT_INTRO_BOY');
      expect(npc?.coord).toEqual({ x: 11, y: 6 });
      expect(npc?.elevation).toBe(3);
      expect(trainer?.kind).toBe('trainer');
      expect(trainer?.trainerType).toBe('TRAINER_TYPE_NORMAL');
      expect(item?.kind).toBe('item');
    });

    it('populates ScriptStep entries from data/maps/*/scripts.inc and resolves Trigger.scriptStepIds', async () => {
      // Map has a bg_event whose script is referenced in scripts.inc
      writeFileSync(
        path.join(dir, 'data', 'maps', 'LittlerootTown', 'map.json'),
        JSON.stringify({
          id: 'MAP_LITTLEROOT_TOWN',
          name: 'LITTLEROOT_TOWN',
          map_type: 'MAP_TYPE_TOWN',
          object_events: [],
          warp_events: [],
          coord_events: [],
          bg_events: [
            {
              type: 'sign',
              x: 4,
              y: 5,
              elevation: 0,
              player_facing_dir: 'BG_EVENT_PLAYER_FACING_ANY',
              script: 'LittlerootTown_Sign',
            },
          ],
        }),
      );
      writeFileSync(
        path.join(dir, 'data', 'maps', 'LittlerootTown', 'scripts.inc'),
        `LittlerootTown_Sign::\n\tlock\n\tmsgbox LittlerootTown_Text_Sign, MSGBOX_SIGN\n\trelease\n\tend\n`,
      );
      const result = await decompScanner.scan(dir, identity);
      expect(result.manifest.scriptSteps.length).toBeGreaterThanOrEqual(4);
      const trigger = result.manifest.triggers.find((t) => t.id === 'MAP_LITTLEROOT_TOWN_bg_0');
      expect(trigger).toBeDefined();
      expect(trigger?.scriptStepIds.length).toBe(4); // lock, msgbox, release, end
      expect(trigger?.scriptStepIds[0]).toBe('LittlerootTown_Sign__0');
      const msgbox = result.manifest.scriptSteps.find((s) => s.id === 'LittlerootTown_Sign__1');
      expect(msgbox?.kind).toBe('dialogue');
      expect(msgbox?.params['text']).toBe('LittlerootTown_Text_Sign');
    });

    it('populates Asset entities from graphics/ and sound/ trees', async () => {
      mkdirSync(path.join(dir, 'graphics', 'object_events', 'pics'), { recursive: true });
      mkdirSync(path.join(dir, 'graphics', 'tilesets'), { recursive: true });
      mkdirSync(path.join(dir, 'sound', 'songs'), { recursive: true });
      writeFileSync(path.join(dir, 'graphics', 'object_events', 'pics', 'npc.png'), 'png');
      writeFileSync(path.join(dir, 'graphics', 'tilesets', 'tile.png'), 'png');
      writeFileSync(path.join(dir, 'sound', 'songs', 'bgm.aif'), 'aif');
      const result = await decompScanner.scan(dir, identity);
      const ids = result.manifest.assets.map((a) => a.id);
      expect(ids).toContain('graphics/object_events/pics/npc.png');
      expect(ids).toContain('graphics/tilesets/tile.png');
      expect(ids).toContain('sound/songs/bgm.aif');
      const npc = result.manifest.assets.find((a) => a.id === 'graphics/object_events/pics/npc.png');
      expect(npc?.kind).toBe('overworld_sprite');
      const bgm = result.manifest.assets.find((a) => a.id === 'sound/songs/bgm.aif');
      expect(bgm?.kind).toBe('music');
    });

    it('populates DialogueNode entities from data/maps/*/text.inc with speaker extracted from label', async () => {
      writeFileSync(
        path.join(dir, 'data', 'maps', 'LittlerootTown', 'text.inc'),
        `LittlerootTown_Mom_Text_WelcomeHome::\n\t.string "Hi, honey!$"\n\nLittlerootTown_Mom_Text_HouseTour::\n\t.string "Wanna look around?$"\n`,
      );
      const result = await decompScanner.scan(dir, identity);
      expect(result.manifest.dialogue.length).toBeGreaterThanOrEqual(2);
      const welcome = result.manifest.dialogue.find(
        (d) => d.id === 'LittlerootTown_Mom_Text_WelcomeHome',
      );
      expect(welcome?.text).toBe('Hi, honey!');
      expect(welcome?.speakerName).toBe('Mom');
    });

    it('populates Trainer entities from src/data/{trainers,trainer_parties}.h with resolved parties', async () => {
      mkdirSync(path.join(dir, 'src', 'data'), { recursive: true });
      writeFileSync(
        path.join(dir, 'src', 'data', 'trainers.h'),
        `const struct Trainer gTrainers[] = {
  [TRAINER_NONE] = {
    .trainerClass = TRAINER_CLASS_PKMN_TRAINER_1,
    .trainerName = _(""),
    .aiFlags = 0,
    .party = {.NoItemDefaultMoves = NULL},
  },
  [TRAINER_SAWYER_1] = {
    .trainerClass = TRAINER_CLASS_CAMPER,
    .trainerName = _("SAWYER"),
    .aiFlags = AI_SCRIPT_CHECK_BAD_MOVE,
    .party = {.NoItemDefaultMoves = sParty_Sawyer1},
  },
};`,
      );
      writeFileSync(
        path.join(dir, 'src', 'data', 'trainer_parties.h'),
        `static const struct TrainerMon sParty_Sawyer1[] = {
  { .lvl = 7, .species = SPECIES_SEEDOT },
  { .lvl = 8, .species = SPECIES_NUMEL },
};`,
      );
      const result = await decompScanner.scan(dir, identity);
      expect(result.manifest.trainers).toHaveLength(2);
      const sawyer = result.manifest.trainers.find((t) => t.id === 'TRAINER_SAWYER_1');
      expect(sawyer?.party).toHaveLength(2);
      expect(sawyer?.party[0]?.speciesId).toBe('SPECIES_SEEDOT');
      expect(sawyer?.party[1]?.level).toBe(8);
    });

    it('populates EncounterTable entities from wild_encounters.json and links MapNode.encounterTableIds', async () => {
      mkdirSync(path.join(dir, 'src', 'data'), { recursive: true });
      writeFileSync(
        path.join(dir, 'src', 'data', 'wild_encounters.json'),
        JSON.stringify({
          wild_encounter_groups: [
            {
              fields: [{ type: 'land_mons', encounter_rates: [20, 20] }],
              encounters: [
                {
                  map: 'MAP_LITTLEROOT_TOWN',
                  base_label: 'gLittlerootTown',
                  land_mons: {
                    encounter_rate: 10,
                    mons: [
                      { min_level: 3, max_level: 4, species: 'SPECIES_POOCHYENA' },
                      { min_level: 3, max_level: 4, species: 'SPECIES_ZIGZAGOON' },
                    ],
                  },
                },
              ],
            },
          ],
        }),
      );
      const result = await decompScanner.scan(dir, identity);
      expect(result.manifest.encounterTables).toHaveLength(1);
      const t = result.manifest.encounterTables[0];
      expect(t?.type).toBe('grass');
      expect(t?.mapId).toBe('MAP_LITTLEROOT_TOWN');
      expect(t?.slots).toHaveLength(2);
      expect(t?.encounterRate).toBe(10);
      const town = result.manifest.maps.find((m) => m.id === 'MAP_LITTLEROOT_TOWN');
      expect(town?.encounterTableIds).toEqual(['gLittlerootTown_grass']);
    });

    it('populates Flag/Variable entities from include/constants/{flags,vars}.h when present', async () => {
      mkdirSync(path.join(dir, 'include', 'constants'), { recursive: true });
      writeFileSync(
        path.join(dir, 'include', 'constants', 'flags.h'),
        `// Story flags\n#define FLAG_VISITED_LITTLEROOT 0x800  // First town visited\n#define FLAG_BADGE01_GET 0x807\n#define FLAG_TEMP_BOULDER 0x10\n`,
      );
      writeFileSync(
        path.join(dir, 'include', 'constants', 'vars.h'),
        `#define VAR_LITTLEROOT_INTRO_STATE 0x4080  // Tracks intro cutscene step\n#define VAR_TEMP_0 0x0\n`,
      );
      const result = await decompScanner.scan(dir, identity);
      expect(result.manifest.flags.length).toBe(3);
      expect(result.manifest.variables.length).toBe(2);
      const visited = result.manifest.flags.find((f) => f.id === 'FLAG_VISITED_LITTLEROOT');
      expect(visited?.scope).toBe('global');
      expect(visited?.description).toBe('First town visited');
      const temp = result.manifest.flags.find((f) => f.id === 'FLAG_TEMP_BOULDER');
      expect(temp?.scope).toBe('temporary');
      const introVar = result.manifest.variables.find((v) => v.id === 'VAR_LITTLEROOT_INTRO_STATE');
      expect(introVar?.description).toBe('Tracks intro cutscene step');
      // Stable sorted
      const flagIds = result.manifest.flags.map((f) => f.id);
      expect(flagIds).toEqual([...flagIds].sort());
    });

    it('warns (but does not fail) when flags.h / vars.h are absent', async () => {
      const result = await decompScanner.scan(dir, identity);
      expect(result.manifest.flags).toHaveLength(0);
      expect(result.manifest.variables).toHaveLength(0);
      expect(result.warnings.some((w) => /flags\.h/.test(w))).toBe(true);
      expect(result.warnings.some((w) => /vars\.h/.test(w))).toBe(true);
    });

    it('populates MapNode.objectEventIds / warpIds / scriptIds references', async () => {
      writeFileSync(
        path.join(dir, 'data', 'maps', 'LittlerootTown', 'map.json'),
        JSON.stringify({
          id: 'MAP_LITTLEROOT_TOWN',
          name: 'LITTLEROOT_TOWN',
          map_type: 'MAP_TYPE_TOWN',
          warp_events: [{ x: 1, y: 1, dest_map: 'MAP_ROUTE101', dest_warp_id: '0' }],
          coord_events: [],
          bg_events: [],
          object_events: [
            { graphics_id: 'X', x: 2, y: 2, elevation: 0, trainer_type: 'TRAINER_TYPE_NONE', script: 'NpcScript', flag: '0' },
          ],
        }),
      );
      writeFileSync(
        path.join(dir, 'data', 'maps', 'Route101', 'map.json'),
        JSON.stringify({
          id: 'MAP_ROUTE101',
          name: 'ROUTE101',
          map_type: 'MAP_TYPE_ROUTE',
          warp_events: [{ x: 5, y: 5, dest_map: 'MAP_LITTLEROOT_TOWN', dest_warp_id: '0' }],
          coord_events: [],
          bg_events: [],
          object_events: [],
        }),
      );
      const result = await decompScanner.scan(dir, identity);
      const town = result.manifest.maps.find((m) => m.id === 'MAP_LITTLEROOT_TOWN');
      expect(town?.warpIds).toEqual(['MAP_LITTLEROOT_TOWN_warp_0']);
      expect(town?.objectEventIds).toEqual(['MAP_LITTLEROOT_TOWN_obj_0']);
    });
  });
});

describe('scanProject orchestrator', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('uses the decomp scanner for a decomp identity', async () => {
    buildDecompFixture(dir);
    const result = await scanProject(dir);
    expect(result.scannerName).toBe('DecompScanner');
    expect(result.manifest.maps.length).toBeGreaterThan(0);
  });

  it('falls back to NoOpScanner for an unknown project, returning an empty but valid manifest', async () => {
    // empty dir - no decomp/patch signals
    const result = await scanProject(dir);
    expect(result.scannerName).toBe('NoOpScanner');
    expect(result.manifest.maps).toHaveLength(0);
    expect(result.manifest.identity.kind).toBe('unknown');
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('honors an explicitly provided identity', async () => {
    buildDecompFixture(dir);
    const forcedIdentity: ProjectIdentity = {
      kind: 'decomp',
      confidence: 1,
      displayName: 'forced-pokeemerald',
      baseGame: 'pokeemerald',
      fork: null,
      featureFlags: [],
      warnings: [],
      evidence: [],
    };
    const result = await scanProject(dir, { identity: forcedIdentity });
    expect(result.manifest.identity.displayName).toBe('forced-pokeemerald');
  });
});

describe('manifest IO', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes the manifest to <projectRoot>/.editor/manifest.json and reads it back identically', async () => {
    buildDecompFixture(dir);
    const result = await scanProject(dir);
    const manifestPath = await writeManifest(dir, result.manifest);
    expect(manifestPath).toBe(manifestPathFor(dir));
    expect(existsSync(manifestPath)).toBe(true);
    // The on-disk JSON parses back to a structurally-equal manifest.
    const onDisk = JSON.parse(readFileSync(manifestPath, 'utf8'));
    expect(onDisk.schemaVersion).toBe(1);
    expect(onDisk.maps.map((m: { id: string }) => m.id).sort()).toEqual(
      result.manifest.maps.map((m) => m.id).sort(),
    );
    const reread = await readManifest(dir);
    expect(reread).not.toBeNull();
    expect(reread?.maps.length).toBe(result.manifest.maps.length);
  });

  it('readManifest returns null when no manifest exists yet', async () => {
    const m = await readManifest(dir);
    expect(m).toBeNull();
  });

  it('readManifest returns null for an unsupported schemaVersion', async () => {
    mkdirSync(path.join(dir, '.editor'), { recursive: true });
    writeFileSync(
      path.join(dir, '.editor', 'manifest.json'),
      JSON.stringify({ schemaVersion: 99 }),
    );
    const m = await readManifest(dir);
    expect(m).toBeNull();
  });
});
