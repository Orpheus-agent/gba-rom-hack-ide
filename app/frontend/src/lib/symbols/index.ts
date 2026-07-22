// Phase Q.1 - Symbol database runtime API.
//
// Provides plain-English names for ROM offsets (flags, vars, songs) by
// looking them up in the per-ROM-family JSON tables built by
// `scripts/build-symbols.mjs`. Binary-ROM workspaces have no
// `include/constants/*.h` on disk; the editor falls back through this
// API so users still see "FLAG_HIDE_OAK_IN_HIS_LAB" instead of
// "flag_0x2B".
//
// Resolution order (highest priority first):
//   1. User annotations (Phase Q.6 - not yet integrated)
//   2. Manifest-provided name (`Flag.name`, etc. - already used by
//      displayName today, supplied by decomp scanners)
//   3. Symbol DB hit (this module)
//   4. Synthetic ID fallback (prettified for display)
//
// New ROM families (CFRU/Unbound/Radical Red/expansion) get added by
// extending the `KNOWN_FAMILIES` map and running the build script.

// Per-ROM-family symbol databases (firered-vanilla.json,
// emerald-vanilla.json, firered-cfru.json, firered-cfru-dpe.json,
// emerald-expansion.json) are NOT distributed with this repository:
// they are bulk extractions of game content (map lists, wild encounter
// tables, species/move/item/ability rosters) from the pret decomp
// projects. You generate them yourself, from your own decomp checkout:
//
//   node scripts/build-symbols.mjs
//   node scripts/build-vanilla-frlg-truth.mjs
//
// The glob below therefore resolves to {} on a fresh clone, and every
// lookup in this module degrades to "no symbol DB" (null / empty list)
// instead of throwing. See `isSymbolDatabaseAvailable()` and
// app/frontend/src/lib/symbols/data/README.md.
const GENERATED_FAMILY_FILES = import.meta.glob('./data/*.json', {
  eager: true,
  import: 'default',
}) as Readonly<Record<string, unknown>>;
import gen3Universal from './data/gen3-universal.json';
import npcGraphicsBundle from './data/npc-graphics.json';
import type { ProjectIdentity } from '@rom-editor/shared';

export type SymbolKind =
  | 'flag'
  | 'var'
  | 'song'
  | 'species'
  | 'move'
  | 'ability'
  | 'item';

/** Gen-3 universal symbol kinds - stable across vanilla FRLG, vanilla
 *  Emerald, CFRU, and pokeemerald-expansion. These resolve from
 *  `gen3-universal.json` regardless of ROM family. Used by the editor
 *  to render plain-English names for tile behaviors, NPC movement,
 *  msgbox types, weather, map types, battle scenes, AI flag bits, the
 *  applymovement byte commands, and the script opcodes themselves.
 *
 *  Separation rationale: the per-family JSON files (firered-vanilla.json
 *  etc.) hold *content* constants that the romhacker may have rebound
 *  (flags they assigned to their own story, vars they repurposed, songs
 *  they added). The universal file holds *engine* constants that the
 *  game code interprets at fixed values - changing them would mean
 *  patching the engine, not just data. */
export type UniversalSymbolKind =
  | 'tile_behavior'
  | 'movement_type'
  | 'movement_command'
  | 'msgbox_type'
  | 'weather'
  | 'map_type'
  | 'battle_scene'
  | 'ai_flag'
  | 'script_command';
export type RomFamily =
  | 'firered-vanilla'
  | 'emerald-vanilla'
  | 'firered-cfru'
  | 'firered-cfru-dpe'
  | 'emerald-expansion';

/** Phase 6.3 - vanilla ground-truth map entry. Keyed by `${bank}.${num}`
 *  in the SymbolDatabaseFile.maps map. Mirrors what
 *  scripts/build-vanilla-frlg-truth.mjs produces. */
export interface MapTruthEntry {
  readonly name: string;
  readonly sourceName: string;
  readonly mapId: string | null;
  readonly mapsec: string | null;
  readonly mapType: string | null;
  readonly music: string | null;
  readonly weather: string | null;
  readonly regionGroup: 'town' | 'route' | 'cave' | 'interior' | 'unknown';
}

/** Phase 6.3 - region map section entry, keyed by MAPSEC byte
 *  (`'0x58'`) in SymbolDatabaseFile.regionMapSections. Unused MAPSEC
 *  slots emit entries with `name: null`. */
export interface RegionMapSectionEntry {
  readonly mapsec: string;
  readonly name: string | null;
  readonly x: number | null;
  readonly y: number | null;
  readonly width: number | null;
  readonly height: number | null;
}

/** Phase 6.3 - single wild encounter slot. Keyed inside a method
 *  group (`land_mons`, `water_mons`, `rock_smash_mons`, `fishing_mons`)
 *  of a per-map WildEncounterTable. The `species` field carries the
 *  SPECIES_FOO constant name from pret; displayName.ts resolves it
 *  to a friendly label via the existing symbol DB. */
export interface WildEncounterSlot {
  readonly species: string;
  readonly minLevel: number;
  readonly maxLevel: number;
}

export interface WildEncounterMethod {
  readonly encounterRate: number | null;
  readonly mons: ReadonlyArray<WildEncounterSlot>;
}

export interface WildEncounterTable {
  readonly land_mons?: WildEncounterMethod;
  readonly water_mons?: WildEncounterMethod;
  readonly rock_smash_mons?: WildEncounterMethod;
  readonly fishing_mons?: WildEncounterMethod;
}

interface SymbolDatabaseFile {
  readonly family: string;
  readonly generatedAtUtc: string;
  readonly source: Readonly<Record<string, string | null>>;
  readonly flags: Readonly<Record<string, string>>;
  readonly vars: Readonly<Record<string, string>>;
  readonly songs: Readonly<Record<string, string>>;
  /** WP-D - scraped OBJ_EVENT_GFX_* constant map (`0xNN` → constant
   *  name like "OBJ_EVENT_GFX_BRENDAN_NORMAL"). Optional - older
   *  generated files don't have this yet. Used by resolveNpcGraphics
   *  as a fallback after the hand-curated pretty-name map for hack-
   *  added sprites that don't have a curated entry. */
  readonly objectGfx?: Readonly<Record<string, string>>;
  /** Modernize-and-Ship slice 3 - scraped SPECIES_*, MOVE_*, ABILITY_*,
   *  ITEM_* constant maps. Keys are hex indices ("0x1A"), values are
   *  bare constant names ("SPECIES_PIKACHU") that displayName.ts
   *  prettifies at render time. Optional so older generated files
   *  remain compatible. */
  readonly species?: Readonly<Record<string, string>>;
  readonly moves?: Readonly<Record<string, string>>;
  readonly abilities?: Readonly<Record<string, string>>;
  readonly items?: Readonly<Record<string, string>>;
  /** Modernize-and-Ship slice 3 - allow-listed config #defines (CFRU
   *  only by default). Keyed by constant name, value is the numeric.
   *  Used by getConfigValue() for editor surfaces that need to know
   *  CFRU's compile-time config (e.g. level-cap-table inspector). */
  readonly config?: Readonly<Record<string, number>>;
  /** Phase 6.3 - vanilla ground truth scraped from pret/pokefirered.
   *  Present on `firered-vanilla` (and inherited by CFRU + CFRU+DPE
   *  via the fallback chain). The displayName overlay reads these
   *  when ProjectIdentity.overlaySafe is true. */
  readonly maps?: Readonly<Record<string, MapTruthEntry>>;
  readonly regionMapSections?: Readonly<Record<string, RegionMapSectionEntry>>;
  readonly wildEncounters?: Readonly<Record<string, WildEncounterTable>>;
  // 6.3b will add trainers, trainerClasses, npcRoles, musicTracks.
  readonly trainers?: Readonly<Record<string, unknown>>;
  readonly trainerClasses?: Readonly<Record<string, unknown>>;
  readonly npcRoles?: Readonly<Record<string, unknown>>;
  readonly musicTracks?: Readonly<Record<string, string>>;
}

/** Human-readable instruction shown by any surface that needs the
 *  symbol database and finds it absent. Kept in one place so the UI,
 *  the console warning and the tests all say the same thing. */
export const SYMBOL_DB_MISSING_MESSAGE =
  'No symbol database found. This repository ships the generator, not the ' +
  'extracted game data. Run `node scripts/build-symbols.mjs` (and ' +
  '`node scripts/build-vanilla-frlg-truth.mjs` for vanilla map / encounter ' +
  'truth) against your own pret decomp checkout to produce ' +
  'app/frontend/src/lib/symbols/data/<family>.json, then restart the editor.';

function loadFamilyDb(family: RomFamily): SymbolDatabaseFile | undefined {
  const raw = GENERATED_FAMILY_FILES[`./data/${family}.json`];
  return raw ? (raw as SymbolDatabaseFile) : undefined;
}

// Phase Y.1 / Y.2 / 5.4 - fork-specific families layer on top of their
// vanilla base. Resolution checks the fork family first, falls through
// to its parent on a miss. CFRU+DPE → CFRU → firered-vanilla;
// pokeemerald-expansion → emerald-vanilla.
const FORK_FALLBACK: Partial<Record<RomFamily, RomFamily>> = {
  'firered-cfru': 'firered-vanilla',
  'firered-cfru-dpe': 'firered-cfru',
  'emerald-expansion': 'emerald-vanilla',
};

const KNOWN_FAMILIES: ReadonlyArray<RomFamily> = [
  'firered-vanilla',
  'emerald-vanilla',
  'firered-cfru',
  'firered-cfru-dpe',
  'emerald-expansion',
];

/** Families whose generated JSON is actually present on disk. Empty on
 *  a fresh clone until the user runs the generators. */
const DBS: Partial<Record<RomFamily, SymbolDatabaseFile>> = Object.fromEntries(
  KNOWN_FAMILIES.map((family) => [family, loadFamilyDb(family)]).filter(
    ([, db]) => db !== undefined,
  ),
) as Partial<Record<RomFamily, SymbolDatabaseFile>>;

/** Which ROM families have a generated symbol database available. */
export function loadedSymbolFamilies(): ReadonlyArray<RomFamily> {
  return KNOWN_FAMILIES.filter((family) => DBS[family] !== undefined);
}

/** True when at least one per-family symbol database was generated.
 *  UI surfaces that show pret-derived names should render an empty
 *  state pointing at `SYMBOL_DB_MISSING_MESSAGE` when this is false. */
export function isSymbolDatabaseAvailable(): boolean {
  return loadedSymbolFamilies().length > 0;
}

if (!isSymbolDatabaseAvailable() && typeof console !== 'undefined') {
  console.warn(`[symbols] ${SYMBOL_DB_MISSING_MESSAGE}`);
}

/** Resolve a ProjectIdentity to the symbol family it should look up
 *  against, or null if we have no matching DB. Fork-aware: a CFRU-based
 *  hack returns 'firered-cfru' (which falls through to firered-vanilla
 *  on a miss); a pokeemerald-expansion fork returns 'emerald-expansion'
 *  (falling through to emerald-vanilla).
 *
 *  Fork matching is intentionally permissive: any identity.fork value
 *  containing "CFRU" / "Complete Fire Red" / "Radical Red" / "Inflamed"
 *  / "Unbound" maps to firered-cfru, since they all build on CFRU and
 *  share its expanded constant tables. */
export function symbolFamilyForIdentity(
  identity: ProjectIdentity | null,
): RomFamily | null {
  if (!identity) return null;
  const fork = (identity.fork ?? '').toLowerCase();
  // Phase 6.8 - `identity.baseGame` comes from two sources:
  //   1. Decomp detector → 'pokefirered' / 'pokeemerald' (the canonical
  //      decomp project identifier, all-lowercase).
  //   2. Binary patch detector → 'Pokémon FireRed' / 'Pokémon Emerald'
  //      (the cartridge header's friendly name). May arrive UTF-8-
  //      mojibake'd as 'PokÃ©mon FireRed' depending on how the JSON
  //      round-trip handled the 'é'.
  // Normalise to a lowercase ASCII-fold form so both lineages map to the
  // same family. Without this, every binary CFRU+DPE ROM short-circuits
  // here, breaking all of Phase 6's overlay resolvers AND the species/
  // move/ability/item symbol lookups that depend on this function.
  const lineage = normaliseBaseGameLineage(identity.baseGame);
  switch (lineage) {
    case 'firered':
      // Phase 5.4 - DPE check first since it's a superset of CFRU.
      if (isDpeFork(fork)) return 'firered-cfru-dpe';
      if (isCfruFork(fork)) return 'firered-cfru';
      return 'firered-vanilla';
    case 'emerald':
      if (isExpansionFork(fork)) return 'emerald-expansion';
      return 'emerald-vanilla';
    default:
      return null;
  }
}

/** Phase 6.8 - collapse a ProjectIdentity.baseGame value down to a
 *  lineage discriminator ('firered' | 'emerald' | null). Accepts both
 *  decomp identifiers (`pokefirered`) and binary cartridge header names
 *  (`Pokémon FireRed`, `PokÃ©mon FireRed`, etc.). */
function normaliseBaseGameLineage(
  baseGame: string | null,
): 'firered' | 'emerald' | null {
  if (!baseGame) return null;
  // ASCII-fold + lowercase + drop non-alphanumerics so 'Pokémon FireRed',
  // 'PokÃ©mon FireRed' (mojibake), 'pokefirered', 'pokemonfirered' all
  // collapse to 'pokemonfirered' / 'pokefirered' (close enough).
  const normalised = baseGame
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip combining diacritics (NFD remainder)
    .toLowerCase()
    .replace(/[^a-z]/g, '');
  if (normalised.includes('firered') || normalised.includes('fire')) {
    // 'pokefirered' (decomp), 'pokemonfirered' (header), and a few
    // mojibake variants ('pokamonfirered') all hit the 'firered'
    // substring; matching 'fire' alone also catches LeafGreen-shipped
    // header variants since both LG and FR share lineage.
    return 'firered';
  }
  if (normalised.includes('emerald')) return 'emerald';
  if (normalised.includes('leafgreen')) return 'firered';
  return null;
}

function isCfruFork(fork: string): boolean {
  if (!fork) return false;
  return (
    fork.includes('cfru') ||
    fork.includes('complete fire red') ||
    fork.includes('complete-fire-red') ||
    fork.includes('radical red') ||
    fork.includes('radical-red') ||
    fork.includes('inflamed red') ||
    fork.includes('inflamed-red') ||
    fork.includes('unbound')
  );
}

/** Phase 5.4 - detect a CFRU+DPE fork. DPE always rides on top of
 *  CFRU, so the detection key is the presence of any DPE-specific
 *  identifier in addition to (or instead of) the CFRU markers. */
function isDpeFork(fork: string): boolean {
  if (!fork) return false;
  return (
    fork.includes('dpe') ||
    fork.includes('dynamic pokemon expansion') ||
    fork.includes('dynamic-pokemon-expansion') ||
    fork.includes('gen 9') ||
    fork.includes('gen-9')
  );
}

function isExpansionFork(fork: string): boolean {
  if (!fork) return false;
  return (
    fork.includes('expansion') ||
    fork.includes('rh-hideout') ||
    fork.includes('pokeemerald-expansion')
  );
}

export interface ResolvedSymbol {
  readonly name: string;
  readonly family: RomFamily;
  readonly source: 'pret' | 'user' | 'inferred';
}

/** Look up a flag/var/song by hex offset (or decimal). Accepts the
 *  canonical "0x1A2B" form, lowercase variants, and bare decimals.
 *  Returns null on miss. Fork families layer on top of their vanilla
 *  base: a miss in firered-cfru falls through to firered-vanilla
 *  automatically (and the returned `family` field reflects which DB
 *  produced the hit so diagnostics stay honest). */
export function resolveSymbol(
  family: RomFamily,
  kind: SymbolKind,
  value: number | string,
): ResolvedSymbol | null {
  const key = normalizeKey(value);
  if (key === null) return null;
  let cursor: RomFamily | undefined = family;
  while (cursor) {
    const db = DBS[cursor];
    if (db) {
      const map = mapForKind(db, kind);
      const name = map?.[key];
      if (name) return { name, family: cursor, source: 'pret' };
    }
    cursor = FORK_FALLBACK[cursor];
  }
  return null;
}

function mapForKind(
  db: SymbolDatabaseFile,
  kind: SymbolKind,
): Readonly<Record<string, string>> | undefined {
  switch (kind) {
    case 'flag':
      return db.flags;
    case 'var':
      return db.vars;
    case 'song':
      return db.songs;
    case 'species':
      return db.species;
    case 'move':
      return db.moves;
    case 'ability':
      return db.abilities;
    case 'item':
      return db.items;
  }
}

/** Modernize-and-Ship slice 3 - look up an allow-listed config #define
 *  (e.g. BASE_OBEDIENCE_LEVEL, BADGE_1_OBEDIENCE_LEVEL,
 *  FAIRY_TYPE_IMPLEMENTED) by name. Walks the fork → vanilla fallback
 *  chain so a CFRU project picks up CFRU's config first; vanilla
 *  families have an empty config map. Returns null when the key isn't
 *  in any database in the chain. */
export function getConfigValue(
  family: RomFamily,
  key: string,
): number | null {
  let cursor: RomFamily | undefined = family;
  while (cursor) {
    const db = DBS[cursor];
    const value = db?.config?.[key];
    if (typeof value === 'number') return value;
    cursor = FORK_FALLBACK[cursor];
  }
  return null;
}

/** Convenience wrapper: resolves the family from a ProjectIdentity. */
export function getConfigValueForIdentity(
  identity: ProjectIdentity | null,
  key: string,
): number | null {
  const family = symbolFamilyForIdentity(identity);
  if (!family) return null;
  return getConfigValue(family, key);
}

/** Same as resolveSymbol but accepts ProjectIdentity + auto-derives the
 *  family. Convenience for displayName integration. */
export function resolveSymbolForIdentity(
  identity: ProjectIdentity | null,
  kind: SymbolKind,
  value: number | string,
): ResolvedSymbol | null {
  const family = symbolFamilyForIdentity(identity);
  if (!family) return null;
  return resolveSymbol(family, kind, value);
}

// ---------------------------------------------------------------------
// Phase 6.4 - Vanilla ground-truth resolvers
//
// These hooks read the scraped pret data merged into firered-vanilla.json
// (Phase 6.3) and only activate when ProjectIdentity.overlaySafe is true.
// overlaySafe is set by the patch detector (Phase 6.2) when the op-log
// records that the editor's own modernise flow produced this ROM. When
// false, the resolvers short-circuit and the displayName layer
// (Phase 6.5) falls through to the synthetic naming path.
// ---------------------------------------------------------------------

/** Walk the FORK_FALLBACK chain until we find a database that has
 *  the requested truth surface populated. Same shape as the existing
 *  `resolveSymbol` walker but keyed by an arbitrary field selector. */
function walkChainForTruth<T>(
  family: RomFamily,
  pick: (db: SymbolDatabaseFile) => Readonly<Record<string, T>> | undefined,
): Readonly<Record<string, T>> | null {
  let cursor: RomFamily | undefined = family;
  while (cursor) {
    const db = DBS[cursor];
    const map = db ? pick(db) : undefined;
    if (map && Object.keys(map).length > 0) return map;
    cursor = FORK_FALLBACK[cursor];
  }
  return null;
}

/** Resolve a map's vanilla ground truth from its (bank, num) pair.
 *  Returns null when:
 *  - ProjectIdentity is missing or `overlaySafe` is false (caller hasn't
 *    earned the right to assert vanilla labels)
 *  - The (bank, num) pair has no vanilla counterpart in pret
 *  Otherwise returns the MapTruthEntry that pret records for that slot. */
export function resolveMapTruth(
  identity: ProjectIdentity | null,
  groupIdx: number,
  mapNum: number,
): MapTruthEntry | null {
  if (!identity?.overlaySafe) return null;
  const family = symbolFamilyForIdentity(identity);
  if (!family) return null;
  const maps = walkChainForTruth(family, (db) => db.maps);
  if (!maps) return null;
  return maps[`${groupIdx}.${mapNum}`] ?? null;
}

/** Resolve a region map section by MAPSEC byte value (0..255) or by
 *  the MAPSEC_FOO constant name. Returns null on miss / not overlaySafe. */
export function resolveRegionMapSection(
  identity: ProjectIdentity | null,
  mapsecRef: number | string,
): RegionMapSectionEntry | null {
  if (!identity?.overlaySafe) return null;
  const family = symbolFamilyForIdentity(identity);
  if (!family) return null;
  const sections = walkChainForTruth(family, (db) => db.regionMapSections);
  if (!sections) return null;
  if (typeof mapsecRef === 'number') {
    const key = `0x${mapsecRef.toString(16).toUpperCase()}`;
    return sections[key] ?? null;
  }
  // String lookup by MAPSEC_FOO constant name.
  for (const entry of Object.values(sections)) {
    if (entry.mapsec === mapsecRef) return entry;
  }
  return null;
}

/** Resolve a wild encounter slot's vanilla species default by (bank, num)
 *  + method + slot index. The method names match pret's JSON
 *  (`land_mons`, `water_mons`, `rock_smash_mons`, `fishing_mons`).
 *  Returns the SPECIES_FOO constant name in the slot (callers can then
 *  prettify via the existing species lookup) plus the level range. */
export function resolveWildEncounterSlot(
  identity: ProjectIdentity | null,
  groupIdx: number,
  mapNum: number,
  method: 'land_mons' | 'water_mons' | 'rock_smash_mons' | 'fishing_mons',
  slotIndex: number,
): WildEncounterSlot | null {
  if (!identity?.overlaySafe) return null;
  const family = symbolFamilyForIdentity(identity);
  if (!family) return null;
  const tables = walkChainForTruth(family, (db) => db.wildEncounters);
  if (!tables) return null;
  const table = tables[`${groupIdx}.${mapNum}`];
  if (!table) return null;
  const slots = table[method]?.mons;
  if (!slots) return null;
  return slots[slotIndex] ?? null;
}

/** Resolve the encounter table for a (bank, num) map - returns the
 *  full table (all four method groups) when available, or null. */
export function resolveWildEncounterTable(
  identity: ProjectIdentity | null,
  groupIdx: number,
  mapNum: number,
): WildEncounterTable | null {
  if (!identity?.overlaySafe) return null;
  const family = symbolFamilyForIdentity(identity);
  if (!family) return null;
  const tables = walkChainForTruth(family, (db) => db.wildEncounters);
  if (!tables) return null;
  return tables[`${groupIdx}.${mapNum}`] ?? null;
}

/** Phase 6.3b stub - resolve a trainer by id. Always returns null
 *  until the scraper extracts pret's trainers.h. The function shape
 *  is stable so Phase 6.5 can wire to it now without rework later. */
export function resolveTrainerTruth(
  identity: ProjectIdentity | null,
  _trainerId: number | string,
): null {
  if (!identity?.overlaySafe) return null;
  return null;
}

/** Phase 6.3b stub - resolve an NPC's role on a map. */
export function resolveNpcRole(
  identity: ProjectIdentity | null,
  _groupIdx: number,
  _mapNum: number,
  _objectEventIdx: number,
): null {
  if (!identity?.overlaySafe) return null;
  return null;
}

/** Phase 6.3b stub - resolve a music track's friendly name.
 *  Deferred because pret's MUS_* comments are Japanese aliases, not
 *  user-friendly track names. */
export function resolveMusicName(
  identity: ProjectIdentity | null,
  songId: string,
): string | null {
  if (!identity?.overlaySafe) return null;
  const family = symbolFamilyForIdentity(identity);
  if (!family) return null;
  const tracks = walkChainForTruth(family, (db) => db.musicTracks);
  if (!tracks) return null;
  return tracks[songId] ?? null;
}

function normalizeKey(value: number | string): string | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) return null;
    return `0x${value.toString(16).toUpperCase()}`;
  }
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (/^0x[0-9A-Fa-f]+$/.test(trimmed)) {
    // Normalize case + drop leading zeroes by re-parsing.
    return `0x${parseInt(trimmed, 16).toString(16).toUpperCase()}`;
  }
  if (/^[0-9]+$/.test(trimmed)) {
    return `0x${parseInt(trimmed, 10).toString(16).toUpperCase()}`;
  }
  return null;
}

/** Enumerate every symbol of a kind. Convenience for "list all known
 *  flags" UIs (Phase Q.2 FlagInspector cross-reference panel). */
export function listSymbols(
  family: RomFamily,
  kind: SymbolKind,
): ReadonlyArray<{ readonly hex: string; readonly name: string }> {
  const db = DBS[family];
  if (!db) return [];
  const map = mapForKind(db, kind);
  if (!map) return [];
  return Object.entries(map).map(([hex, name]) => ({ hex, name }));
}

/** Phase 7.1 - Enumerate every symbol of a kind across the full
 *  FORK_FALLBACK chain. Where the same hex appears in multiple
 *  databases (most species 0-251 exist in all three FRLG families),
 *  the most-specific family wins (cfru-dpe beats cfru beats vanilla).
 *
 *  Used by EntityPicker to fill its name-autocomplete datalist with
 *  every Pokémon / move / item / ability the project's ROM family
 *  knows about - including the 1241 species DPE adds past CFRU's
 *  vanilla-derived range. Without this, the picker only saw the
 *  binary scanner's in-ROM name table, which renders "?" for every
 *  hack-added slot whose name byte the scanner couldn't decode. */
export function listSymbolsForIdentity(
  identity: ProjectIdentity | null,
  kind: SymbolKind,
): ReadonlyArray<{
  readonly hex: string;
  readonly name: string;
  readonly family: RomFamily;
}> {
  if (!identity) return [];
  const startFamily = symbolFamilyForIdentity(identity);
  if (!startFamily) return [];

  // Walk the chain accumulating unique hex keys. The first family in
  // the walk (most specific) wins for any shared key - so a CFRU+DPE
  // ROM gets SPECIES_CALYREX from cfru-dpe.json while still inheriting
  // SPECIES_BULBASAUR from firered-vanilla.json.
  const merged = new Map<
    string,
    { hex: string; name: string; family: RomFamily }
  >();
  let cursor: RomFamily | undefined = startFamily;
  while (cursor) {
    const db = DBS[cursor];
    if (db) {
      const map = mapForKind(db, kind);
      if (map) {
        for (const [hex, name] of Object.entries(map)) {
          if (!merged.has(hex)) {
            merged.set(hex, { hex, name, family: cursor });
          }
        }
      }
    }
    cursor = FORK_FALLBACK[cursor];
  }

  // Numerically-sorted output so the picker's datalist reads in id
  // order rather than the hash-table iteration order of each db.
  return Array.from(merged.values()).sort((a, b) => {
    const av = Number.parseInt(a.hex, 16);
    const bv = Number.parseInt(b.hex, 16);
    if (!Number.isFinite(av) || !Number.isFinite(bv)) return 0;
    return av - bv;
  });
}

// ---------------------------------------------------------------------
// Universal Gen-3 symbol resolution.
//
// Tile behaviors, NPC movement types, the applymovement command bytes,
// msgbox shapes, weather, map_type, battle_scene, ai_flag bits, and
// script opcodes are stable engine constants - they don't vary by ROM
// family (CFRU/RHH/Unbound all inherit them). Resolution comes from
// gen3-universal.json directly, no per-family fallback chain.

interface UniversalSymbolEntry {
  readonly name: string;
  readonly description?: string;
}

interface UniversalSymbolFile {
  readonly kind: string;
  readonly tileBehaviors: Readonly<Record<string, UniversalSymbolEntry>>;
  readonly movementTypes: Readonly<Record<string, UniversalSymbolEntry>>;
  readonly movementCommands: Readonly<Record<string, UniversalSymbolEntry>>;
  readonly msgboxTypes: Readonly<Record<string, UniversalSymbolEntry>>;
  readonly weather: Readonly<Record<string, UniversalSymbolEntry>>;
  readonly mapTypes: Readonly<Record<string, UniversalSymbolEntry>>;
  readonly battleScenes: Readonly<Record<string, UniversalSymbolEntry>>;
  readonly aiFlags: Readonly<Record<string, UniversalSymbolEntry>>;
  readonly scriptCommands: Readonly<Record<string, UniversalSymbolEntry>>;
}

const UNIVERSAL_DB: UniversalSymbolFile = gen3Universal as UniversalSymbolFile;

/** Normalize a JSON key (which may use `0x02` for readability) to the
 *  canonical lookup form (`0x2` - uppercase, no leading zeros) so it
 *  matches whatever `normalizeKey` produces from numeric / string input. */
function normalizeUniversalMap(
  raw: Readonly<Record<string, UniversalSymbolEntry>>,
): Readonly<Record<string, UniversalSymbolEntry>> {
  const out: Record<string, UniversalSymbolEntry> = {};
  for (const [k, v] of Object.entries(raw)) {
    const normalized = normalizeKey(k);
    if (normalized !== null) out[normalized] = v;
  }
  return out;
}

const UNIVERSAL_MAPS: Readonly<Record<UniversalSymbolKind, Readonly<Record<string, UniversalSymbolEntry>>>> = {
  tile_behavior: normalizeUniversalMap(UNIVERSAL_DB.tileBehaviors),
  movement_type: normalizeUniversalMap(UNIVERSAL_DB.movementTypes),
  movement_command: normalizeUniversalMap(UNIVERSAL_DB.movementCommands),
  msgbox_type: normalizeUniversalMap(UNIVERSAL_DB.msgboxTypes),
  weather: normalizeUniversalMap(UNIVERSAL_DB.weather),
  map_type: normalizeUniversalMap(UNIVERSAL_DB.mapTypes),
  battle_scene: normalizeUniversalMap(UNIVERSAL_DB.battleScenes),
  ai_flag: normalizeUniversalMap(UNIVERSAL_DB.aiFlags),
  script_command: normalizeUniversalMap(UNIVERSAL_DB.scriptCommands),
};

/** Resolve a Gen-3 universal engine constant (tile behavior, weather,
 *  msgbox type, etc.) to its plain-English name + optional description.
 *  Accepts the canonical "0x..." form, lowercase variants, and bare
 *  decimals. Returns null on miss so callers can fall back to a generic
 *  label ("Behavior #N", "Weather #N"). */
export function resolveUniversalSymbol(
  kind: UniversalSymbolKind,
  value: number | string,
): UniversalSymbolEntry | null {
  const map = UNIVERSAL_MAPS[kind];
  if (!map) return null;
  const key = normalizeKey(value);
  if (key === null) return null;
  const entry = map[key];
  return entry ?? null;
}

// ---------------------------------------------------------------------
// NPC graphics (OBJ_EVENT_GFX_*) - per-family resolution because FRLG
// and Emerald have completely different rosters. Backs the
// NpcGraphicsPicker that replaces the raw 0-255 number input on
// ObjectEventInspector.

export type NpcGraphicsCategory =
  | 'player'
  | 'generic'
  | 'story'
  | 'gym_leader'
  | 'elite_four'
  | 'frontier_brain'
  | 'team'
  | 'legendary'
  | 'decoration'
  | 'object'
  | 'misc';

export interface NpcGraphicsEntry {
  /** Pretty display name - "Brendan (default)", "Bug Catcher", "Pikachu". */
  readonly name: string;
  /** Coarse category - drives the grouped sidebar in the picker. */
  readonly category: NpcGraphicsCategory;
}

interface NpcGraphicsBundle {
  readonly kind: string;
  readonly emerald: Readonly<Record<string, NpcGraphicsEntry>>;
  readonly firered: Readonly<Record<string, NpcGraphicsEntry>>;
}

const NPC_GRAPHICS_BUNDLE: NpcGraphicsBundle = npcGraphicsBundle as NpcGraphicsBundle;

function normalizeNpcGraphicsMap(
  raw: Readonly<Record<string, NpcGraphicsEntry>>,
): Readonly<Record<string, NpcGraphicsEntry>> {
  const out: Record<string, NpcGraphicsEntry> = {};
  for (const [k, v] of Object.entries(raw)) {
    const n = normalizeKey(k);
    if (n !== null) out[n] = v;
  }
  return out;
}

const NPC_GRAPHICS_BY_FAMILY: Readonly<Record<RomFamily, Readonly<Record<string, NpcGraphicsEntry>>>> = {
  'firered-vanilla': normalizeNpcGraphicsMap(NPC_GRAPHICS_BUNDLE.firered),
  'firered-cfru': normalizeNpcGraphicsMap(NPC_GRAPHICS_BUNDLE.firered),
  // Phase 5.4 - DPE inherits CFRU's overworld sprite table (DPE
  // doesn't replace overworld sprites; it expands the battle-sprite
  // / icon registries).
  'firered-cfru-dpe': normalizeNpcGraphicsMap(NPC_GRAPHICS_BUNDLE.firered),
  'emerald-vanilla': normalizeNpcGraphicsMap(NPC_GRAPHICS_BUNDLE.emerald),
  'emerald-expansion': normalizeNpcGraphicsMap(NPC_GRAPHICS_BUNDLE.emerald),
};

/** Resolve an OBJ_EVENT_GFX_* graphics id to {name, category} for the
 *  given ROM family. CFRU hacks inherit the FRLG roster (DPE adds
 *  species but the OW sprite indices stay vanilla-shaped); expansion
 *  hacks inherit the Emerald roster.
 *
 *  WP-D fallback chain (in order):
 *    1. Hand-curated pretty name + category (covers vanilla rosters).
 *    2. Scraped OBJ_EVENT_GFX_* constant from build-symbols.mjs
 *       (catches hack-added sprites in CFRU / expansion / future
 *       ROM hacks; falls through fork→vanilla like the rest of the
 *       symbol DB).
 *    3. null - callers fall back to a generic "NPC sprite #N" label.
 */
export function resolveNpcGraphics(
  family: RomFamily | null,
  value: number | string,
): NpcGraphicsEntry | null {
  if (!family) return null;
  const map = NPC_GRAPHICS_BY_FAMILY[family];
  const key = normalizeKey(value);
  if (key === null) return null;
  // Layer 1 - hand-curated pretty names.
  if (map) {
    const hit = map[key];
    if (hit) return hit;
  }
  // Layer 2 - scraped constant. Walk fork → vanilla.
  for (let f: RomFamily | undefined = family; f; f = FORK_FALLBACK[f] ?? undefined) {
    const db = DBS[f];
    const objectGfx = db?.objectGfx;
    if (!objectGfx) continue;
    const constName = objectGfx[key];
    if (constName) {
      return {
        name: prettifyGfxConstant(constName),
        category: 'misc',
      };
    }
  }
  return null;
}

/** Convert "OBJ_EVENT_GFX_BRENDAN_MACH_BIKE" → "Brendan Mach Bike".
 *  Used when only the scraped constant name is available (no curated
 *  pretty name). The visual result reads like Title Case with spaces
 *  instead of underscores - good enough that users don't see hex. */
function prettifyGfxConstant(constName: string): string {
  const stripped = constName.replace(/^OBJ_EVENT_GFX_/, '');
  if (stripped.length === 0) return constName;
  return stripped
    .split('_')
    .map((word) => {
      if (word.length === 0) return word;
      // Preserve all-caps abbreviations of 2-3 letters (HM, TM, NPC, OW).
      if (word.length <= 3 && word === word.toUpperCase()) return word;
      return word[0]!.toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(' ');
}

/** Convenience wrapper for ProjectIdentity callers. */
export function resolveNpcGraphicsForIdentity(
  identity: ProjectIdentity | null,
  value: number | string,
): NpcGraphicsEntry | null {
  const family = symbolFamilyForIdentity(identity);
  return resolveNpcGraphics(family, value);
}

/** Enumerate every NPC graphics entry for a family, in numeric order.
 *  Drives the picker's grouped list. */
export function listNpcGraphics(
  family: RomFamily | null,
): ReadonlyArray<{ readonly graphicsId: number; readonly name: string; readonly category: NpcGraphicsCategory }> {
  if (!family) return [];
  const map = NPC_GRAPHICS_BY_FAMILY[family];
  if (!map) return [];
  const out: { graphicsId: number; name: string; category: NpcGraphicsCategory }[] = [];
  for (const [hex, entry] of Object.entries(map)) {
    const id = parseInt(hex.replace(/^0x/i, ''), 16);
    if (!Number.isFinite(id)) continue;
    out.push({ graphicsId: id, name: entry.name, category: entry.category });
  }
  out.sort((a, b) => a.graphicsId - b.graphicsId);
  return out;
}

/** Same, but resolves the family from a ProjectIdentity. */
export function listNpcGraphicsForIdentity(
  identity: ProjectIdentity | null,
): ReadonlyArray<{ readonly graphicsId: number; readonly name: string; readonly category: NpcGraphicsCategory }> {
  const family = symbolFamilyForIdentity(identity);
  return listNpcGraphics(family);
}

/** Enumerate every entry of a universal-symbol kind. Powers dropdown
 *  pickers (the tileset editor's behavior dropdown, the map header
 *  weather dropdown, the trainer AI flag checkbox grid). */
export function listUniversalSymbols(
  kind: UniversalSymbolKind,
): ReadonlyArray<{ readonly hex: string; readonly name: string; readonly description?: string }> {
  const map = UNIVERSAL_MAPS[kind];
  if (!map) return [];
  return Object.entries(map).map(([hex, entry]) => ({
    hex,
    name: entry.name,
    description: entry.description,
  }));
}

/** Diagnostics - how many symbols loaded across all families. Lets
 *  the Project view surface "2,900 vanilla symbols loaded" so users
 *  see when the DB is in effect.
 *
 *  Families whose generated JSON is absent are reported with zero
 *  counts and an empty source rather than omitted, so a caller can
 *  render "firered-vanilla: not generated" without special-casing. */
export function symbolDbSummary(): ReadonlyArray<{
  readonly family: RomFamily;
  readonly flagCount: number;
  readonly varCount: number;
  readonly songCount: number;
  readonly source: string;
  readonly generated: boolean;
}> {
  return KNOWN_FAMILIES.map((family) => {
    const db = DBS[family];
    if (!db) {
      return {
        family,
        flagCount: 0,
        varCount: 0,
        songCount: 0,
        source: '',
        generated: false,
      };
    }
    return {
      family,
      flagCount: Object.keys(db.flags ?? {}).length,
      varCount: Object.keys(db.vars ?? {}).length,
      songCount: Object.keys(db.songs ?? {}).length,
      source: db.source?.flags ?? '',
      generated: true,
    };
  });
}
