#!/usr/bin/env node
/**
 * Phase 8A-1 - Tile-Intel corpus builder (skeleton).
 *
 * Mines tileset + adjacency data from the user's on-disk source
 * clones (pret/pokefirered, pret/pokeemerald, CFRU, DPE) and writes
 * the canonical Tile-Intel IR JSON described in
 * `app/shared/src/tile-intel-ir.ts`.
 *
 * THIS PHASE (8A-1): skeleton only. CLI args, output paths,
 * dispatch into per-source mining stubs, validation against the Zod
 * schema in `app/backend/src/tile-intel/ir-schema.ts`. Each per-source
 * stub emits an empty corpus + a TODO comment for the real work that
 * lands in Phase 8B (pret-firered), 8B-3 (CFRU/DPE/Emerald), 8E
 * (Essentials + curated community packs).
 *
 * Usage:
 *   node scripts/build-tile-intel-corpus.mjs [--source <name>]
 *                                            [--out <dir>]
 *                                            [--pret-firered <path>]
 *                                            [--pret-emerald <path>]
 *                                            [--cfru <path>]
 *                                            [--dpe <path>]
 *                                            [--validate-only]
 *                                            [--no-validate]
 *
 * Defaults:
 *   --source           all known sources (one corpus file per source)
 *   --out              app/backend/src/assets/tile-intel-corpus/
 *   --pret-firered     ./vendor/pret-firered                 (if exists)
 *   --pret-emerald     ./vendor/pret-emerald                 (if exists)
 *   --cfru             C:\path\to\Complete-Fire-Red-Upgrade-master\Complete-Fire-Red-Upgrade-master\
 *   --dpe              C:\path\to\Dynamic-Pokemon-Expansion-master\Dynamic-Pokemon-Expansion-master\
 *
 * Run when:
 *   • The editor first ships
 *   • Phase 8B-1 lands (`buildPretFiredRedCorpus()` becomes real)
 *   • A pinned source-tree commit is bumped
 *
 * NOT run in CI - output is committed to `app/backend/src/assets/`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// Constants + paths
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');

const TOOLING_VERSION = '8A-1';
const SCHEMA_VERSION = 1;

const DEFAULT_OUT_DIR = resolve(
  REPO_ROOT,
  'app/backend/src/assets/tile-intel-corpus',
);

const KNOWN_SOURCES = /** @type {const} */ ([
  'pret-firered',
  'pret-emerald',
  'cfru',
  'dpe',
  // Phase 8E-1 - Pokémon Essentials stock tilesets.
  'essentials',
]);

/** Each source maps to a default on-disk hint. Per-machine paths
 *  for CFRU + DPE match what's already used by build-cfru-bundle-with-dpe.mjs.
 *  pret defaults to a vendor/ subdir which the user must clone manually
 *  (no automatic git-clone - this script is local-only and idempotent). */
/** Default source paths. We probe the user's well-known download
 *  locations first (where the zip extracts double-nested), then
 *  fall back to the repo-local vendor/ paths. The corpus builder
 *  picks the first path that exists. */
function probeDefaultSourcePath(candidates) {
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return candidates[0]; // return the first as the "expected" path even if missing
}

const DEFAULT_SOURCE_PATHS = {
  'pret-firered': probeDefaultSourcePath([
    'C:\\path\\to\\pokefirered-master\\pokefirered-master',
    'C:\\path\\to\\pokefirered-master',
    resolve(REPO_ROOT, 'vendor/pret-firered'),
  ]),
  'pret-emerald': probeDefaultSourcePath([
    'C:\\path\\to\\pokeemerald-master\\pokeemerald-master',
    'C:\\path\\to\\pokeemerald-master',
    resolve(REPO_ROOT, 'vendor/pret-emerald'),
  ]),
  cfru: probeDefaultSourcePath([
    'C:\\path\\to\\Complete-Fire-Red-Upgrade-master\\Complete-Fire-Red-Upgrade-master',
    resolve(REPO_ROOT, 'vendor/cfru'),
  ]),
  dpe: probeDefaultSourcePath([
    'C:\\path\\to\\Dynamic-Pokemon-Expansion-master\\Dynamic-Pokemon-Expansion-master',
    resolve(REPO_ROOT, 'vendor/dpe'),
  ]),
  // Phase 8E-1 - Pokémon Essentials install. Probe the v21.1 release
  // and the GitHub clone (master). The release ships the Graphics/
  // dir we care about under a double-nested directory by default.
  essentials: probeDefaultSourcePath([
    'C:\\path\\to\\Pokemon Essentials v21.1 2023-07-30\\Pokemon Essentials v21.1 2023-07-30',
    'C:\\path\\to\\Pokemon Essentials v21.1 2023-07-30',
    'C:\\path\\to\\pokemon-essentials-master\\pokemon-essentials-master',
    'C:\\path\\to\\pokemon-essentials-master',
    resolve(REPO_ROOT, 'vendor/essentials'),
  ]),
};

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    sources: /** @type {string[] | null} */ (null),
    outDir: DEFAULT_OUT_DIR,
    paths: { ...DEFAULT_SOURCE_PATHS },
    validateOnly: false,
    skipValidation: false,
    help: false,
    maxMaps: /** @type {number | null} */ (null),
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--max-maps') {
      args.maxMaps = Number(argv[++i] ?? fail('missing value for --max-maps'));
    } else if (arg === '--source') {
      const value = argv[++i];
      if (!value) fail('missing value for --source');
      if (args.sources === null) args.sources = [];
      args.sources.push(value);
    } else if (arg === '--out') {
      args.outDir = resolve(argv[++i] ?? fail('missing value for --out'));
    } else if (arg === '--pret-firered') {
      args.paths['pret-firered'] = resolve(argv[++i] ?? fail('missing path'));
    } else if (arg === '--pret-emerald') {
      args.paths['pret-emerald'] = resolve(argv[++i] ?? fail('missing path'));
    } else if (arg === '--cfru') {
      args.paths.cfru = resolve(argv[++i] ?? fail('missing path'));
    } else if (arg === '--dpe') {
      args.paths.dpe = resolve(argv[++i] ?? fail('missing path'));
    } else if (arg === '--essentials') {
      args.paths.essentials = resolve(argv[++i] ?? fail('missing path'));
    } else if (arg === '--validate-only') {
      args.validateOnly = true;
    } else if (arg === '--no-validate') {
      args.skipValidation = true;
    } else {
      fail(`unknown argument: ${arg}`);
    }
  }
  if (args.sources === null) args.sources = [...KNOWN_SOURCES];
  for (const src of args.sources) {
    if (!KNOWN_SOURCES.includes(/** @type any */ (src))) {
      fail(
        `unknown --source '${src}'. Known: ${KNOWN_SOURCES.join(', ')}`,
      );
    }
  }
  return args;
}

function fail(msg) {
  process.stderr.write(`build-tile-intel-corpus: ${msg}\n`);
  process.exit(1);
}

function printHelp() {
  process.stdout.write(`Tile-Intel corpus builder (Phase 8A-1 skeleton)

Usage:
  node scripts/build-tile-intel-corpus.mjs [options]

Options:
  --source <name>        Build only this source (repeatable).
                         Known: ${KNOWN_SOURCES.join(', ')}
  --out <dir>            Output directory.
                         Default: ${DEFAULT_OUT_DIR}
  --pret-firered <path>  Path to pret/pokefirered clone.
                         Default: ${DEFAULT_SOURCE_PATHS['pret-firered']}
  --pret-emerald <path>  Path to pret/pokeemerald clone.
                         Default: ${DEFAULT_SOURCE_PATHS['pret-emerald']}
  --cfru <path>          Path to CFRU source clone.
                         Default: ${DEFAULT_SOURCE_PATHS.cfru}
  --dpe <path>           Path to DPE source clone.
                         Default: ${DEFAULT_SOURCE_PATHS.dpe}
  --essentials <path>    Path to a Pokémon Essentials install
                         (root containing Graphics/).
                         Default: ${DEFAULT_SOURCE_PATHS.essentials}
  --max-maps <n>         Mine only the first <n> map layouts per
                         source. Useful for fast iteration while
                         debugging.
  --validate-only        Validate already-emitted corpus files but
                         don't re-mine.
  --no-validate          Skip the Zod schema check (write only).
  --help, -h             Show this message.
`);
}

// ---------------------------------------------------------------------------
// Git helpers (mirror build-vanilla-frlg-truth.mjs's pattern)
// ---------------------------------------------------------------------------

/** Returns the commit SHA at HEAD of the given source tree, or null
 *  when the path isn't a git repo (e.g. a zip extract). */
function gitHeadSha(sourcePath) {
  try {
    const result = spawnSync('git', ['-C', sourcePath, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (result.status === 0 && result.stdout) {
      return result.stdout.trim();
    }
  } catch {
    /* fall through */
  }
  return null;
}

// ---------------------------------------------------------------------------
// Per-source mining stubs.
// In Phase 8A-1 each returns an empty IR; the real implementations
// land in 8B-1 (pret-firered), 8B-3 (cfru/dpe/emerald) and reuse the
// existing engine primitives (parseTileset, fetchTilesetGraphics,
// parseMetatileAttributes) via dynamic import of the engine's dist.
// ---------------------------------------------------------------------------

/** @param {{ sourcePath: string, sourceCommit: string | null, maxMaps: number | null }} ctx */
async function buildPretFiredRedCorpus(ctx) {
  if (!existsSync(ctx.sourcePath)) {
    return {
      corpus: emptyCorpus('pret-firered'),
      warnings: [
        `pret-firered path does not exist: ${ctx.sourcePath}. ` +
          `Clone https://github.com/pret/pokefirered into that path, ` +
          `or pass --pret-firered <path>.`,
      ],
    };
  }
  // Lazy import keeps the script's startup cost flat when other
  // sources don't need the engine.
  const { mineFrlgCorpus } = await import('./lib/pret-frlg-miner.mjs');
  try {
    const corpus = await mineFrlgCorpus(ctx.sourcePath, {
      source: 'pret-firered',
      sourceCommit: ctx.sourceCommit,
      maxMaps: ctx.maxMaps,
    });
    return { corpus, warnings: [] };
  } catch (e) {
    return {
      corpus: emptyCorpus('pret-firered', ctx.sourceCommit),
      warnings: [`pret-firered mining failed: ${e instanceof Error ? e.message : String(e)}`],
    };
  }
}

/** @param {{ sourcePath: string, sourceCommit: string | null, maxMaps: number | null }} ctx */
async function buildPretEmeraldCorpus(ctx) {
  if (!existsSync(ctx.sourcePath)) {
    return {
      corpus: emptyCorpus('pret-emerald'),
      warnings: [
        `pret-emerald path does not exist: ${ctx.sourcePath}. ` +
          `Clone https://github.com/pret/pokeemerald into that path, ` +
          `or pass --pret-emerald <path>.`,
      ],
    };
  }
  const { mineEmeraldCorpus } = await import('./lib/pret-frlg-miner.mjs');
  try {
    const corpus = await mineEmeraldCorpus(ctx.sourcePath, {
      source: 'pret-emerald',
      sourceCommit: ctx.sourceCommit,
      maxMaps: ctx.maxMaps,
    });
    return { corpus, warnings: [] };
  } catch (e) {
    return {
      corpus: emptyCorpus('pret-emerald', ctx.sourceCommit),
      warnings: [`pret-emerald mining failed: ${e instanceof Error ? e.message : String(e)}`],
    };
  }
}

/** @param {{ sourcePath: string, sourceCommit: string | null }} ctx */
async function buildCfruCorpus(ctx) {
  if (!existsSync(ctx.sourcePath)) {
    return {
      corpus: emptyCorpus('cfru'),
      warnings: [
        `CFRU path does not exist: ${ctx.sourcePath}. ` +
          `Provide via --cfru or skip with --source pret-firered.`,
      ],
    };
  }
  // CFRU is an OVERLAY on top of pret/pokefirered - it adds new
  // species / moves / abilities / items at build time but does NOT
  // ship its own data/tilesets/. The tileset corpus is already
  // covered by `pret-firered.json`. We emit an empty corpus and a
  // note explaining the design.
  return {
    corpus: emptyCorpus('cfru', ctx.sourceCommit),
    warnings: [
      `CFRU has no tileset data of its own (it's an overlay on ` +
        `pret/pokefirered). The vanilla FRLG corpus already covers ` +
        `the tilesets CFRU-modernized ROMs ship with.`,
    ],
  };
}

/** @param {{ sourcePath: string, sourceCommit: string | null }} ctx */
async function buildDpeCorpus(ctx) {
  if (!existsSync(ctx.sourcePath)) {
    return {
      corpus: emptyCorpus('dpe'),
      warnings: [
        `DPE path does not exist: ${ctx.sourcePath}. ` +
          `Provide via --dpe or skip with --source pret-firered.`,
      ],
    };
  }
  // DPE is the Gen-8 species-data expansion on top of CFRU; it
  // ships graphics/ (species sprites) + src/ (species data tables)
  // but no data/tilesets/. Same story as CFRU.
  return {
    corpus: emptyCorpus('dpe', ctx.sourceCommit),
    warnings: [
      `DPE has no tileset data of its own (it's a species-expansion ` +
        `overlay on CFRU/pret). The vanilla FRLG corpus covers the ` +
        `tilesets DPE-modernized ROMs ship with.`,
    ],
  };
}

/** @param {{ sourcePath: string, sourceCommit: string | null }} ctx */
async function buildEssentialsCorpus(ctx) {
  if (!existsSync(ctx.sourcePath)) {
    return {
      corpus: emptyCorpus('essentials'),
      warnings: [
        `Essentials path does not exist: ${ctx.sourcePath}. ` +
          `Provide via --essentials or download Pokémon Essentials v21.x.`,
      ],
    };
  }
  const { mineEssentials } = await import('./lib/essentials-miner.mjs');
  try {
    const result = await mineEssentials({
      essentialsRoot: ctx.sourcePath,
      sourceCommit: ctx.sourceCommit,
    });
    // Build the corpus from scratch (mirrors pret-frlg-miner) to
    // avoid emptyCorpus's `sourceCommit` extra-key leak - IRCorpus
    // forbids unknown top-level fields.
    const corpus = {
      schemaVersion: SCHEMA_VERSION,
      generatedAtUtc: nowIsoZ(),
      source: 'essentials',
      toolingVersion: TOOLING_VERSION,
      tilesets: result.tilesets,
      mapAdjacencies: result.mapAdjacencies,
    };
    return { corpus, warnings: [] };
  } catch (e) {
    return {
      corpus: emptyCorpus('essentials', ctx.sourceCommit),
      warnings: [
        `Essentials mining failed: ${e instanceof Error ? e.message : String(e)}`,
      ],
    };
  }
}

const MINERS = {
  'pret-firered': buildPretFiredRedCorpus,
  'pret-emerald': buildPretEmeraldCorpus,
  cfru: buildCfruCorpus,
  dpe: buildDpeCorpus,
  essentials: buildEssentialsCorpus,
};

// ---------------------------------------------------------------------------
// Empty-corpus helper. Mirrors `emptyIRCorpus` in
// app/backend/src/tile-intel/ir-schema.ts so this script can run
// without importing TypeScript.
// ---------------------------------------------------------------------------

/** @param {string} source @param {string | null} [sourceCommit] */
function emptyCorpus(source, sourceCommit = null) {
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAtUtc: nowIsoZ(),
    source,
    toolingVersion: TOOLING_VERSION,
    sourceCommit,
    tilesets: [],
    mapAdjacencies: [],
  };
}

function nowIsoZ() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// ---------------------------------------------------------------------------
// Validation pass - re-parses each emitted corpus through the Zod
// schema. Done by `node --import tsx` so we can `import` the
// TypeScript schema file directly without a separate build step.
// When tsx isn't installed (e.g. on a fresh checkout), the script
// emits without validation but warns loudly.
// ---------------------------------------------------------------------------

async function validateCorpusViaTsx(corpus) {
  try {
    // Lazy import - only the validate path touches tsx.
    const tsx = await import(
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore: tsx is a devDependency, runtime check
      'tsx/esm/api'
    ).catch(() => null);
    if (!tsx) {
      return { ok: true, validatorAvailable: false };
    }
    /** @type {import('../app/backend/src/tile-intel/ir-schema.js')} */
    const mod = await tsx.tsImport(
      resolve(REPO_ROOT, 'app/backend/src/tile-intel/ir-schema.ts'),
      import.meta.url,
    );
    // Strip sourceCommit before parsing - Zod schema doesn't allow extras
    // at the top level if .strict() were used; we use the default which
    // ignores them, but the IR shape only sanctions specific fields.
    const result = mod.safeParseIRCorpus(corpus);
    return { ok: result.success, validatorAvailable: true, error: result.success ? null : result.error };
  } catch (e) {
    return {
      ok: true,
      validatorAvailable: false,
      warning: `validator unavailable: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  if (!existsSync(args.outDir)) {
    mkdirSync(args.outDir, { recursive: true });
  }

  for (const source of args.sources) {
    const sourcePath = args.paths[source];
    const sourceCommit = gitHeadSha(sourcePath);
    const outFile = resolve(args.outDir, `${source}.json`);

    if (args.validateOnly) {
      if (!existsSync(outFile)) {
        process.stderr.write(
          `[${source}] no existing corpus at ${outFile} - skip.\n`,
        );
        continue;
      }
      const existing = JSON.parse(readFileSync(outFile, 'utf8'));
      if (args.skipValidation) {
        process.stdout.write(`[${source}] --no-validate: skipped\n`);
        continue;
      }
      const result = await validateCorpusViaTsx(existing);
      reportValidation(source, outFile, result);
      continue;
    }

    process.stdout.write(`[${source}] mining from ${sourcePath}\n`);
    const miner = MINERS[source];
    const { corpus, warnings } = await miner({ sourcePath, sourceCommit, maxMaps: args.maxMaps });

    for (const warning of warnings) {
      process.stderr.write(`[${source}] WARN: ${warning}\n`);
    }

    if (!args.skipValidation) {
      const result = await validateCorpusViaTsx(corpus);
      if (!result.ok) {
        process.stderr.write(
          `[${source}] FAIL: Zod validation rejected the emitted IR.\n` +
            `${result.error?.message ?? ''}\n`,
        );
        process.exit(1);
      }
      if (!result.validatorAvailable) {
        process.stderr.write(
          `[${source}] note: tsx not available, skipping schema check. ` +
            `Install tsx in app/backend (devDependency) for validation.\n`,
        );
      }
    }

    // Compact JSON (no indentation) - these files are 10s of MB
    // even at moderate map counts; pretty-printing roughly doubles
    // the size for no human-readability win (nobody hand-inspects
    // 30 MB JSON). Diffability via git is still OK because the
    // corpus changes are mostly additive.
    writeFileSync(outFile, JSON.stringify(corpus) + '\n', 'utf8');
    process.stdout.write(
      `[${source}] wrote ${corpus.tilesets.length} tileset(s), ` +
        `${corpus.mapAdjacencies.length} map adjacency record(s) → ${outFile}\n`,
    );
  }

  process.stdout.write(
    `\nDone. Corpus directory: ${args.outDir}\n` +
      `Next: Phase 8B-1 will fill the per-source miners with real data.\n`,
  );
}

function reportValidation(source, outFile, result) {
  if (!result.validatorAvailable) {
    process.stdout.write(
      `[${source}] validator unavailable (${result.warning ?? 'tsx missing'}); ` +
        `corpus exists at ${outFile} but was not validated.\n`,
    );
    return;
  }
  if (result.ok) {
    process.stdout.write(`[${source}] valid: ${outFile}\n`);
  } else {
    process.stderr.write(
      `[${source}] INVALID: ${outFile}\n${result.error?.message ?? ''}\n`,
    );
    process.exitCode = 1;
  }
}

main().catch((e) => {
  process.stderr.write(`fatal: ${e?.stack ?? String(e)}\n`);
  process.exit(1);
});
