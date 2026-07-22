#!/usr/bin/env node
/**
 * Phase 8C-1 - pret metatile-behavior scraper.
 *
 * Scrapes pret/pokefirered and pret/pokeemerald's
 * `include/constants/metatile_behaviors.h` files into machine-
 * readable JSON keyed by id (the numeric enum value the
 * Tile-Intel IR carries as `behaviorId`). The JSON files are
 * committed under `tile-intel-svc/data/`; the sidecar seeds the
 * `behaviors` Postgres table from them at first request.
 *
 * Two formats to handle:
 *   - FireRed: `#define MB_TALL_GRASS 0x02` (explicit hex values).
 *   - Emerald: `enum { MB_NORMAL, MB_SECRET_BASE_WALL, ... }`
 *     (sequential integer values).
 *
 * Usage:
 *   node scripts/build-pret-behaviors.mjs
 *
 * Output:
 *   tile-intel-svc/data/behaviors-frlg.json
 *   tile-intel-svc/data/behaviors-rse.json
 *
 * Idempotent: rerunning produces identical output for the same
 * pret commit.  Pinned source paths follow the same probe order
 * as the corpus builder.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');

function probeDefaultSourcePath(candidates) {
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return candidates[0];
}

const FRLG_ROOT = probeDefaultSourcePath([
  'C:\\path\\to\\pokefirered-master\\pokefirered-master',
  resolve(REPO_ROOT, 'vendor/pret-firered'),
]);
const RSE_ROOT = probeDefaultSourcePath([
  'C:\\path\\to\\pokeemerald-master\\pokeemerald-master',
  resolve(REPO_ROOT, 'vendor/pret-emerald'),
]);

const OUT_DIR = resolve(REPO_ROOT, 'tile-intel-svc/data');

/** Parse FireRed-style `#define MB_X 0xNN` definitions. */
function parseFrlgBehaviors(text) {
  const entries = [];
  const re = /^\s*#define\s+(MB_\w+)\s+(0x[0-9a-fA-F]+|\d+)/gm;
  let match;
  while ((match = re.exec(text)) !== null) {
    const [, name, valueText] = match;
    const id = valueText.startsWith('0x') ? parseInt(valueText, 16) : parseInt(valueText, 10);
    entries.push({ id, name });
  }
  return entries;
}

/** Parse Emerald-style `enum { MB_NORMAL, ... }` definitions. The
 *  first identifier is value 0, the next 1, etc. The pret source
 *  embeds comments after some entries - we tolerate those. */
function parseRseBehaviors(text) {
  const entries = [];
  // Find the enum block(s).
  const enumRe = /enum\s*\{([\s\S]*?)\}/g;
  let counter = 0;
  let block;
  while ((block = enumRe.exec(text)) !== null) {
    const body = block[1];
    // Strip line + block comments and trailing whitespace.
    const stripped = body
      .replace(/\/\/[^\n]*$/gm, '')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    for (const raw of stripped.split(',')) {
      const trimmed = raw.trim();
      if (!trimmed) continue;
      // Accept "MB_FOO" or "MB_FOO = 0xNN" forms; pret-emerald has
      // some explicit values mixed in.
      const m = trimmed.match(/^(MB_\w+)\s*(?:=\s*(0x[0-9a-fA-F]+|\d+))?$/);
      if (!m) continue;
      const name = m[1];
      let id;
      if (m[2]) {
        id = m[2].startsWith('0x') ? parseInt(m[2], 16) : parseInt(m[2], 10);
        counter = id + 1;
      } else {
        id = counter++;
      }
      entries.push({ id, name });
    }
  }
  // Pret-emerald also has `#define MB_INVALID UCHAR_MAX` at the bottom.
  // Use 0xff as the value.
  const invalidRe = /#define\s+(MB_INVALID)\s+UCHAR_MAX/;
  const inv = text.match(invalidRe);
  if (inv) entries.push({ id: 0xff, name: 'MB_INVALID' });
  return entries;
}

/** Curated behavior → category mapping covering the most common
 *  cases. Behaviors not in this table get `category: "unknown"`
 *  and rely on Phase 8C-1's behavior-to-tags.yaml for finer
 *  classification. */
const NAME_CATEGORY_RULES = [
  [/^MB_TALL_GRASS$|GRASS$|^MB_LONG_GRASS|^MB_SHORT_GRASS/, 'encounter'],
  [/^MB_SAND$|^MB_DEEP_SAND$|^MB_FOOTPRINTS|^MB_ASHGRASS/, 'terrain'],
  [/_WATER$|^MB_WATERFALL|^MB_PUDDLE|^MB_SHALLOW_WATER/, 'terrain'],
  [/^MB_CAVE$|^MB_MOUNTAIN_TOP|^MB_INDOOR_/, 'terrain'],
  [/^MB_ICE$|^MB_THIN_ICE|^MB_CRACKED_/, 'terrain'],
  [/_WARP$|^MB_DOOR|^MB_STAIRS|^MB_LADDER/, 'warp'],
  [/^MB_RUNNING_DISALLOWED$|^MB_NO_RUNNING|^MB_HOLDS_/, 'effect'],
  [/^MB_NORMAL$/, 'terrain'],
  [/^MB_UNUSED_/, 'unused'],
  [/^MB_INVALID$/, 'unused'],
];

function categoryFor(name) {
  for (const [re, cat] of NAME_CATEGORY_RULES) {
    if (re.test(name)) return cat;
  }
  return 'unknown';
}

function emit(family, entries) {
  // Dedup by id (some pret files repeat entries via #define + enum).
  const byId = new Map();
  for (const e of entries) {
    if (byId.has(e.id) && byId.get(e.id).name !== e.name) {
      // Skip dup; keep the first.
      continue;
    }
    byId.set(e.id, {
      id: e.id,
      family,
      name: e.name,
      category: categoryFor(e.name),
    });
  }
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

async function main() {
  // FRLG
  const frlgText = readFileSync(`${FRLG_ROOT}/include/constants/metatile_behaviors.h`, 'utf8');
  const frlgEntries = emit('frlg', parseFrlgBehaviors(frlgText));
  writeFileSync(`${OUT_DIR}/behaviors-frlg.json`, JSON.stringify(frlgEntries, null, 2) + '\n', 'utf8');
  process.stdout.write(`wrote ${frlgEntries.length} FRLG behaviors → ${OUT_DIR}/behaviors-frlg.json\n`);

  // RSE
  const rseText = readFileSync(`${RSE_ROOT}/include/constants/metatile_behaviors.h`, 'utf8');
  const rseEntries = emit('rse', parseRseBehaviors(rseText));
  writeFileSync(`${OUT_DIR}/behaviors-rse.json`, JSON.stringify(rseEntries, null, 2) + '\n', 'utf8');
  process.stdout.write(`wrote ${rseEntries.length} RSE behaviors → ${OUT_DIR}/behaviors-rse.json\n`);
}

main().catch((e) => {
  process.stderr.write(`fatal: ${e?.stack ?? String(e)}\n`);
  process.exit(1);
});
