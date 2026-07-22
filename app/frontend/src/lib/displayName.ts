/**
 * User-friendly name resolution for synthetic manifest ids.
 *
 * The binary-rom scanner lifts entities with synthetic ids like `gfx_5`,
 * `species_25`, `move_45`, `item_4`, `class_3`, `binary_map_2_3`,
 * `script_0xABCD`, `flag_0x800`. These are technically correct but bleed
 * to the operator as JSON-looking strings ("gfx_5" instead of "Player
 * sprite", "species_25" instead of "PIKACHU"). This module owns the
 * lookup: given a synthetic id, return the best user-friendly string
 * the manifest supports.
 *
 * The cross-ref pass in `binary-rom-registry.ts` already populates real
 * names on most entries (e.g. SpeciesEntry.name) when complementary
 * sample-only detectors ran; this module exists for the synthetic ids
 * that REFERENCE other entries (e.g. ObjectEvent.graphicsId, Trainer.
 * className, Warp.toMapId) and never carry a built-in name field.
 *
 * Phase A scope (iter 108 plan): pure read-only mapping; no API calls,
 * no state mutation. The `showInternalIds` debug toggle wraps each
 * resolved name with the original id in parens for power-user diagnosis.
 */

import type { MapGroup, ProjectManifest } from '@rom-editor/shared';
import {
  resolveMapTruth,
  resolveSymbolForIdentity,
  resolveUniversalSymbol,
  resolveWildEncounterSlot,
} from './symbols';
import { lookupAnnotation } from './annotations';
import type { EntityKind } from '../state';

/** Pattern → resolver registry. Each resolver attempts to extract a
 *  numeric index from the synthetic id + look up the matching entry. */
type Resolver = (manifest: ProjectManifest, id: string) => string | null;

/** Result kind - exposed so callers can render fallback labels distinctly
 *  (e.g. dimmer text for "Unknown move #45"). */
export type DisplayNameKind = 'real' | 'fallback' | 'passthrough';

export interface DisplayNameResult {
  /** The human-readable label to render. */
  readonly text: string;
  /** Whether a real in-game name was found (`real`), a generic fallback
   *  with the index (`fallback`), or the input was already a regular
   *  string (`passthrough`). UI can style by kind. */
  readonly kind: DisplayNameKind;
  /** The original id, for tooltips and debug toggle. */
  readonly id: string;
}

/** Phase Q.6 - heuristic kind guess from a synthetic id so the
 *  annotation lookup can fire for IDs we encounter through displayName
 *  alone (without an explicit EntityKind on the call site). Pattern
 *  matches mirror the resolver regexes below. */
function guessKindFromId(id: string): EntityKind | null {
  if (/^species_\d+$/.test(id) || /^SPECIES_/.test(id)) return 'species';
  if (/^move_\d+$/.test(id) || /^MOVE_/.test(id)) return 'move';
  if (/^item_\d+$/.test(id) || /^ITEM_/.test(id)) return 'item';
  if (/^ability_\d+$/.test(id) || /^ABILITY_/.test(id)) return 'ability';
  if (/^type_\d+$/.test(id) || /^TYPE_/.test(id)) return 'type';
  if (/^trainer/i.test(id) || /^TRAINER_/.test(id)) return 'trainer';
  if (/^(binary_)?flag_/i.test(id) || /^FLAG_/.test(id)) return 'flag';
  if (/^(binary_)?var_/i.test(id) || /^VAR_/.test(id)) return 'variable';
  if (/^script@?_?0x/i.test(id) || /^script/i.test(id)) return 'script';
  if (/^song_/i.test(id) || /^MUS_/.test(id) || /^SE_/.test(id)) return 'song';
  if (/^region_/i.test(id)) return 'region';
  if (/^(binary_)?map_/i.test(id) || /^MAP_/.test(id)) return 'map';
  if (/^warp_/i.test(id)) return 'warp';
  if (/^obj_/i.test(id)) return 'objectEvent';
  if (/^trig_/i.test(id)) return 'trigger';
  return null;
}

function matchIndex(id: string, prefixPattern: RegExp): number | null {
  const m = prefixPattern.exec(id);
  if (!m) return null;
  const n = Number.parseInt(m[1]!, 10);
  return Number.isFinite(n) ? n : null;
}

function lookupSpecies(manifest: ProjectManifest, id: string): string | null {
  const idx = matchIndex(id, /^species_(\d+)$/);
  if (idx === null) return null;
  const entry = manifest.speciesNames?.find((s) => s.speciesIndex === idx);
  if (entry && entry.name.length > 0) return entry.name;
  // Modernize-and-Ship slice 3 - symbol-DB fallback before the synthetic
  // suffix. Lets a freshly-modernized ROM show "Pikachu" instead of
  // "Pokémon #25" before the binary scanner finishes lifting species
  // names from the new CFRU base-stats table.
  const fromDb = resolveSymbolForIdentity(manifest.identity ?? null, 'species', idx);
  if (fromDb) return prettifyConstantName(fromDb.name, 'SPECIES_');
  return `Pokémon #${String(idx)}`;
}

function lookupMove(manifest: ProjectManifest, id: string): string | null {
  const idx = matchIndex(id, /^move_(\d+)$/);
  if (idx === null) return null;
  const entry = manifest.moveNames?.find((m) => m.moveIndex === idx);
  if (entry && entry.name.length > 0) return entry.name;
  const fromDb = resolveSymbolForIdentity(manifest.identity ?? null, 'move', idx);
  if (fromDb) return prettifyConstantName(fromDb.name, 'MOVE_');
  return `Move #${String(idx)}`;
}

/** Phase H-RC8 - Gen-3 MOVEMENT_TYPE_* enum names (pokefirered
 *  include/constants/event_object_movement.h). Maps the u8 byte
 *  stored at +0x09 of an ObjectEventTemplate to a friendly label.
 *  Covers the ~60 commonly-used values; hack-added types beyond
 *  vanilla fall back to "Movement type #N". Re-exported for editors
 *  (Phase O.39) that surface these as a labeled select. */
export const GEN3_MOVEMENT_TYPE_NAMES: ReadonlyArray<string> = [
  'None',                      // 0
  'Look around',               // 1
  'Wander around',             // 2
  'Wander left & right',       // 3
  'Wander up & down',          // 4
  'Wander up',                 // 5
  'Wander down',               // 6
  'Wander left',               // 7
  'Wander right',              // 8
  'Face down',                 // 9
  'Face up',                   // 10
  'Face left',                 // 11
  'Face right',                // 12
  'Player',                    // 13
  'Berry tree',                // 14
  'Face down & up',            // 15
  'Face left & right',         // 16
  'Face up & left',            // 17
  'Face up & right',           // 18
  'Face down & left',          // 19
  'Face down & right',         // 20
  'Face down/up/left',         // 21
  'Face down/up/right',        // 22
  'Face up/left/right',        // 23
  'Face down/left/right',      // 24
  'Rotate clockwise',          // 25
  'Rotate counter-clockwise',  // 26
  'Walk up & down',            // 27
  'Walk down & up',            // 28
  'Walk left & right',         // 29
  'Walk right & left',         // 30
  'Walk in place - down',      // 31
  'Walk in place - up',        // 32
  'Walk in place - left',      // 33
  'Walk in place - right',     // 34
  'Jog in place - down',       // 35
  'Jog in place - up',         // 36
  'Jog in place - left',       // 37
  'Jog in place - right',      // 38
  'Run in place - down',       // 39
  'Run in place - up',         // 40
  'Run in place - left',       // 41
  'Run in place - right',      // 42
  'Walk square (UR / DL)',     // 43
  'Walk square (UL / DR)',     // 44
  'Walk square (DR / UL)',     // 45
  'Walk square (DL / UR)',     // 46
  'Walk row (LR)',             // 47
  'Walk row (RL)',             // 48
  'Walk column (UD)',          // 49
  'Walk column (DU)',          // 50
  'Hidden',                    // 51
  'Tree disguise',             // 52
  'Mountain disguise',         // 53
  'Cooltrainer disguise',      // 54
  'Hidden boy',                // 55
  'Hidden girl',               // 56
  'Wander around (slow)',      // 57
  'Walk around (faster)',      // 58
  'Wander left & right (slow)',// 59
  'Buried',                    // 60
];

function lookupMovementType(_manifest: ProjectManifest, id: string): string | null {
  const idx = matchIndex(id, /^movement_(\d+)$/);
  if (idx === null) return null;
  // Universal Gen-3 movementTypes registry takes priority - it has
  // descriptions ("Walks randomly within range") that beat the bare
  // names in the hardcoded list. Fall through to the legacy list for
  // indices the registry doesn't cover.
  const fromRegistry = resolveUniversalSymbol('movement_type', idx);
  if (fromRegistry) return fromRegistry.name;
  if (idx >= 0 && idx < GEN3_MOVEMENT_TYPE_NAMES.length) {
    return GEN3_MOVEMENT_TYPE_NAMES[idx]!;
  }
  return `Movement type #${String(idx)}`;
}

/** Tile-behavior IDs that show up in metatile attributes (the second
 *  byte of each 4-byte metatile attribute pair). The editor sees them
 *  as `tile_behavior_<decimal>` synthetic ids when surfaced from the
 *  binary-ROM lifter. */
function lookupTileBehavior(_manifest: ProjectManifest, id: string): string | null {
  const idx = matchIndex(id, /^tile_behavior_(\d+)$/) ?? matchIndex(id, /^mb_(\d+)$/);
  if (idx === null) return null;
  const entry = resolveUniversalSymbol('tile_behavior', idx);
  if (entry) return entry.name;
  return `Tile behavior #${String(idx)}`;
}

/** Weather constants - exposed by map headers + by the setweather
 *  script command. */
function lookupWeather(_manifest: ProjectManifest, id: string): string | null {
  const idx = matchIndex(id, /^weather_(\d+)$/);
  if (idx === null) return null;
  const entry = resolveUniversalSymbol('weather', idx);
  if (entry) return entry.name;
  return `Weather #${String(idx)}`;
}

/** Map-type constants (Town / Route / Indoor / etc.). */
function lookupMapType(_manifest: ProjectManifest, id: string): string | null {
  const idx = matchIndex(id, /^map_type_(\d+)$/);
  if (idx === null) return null;
  const entry = resolveUniversalSymbol('map_type', idx);
  if (entry) return entry.name;
  return `Map type #${String(idx)}`;
}

/** Battle-scene backdrops. */
function lookupBattleScene(_manifest: ProjectManifest, id: string): string | null {
  const idx = matchIndex(id, /^battle_scene_(\d+)$/);
  if (idx === null) return null;
  const entry = resolveUniversalSymbol('battle_scene', idx);
  if (entry) return entry.name;
  return `Battle scene #${String(idx)}`;
}

/** msgbox shape byte (the trailing arg of the msgbox script command). */
function lookupMsgboxType(_manifest: ProjectManifest, id: string): string | null {
  const idx = matchIndex(id, /^msgbox_(\d+)$/);
  if (idx === null) return null;
  const entry = resolveUniversalSymbol('msgbox_type', idx);
  if (entry) return entry.name;
  return `Dialogue box style #${String(idx)}`;
}

/** Script opcode → plain-English summary. Used by the visual scripter
 *  (WP3) so cards show "Show dialogue" instead of "Opcode 0x6c". */
function lookupScriptCommand(_manifest: ProjectManifest, id: string): string | null {
  const idx = matchIndex(id, /^script_cmd_(\d+)$/) ?? matchIndex(id, /^opcode_(\d+)$/);
  if (idx === null) return null;
  const entry = resolveUniversalSymbol('script_command', idx);
  if (entry) return entry.name;
  return `Script command #${String(idx)}`;
}

/** applymovement byte → plain-English. Used by the visual scripter's
 *  movement editor (turns a script byte sequence into a step list). */
function lookupMovementCommand(_manifest: ProjectManifest, id: string): string | null {
  const idx = matchIndex(id, /^move_step_(\d+)$/);
  if (idx === null) return null;
  const entry = resolveUniversalSymbol('movement_command', idx);
  if (entry) return entry.name;
  return `Movement step #${String(idx)}`;
}

/** AI flag bit → plain-English. Used by the trainer inspector's
 *  AI behavior section so users see "Avoids ineffective moves" instead
 *  of `0x00000001`. */
function lookupAiFlag(_manifest: ProjectManifest, id: string): string | null {
  const idx = matchIndex(id, /^ai_flag_(\d+)$/);
  if (idx === null) return null;
  // AI flags are stored as bit values; the synthetic id is the bit
  // value itself, not the bit position.
  const entry = resolveUniversalSymbol('ai_flag', idx);
  if (entry) return entry.name;
  return `Battle AI behavior #${String(idx)}`;
}

/** Public helper for the trainer inspector: given a 32-bit AI flag mask
 *  return a sorted array of plain-English names for the bits that are
 *  set. Each name maps to one bit. */
export function aiFlagNames(mask: number): ReadonlyArray<{ readonly bit: number; readonly name: string; readonly description?: string }> {
  const out: { bit: number; name: string; description?: string }[] = [];
  for (let i = 0; i < 32; i++) {
    const bit = 1 << i;
    if ((mask & bit) === 0) continue;
    // Bit value > 0x7FFFFFFF would overflow; using >>> 0 to coerce to unsigned.
    const bitUnsigned = bit >>> 0;
    const entry = resolveUniversalSymbol('ai_flag', bitUnsigned);
    if (entry) out.push({ bit: bitUnsigned, name: entry.name, description: entry.description });
    else out.push({ bit: bitUnsigned, name: `Battle AI behavior bit ${i}` });
  }
  return out;
}

function lookupItem(manifest: ProjectManifest, id: string): string | null {
  const idx = matchIndex(id, /^item_(\d+)$/);
  if (idx === null) return null;
  const entry = manifest.items?.find((i) => i.itemIndex === idx);
  if (entry && entry.name.length > 0) return entry.name;
  const fromDb = resolveSymbolForIdentity(manifest.identity ?? null, 'item', idx);
  if (fromDb) return prettifyConstantName(fromDb.name, 'ITEM_');
  return `Item #${String(idx)}`;
}

function lookupAbility(manifest: ProjectManifest, id: string): string | null {
  const idx = matchIndex(id, /^ability_(\d+)$/);
  if (idx === null) return null;
  const entry = manifest.abilities?.find((a) => a.abilityIndex === idx);
  if (entry && entry.name.length > 0) return entry.name;
  const fromDb = resolveSymbolForIdentity(manifest.identity ?? null, 'ability', idx);
  if (fromDb) return prettifyConstantName(fromDb.name, 'ABILITY_');
  return `Ability #${String(idx)}`;
}

/** Modernize-and-Ship slice 3 - turn a raw symbol-DB constant name like
 *  "SPECIES_PIKACHU", "MOVE_HYDRO_PUMP", "ABILITY_FLASH_FIRE",
 *  "ITEM_MASTER_BALL" into a user-facing label "Pikachu", "Hydro Pump",
 *  "Flash Fire", "Master Ball". Strips the kind-specific prefix, then
 *  title-cases each underscore-separated word.
 *
 *  Preservation rules (in order):
 *   1. All-caps letter-only tokens ≤ 3 chars (TM, HM, AI, NPC, RGB).
 *   2. All-caps letters+digits tokens containing at least one digit
 *      (TM01, HM01, B2F, 1F) - common ROM-hack abbreviations.
 *   3. Roman numerals II..X (form variant markers).
 *  Everything else gets title-cased (first letter upper, rest lower).
 *
 *  Public so future panels (species inspector, etc.) can reuse it. */
export function prettifyConstantName(constName: string, prefix: string): string {
  let stripped = constName;
  if (constName.startsWith(prefix)) {
    stripped = constName.slice(prefix.length);
  }
  if (stripped.length === 0) return constName;
  return stripped
    .split('_')
    .map((word) => {
      if (word.length === 0) return word;
      // Pure-letter short abbreviation (TM, HM, AI, NPC).
      if (word.length <= 3 && /^[A-Z]+$/.test(word)) return word;
      // Letters+digits mixed abbreviation (TM01, HM01, B2F, 1F).
      if (/^[A-Z0-9]+$/.test(word) && /[0-9]/.test(word)) return word;
      // Roman numerals (II, III, IV, V, VI, VII, VIII, IX, X).
      if (/^(II|III|IV|V|VI|VII|VIII|IX|X)$/i.test(word)) return word.toUpperCase();
      return word[0]!.toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(' ');
}

function lookupTrainerClass(manifest: ProjectManifest, id: string): string | null {
  const idx = matchIndex(id, /^class_(\d+)$/);
  if (idx === null) return null;
  const entry = manifest.trainerClassNames?.find((c) => c.classIndex === idx);
  return entry && entry.name.length > 0 ? entry.name : `Trainer class #${String(idx)}`;
}

function lookupType(manifest: ProjectManifest, id: string): string | null {
  const idx = matchIndex(id, /^type_(\d+)$/);
  if (idx === null) return null;
  const entry = manifest.typeNames?.find((t) => t.typeIndex === idx);
  return entry && entry.name.length > 0 ? entry.name : `Type #${String(idx)}`;
}

function lookupOverworldSprite(manifest: ProjectManifest, id: string): string | null {
  const idx = matchIndex(id, /^gfx_(\d+)$/);
  if (idx === null) return null;
  const sprite = manifest.overworldSprites?.find((s) => s.spriteIndex === idx);
  if (!sprite) return `NPC sprite #${String(idx)}`;
  // No real "sprite name" exists in the gObjectEventGraphicsInfoPointers
  // table; describe by dimensions so the operator at least sees something
  // meaningful (e.g. "16×32 NPC sprite #5"). Future iter could chain
  // a hack-aware OW sprite name detector.
  return `${String(sprite.width)}×${String(sprite.height)} sprite #${String(idx)}`;
}

function lookupMap(manifest: ProjectManifest, id: string): string | null {
  // Direct id match against manifest.maps (handles both `binary_map_*`
  // and decomp-style ids). Returns the map's `name` field which Phase B
  // will populate with real MAPSEC names.
  const map = manifest.maps.find((m) => m.id === id);
  if (!map) return null;

  // Phase 6.5 - assertive vanilla-truth overlay. When the project's
  // identity carries `overlaySafe: true` (set by Phase 6.2 from a
  // matching modernize_rom op-log entry), look up the (bank, num)
  // pair in the pret ground-truth table. A hit means we KNOW the
  // vanilla map at this slot, so override even when the manifest
  // already produced a synthetic name. Non-modernized ROMs and
  // decomp projects never reach the overlay (overlaySafe is null /
  // false) and continue through prettifyMapName as before.
  const bn = extractBankNum(id);
  if (bn && manifest.identity?.overlaySafe) {
    const truth = resolveMapTruth(manifest.identity, bn.bank, bn.num);
    if (truth) return truth.name;
  }

  return prettifyMapName(map.name, id);
}

/** Extracts (bank, num) from a `binary_map_${bank}_${num}` synthetic id.
 *  Returns null for decomp ids (which don't follow this format - they
 *  use the MAP_FOO constant name directly). */
function extractBankNum(id: string): { bank: number; num: number } | null {
  const m = /^binary_map_(\d+)_(\d+)$/.exec(id);
  if (!m) return null;
  return { bank: parseInt(m[1]!, 10), num: parseInt(m[2]!, 10) };
}

/** Phase 6.5 - resolve a map's region categorization (Town / Route /
 *  Cave / Interior / Other) with the vanilla-truth overlay taking
 *  priority over the scanner's byte-derived guess. The MapsBrowser
 *  sidebar reads this to bucket maps; without the overlay override,
 *  Phase 6.1's conservative byte→bucket mapping leaves modernized
 *  CFRU+DPE maps in "Other (425)" until they get categorized properly.
 *
 *  Returns the manifest's group value when no overlay match exists.
 *  The MapGroup union is a superset of the overlay's regionGroup
 *  union (`'town' | 'route' | 'cave' | 'interior' | 'unknown'`); the
 *  overlay can't return 'dungeon' or 'special' (those are decomp-only
 *  categorisations the manifest carries directly). */
export function lookupMapGroup(
  manifest: ProjectManifest,
  mapId: string,
): MapGroup {
  const map = manifest.maps.find((m) => m.id === mapId);
  if (!map) return 'unknown';
  if (manifest.identity?.overlaySafe) {
    const bn = extractBankNum(mapId);
    if (bn) {
      const truth = resolveMapTruth(manifest.identity, bn.bank, bn.num);
      if (truth) return truth.regionGroup;
    }
  }
  return map.group;
}

/** Phase 6.5 - resolve a wild encounter slot to a SPECIES_FOO constant
 *  name via the vanilla-truth overlay. Used by EncounterTableInspector
 *  when the manifest's slot.speciesId is unresolvable (the screenshot's
 *  "species_undefined" bug - re-scanning fixes it for most slots, the
 *  overlay covers the rest). Returns null when:
 *  - identity is not overlaySafe
 *  - the map (bank, num) has no encounter table in pret
 *  - the (method, slotIndex) doesn't exist
 *
 *  The SPECIES_FOO constant the overlay returns then flows back through
 *  resolveSymbolForIdentity for prettification. */
export function lookupEncounterSlotSpecies(
  manifest: ProjectManifest,
  mapId: string,
  method: 'land_mons' | 'water_mons' | 'rock_smash_mons' | 'fishing_mons',
  slotIndex: number,
): string | null {
  if (!manifest.identity?.overlaySafe) return null;
  const bn = extractBankNum(mapId);
  if (!bn) return null;
  const slot = resolveWildEncounterSlot(
    manifest.identity,
    bn.bank,
    bn.num,
    method,
    slotIndex,
  );
  if (!slot) return null;
  // Prettify the constant name (strip SPECIES_ prefix + title-case).
  return prettifyConstantName(slot.species, 'SPECIES_');
}

/** Phase I.1 - resolve a dialogue id to a human-readable preview from
 *  manifest.dialogue. Handles both decomp-style ids ("LittlerootTown_
 *  Mom_Text_Hi") and binary synthetic ids ("binary_text_dialogue_0x1a8d0_0").
 *  Returns "<speaker>: <first 60 chars>" when the dialogue is found, or
 *  "Dialogue line #N" when the id matches a binary pattern but isn't in
 *  the manifest (truncated detector run, hack-added text, etc.). */
function lookupDialogue(manifest: ProjectManifest, id: string): string | null {
  const entry = manifest.dialogue.find((d) => d.id === id);
  if (entry) {
    const speaker = entry.speakerName?.trim() ?? '';
    const text = entry.text.trim();
    const preview = text.length > 60 ? `${text.slice(0, 57).trim()}…` : text;
    if (speaker.length > 0 && preview.length > 0) {
      return `${speaker}: "${preview}"`;
    }
    if (preview.length > 0) return `"${preview}"`;
    return null;
  }
  // Generic binary text-table id without a matching dialogue entry - 
  // surface its kind + index in plain English.
  const m = /^binary_text_([a-z_]+)_0x[0-9a-fA-F]+_(\d+)$/.exec(id);
  if (m) {
    const kindLabel = m[1]!.replace(/_/g, ' ').replace(/^(.)/, (c) => c.toUpperCase());
    return `${kindLabel} entry #${m[2]!}`;
  }
  return null;
}

/** Cleans up iter-95's synthetic `Map ${group}.${mapNum}` formatting +
 *  `?` for unknown group. Returns a friendlier "Unnamed area (#mapNum)"
 *  until Phase B's MAPSEC detector lands real region names.
 *
 *  Phase F (semantic-world plan §1.3): when the name comes through as
 *  all-caps Gen-3 MAPSEC text ("PALLET TOWN", "ROUTE 1"), convert to
 *  title case ("Pallet Town", "Route 1") to match the modern game
 *  presentation. Acronyms like "B2F" / "1F" / "S.S." stay as-is. */
export function prettifyMapName(rawName: string, mapId: string): string {
  // Match iter-95 format: `Map G.N` where G may be `?`.
  const m = /^Map (\?|\d+)\.(\d+)$/.exec(rawName);
  if (m) {
    const num = m[2]!;
    return `Unnamed area #${num}`;
  }
  // Also clean up the `binary_map_G_N` synthetic id when it slips into
  // a name field (defensive).
  const idMatch = /^binary_map_(\?|\d+)_(\d+)$/.exec(mapId);
  if (idMatch && rawName === mapId) {
    return `Unnamed area #${idMatch[2]!}`;
  }
  return titleCaseGen3Name(rawName);
}

/** Title-case a Gen-3 region/area name. Vanilla MAPSEC entries are
 *  stored as ALL-CAPS strings ("PALLET TOWN", "VIRIDIAN FOREST", "MT.
 *  MOON 1F"). Modern game presentation uses title case ("Pallet Town").
 *  This helper:
 *    1. Skips strings that already mix case (decomp / hack-set names
 *       shouldn't be re-cased).
 *    2. Lowercases the rest, then capitalizes the first letter of each
 *       word.
 *    3. Preserves common Gen-3 acronyms: floor markers (1F, 2F, B1F,
 *       B2F, B3F, ...), abbreviations (S.S., Mt., R., ETC.).
 *
 *  Exported so tests + other surfaces can reuse the same heuristic. */
/** Canonical singular + plural labels for `MapNode.group` vocabulary
 *  values. The vocabulary is lowercase enums (`town`, `route`, `cave`,
 *  `interior`, `dungeon`, `special`, `unknown`). Both Navigator (which
 *  wants "Towns") and inspector chips (which want "Town") read from
 *  this single source. */
const MAP_GROUP_LABELS: Readonly<Record<string, { readonly singular: string; readonly plural: string }>> = {
  town: { singular: 'Town', plural: 'Towns' },
  route: { singular: 'Route', plural: 'Routes' },
  interior: { singular: 'Interior', plural: 'Interiors' },
  cave: { singular: 'Cave', plural: 'Caves' },
  dungeon: { singular: 'Dungeon', plural: 'Dungeons' },
  special: { singular: 'Special', plural: 'Special' },
  unknown: { singular: 'Other', plural: 'Other' },
};

/** Known engine-metadata keys → user-readable labels. These are the
 *  Object.keys() that show up in trainer.metadata, asset.metadata,
 *  map.metadata across the lifter. Adding a translation here keeps
 *  the AdvancedDetails dictionary readable instead of leaking pieces
 *  of the C struct field name into the UI. */
const METADATA_KEY_LABELS: Readonly<Record<string, string>> = {
  // Trainer
  structFileOffset: 'Struct offset',
  partyOffset: 'Party data offset',
  partyFlags: 'Party config',
  aiFlagsRaw: 'AI behavior flags',
  trainerClass: 'Trainer class id',
  rematchTable: 'Rematch table',
  doubleBattle: 'Double battle',
  // Asset
  sourceTableOffset: 'Source table offset',
  sourceFileOffset: 'Source file offset',
  paletteTag: 'Palette tag',
  tileTag: 'Tile tag',
  // Map
  regionMapSection: 'World map section',
  binaryRomBaseAddress: 'ROM base address',
  binaryRomGameCode: 'ROM game code',
  binaryRomFingerprint: 'ROM fingerprint',
  binaryRomGroup: 'Map group',
  binaryRomMapNum: 'Map number',
  // Common scalars
  width: 'Width',
  height: 'Height',
  size: 'Size',
  byteLength: 'Size (bytes)',
};

export function prettifyMetadataKey(key: string): string {
  const known = METADATA_KEY_LABELS[key];
  if (known) return known;
  // Fallback: split camelCase / snake_case / kebab-case → Title Case.
  const withSpaces = key
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .trim();
  if (withSpaces.length === 0) return key;
  return withSpaces.charAt(0).toUpperCase() + withSpaces.slice(1).toLowerCase();
}

export function prettifyMapGroup(group: string, mode: 'singular' | 'plural' = 'singular'): string {
  const entry = MAP_GROUP_LABELS[group];
  if (entry) return entry[mode];
  if (group.length === 0) return 'Other';
  return group.charAt(0).toUpperCase() + group.slice(1);
}

export function titleCaseGen3Name(name: string): string {
  if (name.length === 0) return name;
  // Skip decomp identifiers (anything with an underscore - e.g.
  // `LITTLEROOT_TOWN`, `MAP_PALLET_TOWN`). Those are C constants, not
  // MAPSEC display strings; the operator already chose that shape.
  if (name.includes('_')) return name;
  // Phase G-RC4: only title-case names that contain whitespace OR a
  // period (genuine display strings like "PALLET TOWN" / "MT. MOON").
  // Single-word all-caps tokens (`ROUTE101`, `ELITE4`) are likely
  // decomp-style identifiers - leave them untouched.
  if (!/[\s.]/.test(name)) return name;
  // Skip if the string isn't predominantly upper-case - assume the
  // author already chose the casing.
  const upper = (name.match(/[A-Z]/g) ?? []).length;
  const lower = (name.match(/[a-z]/g) ?? []).length;
  if (upper === 0 || lower > upper) return name;
  // Lowercase everything first, then re-capitalize the first letter
  // after start-of-string / whitespace / hyphen / period. Apostrophes
  // do NOT trigger uppercase (so "PLAYER'S" → "Player's", not "Player'S").
  // Floor markers (1F / B2F) keep their suffixes uppercase as a
  // post-process.
  return name
    .toLowerCase()
    .replace(/(?<=^|[\s\-.])([a-z])/g, (_match, ch: string) => ch.toUpperCase())
    .replace(/\b(B?\d+F)\b/gi, (m) => m.toUpperCase())
    .replace(/\bMt(?!\.)\b/g, 'Mt.');
}

/** Phase O.43 - Plain-English labels for the most well-known + stable
 *  Gen-3 flag values per pret/pokefirered include/constants/flags.h.
 *  Badge + gym-leader + Elite Four + key story milestone addresses are
 *  preserved verbatim by virtually every FRLG hack because the engine
 *  references them directly. Hack-specific reassignments fall through
 *  to the generic `Flag @ 0xNNNN` label via prettifyHexId.
 *
 *  Conservative scope: only addresses I can verify are stable across
 *  forks. Expansion candidates need a documented citation. */
const VANILLA_FRLG_FLAG_NAMES: ReadonlyMap<number, string> = new Map([
  // Badges (0x820 - 0x827)
  [0x820, 'Boulder Badge obtained'],
  [0x821, 'Cascade Badge obtained'],
  [0x822, 'Thunder Badge obtained'],
  [0x823, 'Rainbow Badge obtained'],
  [0x824, 'Soul Badge obtained'],
  [0x825, 'Marsh Badge obtained'],
  [0x826, 'Volcano Badge obtained'],
  [0x827, 'Earth Badge obtained'],
  // Pokédex / starter / story milestones
  [0x828, 'Pokédex received'],
  [0x829, 'Pokéballs received from Oak'],
  [0x82a, 'Running shoes received'],
  [0x82b, "Oak's Parcel received"],
  [0x82d, 'Got starter from Oak'],
  [0x82e, 'Defeated rival in Oak\'s lab'],
  // Phase O.44 - gym leader defeats (0x82F - 0x836)
  [0x82f, 'Defeated Brock (Pewter)'],
  [0x830, 'Defeated Misty (Cerulean)'],
  [0x831, 'Defeated Lt. Surge (Vermilion)'],
  [0x832, 'Defeated Erika (Celadon)'],
  [0x833, 'Defeated Koga (Fuchsia)'],
  [0x834, 'Defeated Sabrina (Saffron)'],
  [0x835, 'Defeated Blaine (Cinnabar)'],
  [0x836, 'Defeated Giovanni (Viridian)'],
  // Phase O.44 - Elite Four + Champion (0x83F - 0x843)
  [0x83f, 'Defeated Lorelei (Elite Four)'],
  [0x840, 'Defeated Bruno (Elite Four)'],
  [0x841, 'Defeated Agatha (Elite Four)'],
  [0x842, 'Defeated Lance (Elite Four)'],
  [0x843, 'Defeated Champion (rival)'],
]);

/** Phase O.45 - VAR_TEMP_0 through VAR_TEMP_F live at 0x4000 - 0x400F
 *  in every Gen-3 game. Scripts use them as scratch space for compare
 *  + setvar opcodes; the values get reset between map transitions in
 *  most situations. Labels are stable across FRLG / Emerald / RS.
 *  Persistent story vars beyond 0x4010 are too hack-specific to
 *  label safely. */
const VANILLA_GEN3_VAR_NAMES: ReadonlyMap<number, string> = new Map(
  Array.from({ length: 16 }, (_, i) => [
    0x4000 + i,
    `Temp variable ${i.toString(16).toUpperCase()}`,
  ] as [number, string]),
);

/** Render `binary_flag_<decimal>` / `binary_var_<decimal>` /
 *  `flag_0xNNNN` / `script_0xNNNN` / `var_0xNNNN` as friendlier
 *  labels. Resolution order, highest priority first:
 *    1. Hand-curated friendly labels (VANILLA_FRLG_FLAG_NAMES /
 *       VANILLA_GEN3_VAR_NAMES) - these read like "Defeated Brock
 *       (Pewter)" and are intentionally nicer than pret's terse
 *       constant names.
 *    2. Phase Q.1 symbol DB lookup against pret/pokefirered or
 *       pret/pokeemerald - adds ~2,900 canonical names that the
 *       hand-curated set never reached.
 *    3. Synthetic fallback `Flag @ 0xNNNN` / `Var @ 0xNNNN`. */
function prettifyHexId(id: string, manifest: ProjectManifest | null): string | null {
  // First: binary-rom synthetic id `binary_flag_<decimal>`.
  const binFlag = /^binary_flag_(\d+)$/.exec(id);
  if (binFlag) {
    const value = parseInt(binFlag[1]!, 10);
    return resolveFlagName(value, manifest) ?? `Flag @ 0x${value.toString(16)}`;
  }
  // Phase O.45 - `binary_var_<decimal>` mirrors the flag flow.
  const binVar = /^binary_var_(\d+)$/.exec(id);
  if (binVar) {
    const value = parseInt(binVar[1]!, 10);
    return resolveVarName(value, manifest) ?? `Var @ 0x${value.toString(16)}`;
  }
  // Second: `flag_0xNNNN` / `script_0xNNNN` / `var_0xNNNN`.
  const m = /^(script|flag|var)_(0x[0-9a-fA-F]+)$/.exec(id);
  if (!m) return null;
  const kindLabel = m[1]! === 'script' ? 'Script' : m[1]! === 'flag' ? 'Flag' : 'Var';
  if (m[1]! === 'flag') {
    const value = parseInt(m[2]!, 16);
    const resolved = resolveFlagName(value, manifest);
    if (resolved !== null) return resolved;
  }
  if (m[1]! === 'var') {
    const value = parseInt(m[2]!, 16);
    const resolved = resolveVarName(value, manifest);
    if (resolved !== null) return resolved;
  }
  if (m[1]! === 'script' && manifest) {
    const ctxName = resolveScriptContext(id, manifest);
    if (ctxName !== null) return ctxName;
  }
  return `${kindLabel} @ ${m[2]!}`;
}

/** Walk the manifest for a script id (`script_0xNNNN`) and synthesize
 *  a context-derived name. The script bytes themselves are opaque, but
 *  the references tell us what kind of script it is:
 *    - referenced by an ObjectEvent.scriptId → "[NPC] talk script · Map"
 *    - referenced by a Trigger.scriptStepIds → "Trigger script · Map"
 *    - referenced by MapNode.scriptIds → "Map init script · Map"
 *  Returns null if the script id has no references in the manifest
 *  (caller falls back to "Script @ 0xNNNN"). */
function resolveScriptContext(scriptId: string, manifest: ProjectManifest): string | null {
  for (const o of manifest.objectEvents) {
    if (o.scriptId !== scriptId) continue;
    const mapName = prettifyMapNameForMapId(manifest, o.mapId);
    if (o.kind === 'trainer') {
      return mapName ? `Trainer battle script · ${mapName}` : 'Trainer battle script';
    }
    if (o.kind === 'item') {
      return mapName ? `Item pickup script · ${mapName}` : 'Item pickup script';
    }
    return mapName ? `NPC talk script · ${mapName}` : 'NPC talk script';
  }
  for (const t of manifest.triggers ?? []) {
    if (!t.scriptStepIds.includes(scriptId as never)) continue;
    const mapName = t.mapId ? prettifyMapNameForMapId(manifest, t.mapId) : null;
    const kind = t.kind === 'on_enter' ? 'Step-on trigger' : t.kind === 'on_interact' ? 'Interact trigger' : 'Trigger';
    return mapName ? `${kind} script · ${mapName}` : `${kind} script`;
  }
  for (const map of manifest.maps) {
    if (!map.scriptIds.includes(scriptId as never)) continue;
    const mapName = prettifyMapNameForMapId(manifest, map.id);
    return mapName ? `Map init script · ${mapName}` : 'Map init script';
  }
  return null;
}

function prettifyMapNameForMapId(manifest: ProjectManifest, mapId: string): string | null {
  const map = manifest.maps.find((m) => m.id === mapId);
  if (!map) return null;
  return prettifyMapName(map.name, map.id);
}

function resolveFlagName(value: number, manifest: ProjectManifest | null): string | null {
  // Hand-curated UX-first labels win over pret's terse names.
  const curated = VANILLA_FRLG_FLAG_NAMES.get(value);
  if (curated !== undefined) return curated;
  // Phase Q.1 - pret/pokefirered + pret/pokeemerald symbol DB.
  const fromDb = resolveSymbolForIdentity(manifest?.identity ?? null, 'flag', value);
  return fromDb?.name ?? null;
}

function resolveVarName(value: number, manifest: ProjectManifest | null): string | null {
  const curated = VANILLA_GEN3_VAR_NAMES.get(value);
  if (curated !== undefined) return curated;
  const fromDb = resolveSymbolForIdentity(manifest?.identity ?? null, 'var', value);
  return fromDb?.name ?? null;
}

/** Phase O.50 - universally-stable song indices. Vanilla FRLG /
 *  Emerald / RS all reserve song 0 as MUS_DUMMY (silence / no music)
 *  and ~358 as the standard wild-Pokémon battle theme, but specific
 *  numeric assignments diverge enough across forks that broader
 *  labeling needs ROM-fingerprint dispatch. Stick to the universal
 *  cases. */
const UNIVERSAL_SONG_NAMES: ReadonlyMap<number, string> = new Map([
  [0, 'Silence (MUS_DUMMY)'],
]);

/** Render `binary_song_N` / `song_N` as `Song #N` for unknown ids,
 *  or a curated label for the universally-stable indices (e.g.
 *  `song_0` → "Silence" since every Gen-3 game reserves 0 as
 *  MUS_DUMMY). */
function prettifySong(id: string): string | null {
  const idx = matchIndex(id, /^(?:binary_)?song_(\d+)$/);
  if (idx === null) return null;
  const known = UNIVERSAL_SONG_NAMES.get(idx);
  if (known !== undefined) return known;
  return `Song #${String(idx)}`;
}

/** Render `tileset_0xN` / `binary_palette_0xN` / `binary_lz77_*` etc. as
 *  short human-readable tags rather than the raw synthetic id. */
function prettifyAssetLike(id: string): string | null {
  const tile = /^tileset_(0x[0-9a-fA-F]+)$/.exec(id);
  if (tile) return `Tileset @ ${tile[1]!}`;
  const pal = /^binary_palette_(0x[0-9a-fA-F]+)$/.exec(id);
  if (pal) return `Palette @ ${pal[1]!}`;
  const lz = /^binary_lz77_(0x[0-9a-fA-F]+)_(\d+)$/.exec(id);
  if (lz) return `LZ77 sprite @ ${lz[1]!} #${lz[2]!}`;
  const cry = /^binary_cry_(\d+)$/.exec(id);
  if (cry) return `Pokémon cry #${cry[1]!}`;
  return null;
}

/** Render `binary_warp_G_N_W` as `Warp #W (map G.N)`. */
function prettifyWarp(id: string): string | null {
  const m = /^binary_warp_(\?|\d+)_(\d+)_(\d+)$/.exec(id);
  if (!m) return null;
  return `Warp #${m[3]!}`;
}

/** Render `binary_obj_G_N_L` as `Object #L`. */
function prettifyObject(id: string): string | null {
  const m = /^binary_obj_(\?|\d+)_(\d+)_(\d+)$/.exec(id);
  if (!m) return null;
  return `Object #${m[3]!}`;
}

/** Render `binary_coord_G_N_I` / `binary_bg_G_N_I` as `Trigger #I` / `Sign #I`. */
function prettifyTrigger(id: string): string | null {
  const coord = /^binary_coord_(\?|\d+)_(\d+)_(\d+)$/.exec(id);
  if (coord) return `Step trigger #${coord[3]!}`;
  const bg = /^binary_bg_(\?|\d+)_(\d+)_(\d+)$/.exec(id);
  if (bg) return `Sign / hidden item #${bg[3]!}`;
  return null;
}

/** Render `binary_trainer_N` as `Trainer #N`, or `trainer_N` as the
 *  trainer-type enum label when the value matches a known battle type.
 *  ObjectEvent.trainerType holds the byte enum, not a trainer id;
 *  rendering `trainer_1` raw is misleading. */
function prettifyTrainer(id: string): string | null {
  const binary = /^binary_trainer_(\d+)$/.exec(id);
  if (binary) return `Trainer #${binary[1]!}`;
  const typeMatch = /^trainer_(\d+)$/.exec(id);
  if (typeMatch) {
    const v = Number.parseInt(typeMatch[1]!, 10);
    if (v === 0) return 'Not a trainer';
    if (v === 1) return 'Normal trainer (line-of-sight)';
    if (v === 2) return 'Sees all directions';
    if (v === 3) return 'Buried (rock-smash trainer)';
    return `Battle type ${v}`;
  }
  return null;
}

const RESOLVERS: ReadonlyArray<Resolver> = [
  lookupMovementType, // Phase H-RC8 - must come BEFORE lookupMove so
                      // `movement_N` doesn't fall through to a Pokémon-move
                      // resolver via the generic /move_(\d+)/ pattern.
  lookupMovementCommand, // `move_step_N` (applymovement byte) → "Walk
                         // - down". Must come before lookupMove for the
                         // same generic-prefix reason.
  lookupSpecies,
  lookupMove,
  lookupItem,
  lookupAbility,
  lookupTrainerClass,
  lookupType,
  lookupOverworldSprite,
  lookupMap,
  lookupDialogue, // Phase I.1 - must come before passthrough so
                  // dialogue ids render as speaker+preview, not raw.
  // Universal Gen-3 engine constants - turn the synthetic ids the
  // binary-ROM lifter emits for tile behaviors / weather / battle scene
  // / msgbox shape / script opcode / AI flag bit into plain English.
  // None of these conflict with each other's id prefixes.
  lookupTileBehavior,
  lookupWeather,
  lookupMapType,
  lookupBattleScene,
  lookupMsgboxType,
  lookupScriptCommand,
  lookupAiFlag,
];

/**
 * Resolve a manifest entity id (synthetic or real) to a human-readable
 * label. Returns a `DisplayNameResult` so callers can render fallback
 * labels distinctly. `id` of `null`/`undefined` returns the literal
 * " - " passthrough so render paths can drop ternary checks.
 *
 * Order of resolution:
 *   1. Sample-collection lookups (species/move/item/ability/etc.)
 *   2. Map name lookup with `prettifyMapName` post-process
 *   3. Synthetic-prefix prettifiers (script/flag/var/song/tileset/warp/
 *      object/trigger/trainer)
 *   4. Passthrough (no transformation; useful when the id already IS a
 *      real string).
 */
export function resolveDisplayName(
  manifest: ProjectManifest,
  id: string | null | undefined,
): DisplayNameResult {
  if (id === null || id === undefined || id === '') {
    return { text: ' - ', kind: 'passthrough', id: '' };
  }
  // 0. Phase Q.6 - user annotations beat everything. If the user has
  //    explicitly named this id (via the inspector rename UI), that
  //    name wins over every auto-resolved label.
  const guessedKind = guessKindFromId(id);
  if (guessedKind) {
    const userName = lookupAnnotation(guessedKind, id);
    if (userName) {
      return { text: userName, kind: 'real', id };
    }
  }
  // 1. Sample-collection lookups.
  for (const r of RESOLVERS) {
    const result = r(manifest, id);
    if (result !== null) {
      // `Pokémon #N` / `Move #N` / etc. are fallbacks; everything else
      // is a real name (the matched-collection branch checks length>0).
      const isFallback = /(#\d+)$/.test(result);
      return { text: result, kind: isFallback ? 'fallback' : 'real', id };
    }
  }
  // 2. Synthetic-prefix prettifiers. prettifyHexId consults the Phase
  //    Q.1 symbol DB via manifest.identity; the others are id-only.
  {
    const hexResult = prettifyHexId(id, manifest);
    if (hexResult !== null) return { text: hexResult, kind: 'fallback', id };
  }
  for (const fn of [
    prettifySong,
    prettifyAssetLike,
    prettifyWarp,
    prettifyObject,
    prettifyTrigger,
    prettifyTrainer,
  ]) {
    const result = fn(id);
    if (result !== null) return { text: result, kind: 'fallback', id };
  }
  // 3. Passthrough.
  return { text: id, kind: 'passthrough', id };
}

/** Convenience wrapper: returns just the text + optionally appends the
 *  internal id in parens when `showInternalIds` is true. */
export function displayName(
  manifest: ProjectManifest,
  id: string | null | undefined,
  showInternalIds: boolean,
): string {
  const r = resolveDisplayName(manifest, id);
  if (!showInternalIds || r.kind === 'passthrough' || r.id === r.text) return r.text;
  return `${r.text} (${r.id})`;
}
