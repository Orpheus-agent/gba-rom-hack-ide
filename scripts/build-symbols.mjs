#!/usr/bin/env node
// Phase Q.1 - Symbol database build script.
//
// Fetches pret/pokefirered and pret/pokeemerald reference symbol headers
// from GitHub raw and parses them into the editor's symbol database JSON
// format (symbols/<rom-family>.json). The output is consumed by
// `app/frontend/src/lib/symbols/index.ts` at runtime so binary-ROM
// workspaces (where include/constants/*.h is not on disk) still get
// human-readable flag/var/song/species names instead of `flag_0x223`.
//
// Run from repo root:   node scripts/build-symbols.mjs
//
// Re-run whenever:
// - A new ROM family is added (CFRU / pokeemerald-expansion / Unbound)
// - pret upstream adds new constants
// - We notice missing canonical names

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import https from 'node:https';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Fetch helper
// ---------------------------------------------------------------------------

function fetchText(url) {
  return new Promise((res, rej) => {
    https
      .get(url, (response) => {
        if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          // Follow redirect once.
          fetchText(response.headers.location).then(res, rej);
          return;
        }
        if (response.statusCode !== 200) {
          rej(new Error(`GET ${url} → HTTP ${response.statusCode}`));
          return;
        }
        let data = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => (data += chunk));
        response.on('end', () => res(data));
      })
      .on('error', rej);
  });
}

// ---------------------------------------------------------------------------
// C #define parser (subset adequate for pret's constant headers)
//
// Handles two shapes:
//
//   #define FLAG_BADGE01_GET                 0x820
//   #define FLAG_TEMP_1                      (TEMP_FLAGS_START + 0x01)
//
// Arithmetic resolution: we maintain a running `env` of already-resolved
// names so subsequent expressions can reference them. Math is restricted
// to + and - with integer literals, hex literals, and previously defined
// identifiers - adequate for pret's headers.
// ---------------------------------------------------------------------------

function parseDefines(source) {
  const out = new Map();
  const lines = source.split(/\r?\n/);
  const lineRe = /^\s*#define\s+([A-Z_0-9]+)\s+(.+?)(?:\s*\/\/.*|\s*\/\*.*?\*\/)?\s*$/;
  for (const line of lines) {
    const m = line.match(lineRe);
    if (!m) continue;
    const name = m[1];
    const rawValue = m[2].trim();
    if (rawValue.startsWith('(')) {
      // Strip outermost parens for the evaluator.
      const inner = rawValue.replace(/^\(\s*/, '').replace(/\s*\)$/, '');
      const v = evalExpr(inner, out);
      if (v !== null) out.set(name, v);
    } else {
      const v = evalAtom(rawValue, out);
      if (v !== null) out.set(name, v);
    }
  }
  return out;
}

function evalAtom(s, env) {
  s = s.trim();
  if (s === '') return null;
  if (/^0x[0-9A-Fa-f]+$/.test(s)) return parseInt(s, 16);
  if (/^[0-9]+$/.test(s)) return parseInt(s, 10);
  if (/^[A-Z_0-9]+$/.test(s)) {
    const v = env.get(s);
    return typeof v === 'number' ? v : null;
  }
  return null;
}

function evalExpr(s, env) {
  // Accept `A + B - C + 0x10` style expressions.
  const tokens = s.split(/(\+|-)/).map((t) => t.trim()).filter(Boolean);
  if (tokens.length === 0) return null;
  let total = evalAtom(tokens[0], env);
  if (total === null) return null;
  for (let i = 1; i + 1 < tokens.length; i += 2) {
    const op = tokens[i];
    const v = evalAtom(tokens[i + 1], env);
    if (v === null) return null;
    if (op === '+') total += v;
    else if (op === '-') total -= v;
    else return null;
  }
  return total;
}

// ---------------------------------------------------------------------------
// Category filters - drop the obvious "base address" sentinels so consumers
// don't see entries like `TEMP_FLAGS_START` clogging the database. We keep
// them in `env` (needed for arithmetic) but exclude from the JSON output.
// ---------------------------------------------------------------------------

const FLAG_EXCLUDE_RE = /^(FLAGS_COUNT|FLAG_NONE|TEMP_FLAGS_START|SPECIAL_FLAGS_START|SYSTEM_FLAGS|TRAINER_FLAGS_START|TRAINER_FLAGS_END|SYSTEM_FLAGS_END|HIDDEN_ITEMS_START|HIDDEN_ITEMS_END|HIDDEN_ITEMS_COUNT|FLAG_HIDDEN_ITEMS_START|FLAG_HIDDEN_ITEMS_END|DAILY_FLAGS_START|DAILY_FLAGS_END)$/;
const VAR_EXCLUDE_RE = /^(VARS_COUNT|VARS_START|SPECIAL_VARS_START|TEMP_VARS_START|VARS_END)$/;
const SONG_EXCLUDE_RE = /^(MUS_DUMMY|SE_DUMMY|MUSIC_COUNT|MUS_NONE|MUS_NONE_OR_INVALID)$/;
// WP-D - drop the obvious sentinels but keep every actual graphic id.
const OBJ_GFX_EXCLUDE_RE = /^(OBJ_EVENT_GFX_NONE|NUM_OBJ_EVENT_GFX|OBJ_EVENT_GFX_COUNT)$/;

// Modernize-and-Ship slice 3 - species/move/ability/item constant
// tables. Same exclude pattern as flags/vars: drop the count + none
// sentinels, keep every real entry. Names land in the JSON verbatim
// (e.g. "SPECIES_BULBASAUR"); displayName.ts handles the strip-prefix
// + title-case prettification at render time.
const SPECIES_EXCLUDE_RE = /^(SPECIES_NONE|NUM_SPECIES|SPECIES_COUNT|SPECIES_TABLES_TERMIN|SPECIES_EGG|SPECIES_OLD_UNOWN_.+|SPECIES_MAX)$/;
const MOVE_EXCLUDE_RE = /^(MOVE_NONE|MOVES_COUNT|MOVE_COUNT|MOVE_UNAVAILABLE)$/;
const ABILITY_EXCLUDE_RE = /^(ABILITY_NONE|ABILITIES_COUNT|ABILITY_COUNT)$/;
const ITEM_EXCLUDE_RE = /^(ITEM_NONE|ITEMS_COUNT|ITEM_COUNT|ITEM_USE_OUT_OF_BATTLE|ITEM_USE_IN_BATTLE|ITEM_B_USE_MEDICINE|ITEM_B_USE_OTHER)$/;

// Modernize-and-Ship slice 3 - CFRU's src/config.h has many
// preprocessor-guarded defines. We only extract the subset we know
// the editor needs (level-cap-table filing in a future slice). The
// allow-list keeps the JSON small and the parser's footprint
// predictable - anything that doesn't match is ignored.
const CONFIG_ALLOWLIST_RE = /^(BASE_OBEDIENCE_LEVEL|BADGE_\d+_OBEDIENCE_LEVEL|MAX_LEVEL|FIRST_PARTY_MEMBER_LEVEL|MAX_BAG_ITEM_CAPACITY|EXP_(GAIN_TYPE|CAP_TYPE)|OBEDIENCE_BY_BADGE_AMOUNT|OBEDIENCE_CHECK_FOR_PLAYER_ORIGINAL_POKEMON|FAIRY_TYPE_IMPLEMENTED|DAY_NIGHT_TINTING|MEGA_EVOLUTION_FEATURE|Z_MOVE_FEATURE|DYNAMAX_FEATURE)$/;

function filterTo(entries, prefix, excludeRe) {
  const out = {};
  for (const [name, value] of entries) {
    if (!name.startsWith(prefix)) continue;
    if (excludeRe.test(name)) continue;
    out[`0x${value.toString(16).toUpperCase()}`] = name;
  }
  return out;
}

/** Modernize-and-Ship slice 3 - allow-listed config #defines for
 *  src/config.h. Unlike flag/var/song scraping (which uses prefix
 *  matching), config entries are picked by full-name allow-list so
 *  we don't accidentally export every implementation detail. Output
 *  shape mirrors filterTo but the key is the constant name (the
 *  config consumer queries by name, not by hex value). */
function filterConfig(entries, allowlistRe) {
  const out = {};
  for (const [name, value] of entries) {
    if (!allowlistRe.test(name)) continue;
    out[name] = value;
  }
  return out;
}

// WP-D - Object event graphics ids. The hand-curated npc-graphics.json
// has pretty names + categories for the common vanilla rosters. The
// scraper picks up everything ELSE (hack-added sprites in CFRU /
// expansion / future ROM hacks) so we have at least a constant-name
// fallback instead of "NPC sprite #N". Output keys are `0xNN` hex
// strings (matches the runtime resolver's `normalizeKey` for graphics
// IDs, which are u8 0..255) - value is the bare constant name; the
// loader converts it to a pretty form at display time.
//
// Two source-shape variants in the wild:
//   - pret/pokefirered, pret/pokeemerald, rh-hideout/pokeemerald-expansion
//     use `#define OBJ_EVENT_GFX_<NAME> N` - parsed by parseDefines().
//   - Skeli789/Complete-Fire-Red-Upgrade uses a C enum with the
//     `EVENT_OBJ_GFX_<NAME>` prefix (auto-incrementing values, optional
//     `= N` assignments). Handled by parseEnumValues().
function filterObjectGfx(entries) {
  const out = {};
  for (const [name, value] of entries) {
    if (!name.startsWith('OBJ_EVENT_GFX_') && !name.startsWith('EVENT_OBJ_GFX_')) continue;
    if (OBJ_GFX_EXCLUDE_RE.test(name)) continue;
    // Some headers define template macros (e.g. OBJ_EVENT_GFX_OW_MON
    // for dynamic Pokémon spawns). Skip non-integer values.
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 0xff) {
      continue;
    }
    out[`0x${value.toString(16).toUpperCase().padStart(2, '0')}`] = name;
  }
  return out;
}

/** Parse a C enum body - handles auto-incrementing values + explicit
 *  `= N` assignments + trailing commas + line comments. Returns the
 *  same Map shape as parseDefines so filterObjectGfx can consume it. */
function parseEnumValues(source) {
  const out = new Map();
  // Pull out every `enum [Name] { ... }` block. The header may have
  // multiple enums; we union them - the prefix filter in
  // filterObjectGfx keeps only the OBJ/EVENT graphics ones.
  const enumBlockRe = /enum[\s\S]*?\{([\s\S]*?)\}/g;
  let match;
  while ((match = enumBlockRe.exec(source)) !== null) {
    const body = match[1];
    let nextValue = 0;
    // Split on commas + newlines; allow inline `// comment` after entry.
    const tokens = body.split(/,/);
    for (let rawToken of tokens) {
      // Strip line + block comments.
      rawToken = rawToken.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').trim();
      if (rawToken.length === 0) continue;
      const eqMatch = rawToken.match(/^([A-Z_0-9]+)\s*=\s*(.+)$/);
      const bareMatch = rawToken.match(/^([A-Z_0-9]+)$/);
      let name;
      if (eqMatch) {
        name = eqMatch[1];
        const v = evalAtom(eqMatch[2].trim(), out);
        if (v === null) {
          // Couldn't resolve - assume sequential from last assigned.
          out.set(name, nextValue);
          nextValue += 1;
        } else {
          out.set(name, v);
          nextValue = v + 1;
        }
      } else if (bareMatch) {
        name = bareMatch[1];
        out.set(name, nextValue);
        nextValue += 1;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Family-specific build pipelines
// ---------------------------------------------------------------------------

async function buildFamily(family) {
  const cfg = FAMILIES[family];
  if (!cfg) throw new Error(`Unknown family ${family}`);

  const out = {
    family,
    generatedAtUtc: new Date().toISOString(),
    source: {
      flags: cfg.flagsUrl,
      vars: cfg.varsUrl,
      songs: cfg.songsUrl,
      objectGfx: cfg.objectGfxUrl ?? null,
      species: cfg.speciesUrl ?? null,
      moves: cfg.movesUrl ?? null,
      abilities: cfg.abilitiesUrl ?? null,
      items: cfg.itemsUrl ?? null,
      config: cfg.configUrl ?? null,
    },
    flags: {},
    vars: {},
    songs: {},
    /** WP-D - `0xNN` (decimal u8 written as hex string) → bare constant
     *  name like "OBJ_EVENT_GFX_BRENDAN_NORMAL". The frontend picker
     *  has its own hand-curated pretty-name + category map for the
     *  vanilla rosters; this catches everything ELSE (hack-added
     *  sprites) so users get a real name instead of "NPC sprite #N". */
    objectGfx: {},
    /** Modernize-and-Ship slice 3 - species/move/ability/item constant
     *  tables, scraped from include/constants/<kind>.h per family.
     *  Keys are hex-formatted indices ("0x1A" for value 26); values are
     *  bare constant names ("SPECIES_PIKACHU") that displayName.ts
     *  prettifies at render time. Optional - families without a
     *  source URL get an empty object. */
    species: {},
    moves: {},
    abilities: {},
    items: {},
    /** Modernize-and-Ship slice 3 - allow-listed entries from src/config.h
     *  (CFRU-only by default). Keyed by constant name, value is the
     *  numeric the preprocessor would have folded. Used by the editor
     *  to show "Level cap at badge 1: 30" etc. without having to read
     *  the C source. Empty object for families without a config URL. */
    config: {},
  };

  console.log(`[${family}] fetching flags.h …`);
  const flagsText = await fetchText(cfg.flagsUrl);
  const flagsEnv = parseDefines(flagsText);
  out.flags = filterTo(flagsEnv, 'FLAG_', FLAG_EXCLUDE_RE);
  console.log(`[${family}]   ${Object.keys(out.flags).length} flags parsed`);

  console.log(`[${family}] fetching vars.h …`);
  const varsText = await fetchText(cfg.varsUrl);
  const varsEnv = parseDefines(varsText);
  out.vars = filterTo(varsEnv, 'VAR_', VAR_EXCLUDE_RE);
  console.log(`[${family}]   ${Object.keys(out.vars).length} vars parsed`);

  if (cfg.songsUrl) {
    try {
      console.log(`[${family}] fetching songs.h …`);
      const songsText = await fetchText(cfg.songsUrl);
      const songsEnv = parseDefines(songsText);
      const musicEntries = filterTo(songsEnv, 'MUS_', SONG_EXCLUDE_RE);
      const seEntries = filterTo(songsEnv, 'SE_', SONG_EXCLUDE_RE);
      out.songs = { ...musicEntries, ...seEntries };
      console.log(`[${family}]   ${Object.keys(out.songs).length} songs parsed`);
    } catch (e) {
      console.warn(`[${family}] songs.h unavailable (${e.message}); skipping`);
    }
  }

  // WP-D - Object event graphics (NPC sprite IDs).
  if (cfg.objectGfxUrl) {
    try {
      console.log(`[${family}] fetching event_objects.h …`);
      const objText = await fetchText(cfg.objectGfxUrl);
      // Merge defines + enum entries; some headers use one, some
      // the other, some both (a few defines for aliases + an enum
      // for the canonical sequential block).
      const defineEnv = parseDefines(objText);
      const enumEnv = parseEnumValues(objText);
      const merged = new Map([...defineEnv, ...enumEnv]);
      out.objectGfx = filterObjectGfx(merged);
      console.log(`[${family}]   ${Object.keys(out.objectGfx).length} OBJ_EVENT_GFX_* parsed (defines:${defineEnv.size} enum:${enumEnv.size})`);
    } catch (e) {
      console.warn(`[${family}] event_objects.h unavailable (${e.message}); skipping`);
    }
  }

  // Modernize-and-Ship slice 3 - species/move/ability/item/config tables.
  // Same pattern as flags/vars: fetch the header, parse #defines, filter
  // by prefix + exclude regex, write keyed by hex index. Failure to fetch
  // is non-fatal (the field stays as the empty object initialized above).
  for (const [key, url, prefix, excludeRe, basename] of [
    ['species', cfg.speciesUrl, 'SPECIES_', SPECIES_EXCLUDE_RE, 'species.h'],
    ['moves', cfg.movesUrl, 'MOVE_', MOVE_EXCLUDE_RE, 'moves.h'],
    ['abilities', cfg.abilitiesUrl, 'ABILITY_', ABILITY_EXCLUDE_RE, 'abilities.h'],
    ['items', cfg.itemsUrl, 'ITEM_', ITEM_EXCLUDE_RE, 'items.h'],
  ]) {
    if (!url) continue;
    try {
      console.log(`[${family}] fetching ${basename} …`);
      const text = await fetchText(url);
      const env = parseDefines(text);
      out[key] = filterTo(env, prefix, excludeRe);
      console.log(`[${family}]   ${Object.keys(out[key]).length} ${prefix}* parsed`);
    } catch (e) {
      console.warn(`[${family}] ${basename} unavailable (${e.message}); skipping`);
    }
  }

  if (cfg.configUrl) {
    try {
      console.log(`[${family}] fetching config.h …`);
      const text = await fetchText(cfg.configUrl);
      const env = parseDefines(text);
      out.config = filterConfig(env, CONFIG_ALLOWLIST_RE);
      console.log(`[${family}]   ${Object.keys(out.config).length} config entries parsed`);
    } catch (e) {
      console.warn(`[${family}] config.h unavailable (${e.message}); skipping`);
    }
  }

  // Write to two locations:
  //   1. symbols/<family>.json - canonical, repo-root, source-of-truth.
  //      Read by tooling, CI, future backend detectors (Phase Y).
  //   2. app/frontend/src/lib/symbols/data/<family>.json - mirror so Vite
  //      can bundle the data without leaving the project tsconfig rootDir.
  //
  // Both files are checked in; running this script regenerates both.
  const canonicalDir = resolve(REPO_ROOT, 'symbols');
  mkdirSync(canonicalDir, { recursive: true });
  const canonicalPath = resolve(canonicalDir, `${family}.json`);
  writeFileSync(canonicalPath, JSON.stringify(out, null, 2) + '\n', 'utf8');
  console.log(`[${family}] wrote ${canonicalPath}`);

  const frontendDir = resolve(REPO_ROOT, 'app/frontend/src/lib/symbols/data');
  mkdirSync(frontendDir, { recursive: true });
  const frontendPath = resolve(frontendDir, `${family}.json`);
  writeFileSync(frontendPath, JSON.stringify(out, null, 2) + '\n', 'utf8');
  console.log(`[${family}] wrote ${frontendPath}`);
}

const FAMILIES = {
  'firered-vanilla': {
    flagsUrl:
      'https://raw.githubusercontent.com/pret/pokefirered/master/include/constants/flags.h',
    varsUrl:
      'https://raw.githubusercontent.com/pret/pokefirered/master/include/constants/vars.h',
    songsUrl:
      'https://raw.githubusercontent.com/pret/pokefirered/master/include/constants/songs.h',
    objectGfxUrl:
      'https://raw.githubusercontent.com/pret/pokefirered/master/include/constants/event_objects.h',
    speciesUrl:
      'https://raw.githubusercontent.com/pret/pokefirered/master/include/constants/species.h',
    movesUrl:
      'https://raw.githubusercontent.com/pret/pokefirered/master/include/constants/moves.h',
    abilitiesUrl:
      'https://raw.githubusercontent.com/pret/pokefirered/master/include/constants/abilities.h',
    itemsUrl:
      'https://raw.githubusercontent.com/pret/pokefirered/master/include/constants/items.h',
  },
  'emerald-vanilla': {
    flagsUrl:
      'https://raw.githubusercontent.com/pret/pokeemerald/master/include/constants/flags.h',
    varsUrl:
      'https://raw.githubusercontent.com/pret/pokeemerald/master/include/constants/vars.h',
    songsUrl:
      'https://raw.githubusercontent.com/pret/pokeemerald/master/include/constants/songs.h',
    objectGfxUrl:
      'https://raw.githubusercontent.com/pret/pokeemerald/master/include/constants/event_objects.h',
    speciesUrl:
      'https://raw.githubusercontent.com/pret/pokeemerald/master/include/constants/species.h',
    movesUrl:
      'https://raw.githubusercontent.com/pret/pokeemerald/master/include/constants/moves.h',
    abilitiesUrl:
      'https://raw.githubusercontent.com/pret/pokeemerald/master/include/constants/abilities.h',
    itemsUrl:
      'https://raw.githubusercontent.com/pret/pokeemerald/master/include/constants/items.h',
  },
  // Phase Y.1 - Complete FireRed Upgrade. Powers Pokémon Unbound,
  // Radical Red, Inflamed Red, and most modern FireRed-base hacks.
  // CFRU extends vanilla FireRed's constant tables with mission-system
  // flags, expanded ability/move slots, and new battle-engine vars.
  'firered-cfru': {
    flagsUrl:
      'https://raw.githubusercontent.com/Skeli789/Complete-Fire-Red-Upgrade/master/include/constants/flags.h',
    varsUrl:
      'https://raw.githubusercontent.com/Skeli789/Complete-Fire-Red-Upgrade/master/include/constants/vars.h',
    songsUrl:
      'https://raw.githubusercontent.com/Skeli789/Complete-Fire-Red-Upgrade/master/include/constants/songs.h',
    objectGfxUrl:
      'https://raw.githubusercontent.com/Skeli789/Complete-Fire-Red-Upgrade/master/include/constants/event_objects.h',
    speciesUrl:
      'https://raw.githubusercontent.com/Skeli789/Complete-Fire-Red-Upgrade/master/include/constants/species.h',
    movesUrl:
      'https://raw.githubusercontent.com/Skeli789/Complete-Fire-Red-Upgrade/master/include/constants/moves.h',
    abilitiesUrl:
      'https://raw.githubusercontent.com/Skeli789/Complete-Fire-Red-Upgrade/master/include/constants/abilities.h',
    itemsUrl:
      'https://raw.githubusercontent.com/Skeli789/Complete-Fire-Red-Upgrade/master/include/constants/items.h',
    configUrl:
      'https://raw.githubusercontent.com/Skeli789/Complete-Fire-Red-Upgrade/master/src/config.h',
  },
  // Phase 5.4 - CFRU + Dynamic Pokémon Expansion. DPE overlays on
  // top of a CFRU clone (see scripts/build-cfru-bundle-with-dpe.mjs);
  // for the symbol DB we resolve from BOTH, with DPE's includes
  // winning when they exist (DPE supplies the actual implementations
  // for species past vanilla's cap) and falling back to CFRU for
  // fields DPE doesn't define (flags / vars / songs / object_events).
  //
  // DPE's headers live at include/<name>.h (NOT include/constants/),
  // so the URLs aren't a drop-in copy of the CFRU paths.
  'firered-cfru-dpe': {
    // Flag/var/song/object-event tables come from CFRU - DPE inherits
    // them transparently.
    flagsUrl:
      'https://raw.githubusercontent.com/Skeli789/Complete-Fire-Red-Upgrade/master/include/constants/flags.h',
    varsUrl:
      'https://raw.githubusercontent.com/Skeli789/Complete-Fire-Red-Upgrade/master/include/constants/vars.h',
    songsUrl:
      'https://raw.githubusercontent.com/Skeli789/Complete-Fire-Red-Upgrade/master/include/constants/songs.h',
    objectGfxUrl:
      'https://raw.githubusercontent.com/Skeli789/Complete-Fire-Red-Upgrade/master/include/constants/event_objects.h',
    // Species / moves / abilities / items come from DPE - these are
    // the registries DPE's dynamic-insertion engine actually reads
    // from at build time.
    speciesUrl:
      'https://raw.githubusercontent.com/Skeli789/Dynamic-Pokemon-Expansion/master/include/species.h',
    movesUrl:
      'https://raw.githubusercontent.com/Skeli789/Dynamic-Pokemon-Expansion/master/include/moves.h',
    abilitiesUrl:
      'https://raw.githubusercontent.com/Skeli789/Dynamic-Pokemon-Expansion/master/include/abilities.h',
    itemsUrl:
      'https://raw.githubusercontent.com/Skeli789/Dynamic-Pokemon-Expansion/master/include/items.h',
    // Config flows from CFRU (DPE doesn't ship one).
    configUrl:
      'https://raw.githubusercontent.com/Skeli789/Complete-Fire-Red-Upgrade/master/src/config.h',
  },
  // Phase Y.2 - pokeemerald-expansion (rh-hideout). Generation 1–8
  // Pokémon, Fairy type, modern battle mechanics, Z-moves, Mega
  // Evolution. Drop-in fork of pokeemerald that many fan projects build
  // against.
  'emerald-expansion': {
    flagsUrl:
      'https://raw.githubusercontent.com/rh-hideout/pokeemerald-expansion/master/include/constants/flags.h',
    varsUrl:
      'https://raw.githubusercontent.com/rh-hideout/pokeemerald-expansion/master/include/constants/vars.h',
    songsUrl:
      'https://raw.githubusercontent.com/rh-hideout/pokeemerald-expansion/master/include/constants/songs.h',
    objectGfxUrl:
      'https://raw.githubusercontent.com/rh-hideout/pokeemerald-expansion/master/include/constants/event_objects.h',
    speciesUrl:
      'https://raw.githubusercontent.com/rh-hideout/pokeemerald-expansion/master/include/constants/species.h',
    movesUrl:
      'https://raw.githubusercontent.com/rh-hideout/pokeemerald-expansion/master/include/constants/moves.h',
    abilitiesUrl:
      'https://raw.githubusercontent.com/rh-hideout/pokeemerald-expansion/master/include/constants/abilities.h',
    itemsUrl:
      'https://raw.githubusercontent.com/rh-hideout/pokeemerald-expansion/master/include/constants/items.h',
  },
};

const FAMILIES_TO_BUILD =
  process.argv.length > 2 ? process.argv.slice(2) : Object.keys(FAMILIES);

console.log(`Building ${FAMILIES_TO_BUILD.length} symbol families: ${FAMILIES_TO_BUILD.join(', ')}`);

let failed = 0;
for (const family of FAMILIES_TO_BUILD) {
  try {
    await buildFamily(family);
  } catch (e) {
    console.error(`[${family}] FAILED:`, e.message);
    failed++;
  }
}

if (failed > 0) {
  console.error(`${failed} family build(s) failed`);
  process.exit(1);
}
console.log('All symbol families built successfully.');
