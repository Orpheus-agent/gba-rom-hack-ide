#!/usr/bin/env node
/**
 * Phase 6.3 - Vanilla FRLG ground-truth scraper.
 *
 * Reads pret/pokefirered (https://github.com/pret/pokefirered) and
 * builds a structured JSON of everything the editor needs to label a
 * vanilla-derived ROM correctly:
 *
 *   - maps[<bank.num>] = { name, mapsec, mapType, music, weather, regionGroup }
 *   - regionMapSections[<hex>] = { name, x, y }
 *   - wildEncounters[<bank.num>] = { land: [...], water: [...], rock_smash: [...], fishing: [...] }
 *   - trainers[<hex>] = { name, classId, partySize, ai_flags }
 *   - trainerClasses[<hex>] = "CLASS_NAME"
 *   - npcRoles[<bank.num>] = { <objectEventIdx>: { gfxId, scriptLabel } }
 *   - musicTracks[<MUS_*>] = "Friendly Name"
 *
 * Merges into `app/frontend/src/lib/symbols/data/firered-vanilla.json`
 * as new top-level keys (preserving the existing flags/vars/songs/
 * species/moves/abilities/items/objectGfx/config structure).
 *
 * Snapshots a specific pret commit so re-running is reproducible.
 *
 * Usage:
 *   node scripts/build-vanilla-frlg-truth.mjs
 *
 * Run once when:
 *   - The editor first ships
 *   - pret upstream adds new constants the editor needs
 *   - You want to bump the pinned commit SHA
 *
 * NOT run in CI - same model as `build-symbols.mjs`. The output JSON
 * is tracked so all users get the data without re-running the scrape.
 *
 * Phase 6.3 first-pass scope: maps + regionMapSections + musicTracks.
 * The wild-encounter and trainer surfaces are wired into the scraper
 * but use stub parsers - pret stores them in C source format that
 * needs a heavier extractor; revisit when the visible UX wins from
 * map labels are confirmed first.
 */

import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import https from 'node:https';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Pinned pret commit. Bump this when you want to refresh the truth data.
// `master` is a moving target - fine for interactive runs, but the JSON
// records the commit SHA the script resolved at scrape time so the
// produced data is reproducible across users.
// ---------------------------------------------------------------------------
const PRET_REF = 'master';
const PRET_BASE = `https://raw.githubusercontent.com/pret/pokefirered/${PRET_REF}`;
const PRET_API_BASE = `https://api.github.com/repos/pret/pokefirered`;

const OUTPUT_PATH = resolve(
  REPO_ROOT,
  'app/frontend/src/lib/symbols/data/firered-vanilla.json',
);

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function fetchText(url, { headers = {} } = {}) {
  return new Promise((res, rej) => {
    https
      .get(url, { headers: { 'User-Agent': 'rom-editor-vanilla-truth-scraper', ...headers } }, (response) => {
        if (
          response.statusCode &&
          response.statusCode >= 300 &&
          response.statusCode < 400 &&
          response.headers.location
        ) {
          fetchText(response.headers.location, { headers }).then(res, rej);
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

async function fetchJson(url, opts) {
  const text = await fetchText(url, opts);
  return JSON.parse(text);
}

/** Run promise-producing tasks in chunks of `parallelism` to avoid
 *  hammering raw.githubusercontent.com (which 403s on burst). */
async function pMapBatched(items, parallelism, fn) {
  const out = new Array(items.length);
  for (let i = 0; i < items.length; i += parallelism) {
    const slice = items.slice(i, i + parallelism);
    const results = await Promise.all(
      slice.map((item, j) => fn(item, i + j)),
    );
    for (let j = 0; j < results.length; j++) out[i + j] = results[j];
  }
  return out;
}

// ---------------------------------------------------------------------------
// String helpers
// ---------------------------------------------------------------------------

/** "PalletTown" → "Pallet Town". "Route1" → "Route 1". "FuchsiaCity_PokemonCenter1F" → "Fuchsia City Pokémon Center 1F". */
function humanizeMapName(camelCase) {
  return camelCase
    // Split on snake-case underscores first.
    .split('_')
    .map((part) =>
      part
        // Insert space before any uppercase letter that follows a lowercase one OR a digit.
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        // Insert space before a digit that follows a letter.
        .replace(/([a-zA-Z])(\d)/g, '$1 $2'),
    )
    .join(' ')
    // Normalise multiple spaces.
    .replace(/\s+/g, ' ')
    .trim();
}

/** MAPSEC_PALLET_TOWN → editor MapGroup ('town' / 'route' / 'cave' / 'interior' / 'unknown'). */
function mapTypeToRegionGroup(mapType) {
  switch (mapType) {
    case 'MAP_TYPE_TOWN':
    case 'MAP_TYPE_CITY':
      return 'town';
    case 'MAP_TYPE_ROUTE':
      return 'route';
    case 'MAP_TYPE_UNDERGROUND':
      return 'cave';
    case 'MAP_TYPE_INDOOR':
    case 'MAP_TYPE_SECRET_BASE':
      return 'interior';
    // OCEAN_ROUTE → 'route' is safe HERE because the truth JSON is
    // vanilla-FRLG-only and FRLG genuinely labels Routes 19-21 as
    // OCEAN_ROUTE. (The Phase 6.1 runtime mapping refuses byte 6
    // because CFRU might overwrite the bytes; the overlay supplies
    // the right answer per-(bank,num).)
    case 'MAP_TYPE_OCEAN_ROUTE':
      return 'route';
    default:
      return 'unknown';
  }
}

// ---------------------------------------------------------------------------
// Step 1 - Resolve the pinned ref to a concrete commit SHA so the
// output JSON records what was scraped. Falls back to PRET_REF
// verbatim when the API call fails (network down, rate-limited, etc.).
// ---------------------------------------------------------------------------
async function resolveCommitSha() {
  try {
    const refData = await fetchJson(`${PRET_API_BASE}/commits/${PRET_REF}`, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    return refData.sha ?? PRET_REF;
  } catch (e) {
    console.warn(`Warning: couldn't resolve ${PRET_REF} to a SHA (${e.message}); recording the ref verbatim.`);
    return PRET_REF;
  }
}

// ---------------------------------------------------------------------------
// Step 2 - Maps
// ---------------------------------------------------------------------------
async function scrapeMaps() {
  console.log('  - Fetching map_groups.json…');
  const groups = await fetchJson(`${PRET_BASE}/data/maps/map_groups.json`);
  if (!groups.group_order || !Array.isArray(groups.group_order)) {
    throw new Error('map_groups.json has unexpected shape - no group_order array');
  }

  // Build the flat (bank, num) → mapName list first.
  const allMaps = [];
  for (const groupKey of groups.group_order) {
    const mapList = groups[groupKey];
    if (!Array.isArray(mapList)) {
      console.warn(`    skipping ${groupKey} - not an array`);
      continue;
    }
    const bankIdx = groups.group_order.indexOf(groupKey);
    for (let mapIdx = 0; mapIdx < mapList.length; mapIdx++) {
      allMaps.push({ bankIdx, mapIdx, mapName: mapList[mapIdx] });
    }
  }
  console.log(`    discovered ${allMaps.length} map entries across ${groups.group_order.length} banks`);

  // Fetch each map.json. Parallelism 8 - github raw is pretty
  // tolerant but burst-403s if you push 100+ concurrent gets.
  console.log('  - Fetching per-map map.json files (parallelism 8)…');
  const mapJsons = await pMapBatched(allMaps, 8, async ({ mapName }, i) => {
    try {
      const data = await fetchJson(`${PRET_BASE}/data/maps/${mapName}/map.json`);
      if ((i + 1) % 50 === 0) console.log(`    fetched ${i + 1}/${allMaps.length}…`);
      return data;
    } catch (e) {
      console.warn(`    failed to fetch ${mapName}/map.json: ${e.message}`);
      return null;
    }
  });

  const maps = {};
  const mapIdToKey = {}; // MAP_PALLET_TOWN → "3.0", used by wild encounter cross-ref
  for (let i = 0; i < allMaps.length; i++) {
    const { bankIdx, mapIdx, mapName } = allMaps[i];
    const data = mapJsons[i];
    if (!data) continue;
    const key = `${bankIdx}.${mapIdx}`;
    maps[key] = {
      name: humanizeMapName(mapName),
      sourceName: mapName,
      // The MAP_FOO constant - used by wild_encounters.json and other
      // cross-references to identify a specific map without bank/num.
      mapId: data.id ?? null,
      mapsec: data.region_map_section ?? null,
      mapType: data.map_type ?? null,
      music: data.music ?? null,
      weather: data.weather ?? null,
      regionGroup: mapTypeToRegionGroup(data.map_type),
    };
    if (data.id) mapIdToKey[data.id] = key;
  }
  console.log(`    parsed ${Object.keys(maps).length} maps`);
  return { maps, mapIdToKey };
}

// ---------------------------------------------------------------------------
// Step 3 - Region map sections
//
// pret/pokefirered stores everything we need in a clean JSON file at
// `src/data/region_map/region_map_sections.json`. The file's
// `map_sections` array is in MAPSEC byte order - the index IS the
// byte value the ROM's `regionMapSectionId` field carries. Each entry
// has `id` (the MAPSEC_FOO constant) plus optional `name` / `x` / `y`
// / `width` / `height` (the entries WITHOUT a name are placeholders
// for unused MAPSEC slots from when the file was shared with Hoenn).
// We emit one record per indexed slot, named or not - the displayName
// resolver short-circuits on missing names.
// ---------------------------------------------------------------------------
async function scrapeRegionMapSections() {
  console.log('  - Fetching region_map_sections.json…');
  const data = await fetchJson(
    `${PRET_BASE}/src/data/region_map/region_map_sections.json`,
  );
  if (!Array.isArray(data?.map_sections)) {
    throw new Error('region_map_sections.json has unexpected shape');
  }

  const regionMapSections = {};
  data.map_sections.forEach((section, byteVal) => {
    if (!section?.id) return;
    const entry = {
      mapsec: section.id,
      name: section.name ?? null,
      x: section.x ?? null,
      y: section.y ?? null,
      width: section.width ?? null,
      height: section.height ?? null,
    };
    regionMapSections[`0x${byteVal.toString(16).toUpperCase()}`] = entry;
  });
  console.log(
    `    parsed ${Object.keys(regionMapSections).length} region map section entries ` +
      `(${data.map_sections.filter((s) => s?.name).length} named)`,
  );
  return regionMapSections;
}

// ---------------------------------------------------------------------------
// Step 4 - Music track friendly names (deferred - pret comments are
// Japanese aliases, not friendly names)
//
// pret/pokefirered's `include/constants/songs.h` carries comments on
// most MUS_* entries - but they're the original Japanese constant
// names (e.g. `MUS_PALLET 300 // MUS_MASARA`, where "MASARA" is the
// Japanese name for Pallet Town). NOT user-friendly track names like
// "Pallet Town Theme". Phase 6.3 ships with this surface empty; if
// the editor wants real track names, that's a curation task - feed a
// hand-maintained `musicTracks-curated.json` into the merge step.
// The existing `songs` symbol DB still prettifies MUS_PALLET to
// "Pallet" via the strip-prefix + title-case path, which is fine for
// chat / inspector display.
// ---------------------------------------------------------------------------
async function scrapeMusicTracks() {
  return {};
}

// ---------------------------------------------------------------------------
// Step 5 - wildEncounters
//
// pret stores wild encounters in clean JSON at `src/data/wild_encounters.json`.
// Each entry carries `map` (MAP_FOO constant), `base_label` (which
// tells us FireRed vs LeafGreen), and four optional slot arrays
// (`land_mons`, `water_mons`, `rock_smash_mons`, `fishing_mons`) with
// per-slot species + min/max level. We filter to FireRed-specific
// entries and re-key by the (bank, num) we built in step 2.
// ---------------------------------------------------------------------------
async function scrapeWildEncounters(mapIdToKey) {
  console.log('  - Fetching wild_encounters.json…');
  const data = await fetchJson(`${PRET_BASE}/src/data/wild_encounters.json`);
  if (!Array.isArray(data?.wild_encounter_groups)) {
    throw new Error('wild_encounters.json has unexpected shape');
  }

  // FRLG ships two encounter groups (one per version). Filter to FireRed.
  const fireRedGroup = data.wild_encounter_groups.find(
    (g) => g.label === 'gWildMonHeaders' && /FireRed/i.test(JSON.stringify(g.encounters?.[0]?.base_label ?? '')),
  ) ?? data.wild_encounter_groups[0];
  if (!fireRedGroup?.encounters) {
    throw new Error('Could not locate FireRed encounter group');
  }

  const wildEncounters = {};
  let skipped = 0;
  for (const enc of fireRedGroup.encounters) {
    // Skip LeafGreen-suffixed entries - same map, different game.
    if (enc.base_label && /_LeafGreen$/.test(enc.base_label)) continue;
    const key = mapIdToKey[enc.map];
    if (!key) {
      skipped++;
      continue;
    }
    // Each slot list maps directly through.
    const out = {};
    for (const kind of ['land_mons', 'water_mons', 'rock_smash_mons', 'fishing_mons']) {
      if (enc[kind]?.mons) {
        out[kind] = {
          encounterRate: enc[kind].encounter_rate ?? null,
          mons: enc[kind].mons.map((m) => ({
            species: m.species,
            minLevel: m.min_level,
            maxLevel: m.max_level,
          })),
        };
      }
    }
    if (Object.keys(out).length > 0) wildEncounters[key] = out;
  }
  if (skipped > 0) {
    console.log(`    parsed ${Object.keys(wildEncounters).length} encounter tables (${skipped} entries had unresolvable MAP_* ids)`);
  } else {
    console.log(`    parsed ${Object.keys(wildEncounters).length} encounter tables`);
  }
  return wildEncounters;
}

// ---------------------------------------------------------------------------
// Step 6 - Trainers / trainer classes / NPC roles - deferred to 6.3b
//
// pret stores trainers as `[TRAINER_FOO] = { .trainerClass = ..., .trainerName = _("NAME"), ... }`
// in `src/data/trainers.h`, plus opponents.h for the TRAINER_FOO byte
// values + trainer_types.h for the TRAINER_CLASS_FOO byte values.
// Three-file cross-reference; doable but verbose enough that the
// regex extraction would dominate the script's complexity. Wire-frame
// the output shape so the overlay layer's resolvers have a stable
// API contract; populate in a follow-up commit on this same branch.
// ---------------------------------------------------------------------------
async function scrapeStubs() {
  return {
    trainers: {},
    trainerClasses: {},
    npcRoles: {},
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log(`Phase 6.3 - Vanilla FRLG truth scraper (pret ref: ${PRET_REF})`);
  console.log();

  console.log('Step 1/5 - Resolve commit SHA');
  const commitSha = await resolveCommitSha();
  console.log(`  pret commit: ${commitSha.slice(0, 12)}…`);

  console.log();
  console.log('Step 2/6 - Maps');
  const { maps, mapIdToKey } = await scrapeMaps();

  console.log();
  console.log('Step 3/6 - Region map sections');
  const regionMapSections = await scrapeRegionMapSections();

  console.log();
  console.log('Step 4/6 - Music track friendly names (deferred)');
  const musicTracks = await scrapeMusicTracks();

  console.log();
  console.log('Step 5/6 - Wild encounters');
  const wildEncounters = await scrapeWildEncounters(mapIdToKey);

  console.log();
  console.log('Step 6/6 - Trainer + NPC role stubs (deferred to 6.3b)');
  const stubs = await scrapeStubs();

  // Merge into the existing firered-vanilla.json so the symbol DB
  // loader already knows where to find this data.
  console.log();
  console.log(`Step finalize - merging into ${OUTPUT_PATH}`);
  const existing = JSON.parse(readFileSync(OUTPUT_PATH, 'utf8'));
  const merged = {
    ...existing,
    // Phase 6.3 - new top-level keys for vanilla ground truth.
    vanillaTruth: {
      scrapedAtUtc: new Date().toISOString(),
      pretRef: PRET_REF,
      pretCommitSha: commitSha,
      mapCount: Object.keys(maps).length,
      regionMapSectionCount: Object.keys(regionMapSections).length,
      musicTrackCount: Object.keys(musicTracks).length,
      wildEncountersMapCount: Object.keys(wildEncounters).length,
      // 6.3b will fill these.
      trainerCount: Object.keys(stubs.trainers).length,
      trainerClassCount: Object.keys(stubs.trainerClasses).length,
      npcRolesMapCount: Object.keys(stubs.npcRoles).length,
    },
    maps,
    regionMapSections,
    musicTracks,
    wildEncounters,
    trainers: stubs.trainers,
    trainerClasses: stubs.trainerClasses,
    npcRoles: stubs.npcRoles,
  };
  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  console.log('  wrote.');
  console.log();
  console.log('Summary:');
  console.log(`  Maps:               ${Object.keys(maps).length}`);
  console.log(`  Region sections:    ${Object.keys(regionMapSections).length}`);
  console.log(`  Wild encounters:    ${Object.keys(wildEncounters).length}`);
  console.log(`  Music tracks:       ${Object.keys(musicTracks).length}  (deferred - pret comments are Japanese aliases)`);
  console.log(`  Trainers:           ${Object.keys(stubs.trainers).length}  (6.3b stub)`);
  console.log(`  Trainer classes:    ${Object.keys(stubs.trainerClasses).length}  (6.3b stub)`);
  console.log(`  NPC roles maps:     ${Object.keys(stubs.npcRoles).length}  (6.3b stub)`);
}

main().catch((e) => {
  console.error('\nFATAL:', e?.message ?? e);
  process.exit(1);
});
