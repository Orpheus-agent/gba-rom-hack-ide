/* BW demake #136 - opening slice geography: Nuvema Town <-> Route 1 <-> Accumula
 * Town, all on the shared gTileset_BwNuvema, connected vertically. Re-authors
 * Nuvema (adds the up-connection). Best-effort visuals; real geometry/collision/
 * connections. Run: tsx src/bw/build-slice.ts  (tileset must already exist via
 * build-nuvema.ts; we reuse gTileset_BwNuvema and recompute grass/obstacle.) */
import { promises as fs } from 'node:fs';
import { graphics } from '@rom-introspection/engine';
import { writeDecompLayout, type LayoutCellSpec } from '../decomp/write-layout.js';
import {
  writeDecompMap,
  type MapJson,
  type MapConnection,
  type MapObjectEvent,
} from '../decomp/write-map.js';
import { writeFileAtomic, appendLineIfMissing } from '../decomp/decomp-write-util.js';
import { buildPartyTrainer, writeDecompTrainer } from '../decomp/write-trainer.js';
import { writeDecompTileset } from '../decomp/write-tileset.js';
import { reskinTrainer } from '../events/trainer-party-edit.js';
import type { PartyMon } from '../scan/trainers-party.js';

const PROJECT = 'C:/path/to/pokefirered-expansion';
const ETS = 'C:/path/to/ETS v2.5.png';
// IMPORTANT: a CUSTOM tileset used as the field PRIMARY makes all field object
// sprites (player + NPCs) invisible (FRLG only ships gTileset_General/Building as
// primaries; the field/sprite system depends on that). Confirmed live in mGBA.
// FIX: the ETS tileset is a SECONDARY paired with the vanilla General primary;
// layout cells reference its metatiles at NUM_METATILES_IN_PRIMARY(640)+local.
const PRIMARY = 'gTileset_General';
const SECONDARY = 'gTileset_BwNuvema';
const SEC_MT_BASE = 640; // NUM_METATILES_IN_PRIMARY - secondary metatiles start here

function metatileAvg(px: Uint8Array, w: number, m: number): { r: number; g: number; b: number } {
  const perRow = w / 16;
  const mx = (m % perRow) * 16;
  const my = Math.floor(m / perRow) * 16;
  let r = 0;
  let g = 0;
  let b = 0;
  for (let y = 0; y < 16; y++)
    for (let x = 0; x < 16; x++) {
      const o = ((my + y) * w + (mx + x)) * 4;
      r += px[o] ?? 0;
      g += px[o + 1] ?? 0;
      b += px[o + 2] ?? 0;
    }
  return { r: r / 256, g: g / 256, b: b / 256 };
}

function baseMap(
  id: string,
  name: string,
  layout: string,
  connections: MapConnection[],
  objectEvents: MapObjectEvent[] = [],
  music = 'MUS_PALLET',
): MapJson {
  return {
    id,
    name,
    layout,
    music,
    region_map_section: 'MAPSEC_PALLET_TOWN',
    requires_flash: false,
    weather: 'WEATHER_SUNNY',
    map_type: 'MAP_TYPE_TOWN',
    allow_cycling: true,
    allow_escaping: false,
    allow_running: true,
    // All BW maps currently share MAPSEC_PALLET_TOWN, so the entry banner would
    // wrongly flash "PALLET TOWN". Suppress it until real region-map names are
    // reskinned (edit region_map_sections.json names + per-map mapsec param).
    show_map_name: false,
    floor_number: 0,
    battle_scene: 'MAP_BATTLE_SCENE_NORMAL',
    connections,
    object_events: objectEvents,
    warp_events: [],
    coord_events: [],
    bg_events: [],
  };
}

/** A simple wandering/standing NPC object-event. */
function npc(graphicsId: string, x: number, y: number, script: string, movement = 'MOVEMENT_TYPE_FACE_DOWN', flag = '0'): MapObjectEvent {
  // OBJ_EVENT_GFX_ITEM_BALL softlocks the field load with FACE_DOWN (its sprite has no
  // directional frames); vanilla always uses LOOK_AROUND for it. Force it so no caller
  // can reintroduce that softlock (root cause of the 2026-06-01 gift-box black screen).
  if (graphicsId === 'OBJ_EVENT_GFX_ITEM_BALL' && movement === 'MOVEMENT_TYPE_FACE_DOWN') {
    movement = 'MOVEMENT_TYPE_LOOK_AROUND';
  }
  return {
    type: 'object',
    graphics_id: graphicsId,
    x,
    y,
    elevation: 3,
    movement_type: movement,
    movement_range_x: 1,
    movement_range_y: 1,
    trainer_type: 'TRAINER_TYPE_NONE',
    trainer_sight_or_berry_tree_id: '0',
    script,
    flag,
  };
}

/** Write a map's scripts.inc: the required <Name>_MapScripts table + any
 *  talk-script blocks. Overwrites the writeDecompMap stub so build-slice owns
 *  the script content (idempotent across re-runs). */
async function writeMapScripts(
  name: string,
  talkScripts: Array<{ label: string; textLabel: string; text: string }>,
  rawBlocks: string[] = [],
): Promise<void> {
  let out = `${name}_MapScripts::\n\t.byte 0\n`;
  for (const s of talkScripts) {
    out += `\n${s.label}::\n\tlock\n\tfaceplayer\n\tmsgbox ${s.textLabel}, MSGBOX_NPC\n\trelease\n\tend\n`;
    out += `\n${s.textLabel}:\n\t.string "${s.text}$"\n`;
  }
  for (const raw of rawBlocks) out += `\n${raw.trim()}\n`;
  await writeFileAtomic(`${PROJECT}/data/maps/${name}/scripts.inc`, out);
}

interface WildMon {
  min_level: number;
  max_level: number;
  species: string;
}

/** Build a 12-entry land mon list from [species, count, minLv, maxLv] rows
 *  (counts should total 12). */
function landMons(rows: Array<[string, number, number, number]>): WildMon[] {
  const out: WildMon[] = [];
  for (const [species, count, lo, hi] of rows)
    for (let i = 0; i < count; i++) out.push({ min_level: lo, max_level: hi, species });
  return out;
}

/** Append a land wild-encounter table for a map to wild_encounters.json
 *  (idempotent by map). `mons` MUST be exactly 12 (land_mons field length). */
async function addWildLand(map: string, baseLabel: string, rate: number, mons: WildMon[]): Promise<void> {
  const wjPath = `${PROJECT}/src/data/wild_encounters.json`;
  const j = JSON.parse(await fs.readFile(wjPath, 'utf8')) as {
    wild_encounter_groups: Array<{ for_maps?: boolean; encounters: Array<Record<string, unknown>> }>;
  };
  const g = j.wild_encounter_groups.find((x) => x.for_maps);
  if (!g) return;
  if (g.encounters.some((e) => e['map'] === map)) return;
  g.encounters.push({ map, base_label: baseLabel, land_mons: { encounter_rate: rate, mons } });
  await writeFileAtomic(wjPath, JSON.stringify(j, null, 2) + '\n');
}

/** A BW gym leader reskinned onto an existing Kanto leader slot (0 net-new
 *  TRAINER_* flags). `party` = [species displayName, level] pairs (moves left to
 *  the engine's level-up defaults → no move-name build-break risk). */
interface GymLeader {
  slot: string; // Kanto TRAINER_LEADER_* slot to reskin
  badgeFlag: string; // FLAG_BADGE0X_GET awarded on win
  name: string; // BW leader display name
  gfx: string; // placeholder OW sprite (tagged for replacement)
  x: number;
  y: number;
  party: Array<[string, number]>;
}

function leaderMon(species: string, level: number): PartyMon {
  return { species, heldItem: null, level, ivs: null, evs: null, ability: null, nature: null, moves: [], extraLines: [] };
}

/** Battle + badge-award script blocks for a gym leader, mirroring the proven FRLG
 *  gym pattern: trainerbattle_single with a post-win continuation that sets the
 *  badge flag; the skip path (already defeated) shows post-battle dialogue. */
function gymLeaderScript(town: string, L: GymLeader): string[] {
  const T = (s: string): string => `${town}_Text_Leader${s}`;
  return [
    `${town}_EventScript_Leader::\n\ttrainerbattle_single ${L.slot}, ${T('Intro')}, ${T('Defeat')}, ${town}_EventScript_LeaderWin, NO_MUSIC\n\tmsgbox ${T('Post')}, MSGBOX_DEFAULT\n\trelease\n\tend`,
    `${town}_EventScript_LeaderWin::\n\tsetflag ${L.badgeFlag}\n\tmsgbox ${T('Badge')}, MSGBOX_DEFAULT\n\trelease\n\tend`,
    `${T('Intro')}:\n\t.string "I am ${L.name}, the GYM LEADER!\\nLet's see what you've got!$"`,
    `${T('Defeat')}:\n\t.string "...You truly are strong.$"`,
    `${T('Post')}:\n\t.string "${L.name}: Keep on training!$"`,
    `${T('Badge')}:\n\t.string "You received the GYM BADGE!$"`,
  ];
}

/** Reskin a Kanto leader slot into a BW leader (name + party). */
async function reskinLeader(L: GymLeader): Promise<void> {
  await reskinTrainer(PROJECT, L.slot, { name: L.name, party: L.party.map(([s, lv]) => leaderMon(s, lv)) });
}

/** An Elite Four / Champion fighter reskinned onto a Kanto E4/champion slot. */
interface LeagueFighter {
  key: string; // script-label suffix, e.g. 'Shauntal'
  slot: string; // Kanto TRAINER_ELITE_FOUR_* / TRAINER_CHAMPION_* slot
  name: string;
  gfx: string;
  x: number;
  y: number;
  party: Array<[string, number]>;
}

/** Plain battle script for an Elite Four member (no badge; simple post dialogue). */
function leagueBattlerScript(map: string, f: LeagueFighter): string[] {
  const L = `${map}_EventScript_${f.key}`;
  const T = (s: string): string => `${map}_Text_${f.key}${s}`;
  return [
    `${L}::\n\ttrainerbattle_single ${f.slot}, ${T('Intro')}, ${T('Defeat')}\n\tmsgbox ${T('Post')}, MSGBOX_DEFAULT\n\trelease\n\tend`,
    `${T('Intro')}:\n\t.string "I am ${f.name} of the ELITE FOUR!\\nYou won't get past me!$"`,
    `${T('Defeat')}:\n\t.string "...You are remarkable.$"`,
    `${T('Post')}:\n\t.string "${f.name}: Press on to the CHAMPION.$"`,
  ];
}

/** A badge-gated climax battle (Champion Alder / N / Ghetsis). When `credits` is
 *  set, victory rolls Hall of Fame + credits (special EnterHallOfFame -> DoCredits
 * - the canonical FRLG end-game specials). NOTE: the credits hand-off itself can
 *  only be fully verified in-emulator. */
function climaxScript(
  map: string,
  f: LeagueFighter,
  lines: { intro: string; defeat: string; post: string; locked: string; win?: string },
  opts: { credits?: boolean } = {},
): string[] {
  const E = `${map}_EventScript_${f.key}`;
  const T = (s: string): string => `${map}_Text_${f.key}${s}`;
  const win = `${map}_EventScript_${f.key}Win`;
  const winBody = opts.credits
    ? `setflag FLAG_SYS_GAME_CLEAR\n\tsetrespawn HEAL_LOCATION_PALLET_TOWN\n\tfadescreenspeed FADE_TO_BLACK, 24\n\tspecial EnterHallOfFame\n\twaitstate\n\tspecial DoCredits\n\twaitstate\n\treleaseall\n\tend`
    : `msgbox ${T('Win')}, MSGBOX_DEFAULT\n\trelease\n\tend`;
  const blocks = [
    `${E}::\n\tgoto_if_unset FLAG_BADGE08_GET, ${map}_EventScript_${f.key}Locked\n\ttrainerbattle_single ${f.slot}, ${T('Intro')}, ${T('Defeat')}, ${win}, NO_MUSIC\n\tmsgbox ${T('Post')}, MSGBOX_DEFAULT\n\trelease\n\tend`,
    `${map}_EventScript_${f.key}Locked::\n\tlockall\n\tmsgbox ${T('Locked')}, MSGBOX_DEFAULT\n\treleaseall\n\tend`,
    `${win}::\n\t${winBody}`,
    `${T('Intro')}:\n\t.string "${lines.intro}$"`,
    `${T('Defeat')}:\n\t.string "${lines.defeat}$"`,
    `${T('Post')}:\n\t.string "${lines.post}$"`,
    `${T('Locked')}:\n\t.string "${lines.locked}$"`,
  ];
  if (!opts.credits) blocks.push(`${T('Win')}:\n\t.string "${lines.win ?? lines.post}$"`);
  return blocks;
}

/** A generic route trainer / Plasma grunt reskinned onto an unused Kanto slot
 *  (e.g. TRAINER_YOUNGSTER_*) - 0 net-new flags. Talk-to-battle (no sight). */
interface RouteTrainer {
  key: string; // script-label suffix, unique per map
  slot: string; // Kanto slot to reskin (class kept as placeholder)
  name: string;
  gfx: string;
  x: number;
  y: number;
  party: Array<[string, number]>;
  intro?: string;
  defeat?: string;
  post?: string;
}

function routeTrainerScript(map: string, t: RouteTrainer): string[] {
  const E = `${map}_EventScript_${t.key}`;
  const T = (s: string): string => `${map}_Text_${t.key}${s}`;
  return [
    `${E}::\n\ttrainerbattle_single ${t.slot}, ${T('Intro')}, ${T('Defeat')}\n\tmsgbox ${T('Post')}, MSGBOX_DEFAULT\n\trelease\n\tend`,
    `${T('Intro')}:\n\t.string "${t.intro ?? "Let's have a battle!"}$"`,
    `${T('Defeat')}:\n\t.string "${t.defeat ?? 'You got me!'}$"`,
    `${T('Post')}:\n\t.string "${t.post ?? 'You battle well.'}$"`,
  ];
}

/** A ground item ball. `flag` (the object's hide flag) is reused from an unreachable
 *  Kanto item ball → 0 net-new flags; STD_FIND_ITEM sets it on pickup. */
interface RouteItem {
  key: string;
  item: string; // ITEM_*
  x: number;
  y: number;
  flag: string; // FLAG_HIDE_* reused from an unreachable Kanto item ball
}

function itemBall(it: RouteItem, mapName: string): MapObjectEvent {
  return { ...npc('OBJ_EVENT_GFX_ITEM_BALL', it.x, it.y, `${mapName}_EventScript_Item${it.key}`), flag: it.flag };
}

function itemBallScript(mapName: string, it: RouteItem): string {
  return `${mapName}_EventScript_Item${it.key}::\n\tfinditem ${it.item}\n\tend`;
}

/** A nurse object-event that heals via the shared BwCommon heal script. Place one
 *  per town so the demake is completable without a Pokemon Center interior. */
function nurseNpc(x = 12, y = 12): MapObjectEvent {
  return npc('OBJ_EVENT_GFX_NURSE', x, y, 'BwCommon_EventScript_Nurse');
}

/** Author the shared outdoor-nurse heal script + register its include. Re-authored
 *  every run (survives any decomp reset). `special HealPlayerParty` fully restores
 *  the party - the field-heal primitive used by Pokemon Center nurses. */
async function writeCommonScripts(): Promise<void> {
  const inc =
    [
      'BwCommon_EventScript_Nurse::',
      '\tlock',
      '\tfaceplayer',
      '\tmsgbox BwCommon_Text_NurseWelcome, MSGBOX_DEFAULT',
      '\tspecial HealPlayerParty',
      '\tmsgbox BwCommon_Text_NurseHealed, MSGBOX_DEFAULT',
      '\trelease',
      '\tend',
      '',
      'BwCommon_Text_NurseWelcome:',
      '\t.string "Welcome! Let me heal your POKeMON.$"',
      '',
      'BwCommon_Text_NurseHealed:',
      '\t.string "Your POKeMON are restored to\\nfull health! Take care!$"',
      '',
    ].join('\n') + '\n';
  await writeFileAtomic(`${PROJECT}/data/scripts/bw_common.inc`, inc);
  await appendLineIfMissing(`${PROJECT}/data/event_scripts.s`, '\t.include "data/scripts/bw_common.inc"');
}

/** Reskin an E4/champion slot (name + party); class stays Elite Four/Champion. */
async function reskinFighter(f: LeagueFighter): Promise<void> {
  await reskinTrainer(PROJECT, f.slot, { name: f.name, party: f.party.map(([s, lv]) => leaderMon(s, lv)) });
}

async function main(): Promise<void> {
  const png = graphics.decodePng(new Uint8Array(await fs.readFile(ETS)));
  const SW = 256;
  const SH = 128;
  const section = new Uint8Array(SW * SH * 4);
  for (let y = 0; y < SH; y++) {
    const src = y * png.width * 4;
    section.set(png.pixels.subarray(src, src + SW * 4), y * SW * 4);
  }
  const N = 128;
  const avgs = Array.from({ length: N }, (_, m) => metatileAvg(section, SW, m));
  const bright = (c: { r: number; g: number; b: number }): number => c.r + c.g + c.b;
  let grass = 0;
  let gs = -Infinity;
  avgs.forEach((c, i) => {
    if (bright(c) < 40) return;
    const s = c.g - (c.r + c.b) / 2 - Math.abs(c.g - 110) * 0.3;
    if (s > gs) {
      gs = s;
      grass = i;
    }
  });
  const gc = avgs[grass]!;
  let obst = grass;
  let od = -1;
  avgs.forEach((c, i) => {
    if (bright(c) < 40) return;
    const d = (c.r - gc.r) ** 2 + (c.g - gc.g) ** 2 + (c.b - gc.b) ** 2;
    if (d > od) {
      od = d;
      obst = i;
    }
  });
  // 2nd-greenest metatile → tall grass (encounter tiles), distinct from town grass.
  let tallGrass = grass;
  let tgs = -Infinity;
  avgs.forEach((c, i) => {
    if (i === grass || bright(c) < 40) return;
    const s = c.g - (c.r + c.b) / 2 - Math.abs(c.g - 110) * 0.3;
    if (s > tgs) {
      tgs = s;
      tallGrass = i;
    }
  });
  // (Re)create the shared tileset, marking the tall-grass metatile MB_TALL_GRASS
  // so Route-1 grass patches can host wild encounters (table added separately).
  await writeDecompTileset(PROJECT, {
    name: 'BwNuvema',
    dir: 'bw_nuvema',
    isSecondary: true,
    pixels: section,
    width: SW,
    height: SH,
    behaviors: new Map([[tallGrass, 'MB_TALL_GRASS']]), // behaviors use LOCAL metatile ids
  });

  // The tileset is now SECONDARY: every layout cell must reference its metatiles at
  // SEC_MT_BASE+local. Offset the shared indices AFTER the behaviors map (local) is built.
  grass += SEC_MT_BASE;
  obst += SEC_MT_BASE;
  tallGrass += SEC_MT_BASE;

  // Shared outdoor-nurse heal script (every town gets a healing NPC).
  await writeCommonScripts();

  const W = 24;
  const G: LayoutCellSpec = { metatileId: grass, collision: 0, elevation: 3 };
  const O: LayoutCellSpec = { metatileId: obst, collision: 1, elevation: 3 };
  const field = (h: number): LayoutCellSpec[] => Array.from({ length: W * h }, () => ({ ...G }));
  const rect = (cells: LayoutCellSpec[], h: number, x0: number, y0: number, w: number, hh: number, c: LayoutCellSpec): void => {
    for (let y = y0; y < y0 + hh; y++)
      for (let x = x0; x < x0 + w; x++) if (x >= 0 && x < W && y >= 0 && y < h) cells[y * W + x] = { ...c };
  };
  type Box = [number, number, number, number]; // x,y,w,h

  // Generic authors for the common cases (special maps like Nuvema stay inline).
  const authorRoute = async (
    mapId: string,
    mapName: string,
    H: number,
    patches: Box[],
    connections: MapConnection[],
    enc?: { rate: number; mons: WildMon[] },
    trainers: RouteTrainer[] = [],
    items: RouteItem[] = [],
    music = 'MUS_ROUTE3',
  ): Promise<void> => {
    const layoutId = mapId.replace('MAP_', 'LAYOUT_');
    const cells = field(H);
    rect(cells, H, 0, 0, 3, H, O);
    rect(cells, H, W - 3, 0, 3, H, O);
    const TG: LayoutCellSpec = { metatileId: tallGrass, collision: 0, elevation: 3 };
    for (const [x, y, w, h] of patches) rect(cells, H, x, y, w, h, TG);
    await writeDecompLayout(PROJECT, { id: layoutId, name: `${mapName}_Layout`, dir: mapName, width: W, height: H, primaryTileset: PRIMARY, secondaryTileset: SECONDARY, cells });
    const objs = [
      ...trainers.map((t) => npc(t.gfx, t.x, t.y, `${mapName}_EventScript_${t.key}`)),
      ...items.map((it) => itemBall(it, mapName)),
    ];
    await writeDecompMap(PROJECT, { ...baseMap(mapId, mapName, layoutId, connections, objs, music), map_type: 'MAP_TYPE_ROUTE' }, 'gMapGroup_TownsAndRoutes');
    if (trainers.length || items.length) {
      await writeMapScripts(mapName, [], [...trainers.flatMap((t) => routeTrainerScript(mapName, t)), ...items.map((it) => itemBallScript(mapName, it))]);
      for (const t of trainers) await reskinTrainer(PROJECT, t.slot, { name: t.name, party: t.party.map(([s, lv]) => leaderMon(s, lv)) });
    }
    if (enc) await addWildLand(mapId, `s${mapName}`, enc.rate, enc.mons);
  };
  const authorTown = async (
    mapId: string,
    mapName: string,
    H: number,
    buildings: Box[],
    connections: MapConnection[],
    npcs: Array<{ gfx: string; x: number; y: number; label: string; text: string }>,
    leader?: GymLeader,
    battlers: RouteTrainer[] = [],
    music = 'MUS_PEWTER',
  ): Promise<void> => {
    const layoutId = mapId.replace('MAP_', 'LAYOUT_');
    const cells = field(H);
    for (const [x, y, w, h] of buildings) rect(cells, H, x, y, w, h, O);
    await writeDecompLayout(PROJECT, { id: layoutId, name: `${mapName}_Layout`, dir: mapName, width: W, height: H, primaryTileset: PRIMARY, secondaryTileset: SECONDARY, cells });
    const objs = npcs.map((n) => npc(n.gfx, n.x, n.y, n.label));
    objs.push(nurseNpc()); // every town heals (no Pokemon Center interior needed)
    if (leader) objs.push(npc(leader.gfx, leader.x, leader.y, `${mapName}_EventScript_Leader`));
    for (const b of battlers) objs.push(npc(b.gfx, b.x, b.y, `${mapName}_EventScript_${b.key}`));
    await writeDecompMap(PROJECT, baseMap(mapId, mapName, layoutId, connections, objs, music), 'gMapGroup_TownsAndRoutes');
    await writeMapScripts(
      mapName,
      npcs.map((n) => ({ label: n.label, textLabel: n.label.replace('_EventScript_', '_Text_'), text: n.text })),
      [...(leader ? gymLeaderScript(mapName, leader) : []), ...battlers.flatMap((b) => routeTrainerScript(mapName, b))],
    );
    if (leader) await reskinLeader(leader);
    for (const b of battlers) await reskinTrainer(PROJECT, b.slot, { name: b.name, party: b.party.map(([s, lv]) => leaderMon(s, lv)) });
  };

  // Nuvema Town (24x20) - re-authored WITH the up-connection to Route 1.
  {
    const H = 20;
    const cells = field(H);
    rect(cells, H, 4, 4, 4, 3, O);
    rect(cells, H, 15, 4, 5, 3, O);
    rect(cells, H, 9, 11, 6, 4, O);
    await writeDecompLayout(PROJECT, {
      id: 'LAYOUT_NUVEMA_TOWN',
      name: 'NuvemaTown_Layout',
      dir: 'NuvemaTown',
      width: W,
      height: H,
      primaryTileset: PRIMARY,
      secondaryTileset: SECONDARY,
      cells,
    });
    // Placeholder FRLG sprites (tagged for BW sprite replacement). Dialogue is
    // paraphrased BW tone, not verbatim game text.
    const nuvemaNpcs = [
      npc('OBJ_EVENT_GFX_WOMAN_1', 12, 9, 'NuvemaTown_EventScript_Townsperson'),
      npc('OBJ_EVENT_GFX_GIRL_1', 8, 9, 'NuvemaTown_EventScript_Bianca'),
      npc('OBJ_EVENT_GFX_BOY_1', 16, 9, 'NuvemaTown_EventScript_Cheren'),
      // Item-ball graphic MUST use LOOK_AROUND (the vanilla movement for every
      // OBJ_EVENT_GFX_ITEM_BALL); FACE_DOWN softlocks the field load on this sprite.
      // (Box-vanish-on-take reverted: removeobject+hide-flag caused a despawn→respawn
      // flicker on camera re-approach - deferred polish; box stays + says "empty".)
      npc('OBJ_EVENT_GFX_ITEM_BALL', 12, 17, 'NuvemaTown_EventScript_GiftBox', 'MOVEMENT_TYPE_LOOK_AROUND'),
      npc('OBJ_EVENT_GFX_WOMAN_2', 20, 9, 'NuvemaTown_EventScript_Mom'),
      nurseNpc(3, 9),
    ];
    await writeDecompMap(
      PROJECT,
      baseMap('MAP_NUVEMA_TOWN', 'NuvemaTown', 'LAYOUT_NUVEMA_TOWN', [{ map: 'MAP_BW_ROUTE1', offset: 0, direction: 'up' }], nuvemaNpcs),
      'gMapGroup_TownsAndRoutes',
    );
    // Starter = Prof. Juniper's GIFT BOX (the real BW delivered box of 3), examined
    // as an object. Choosing one makes Cheren & Bianca take the others per BW's real
    // type triangle (Cheren takes the one strong vs yours; Bianca the one weak to
    // yours). De-fabricates the prior invented outdoor "I am Prof. Juniper, choose"
    // yes/no scene. NOTE: still OUTDOORS in Nuvema (location-approx) - the faithful
    // BEDROOM relocation is warp-gated and awaits user runtime walk-testing.
    // (var name kept as juniperStarter so the writeMapScripts call below is unchanged.)
    const juniperStarter = [
      'NuvemaTown_EventScript_GiftBox::',
      '\tlock',
      '\tgoto_if_set FLAG_UNUSED_0x4AB, NuvemaTown_EventScript_BoxTaken',
      '\tmsgbox NuvemaTown_Text_BoxIntro, MSGBOX_DEFAULT',
      'NuvemaTown_EventScript_BoxChoose::',
      '\tmsgbox NuvemaTown_Text_PickSnivy, MSGBOX_YESNO',
      '\tgoto_if_eq VAR_RESULT, YES, NuvemaTown_EventScript_GiveSnivy',
      '\tmsgbox NuvemaTown_Text_PickTepig, MSGBOX_YESNO',
      '\tgoto_if_eq VAR_RESULT, YES, NuvemaTown_EventScript_GiveTepig',
      '\tmsgbox NuvemaTown_Text_PickOshawott, MSGBOX_YESNO',
      '\tgoto_if_eq VAR_RESULT, YES, NuvemaTown_EventScript_GiveOshawott',
      '\tmsgbox NuvemaTown_Text_BoxThink, MSGBOX_DEFAULT',
      '\trelease',
      '\tend',
      '',
      'NuvemaTown_EventScript_GiveSnivy::',
      '\tgivemon SPECIES_SNIVY, 5',
      '\tsetflag FLAG_UNUSED_0x4AC', // records: player chose Snivy (Cheren takes Tepig)
      '\tmsgbox NuvemaTown_Text_TookForSnivy, MSGBOX_DEFAULT',
      '\tgoto NuvemaTown_EventScript_StarterGiven',
      'NuvemaTown_EventScript_GiveTepig::',
      '\tgivemon SPECIES_TEPIG, 5',
      '\tsetflag FLAG_UNUSED_0x4AD', // records: player chose Tepig (Cheren takes Oshawott)
      '\tmsgbox NuvemaTown_Text_TookForTepig, MSGBOX_DEFAULT',
      '\tgoto NuvemaTown_EventScript_StarterGiven',
      'NuvemaTown_EventScript_GiveOshawott::',
      '\tgivemon SPECIES_OSHAWOTT, 5',
      '\tsetflag FLAG_UNUSED_0x4AE', // records: player chose Oshawott (Cheren takes Snivy)
      '\tmsgbox NuvemaTown_Text_TookForOshawott, MSGBOX_DEFAULT',
      '\tgoto NuvemaTown_EventScript_StarterGiven',
      '',
      'NuvemaTown_EventScript_StarterGiven::',
      '\tsetflag FLAG_UNUSED_0x4AB', // gates re-examine -> "The box is empty now." (box stays; instant-vanish deferred, see object comment)
      '\trelease',
      '\tend',
      '',
      'NuvemaTown_EventScript_BoxTaken::',
      '\tmsgbox NuvemaTown_Text_BoxTaken, MSGBOX_NPC',
      '\trelease',
      '\tend',
      '',
      'NuvemaTown_Text_BoxIntro:',
      '\t.string "It\'s a gift from PROF. JUNIPER!\\nThree POKéMON are inside.$"',
      'NuvemaTown_Text_PickSnivy:',
      '\t.string "Take the Grass-type SNIVY?$"',
      'NuvemaTown_Text_PickTepig:',
      '\t.string "Take the Fire-type TEPIG?$"',
      'NuvemaTown_Text_PickOshawott:',
      '\t.string "Take the Water-type OSHAWOTT?$"',
      'NuvemaTown_Text_BoxThink:',
      '\t.string "Which POKéMON will you choose?$"',
      'NuvemaTown_Text_TookForSnivy:',
      '\t.string "CHEREN took TEPIG, and BIANCA\\ntook OSHAWOTT!$"',
      'NuvemaTown_Text_TookForTepig:',
      '\t.string "CHEREN took OSHAWOTT, and BIANCA\\ntook SNIVY!$"',
      'NuvemaTown_Text_TookForOshawott:',
      '\t.string "CHEREN took SNIVY, and BIANCA\\ntook TEPIG!$"',
      'NuvemaTown_Text_BoxTaken:',
      '\t.string "The box is empty now.$"',
    ].join('\n');
    // First rival battle: Cheren (Tepig Lv5 from .bw-extract/trainers.json).
    // New TRAINER_* (within the ~25-net-new cap; switch to Kanto-slot reuse as
    // the slice grows). Talk-triggered trainerbattle_single.
    const cherenMon: PartyMon = {
      species: 'Tepig',
      heldItem: null,
      level: 5,
      ivs: null,
      evs: null,
      ability: 'Blaze',
      nature: 'Impish',
      moves: ['Tackle', 'Tail Whip'],
      extraLines: [],
    };
    // Type-adaptive rival: Cheren takes the starter that is STRONG vs the player's
    // choice (BW rule). CHEREN_1=Tepig (player chose Snivy), _2=Oshawott (chose Tepig),
    // _3=Snivy (chose Oshawott). Trainer moves are not learnset-checked, so reusing
    // the same moves is build-safe. The gift box sets a choice flag the battle reads.
    const cherenHeader = { name: 'Cheren', className: 'Youngster', pic: 'Youngster', gender: 'Male', music: 'Male', ai: 'Basic Trainer' } as const;
    const cherenMonOsha: PartyMon = { ...cherenMon, species: 'Oshawott', ability: 'Torrent' };
    const cherenMonSniv: PartyMon = { ...cherenMon, species: 'Snivy', ability: 'Overgrow' };
    await writeDecompTrainer(PROJECT, buildPartyTrainer('TRAINER_BW_CHEREN_1', cherenHeader, [cherenMon]));
    await writeDecompTrainer(PROJECT, buildPartyTrainer('TRAINER_BW_CHEREN_2', cherenHeader, [cherenMonOsha]));
    await writeDecompTrainer(PROJECT, buildPartyTrainer('TRAINER_BW_CHEREN_3', cherenHeader, [cherenMonSniv]));
    // Bianca: type-adaptive too, but takes the starter WEAK to the player's choice
    // (BW rule). BIANCA_1=Oshawott (chose Snivy), _2=Snivy (chose Tepig), _3=Tepig
    // (chose Oshawott). Reuses the same per-species mon objects as Cheren.
    const biancaHeader = { name: 'Bianca', className: 'Lass', pic: 'Lass', gender: 'Female', music: 'Female', ai: 'Basic Trainer' } as const;
    await writeDecompTrainer(PROJECT, buildPartyTrainer('TRAINER_BW_BIANCA_1', biancaHeader, [cherenMonOsha]));
    await writeDecompTrainer(PROJECT, buildPartyTrainer('TRAINER_BW_BIANCA_2', biancaHeader, [cherenMonSniv]));
    await writeDecompTrainer(PROJECT, buildPartyTrainer('TRAINER_BW_BIANCA_3', biancaHeader, [cherenMon]));
    const cherenBattle = [
      'NuvemaTown_EventScript_Cheren::',
      '\tgoto_if_set FLAG_UNUSED_0x4AD, NuvemaTown_EventScript_CherenOshawott',
      '\tgoto_if_set FLAG_UNUSED_0x4AE, NuvemaTown_EventScript_CherenSnivy',
      'NuvemaTown_EventScript_CherenTepig::',
      '\ttrainerbattle_single TRAINER_BW_CHEREN_1, NuvemaTown_Text_CherenIntro, NuvemaTown_Text_CherenDefeat',
      '\tmsgbox NuvemaTown_Text_CherenPost, MSGBOX_AUTOCLOSE',
      '\tend',
      '',
      'NuvemaTown_EventScript_CherenOshawott::',
      '\ttrainerbattle_single TRAINER_BW_CHEREN_2, NuvemaTown_Text_CherenIntro, NuvemaTown_Text_CherenDefeat',
      '\tmsgbox NuvemaTown_Text_CherenPost, MSGBOX_AUTOCLOSE',
      '\tend',
      '',
      'NuvemaTown_EventScript_CherenSnivy::',
      '\ttrainerbattle_single TRAINER_BW_CHEREN_3, NuvemaTown_Text_CherenIntro, NuvemaTown_Text_CherenDefeat',
      '\tmsgbox NuvemaTown_Text_CherenPost, MSGBOX_AUTOCLOSE',
      '\tend',
      '',
      'NuvemaTown_Text_CherenIntro:',
      '\t.string "I\'m CHEREN! Let\'s see whose\\nPOKéMON is stronger!$"',
      'NuvemaTown_Text_CherenDefeat:',
      '\t.string "...I lost?$"',
      'NuvemaTown_Text_CherenPost:',
      '\t.string "I\'ll keep training!$"',
    ].join('\n');
    // Second rival battle: Bianca (type-adaptive - she has the starter WEAK to yours).
    const biancaBattle = [
      'NuvemaTown_EventScript_Bianca::',
      '\tgoto_if_set FLAG_UNUSED_0x4AD, NuvemaTown_EventScript_BiancaSnivy',
      '\tgoto_if_set FLAG_UNUSED_0x4AE, NuvemaTown_EventScript_BiancaTepig',
      'NuvemaTown_EventScript_BiancaOshawott::',
      '\ttrainerbattle_single TRAINER_BW_BIANCA_1, NuvemaTown_Text_BiancaIntro, NuvemaTown_Text_BiancaDefeat',
      '\tmsgbox NuvemaTown_Text_BiancaPost, MSGBOX_AUTOCLOSE',
      '\tend',
      '',
      'NuvemaTown_EventScript_BiancaSnivy::',
      '\ttrainerbattle_single TRAINER_BW_BIANCA_2, NuvemaTown_Text_BiancaIntro, NuvemaTown_Text_BiancaDefeat',
      '\tmsgbox NuvemaTown_Text_BiancaPost, MSGBOX_AUTOCLOSE',
      '\tend',
      '',
      'NuvemaTown_EventScript_BiancaTepig::',
      '\ttrainerbattle_single TRAINER_BW_BIANCA_3, NuvemaTown_Text_BiancaIntro, NuvemaTown_Text_BiancaDefeat',
      '\tmsgbox NuvemaTown_Text_BiancaPost, MSGBOX_AUTOCLOSE',
      '\tend',
      '',
      'NuvemaTown_Text_BiancaIntro:',
      '\t.string "I\'m BIANCA! Let\'s battle with\\nour new POKéMON!$"',
      'NuvemaTown_Text_BiancaDefeat:',
      '\t.string "Wow, you\'re strong!$"',
      'NuvemaTown_Text_BiancaPost:',
      '\t.string "That was so much fun!$"',
    ].join('\n');
    // Mom's starter kit (one-time): Poké Balls + Potions so the player can
    // actually build a team (catching is otherwise gated by scarce ball items).
    // Reuses an unreachable Kanto item flag as the one-time gate.
    const momGift = [
      'NuvemaTown_EventScript_Mom::',
      '\tlock',
      '\tfaceplayer',
      '\tgoto_if_set FLAG_HIDE_CELADON_CITY_ETHER, NuvemaTown_EventScript_MomPost',
      '\tmsgbox NuvemaTown_Text_MomOffer, MSGBOX_DEFAULT',
      '\tgiveitem_msg NuvemaTown_Text_MomGaveBalls, ITEM_POKE_BALL, 10',
      '\tgiveitem_msg NuvemaTown_Text_MomGavePotions, ITEM_POTION, 5',
      '\tsetflag FLAG_HIDE_CELADON_CITY_ETHER',
      '\trelease',
      '\tend',
      '',
      'NuvemaTown_EventScript_MomPost::',
      '\tmsgbox NuvemaTown_Text_MomPost, MSGBOX_NPC',
      '\trelease',
      '\tend',
      '',
      'NuvemaTown_Text_MomOffer:',
      '\t.string "Take these for your journey,\\ndear! Go catch lots of POKéMON!$"',
      'NuvemaTown_Text_MomGaveBalls:',
      '\t.string "Got 10 POKé BALLS!$"',
      'NuvemaTown_Text_MomGavePotions:',
      '\t.string "Got 5 POTIONS!$"',
      'NuvemaTown_Text_MomPost:',
      '\t.string "Be careful out there!$"',
    ].join('\n');
    await writeMapScripts(
      'NuvemaTown',
      [
        { label: 'NuvemaTown_EventScript_Townsperson', textLabel: 'NuvemaTown_Text_Townsperson', text: 'NUVEMA TOWN\\nWhere journeys begin!' },
      ],
      [juniperStarter, cherenBattle, biancaBattle, momGift],
    );
  }

  // Route 1 (24x30) - vertical route, treelines down both sides.
  {
    const H = 30;
    const cells = field(H);
    rect(cells, H, 0, 0, 3, H, O); // left treeline
    rect(cells, H, W - 3, 0, 3, H, O); // right treeline
    const TG: LayoutCellSpec = { metatileId: tallGrass, collision: 0, elevation: 3 };
    rect(cells, H, 5, 6, 6, 4, TG); // upper grass patch (encounters)
    rect(cells, H, 13, 18, 6, 4, TG); // lower grass patch
    await writeDecompLayout(PROJECT, {
      id: 'LAYOUT_BW_ROUTE1',
      name: 'BwRoute1_Layout',
      dir: 'BwRoute1',
      width: W,
      height: H,
      primaryTileset: PRIMARY,
      secondaryTileset: SECONDARY,
      cells,
    });
    const m = baseMap('MAP_BW_ROUTE1', 'BwRoute1', 'LAYOUT_BW_ROUTE1', [
      { map: 'MAP_NUVEMA_TOWN', offset: 0, direction: 'down' },
      { map: 'MAP_ACCUMULA_TOWN', offset: 0, direction: 'up' },
    ]);
    await writeDecompMap(PROJECT, { ...m, map_type: 'MAP_TYPE_ROUTE' }, 'gMapGroup_TownsAndRoutes');
    // BW Route 1 wild grass trio: Patrat + Lillipup + Purrloin, Lv2-4 (12 slots).
    await addWildLand('MAP_BW_ROUTE1', 'sBwRoute1', 20, [
      ...Array.from({ length: 5 }, () => ({ min_level: 2, max_level: 4, species: 'SPECIES_PATRAT' })),
      ...Array.from({ length: 4 }, () => ({ min_level: 2, max_level: 4, species: 'SPECIES_LILLIPUP' })),
      ...Array.from({ length: 3 }, () => ({ min_level: 2, max_level: 4, species: 'SPECIES_PURRLOIN' })),
    ]);
  }

  // Accumula Town (24x20).
  {
    const H = 20;
    const cells = field(H);
    rect(cells, H, 4, 5, 5, 3, O);
    rect(cells, H, 14, 5, 5, 3, O);
    rect(cells, H, 9, 12, 6, 3, O);
    await writeDecompLayout(PROJECT, {
      id: 'LAYOUT_ACCUMULA_TOWN',
      name: 'AccumulaTown_Layout',
      dir: 'AccumulaTown',
      width: W,
      height: H,
      primaryTileset: PRIMARY,
      secondaryTileset: SECONDARY,
      cells,
    });
    const accumulaNpcs = [
      npc('OBJ_EVENT_GFX_OLD_MAN_1', 6, 10, 'AccumulaTown_EventScript_Townsperson'),
      npc('OBJ_EVENT_GFX_GENTLEMAN', 12, 9, 'AccumulaTown_EventScript_Sage'),
      npc('OBJ_EVENT_GFX_MAN_1', 16, 10, 'AccumulaTown_EventScript_Plasma'),
    ];
    await writeDecompMap(
      PROJECT,
      baseMap('MAP_ACCUMULA_TOWN', 'AccumulaTown', 'LAYOUT_ACCUMULA_TOWN', [
        { map: 'MAP_BW_ROUTE1', offset: 0, direction: 'down' },
        { map: 'MAP_BW_ROUTE2', offset: 0, direction: 'up' },
      ], accumulaNpcs),
      'gMapGroup_TownsAndRoutes',
    );
    await writeMapScripts('AccumulaTown', [
      { label: 'AccumulaTown_EventScript_Townsperson', textLabel: 'AccumulaTown_Text_Townsperson', text: 'ACCUMULA TOWN is\\npeaceful... most days.' },
      { label: 'AccumulaTown_EventScript_Sage', textLabel: 'AccumulaTown_Text_Sage', text: 'Heed the words of\\nTEAM PLASMA...' },
      { label: 'AccumulaTown_EventScript_Plasma', textLabel: 'AccumulaTown_Text_Plasma', text: 'TEAM PLASMA will\\nliberate POKéMON!' },
    ]);
  }

  // Route 2 (24x28): Accumula <-> Striaton, grass patches.
  {
    const H = 28;
    const cells = field(H);
    rect(cells, H, 0, 0, 3, H, O);
    rect(cells, H, W - 3, 0, 3, H, O);
    const TG: LayoutCellSpec = { metatileId: tallGrass, collision: 0, elevation: 3 };
    rect(cells, H, 6, 5, 5, 4, TG);
    rect(cells, H, 13, 17, 5, 4, TG);
    await writeDecompLayout(PROJECT, {
      id: 'LAYOUT_BW_ROUTE2',
      name: 'BwRoute2_Layout',
      dir: 'BwRoute2',
      width: W,
      height: H,
      primaryTileset: PRIMARY,
      secondaryTileset: SECONDARY,
      cells,
    });
    const m = baseMap('MAP_BW_ROUTE2', 'BwRoute2', 'LAYOUT_BW_ROUTE2', [
      { map: 'MAP_ACCUMULA_TOWN', offset: 0, direction: 'down' },
      { map: 'MAP_STRIATON_CITY', offset: 0, direction: 'up' },
    ]);
    await writeDecompMap(PROJECT, { ...m, map_type: 'MAP_TYPE_ROUTE' }, 'gMapGroup_TownsAndRoutes');
    await addWildLand('MAP_BW_ROUTE2', 'sBwRoute2', 21, [
      ...Array.from({ length: 5 }, () => ({ min_level: 3, max_level: 5, species: 'SPECIES_PATRAT' })),
      ...Array.from({ length: 4 }, () => ({ min_level: 3, max_level: 5, species: 'SPECIES_LILLIPUP' })),
      ...Array.from({ length: 3 }, () => ({ min_level: 3, max_level: 5, species: 'SPECIES_PURRLOIN' })),
    ]);
  }

  // Striaton City (24x22): first gym town (Cilan/Chili/Cress).
  {
    const H = 22;
    const cells = field(H);
    rect(cells, H, 4, 5, 5, 3, O); // gym
    rect(cells, H, 14, 5, 5, 3, O); // PC/Mart
    rect(cells, H, 9, 13, 6, 3, O); // building
    await writeDecompLayout(PROJECT, {
      id: 'LAYOUT_STRIATON_CITY',
      name: 'StriatonCity_Layout',
      dir: 'StriatonCity',
      width: W,
      height: H,
      primaryTileset: PRIMARY,
      secondaryTileset: SECONDARY,
      cells,
    });
    const striatonLeader: GymLeader = {
      slot: 'TRAINER_LEADER_BROCK', badgeFlag: 'FLAG_BADGE01_GET', name: 'CHILI',
      gfx: 'OBJ_EVENT_GFX_MAN_1', x: 12, y: 9, party: [['Lillipup', 12], ['Pansear', 12]],
    };
    const striatonNpcs = [
      npc('OBJ_EVENT_GFX_WOMAN_1', 7, 10, 'StriatonCity_EventScript_Local'),
      npc('OBJ_EVENT_GFX_MAN_2', 16, 10, 'StriatonCity_EventScript_GymHint'),
      npc(striatonLeader.gfx, striatonLeader.x, striatonLeader.y, 'StriatonCity_EventScript_Leader'),
      nurseNpc(),
    ];
    await writeDecompMap(
      PROJECT,
      baseMap('MAP_STRIATON_CITY', 'StriatonCity', 'LAYOUT_STRIATON_CITY', [
        { map: 'MAP_BW_ROUTE2', offset: 0, direction: 'down' },
        { map: 'MAP_BW_ROUTE3', offset: 0, direction: 'up' },
      ], striatonNpcs),
      'gMapGroup_TownsAndRoutes',
    );
    await writeMapScripts('StriatonCity', [
      { label: 'StriatonCity_EventScript_Local', textLabel: 'StriatonCity_Text_Local', text: 'Welcome to STRIATON CITY!' },
      { label: 'StriatonCity_EventScript_GymHint', textLabel: 'StriatonCity_Text_GymHint', text: 'CILAN, CHILI and CRESS\\nrun the GYM together.' },
    ], gymLeaderScript('StriatonCity', striatonLeader));
    await reskinLeader(striatonLeader);
  }

  // Route 3 (Striaton <-> Nacrene) - approximated walk-link (BW routes it via
  // Wellspring Cave/Pinwheel, which need warps - deferred).
  await authorRoute(
    'MAP_BW_ROUTE3',
    'BwRoute3',
    26,
    [
      [6, 6, 5, 4],
      [13, 16, 5, 4],
    ],
    [
      { map: 'MAP_STRIATON_CITY', offset: 0, direction: 'down' },
      { map: 'MAP_NACRENE_CITY', offset: 0, direction: 'up' },
    ],
    {
      rate: 21,
      mons: [
        ...Array.from({ length: 5 }, () => ({ min_level: 5, max_level: 7, species: 'SPECIES_PURRLOIN' })),
        ...Array.from({ length: 4 }, () => ({ min_level: 5, max_level: 7, species: 'SPECIES_PATRAT' })),
        ...Array.from({ length: 3 }, () => ({ min_level: 5, max_level: 7, species: 'SPECIES_BLITZLE' })),
      ],
    },
    [
      { key: 'Youngster', slot: 'TRAINER_YOUNGSTER_BEN', name: 'JIMMY', gfx: 'OBJ_EVENT_GFX_BOY_1', x: 4, y: 8, party: [['Patrat', 12], ['Lillipup', 13]], intro: 'My POKéMON are getting strong!' },
      { key: 'Lass', slot: 'TRAINER_YOUNGSTER_CALVIN', name: 'MALI', gfx: 'OBJ_EVENT_GFX_GIRL_1', x: 19, y: 12, party: [['Purrloin', 13]], intro: 'Hi! Want to battle?' },
      { key: 'PlasmaGrunt', slot: 'TRAINER_YOUNGSTER_JOSH', name: 'PLASMA', gfx: 'OBJ_EVENT_GFX_MAN_1', x: 19, y: 22, party: [['Patrat', 13], ['Purrloin', 13]], intro: 'TEAM PLASMA will liberate POKéMON!', defeat: 'Plasma will not forget this!', post: 'We fight for POKéMON liberation!' },
    ],
    [{ key: 'Potion', item: 'ITEM_POTION', x: 4, y: 14, flag: 'FLAG_HIDE_CERULEAN_CAVE_1F_FULL_RESTORE' }],
  );

  // Nacrene City (Lenora's gym town / museum).
  await authorTown(
    'MAP_NACRENE_CITY',
    'NacreneCity',
    22,
    [
      [4, 5, 5, 3],
      [14, 5, 5, 3],
      [9, 13, 6, 3],
    ],
    [
      { map: 'MAP_BW_ROUTE3', offset: 0, direction: 'down' },
      { map: 'MAP_PINWHEEL_FOREST', offset: 0, direction: 'up' },
    ],
    [
      { gfx: 'OBJ_EVENT_GFX_WOMAN_2', x: 7, y: 10, label: 'NacreneCity_EventScript_Local', text: 'NACRENE CITY is full of art!' },
      { gfx: 'OBJ_EVENT_GFX_MAN_1', x: 16, y: 10, label: 'NacreneCity_EventScript_GymHint', text: 'LENORA runs the GYM\\ninside the museum.' },
      { gfx: 'OBJ_EVENT_GFX_GENTLEMAN', x: 3, y: 11, label: 'NacreneCity_EventScript_Plasma', text: 'A TEAM PLASMA SAGE\\npreached about freeing\\nPOKéMON near the museum.' },
    ],
    { slot: 'TRAINER_LEADER_MISTY', badgeFlag: 'FLAG_BADGE02_GET', name: 'LENORA', gfx: 'OBJ_EVENT_GFX_WOMAN_2', x: 12, y: 9, party: [['Herdier', 19], ['Watchog', 19]] },
    [
      { key: 'N', slot: 'TRAINER_CHAMPION_REMATCH_BULBASAUR', name: 'N', gfx: 'OBJ_EVENT_GFX_BOY_1', x: 20, y: 11, party: [['Pidove', 13], ['Tympole', 13], ['Timburr', 13]], intro: "Your POKeMON... I can hear their voices. Let us battle!", defeat: "...Interesting. Your bond is real.", post: "N: We will meet again." },
    ],
  );

  // Pinwheel Forest (Nacrene <-> Castelia; warp-gated in BW, walk-approximated).
  await authorRoute('MAP_PINWHEEL_FOREST', 'PinwheelForest', 30, [[5, 5, 6, 5], [13, 18, 6, 5]], [
    { map: 'MAP_NACRENE_CITY', offset: 0, direction: 'down' },
    { map: 'MAP_CASTELIA_CITY', offset: 0, direction: 'up' },
  ], { rate: 22, mons: landMons([['SPECIES_PIDOVE', 5, 8, 11], ['SPECIES_SEWADDLE', 4, 8, 11], ['SPECIES_VENIPEDE', 3, 8, 11]]) }, [
    { key: 'Bug1', slot: 'TRAINER_BUG_CATCHER_RICK', name: 'AARON', gfx: 'OBJ_EVENT_GFX_BOY_1', x: 4, y: 8, party: [['Sewaddle', 10], ['Venipede', 10]], intro: 'Bugs thrive in PINWHEEL FOREST!' },
    { key: 'Bug2', slot: 'TRAINER_BUG_CATCHER_DOUG', name: 'NORA', gfx: 'OBJ_EVENT_GFX_GIRL_1', x: 19, y: 12, party: [['Sewaddle', 11]], intro: 'My SEWADDLE is strong!' },
  ], [
    { key: 'GreatBall', item: 'ITEM_GREAT_BALL', x: 4, y: 16, flag: 'FLAG_HIDE_FIVE_ISLAND_LOST_CAVE_ROOM11_LAX_INCENSE' },
  ], 'MUS_VIRIDIAN_FOREST');

  // Castelia City (Burgh's gym; huge port city, approximated to town size).
  await authorTown('MAP_CASTELIA_CITY', 'CasteliaCity', 24, [[3, 4, 5, 3], [16, 4, 5, 3], [9, 15, 6, 3]], [
    { map: 'MAP_PINWHEEL_FOREST', offset: 0, direction: 'down' },
    { map: 'MAP_BW_ROUTE4', offset: 0, direction: 'up' },
  ], [
    { gfx: 'OBJ_EVENT_GFX_GENTLEMAN', x: 6, y: 10, label: 'CasteliaCity_EventScript_Local', text: 'CASTELIA CITY never sleeps!' },
    { gfx: 'OBJ_EVENT_GFX_MAN_1', x: 17, y: 10, label: 'CasteliaCity_EventScript_GymHint', text: 'BURGH, the BUG-type LEADER,\\nis an artist too.' },
    { gfx: 'OBJ_EVENT_GFX_MAN_1', x: 3, y: 11, label: 'CasteliaCity_EventScript_Plasma', text: 'TEAM PLASMA grunts caused\\na scene by the harbor.\\nA boy named N stopped them.' },
  ], { slot: 'TRAINER_LEADER_LT_SURGE', badgeFlag: 'FLAG_BADGE03_GET', name: 'BURGH', gfx: 'OBJ_EVENT_GFX_MAN_3', x: 12, y: 9, party: [['Whirlipede', 23], ['Dwebble', 24], ['Leavanny', 24]] }, [
    { key: 'Cheren', slot: 'TRAINER_RIVAL_CERULEAN_BULBASAUR', name: 'CHEREN', gfx: 'OBJ_EVENT_GFX_BOY_1', x: 20, y: 11, party: [['Tranquill', 19], ['Liepard', 20]], intro: "Let's measure how far we've each come!", defeat: "Hmph. I still have work to do.", post: "CHEREN: Strength has many forms." },
  ]);

  // Route 4 (Castelia <-> Nimbasa; desert edge).
  await authorRoute('MAP_BW_ROUTE4', 'BwRoute4', 28, [[6, 6, 5, 4], [13, 17, 5, 4]], [
    { map: 'MAP_CASTELIA_CITY', offset: 0, direction: 'down' },
    { map: 'MAP_NIMBASA_CITY', offset: 0, direction: 'up' },
  ], { rate: 22, mons: landMons([['SPECIES_SANDILE', 5, 13, 15], ['SPECIES_SCRAGGY', 4, 13, 15], ['SPECIES_DARUMAKA', 3, 13, 15]]) }, [
    { key: 'Trainer1', slot: 'TRAINER_YOUNGSTER_TIMMY', name: 'BROOKS', gfx: 'OBJ_EVENT_GFX_MANIAC', x: 4, y: 9, party: [['Sandile', 14], ['Darumaka', 14]], intro: 'The desert toughens POKéMON!' },
    { key: 'Trainer2', slot: 'TRAINER_YOUNGSTER_JOEY', name: 'SHANE', gfx: 'OBJ_EVENT_GFX_BOY_1', x: 19, y: 13, party: [['Scraggy', 15]], intro: 'My SCRAGGY is fierce!' },
  ], [
    { key: 'SuperPotion', item: 'ITEM_SUPER_POTION', x: 19, y: 16, flag: 'FLAG_HIDE_CERULEAN_CAVE_1F_NUGGET' },
  ]);

  // Nimbasa City (Elesa's gym; amusement park).
  await authorTown('MAP_NIMBASA_CITY', 'NimbasaCity', 24, [[3, 4, 5, 3], [16, 4, 5, 3], [9, 15, 6, 3]], [
    { map: 'MAP_BW_ROUTE4', offset: 0, direction: 'down' },
    { map: 'MAP_BW_ROUTE5', offset: 0, direction: 'up' },
  ], [
    { gfx: 'OBJ_EVENT_GFX_WOMAN_1', x: 6, y: 10, label: 'NimbasaCity_EventScript_Local', text: 'NIMBASA CITY has rides\\nand a big stadium!' },
    { gfx: 'OBJ_EVENT_GFX_BEAUTY', x: 17, y: 10, label: 'NimbasaCity_EventScript_GymHint', text: "ELESA's ELECTRIC GYM\\nlights up the city." },
    { gfx: 'OBJ_EVENT_GFX_BOY_1', x: 3, y: 11, label: 'NimbasaCity_EventScript_Plasma', text: 'That young man N spoke of\\na world where POKéMON and\\npeople live apart...' },
  ], { slot: 'TRAINER_LEADER_ERIKA', badgeFlag: 'FLAG_BADGE04_GET', name: 'ELESA', gfx: 'OBJ_EVENT_GFX_BEAUTY', x: 12, y: 9, party: [['Emolga', 30], ['Emolga', 30], ['Zebstrika', 30]] }, [
    { key: 'Bianca', slot: 'TRAINER_RIVAL_CERULEAN_SQUIRTLE', name: 'BIANCA', gfx: 'OBJ_EVENT_GFX_GIRL_1', x: 20, y: 11, party: [['Herdier', 19], ['Munna', 19], ['Pansage', 20]], intro: "Heeey! Let's see how much stronger I've gotten!", defeat: "Awww, I lost again!", post: "BIANCA: I'll keep training too!" },
  ]);

  // Route 5 (Nimbasa <-> Driftveil Drawbridge).
  await authorRoute('MAP_BW_ROUTE5', 'BwRoute5', 26, [[6, 6, 5, 4], [13, 16, 5, 4]], [
    { map: 'MAP_NIMBASA_CITY', offset: 0, direction: 'down' },
    { map: 'MAP_DRIFTVEIL_DRAWBRIDGE', offset: 0, direction: 'up' },
  ], { rate: 22, mons: landMons([['SPECIES_PURRLOIN', 5, 16, 18], ['SPECIES_PIDOVE', 4, 16, 18], ['SPECIES_LIEPARD', 3, 16, 18]]) }, [
    { key: 'Trainer1', slot: 'TRAINER_YOUNGSTER_DAN', name: 'KENJI', gfx: 'OBJ_EVENT_GFX_HIKER', x: 4, y: 9, party: [['Tympole', 18], ['Timburr', 18]], intro: 'Route 5 trainers are tough!' },
    { key: 'PlasmaGrunt', slot: 'TRAINER_YOUNGSTER_CHAD', name: 'PLASMA', gfx: 'OBJ_EVENT_GFX_MAN_1', x: 19, y: 12, party: [['Scraggy', 18], ['Trubbish', 18]], intro: 'TEAM PLASMA blocks your path!', defeat: 'Ngh... Plasma retreats!', post: 'Lord GHETSIS will prevail!' },
  ], [
    { key: 'GreatBall', item: 'ITEM_GREAT_BALL', x: 4, y: 16, flag: 'FLAG_HIDE_CERULEAN_CAVE_2F_FULL_RESTORE' },
  ]);

  // Driftveil Drawbridge (Route 5 <-> Driftveil) - bridge, Ducklett overhead.
  await authorRoute('MAP_DRIFTVEIL_DRAWBRIDGE', 'DriftveilDrawbridge', 22, [], [
    { map: 'MAP_BW_ROUTE5', offset: 0, direction: 'down' },
    { map: 'MAP_DRIFTVEIL_CITY', offset: 0, direction: 'up' },
  ]);

  // Driftveil City (Clay's ground gym; market town).
  await authorTown('MAP_DRIFTVEIL_CITY', 'DriftveilCity', 24, [[3, 4, 5, 3], [16, 4, 5, 3], [9, 15, 6, 3]], [
    { map: 'MAP_DRIFTVEIL_DRAWBRIDGE', offset: 0, direction: 'down' },
    { map: 'MAP_BW_ROUTE6', offset: 0, direction: 'up' },
  ], [
    { gfx: 'OBJ_EVENT_GFX_HIKER', x: 6, y: 10, label: 'DriftveilCity_EventScript_Local', text: 'DRIFTVEIL CITY has a\\nbustling market.' },
    { gfx: 'OBJ_EVENT_GFX_MAN_3', x: 17, y: 10, label: 'DriftveilCity_EventScript_GymHint', text: "CLAY digs the GROUND-type\\nGYM down in the mine." },
    { gfx: 'OBJ_EVENT_GFX_MAN_1', x: 3, y: 11, label: 'DriftveilCity_EventScript_Plasma', text: 'TEAM PLASMA was spotted\\nsneaking into the COLD\\nSTORAGE outside town.' },
  ], { slot: 'TRAINER_LEADER_KOGA', badgeFlag: 'FLAG_BADGE05_GET', name: 'CLAY', gfx: 'OBJ_EVENT_GFX_HIKER', x: 12, y: 9, party: [['Krokorok', 34], ['Palpitoad', 34], ['Excadrill', 34]] }, [
    { key: 'Bianca', slot: 'TRAINER_RIVAL_CERULEAN_CHARMANDER', name: 'BIANCA', gfx: 'OBJ_EVENT_GFX_GIRL_1', x: 20, y: 11, party: [['Herdier', 30], ['Musharna', 31]], intro: "I'm not the crybaby I used to be! Battle!", defeat: "Mmgh, so close!", post: "BIANCA: I'm finding my own path now." },
  ]);

  // Route 6 (Driftveil <-> Mistralton; forest edge).
  await authorRoute('MAP_BW_ROUTE6', 'BwRoute6', 28, [[6, 6, 5, 4], [13, 17, 5, 4]], [
    { map: 'MAP_DRIFTVEIL_CITY', offset: 0, direction: 'down' },
    { map: 'MAP_MISTRALTON_CITY', offset: 0, direction: 'up' },
  ], { rate: 22, mons: landMons([['SPECIES_DEERLING', 5, 18, 20], ['SPECIES_KARRABLAST', 4, 18, 20], ['SPECIES_FOONGUS', 3, 18, 20]]) }, [
    { key: 'R6T1', slot: 'TRAINER_BUG_CATCHER_KENT', name: 'WALT', gfx: 'OBJ_EVENT_GFX_BOY_1', x: 4, y: 9, party: [['Deerling', 20], ['Karrablast', 20]], intro: 'ROUTE 6 toughens POKéMON!' },
    { key: 'R6T2', slot: 'TRAINER_BUG_CATCHER_ROBBY', name: 'NESSA', gfx: 'OBJ_EVENT_GFX_GIRL_1', x: 19, y: 13, party: [['Foongus', 21]], intro: 'My FOONGUS spores are nasty!' },
  ], [
    { key: 'SuperPotion', item: 'ITEM_SUPER_POTION', x: 4, y: 14, flag: 'FLAG_HIDE_CERULEAN_CAVE_2F_PP_UP' },
    { key: 'Revive', item: 'ITEM_REVIVE', x: 19, y: 14, flag: 'FLAG_HIDE_CERULEAN_CAVE_2F_ULTRA_BALL' },
  ]);

  // Mistralton City (Skyla's flying gym; airport).
  await authorTown('MAP_MISTRALTON_CITY', 'MistraltonCity', 24, [[3, 4, 5, 3], [16, 4, 5, 3], [9, 15, 6, 3]], [
    { map: 'MAP_BW_ROUTE6', offset: 0, direction: 'down' },
    { map: 'MAP_BW_ROUTE7', offset: 0, direction: 'up' },
  ], [
    { gfx: 'OBJ_EVENT_GFX_WOMAN_1', x: 6, y: 10, label: 'MistraltonCity_EventScript_Local', text: 'MISTRALTON CITY has\\na cargo airport.' },
    { gfx: 'OBJ_EVENT_GFX_BEAUTY', x: 17, y: 10, label: 'MistraltonCity_EventScript_GymHint', text: "SKYLA flies the\\nFLYING-type GYM." },
  ], { slot: 'TRAINER_LEADER_SABRINA', badgeFlag: 'FLAG_BADGE06_GET', name: 'SKYLA', gfx: 'OBJ_EVENT_GFX_WOMAN_1', x: 12, y: 9, party: [['Swoobat', 41], ['Unfezant', 42], ['Swanna', 42]] });

  // Route 7 (Mistralton <-> Twist Mountain; tall autumn grass).
  await authorRoute('MAP_BW_ROUTE7', 'BwRoute7', 30, [[6, 6, 5, 4], [13, 18, 5, 4]], [
    { map: 'MAP_MISTRALTON_CITY', offset: 0, direction: 'down' },
    { map: 'MAP_TWIST_MOUNTAIN', offset: 0, direction: 'up' },
  ], { rate: 22, mons: landMons([['SPECIES_TRANQUILL', 5, 22, 25], ['SPECIES_WATCHOG', 4, 22, 25], ['SPECIES_DEERLING', 3, 22, 25]]) }, [
    { key: 'R7T1', slot: 'TRAINER_BUG_CATCHER_BRENT', name: 'GROVER', gfx: 'OBJ_EVENT_GFX_BOY_1', x: 4, y: 9, party: [['Tranquill', 25], ['Watchog', 25]], intro: 'The autumn grass hides power!' },
    { key: 'R7T2', slot: 'TRAINER_BUG_CATCHER_CALE', name: 'PETRA', gfx: 'OBJ_EVENT_GFX_GIRL_1', x: 19, y: 12, party: [['Deerling', 26]], intro: 'Battle me before TWIST MOUNTAIN!' },
  ], [
    { key: 'HyperPotion', item: 'ITEM_HYPER_POTION', x: 4, y: 14, flag: 'FLAG_HIDE_CERULEAN_CAVE_B1F_MAX_REVIVE' },
  ]);

  // Twist Mountain (cave; Route 7 <-> Icirrus).
  await authorRoute('MAP_TWIST_MOUNTAIN', 'TwistMountain', 28, [[6, 6, 5, 4], [13, 17, 5, 4]], [
    { map: 'MAP_BW_ROUTE7', offset: 0, direction: 'down' },
    { map: 'MAP_ICIRRUS_CITY', offset: 0, direction: 'up' },
  ], { rate: 20, mons: landMons([['SPECIES_BOLDORE', 5, 28, 32], ['SPECIES_WOOBAT', 4, 28, 32], ['SPECIES_GURDURR', 3, 28, 32]]) }, [
    { key: 'Hiker1', slot: 'TRAINER_BUG_CATCHER_SAMMY', name: 'GROK', gfx: 'OBJ_EVENT_GFX_HIKER', x: 4, y: 8, party: [['Boldore', 30], ['Woobat', 30]], intro: 'These caves are my home!' },
  ], [
    { key: 'Revive', item: 'ITEM_REVIVE', x: 19, y: 12, flag: 'FLAG_HIDE_FIVE_ISLAND_LOST_CAVE_ROOM12_SEA_INCENSE' },
  ], 'MUS_MT_MOON');

  // Icirrus City (Brycen's ice gym; snowy).
  await authorTown('MAP_ICIRRUS_CITY', 'IcirrusCity', 24, [[3, 4, 5, 3], [16, 4, 5, 3], [9, 15, 6, 3]], [
    { map: 'MAP_TWIST_MOUNTAIN', offset: 0, direction: 'down' },
    { map: 'MAP_BW_ROUTE8', offset: 0, direction: 'up' },
  ], [
    { gfx: 'OBJ_EVENT_GFX_MAN_3', x: 6, y: 10, label: 'IcirrusCity_EventScript_Local', text: 'ICIRRUS CITY is\\nblanketed in snow.' },
    { gfx: 'OBJ_EVENT_GFX_MANIAC', x: 17, y: 10, label: 'IcirrusCity_EventScript_GymHint', text: "BRYCEN guards the\\nICE-type GYM." },
  ], { slot: 'TRAINER_LEADER_BLAINE', badgeFlag: 'FLAG_BADGE07_GET', name: 'BRYCEN', gfx: 'OBJ_EVENT_GFX_MAN_3', x: 12, y: 9, party: [['Vanillish', 46], ['Beartic', 47], ['Cryogonal', 47]] });

  // Route 8 (Icirrus <-> Tubeline Bridge; marshy moor edge).
  await authorRoute('MAP_BW_ROUTE8', 'BwRoute8', 30, [[6, 6, 5, 4], [13, 18, 5, 4]], [
    { map: 'MAP_ICIRRUS_CITY', offset: 0, direction: 'down' },
    { map: 'MAP_TUBELINE_BRIDGE', offset: 0, direction: 'up' },
  ], { rate: 22, mons: landMons([['SPECIES_PALPITOAD', 5, 31, 33], ['SPECIES_STUNFISK', 4, 31, 33], ['SPECIES_GURDURR', 3, 31, 33]]) }, [
    { key: 'T1', slot: 'TRAINER_BUG_CATCHER_COLTON', name: 'MARLON', gfx: 'OBJ_EVENT_GFX_MAN_3', x: 4, y: 8, party: [['Palpitoad', 32], ['Stunfisk', 32]], intro: 'The marsh hides strong POKéMON!' },
    { key: 'T2', slot: 'TRAINER_BUG_CATCHER_GREG', name: 'DINA', gfx: 'OBJ_EVENT_GFX_WOMAN_1', x: 19, y: 12, party: [['Gurdurr', 33]], intro: 'Care to battle?' },
  ], [
    { key: 'FullHeal', item: 'ITEM_FULL_HEAL', x: 4, y: 16, flag: 'FLAG_HIDE_CERULEAN_CAVE_1F_MAX_ELIXIR' },
  ]);

  // Tubeline Bridge (Route 8 <-> Route 9; bridge, Emolga overhead).
  await authorRoute('MAP_TUBELINE_BRIDGE', 'TubelineBridge', 22, [], [
    { map: 'MAP_BW_ROUTE8', offset: 0, direction: 'down' },
    { map: 'MAP_BW_ROUTE9', offset: 0, direction: 'up' },
  ]);

  // Route 9 (Tubeline Bridge <-> Opelucid; shopping mall route).
  await authorRoute('MAP_BW_ROUTE9', 'BwRoute9', 30, [[6, 6, 5, 4], [13, 18, 5, 4]], [
    { map: 'MAP_TUBELINE_BRIDGE', offset: 0, direction: 'down' },
    { map: 'MAP_OPELUCID_CITY', offset: 0, direction: 'up' },
  ], { rate: 22, mons: landMons([['SPECIES_TRUBBISH', 5, 33, 36], ['SPECIES_MINCCINO', 4, 33, 36], ['SPECIES_LIEPARD', 3, 33, 36]]) }, [
    { key: 'T1', slot: 'TRAINER_BUG_CATCHER_JAMES', name: 'CHARLES', gfx: 'OBJ_EVENT_GFX_GENTLEMAN', x: 4, y: 8, party: [['Minccino', 34], ['Liepard', 34]], intro: 'A gentleman always battles fair!' },
    { key: 'T2', slot: 'TRAINER_LASS_JANICE', name: 'GINA', gfx: 'OBJ_EVENT_GFX_GIRL_1', x: 19, y: 12, party: [['Trubbish', 34]], intro: 'Shopping, then battling!' },
  ], [
    { key: 'UltraBall', item: 'ITEM_ULTRA_BALL', x: 4, y: 16, flag: 'FLAG_HIDE_CERULEAN_CAVE_B1F_ULTRA_BALL' },
  ]);

  // Opelucid City (Drayden's dragon gym; 8th badge).
  await authorTown('MAP_OPELUCID_CITY', 'OpelucidCity', 24, [[3, 4, 5, 3], [16, 4, 5, 3], [9, 15, 6, 3]], [
    { map: 'MAP_BW_ROUTE9', offset: 0, direction: 'down' },
    { map: 'MAP_BW_ROUTE10', offset: 0, direction: 'up' },
  ], [
    { gfx: 'OBJ_EVENT_GFX_HIKER', x: 6, y: 10, label: 'OpelucidCity_EventScript_Local', text: 'OPELUCID CITY blends\\nold and new.' },
    { gfx: 'OBJ_EVENT_GFX_OLD_MAN_1', x: 17, y: 10, label: 'OpelucidCity_EventScript_GymHint', text: "DRAYDEN trains the\\nDRAGON-type GYM." },
  ], { slot: 'TRAINER_LEADER_GIOVANNI', badgeFlag: 'FLAG_BADGE08_GET', name: 'DRAYDEN', gfx: 'OBJ_EVENT_GFX_OLD_MAN_1', x: 12, y: 9, party: [['Fraxure', 55], ['Druddigon', 55], ['Haxorus', 56]] }, [
    { key: 'Cheren', slot: 'TRAINER_RIVAL_SS_ANNE_SQUIRTLE', name: 'CHEREN', gfx: 'OBJ_EVENT_GFX_BOY_1', x: 20, y: 11, party: [['Unfezant', 41], ['Liepard', 41], ['Stoutland', 43]], intro: "One last bout before the LEAGUE!", defeat: "You've grown remarkably strong.", post: "CHEREN: I'll find my own answer to strength." },
  ]);

  // Route 10 (Opelucid <-> Victory Road; final route, Plasma checkpoint in BW).
  await authorRoute('MAP_BW_ROUTE10', 'BwRoute10', 30, [[6, 6, 5, 4], [13, 18, 5, 4]], [
    { map: 'MAP_OPELUCID_CITY', offset: 0, direction: 'down' },
    { map: 'MAP_BW_VICTORY_ROAD', offset: 0, direction: 'up' },
  ], { rate: 22, mons: landMons([['SPECIES_PAWNIARD', 5, 39, 43], ['SPECIES_KLANG', 4, 39, 43], ['SPECIES_GALVANTULA', 3, 39, 43]]) }, [
    { key: 'T1', slot: 'TRAINER_LASS_SALLY', name: 'BREE', gfx: 'OBJ_EVENT_GFX_BEAUTY', x: 4, y: 8, party: [['Pawniard', 40], ['Galvantula', 40]], intro: 'The final stretch! Battle me!' },
    { key: 'T2', slot: 'TRAINER_LASS_ROBIN', name: 'KIRA', gfx: 'OBJ_EVENT_GFX_WOMAN_2', x: 19, y: 12, party: [['Klang', 40]], intro: 'Only the strong reach the LEAGUE.' },
  ], [
    { key: 'MaxPotion', item: 'ITEM_MAX_POTION', x: 4, y: 16, flag: 'FLAG_HIDE_FIVE_ISLAND_LOST_CAVE_ROOM10_SILK_SCARF' },
  ]);

  // Victory Road (cave climb; Route 10 <-> Pokemon League).
  await authorRoute('MAP_BW_VICTORY_ROAD', 'BwVictoryRoad', 32, [[5, 6, 5, 5], [13, 19, 5, 5]], [
    { map: 'MAP_BW_ROUTE10', offset: 0, direction: 'down' },
    { map: 'MAP_BW_POKEMON_LEAGUE', offset: 0, direction: 'up' },
  ], { rate: 20, mons: landMons([['SPECIES_GIGALITH', 5, 44, 48], ['SPECIES_DRUDDIGON', 4, 44, 48], ['SPECIES_GOLETT', 3, 44, 48]]) }, [
    { key: 'T1', slot: 'TRAINER_LASS_CRISSY', name: 'VERA', gfx: 'OBJ_EVENT_GFX_BEAUTY', x: 4, y: 8, party: [['Druddigon', 46], ['Golurk', 46]], intro: 'VICTORY ROAD is the final test!' },
    { key: 'T2', slot: 'TRAINER_BUG_CATCHER_ANTHONY', name: 'RANDOLF', gfx: 'OBJ_EVENT_GFX_MAN_1', x: 4, y: 16, party: [['Druddigon', 46], ['Gigalith', 46]], intro: 'The LEAGUE awaits only the worthy!' },
    { key: 'T3', slot: 'TRAINER_BUG_CATCHER_CHARLIE', name: 'LENA', gfx: 'OBJ_EVENT_GFX_GIRL_1', x: 19, y: 8, party: [['Golurk', 47], ['Galvantula', 47]], intro: 'None shall pass me unbattled!' },
  ], [
    { key: 'FullRestore', item: 'ITEM_FULL_RESTORE', x: 19, y: 12, flag: 'FLAG_HIDE_FIVE_ISLAND_LOST_CAVE_ROOM13_MAX_REVIVE' },
  ], 'MUS_VICTORY_ROAD');

  // Pokemon League (plaza fronting the Elite Four + Champion; spine terminus +
  // credits). E4 + Champion reskinned onto Kanto E4/champion slots (0 net-new
  // flags). Champion gated behind the 8th badge; victory triggers Hall of Fame +
  // credits. Teams: E4 from extracted xlsx data; Alder = canonical BW1 team.
  {
    const map = 'BwPokemonLeague';
    const H = 24;
    const e4: LeagueFighter[] = [
      { key: 'Shauntal', slot: 'TRAINER_ELITE_FOUR_AGATHA', name: 'SHAUNTAL', gfx: 'OBJ_EVENT_GFX_WOMAN_2', x: 6, y: 9, party: [['Cofagrigus', 61], ['Golurk', 61], ['Chandelure', 61], ['Jellicent', 62]] },
      { key: 'Grimsley', slot: 'TRAINER_ELITE_FOUR_LANCE', name: 'GRIMSLEY', gfx: 'OBJ_EVENT_GFX_MAN_1', x: 10, y: 9, party: [['Scrafty', 59], ['Krookodile', 59], ['Bisharp', 59], ['Liepard', 59]] },
      { key: 'Caitlin', slot: 'TRAINER_ELITE_FOUR_LORELEI', name: 'CAITLIN', gfx: 'OBJ_EVENT_GFX_BEAUTY', x: 14, y: 9, party: [['Reuniclus', 60], ['Sigilyph', 60], ['Gothitelle', 60], ['Musharna', 61]] },
      { key: 'Marshal', slot: 'TRAINER_ELITE_FOUR_BRUNO', name: 'MARSHAL', gfx: 'OBJ_EVENT_GFX_MAN_3', x: 18, y: 9, party: [['Throh', 57], ['Conkeldurr', 58], ['Mienshao', 58], ['Sawk', 58]] },
    ];
    // Climax trio (all badge-8 gated; reskinned champion-tier slots, 0 net-new
    // flags). BW's true finale is N -> Ghetsis at the League; Alder is the
    // standing Champion. Ghetsis victory rolls the credits.
    const alder: LeagueFighter = {
      key: 'Champion', slot: 'TRAINER_CHAMPION_FIRST_SQUIRTLE', name: 'ALDER', gfx: 'OBJ_EVENT_GFX_OLD_MAN_1', x: 8, y: 18,
      party: [['Accelgor', 60], ['Bouffalant', 60], ['Vanilluxe', 60], ['Escavalier', 60], ['Druddigon', 60], ['Volcarona', 63]],
    };
    const nFighter: LeagueFighter = {
      key: 'N', slot: 'TRAINER_CHAMPION_REMATCH_SQUIRTLE', name: 'N', gfx: 'OBJ_EVENT_GFX_BOY_1', x: 12, y: 18,
      party: [['Zekrom', 60], ['Klinklang', 60], ['Zoroark', 60], ['Archeops', 60], ['Carracosta', 60], ['Vanilluxe', 60]],
    };
    const ghetsis: LeagueFighter = {
      key: 'Ghetsis', slot: 'TRAINER_CHAMPION_REMATCH_CHARMANDER', name: 'GHETSIS', gfx: 'OBJ_EVENT_GFX_GENTLEMAN', x: 16, y: 18,
      party: [['Cofagrigus', 60], ['Bouffalant', 60], ['Seismitoad', 60], ['Bisharp', 60], ['Eelektross', 60], ['Hydreigon', 63]],
    };
    const cells = field(H);
    rect(cells, H, 8, 3, 8, 4, O); // league building footprint
    await writeDecompLayout(PROJECT, { id: 'LAYOUT_BW_POKEMON_LEAGUE', name: `${map}_Layout`, dir: map, width: W, height: H, primaryTileset: PRIMARY, secondaryTileset: SECONDARY, cells });
    const flavor = [
      { gfx: 'OBJ_EVENT_GFX_BEAUTY', x: 3, y: 12, label: `${map}_EventScript_Local`, text: 'The POKéMON LEAGUE\\nawaits the worthy.' },
    ];
    const objs = [
      ...flavor.map((n) => npc(n.gfx, n.x, n.y, n.label)),
      ...e4.map((f) => npc(f.gfx, f.x, f.y, `${map}_EventScript_${f.key}`)),
      ...[alder, nFighter, ghetsis].map((f) => npc(f.gfx, f.x, f.y, `${map}_EventScript_${f.key}`)),
    ];
    await writeDecompMap(PROJECT, baseMap('MAP_BW_POKEMON_LEAGUE', map, 'LAYOUT_BW_POKEMON_LEAGUE', [{ map: 'MAP_BW_VICTORY_ROAD', offset: 0, direction: 'down' }], objs, 'MUS_VICTORY_ROAD'), 'gMapGroup_TownsAndRoutes');
    await writeMapScripts(
      map,
      flavor.map((n) => ({ label: n.label, textLabel: n.label.replace('_EventScript_', '_Text_'), text: n.text })),
      [
        ...e4.flatMap((f) => leagueBattlerScript(map, f)),
        ...climaxScript(map, alder, { intro: "I am ALDER, the CHAMPION!\\nShow me the bonds you share!", defeat: "...Magnificent. Truly.", post: "ALDER: A new wind blows\\nthrough Unova.", locked: "Earn all 8 BADGES first." }),
        ...climaxScript(map, nFighter, { intro: "I am N.\\nMy ideals will reshape the world!", defeat: "...Your POKéMON trust you.", post: "N: Perhaps I was wrong...", locked: "Only champions may pass." }),
        ...climaxScript(map, ghetsis, { intro: "I am GHETSIS of TEAM PLASMA!\\nKneel before me!", defeat: "Im-impossible! My plan...!", post: "GHETSIS: This isn't over...", locked: "You are not ready." }, { credits: true }),
      ],
    );
    for (const f of [...e4, alder, nFighter, ghetsis]) await reskinFighter(f);
  }

  console.log(`slice authored: 26 maps + 8 gym leaders + Elite Four + Alder/N/Ghetsis finale (Ghetsis win -> credits). All reskinned Kanto slots, 0 net-new flags.`);
}

void main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
