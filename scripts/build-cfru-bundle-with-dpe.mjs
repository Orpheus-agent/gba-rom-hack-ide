#!/usr/bin/env node
// Phase 3.41 + Phase 5 update - Bundle the CFRU + DPE patch.
//
// Builds Complete Fire Red Upgrade WITH Dynamic Pokémon Expansion
// applied. DPE's README is explicit about the workflow:
//
//   1. Apply DPE to vanilla FireRed first (DPE's make.py reads
//      BPRE0.gba = vanilla, writes test.gba = vanilla+DPE).
//   2. Apply CFRU on top (CFRU's make.py reads BPRE0.gba = the DPE
//      output from step 1, writes test.gba = vanilla+DPE+CFRU).
//
// The previous Phase 3.41 scaffold tried to merge DPE's source tree
// INTO CFRU's tree and run a single build. That doesn't match how
// Skeli789's tooling works - DPE's hack-author directive FILES
// (bytereplacement, hooks, repoints, etc.) live at the root of DPE
// and CFRU has SAME-NAMED files with different content. A simple
// directory-overlay would either overwrite CFRU's directives with
// DPE's incomplete subset, or vice versa, and the merged tree
// wouldn't compile.
//
// This script does the right thing: two sequential builds.
//
// Output: app/backend/src/assets/modernize/dpe.bps (BPS delta from
// vanilla → CFRU+DPE) + app/backend/src/assets/modernize/dpe.json
// (metadata).
//
// Pre-requisites:
//   - devkitARM on PATH (`arm-none-eabi-gcc` resolvable).
//   - python 3.6+ on PATH.
//   - CFRU source tree at --cfru-repo (default below).
//   - DPE source tree at --dpe-repo (default below).
//   - Engine built (`cd engine && npm run build`) - the script
//     dynamic-imports the engine's BPS encoder.
//
// Usage:
//   node scripts/build-cfru-bundle-with-dpe.mjs
//   node scripts/build-cfru-bundle-with-dpe.mjs --vanilla-rom <path>
//                                                --cfru-repo <path>
//                                                --dpe-repo <path>
//                                                --keep-staging
//                                                --skip-dpe   # only build CFRU; useful for diagnostics

import { spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const VANILLA_SHA1 = '41cb23d8dccc8ebd7c649cd8fbb58eeace6e2fdc';

const DEFAULT_VANILLA_ROM = `C:\\path\\to\\roms\\Pokemon - FireRed Version (USA).gba`;
const DEFAULT_CFRU_REPO = `C:\\path\\to\\Complete-Fire-Red-Upgrade-master\\Complete-Fire-Red-Upgrade-master`;
const DEFAULT_DPE_REPO = `C:\\path\\to\\Dynamic-Pokemon-Expansion-master\\Dynamic-Pokemon-Expansion-master`;

function parseArgs(argv) {
  const args = {
    vanillaRom: null,
    cfruRepo: null,
    dpeRepo: null,
    keepStaging: false,
    skipDpe: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--vanilla-rom') args.vanillaRom = argv[++i];
    else if (a === '--cfru-repo') args.cfruRepo = argv[++i];
    else if (a === '--dpe-repo') args.dpeRepo = argv[++i];
    else if (a === '--keep-staging') args.keepStaging = true;
    else if (a === '--skip-dpe') args.skipDpe = true;
    else if (a === '--help' || a === '-h') {
      console.log(`Usage: node scripts/build-cfru-bundle-with-dpe.mjs [--vanilla-rom <path>] [--cfru-repo <path>] [--dpe-repo <path>] [--keep-staging] [--skip-dpe]`);
      console.log(``);
      console.log(`Defaults:`);
      console.log(`  --vanilla-rom ${DEFAULT_VANILLA_ROM}`);
      console.log(`  --cfru-repo   ${DEFAULT_CFRU_REPO}`);
      console.log(`  --dpe-repo    ${DEFAULT_DPE_REPO}`);
      console.log(``);
      console.log(`Workflow: vanilla → DPE build → CFRU build → BPS diff. The two builds`);
      console.log(`run in <repo>/.dpe-build-staging/dpe-build/ and .../cfru-build/. Pass`);
      console.log(`--keep-staging to inspect the intermediate trees after a build.`);
      console.log(``);
      console.log(`Pass --skip-dpe to do a CFRU-only build (useful for sanity-checking`);
      console.log(`that CFRU compiles on this machine before debugging DPE issues).`);
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  if (!args.vanillaRom) args.vanillaRom = DEFAULT_VANILLA_ROM;
  if (!args.cfruRepo) args.cfruRepo = DEFAULT_CFRU_REPO;
  if (!args.dpeRepo) args.dpeRepo = DEFAULT_DPE_REPO;
  return args;
}

function sha1Hex(bytes) {
  return createHash('sha1').update(bytes).digest('hex');
}

function spawnAndStream(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', ...opts });
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(' ')} exited with code ${code}`));
    });
    child.on('error', reject);
  });
}

async function pathExists(p) {
  try {
    await fsp.stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Recursive copy. Uses fs.cp under the hood (Node 16.7+) so file
 *  vs directory disambiguation is handled correctly - the previous
 *  hand-rolled implementation incorrectly mkdir'd entries that are
 *  actually FILES (bytereplacement, hooks, repoints, etc. - all
 *  hack-author directive files at CFRU/DPE root). */
async function copyTree(src, dst) {
  await fsp.mkdir(path.dirname(dst), { recursive: true });
  await fsp.cp(src, dst, { recursive: true, force: true });
}

async function main() {
  const args = parseArgs(process.argv);

  console.log('=== Phase 3.41 (Phase 5-refresh) - CFRU + DPE bundle build ===');
  console.log(`Vanilla ROM: ${args.vanillaRom}`);
  console.log(`CFRU repo:   ${args.cfruRepo}`);
  console.log(`DPE repo:    ${args.dpeRepo}`);
  if (args.skipDpe) console.log('Mode:        CFRU-ONLY (skipping DPE pass for diagnostics)');
  console.log('');

  // ── Pre-checks ────────────────────────────────────────────────
  if (!(await pathExists(args.vanillaRom))) {
    console.error(`ERROR: vanilla ROM not found at ${args.vanillaRom}`);
    process.exit(1);
  }
  if (!(await pathExists(args.cfruRepo))) {
    console.error(`ERROR: CFRU repo not found at ${args.cfruRepo}`);
    console.error(`Download from https://github.com/Skeli789/Complete-Fire-Red-Upgrade and extract to that path.`);
    process.exit(1);
  }
  if (!args.skipDpe && !(await pathExists(args.dpeRepo))) {
    console.error(`ERROR: DPE repo not found at ${args.dpeRepo}`);
    console.error(`Download from https://github.com/Skeli789/Dynamic-Pokemon-Expansion and extract to that path.`);
    process.exit(1);
  }

  console.log('[1] Verifying vanilla ROM SHA-1…');
  const vanillaBytes = await fsp.readFile(args.vanillaRom);
  const vanillaSha = sha1Hex(vanillaBytes);
  if (vanillaSha !== VANILLA_SHA1) {
    console.error(`ERROR: vanilla ROM SHA-1 mismatch.`);
    console.error(`  expected ${VANILLA_SHA1}`);
    console.error(`  got      ${vanillaSha}`);
    process.exit(1);
  }
  console.log(`  OK: ${vanillaSha}`);

  // ── Staging ───────────────────────────────────────────────────
  const stageRoot = path.join(REPO_ROOT, '.dpe-build-staging');
  await fsp.rm(stageRoot, { recursive: true, force: true });
  await fsp.mkdir(stageRoot, { recursive: true });

  // ── Step 2: DPE build (vanilla → vanilla+DPE) ─────────────────
  let intermediateRomBytes;
  if (args.skipDpe) {
    console.log('');
    console.log('[2] DPE step skipped (--skip-dpe). Feeding raw vanilla into CFRU build.');
    intermediateRomBytes = vanillaBytes;
  } else {
    const dpeBuildDir = path.join(stageRoot, 'dpe-build');
    console.log('');
    console.log('[2] DPE build - applying DPE to vanilla FireRed.');
    console.log(`    Staging DPE source at ${dpeBuildDir}…`);
    await copyTree(args.dpeRepo, dpeBuildDir);
    console.log('    Dropping vanilla ROM as BPRE0.gba…');
    await fsp.copyFile(args.vanillaRom, path.join(dpeBuildDir, 'BPRE0.gba'));
    console.log('    Running `python scripts/make.py` inside the DPE tree…');
    await spawnAndStream('python', ['scripts/make.py'], { cwd: dpeBuildDir });
    const dpeOut = path.join(dpeBuildDir, 'test.gba');
    if (!(await pathExists(dpeOut))) {
      console.error(`ERROR: DPE build did not produce ${dpeOut}.`);
      console.error(`Inspect ${dpeBuildDir} for clues; re-run with --keep-staging to preserve it.`);
      process.exit(1);
    }
    intermediateRomBytes = await fsp.readFile(dpeOut);
    const dpeSha = sha1Hex(intermediateRomBytes);
    console.log(`    OK: vanilla+DPE SHA-1 = ${dpeSha} (${intermediateRomBytes.length} bytes)`);
  }

  // ── Step 3: CFRU build (vanilla+DPE → vanilla+DPE+CFRU) ───────
  const cfruBuildDir = path.join(stageRoot, 'cfru-build');
  console.log('');
  console.log('[3] CFRU build - applying CFRU on top of the prior output.');
  console.log(`    Staging CFRU source at ${cfruBuildDir}…`);
  await copyTree(args.cfruRepo, cfruBuildDir);
  console.log('    Dropping intermediate ROM as BPRE0.gba…');
  await fsp.writeFile(path.join(cfruBuildDir, 'BPRE0.gba'), intermediateRomBytes);
  console.log('    Running `python scripts/make.py` inside the CFRU tree…');
  await spawnAndStream('python', ['scripts/make.py'], { cwd: cfruBuildDir });
  const cfruOut = path.join(cfruBuildDir, 'test.gba');
  if (!(await pathExists(cfruOut))) {
    console.error(`ERROR: CFRU build did not produce ${cfruOut}.`);
    process.exit(1);
  }
  const finalBytes = await fsp.readFile(cfruOut);
  const finalSha = sha1Hex(finalBytes);
  console.log(`    OK: final SHA-1 = ${finalSha} (${finalBytes.length} bytes)`);

  // ── Step 4: BPS encode via the engine ─────────────────────────
  console.log('');
  console.log('[4] Producing BPS delta via engine encoder…');
  const enginePath = path.join(REPO_ROOT, 'engine', 'dist', 'index.js');
  if (!(await pathExists(enginePath))) {
    console.error(`ERROR: engine dist not built. Run \`cd engine && npm run build\` first.`);
    process.exit(1);
  }
  const engineModule = await import(`file://${enginePath.replace(/\\/g, '/')}`);
  const { patch: patchApi } = engineModule;
  const vanillaU8 = new Uint8Array(vanillaBytes);
  const finalU8 = new Uint8Array(finalBytes);
  const actions = patchApi.produceBpsActions(vanillaU8, finalU8);
  const bpsBytes = patchApi.encodeBps(actions, vanillaU8, finalU8);
  console.log(`    OK: BPS encoded - ${bpsBytes.byteLength} bytes (vs ${finalU8.byteLength} for the raw ROM).`);

  // ── Step 5: Write artifacts ───────────────────────────────────
  console.log('');
  console.log('[5] Writing artifacts…');
  const assetsDir = path.join(REPO_ROOT, 'app', 'backend', 'src', 'assets', 'modernize');
  await fsp.mkdir(assetsDir, { recursive: true });
  const bpsName = args.skipDpe ? 'cfru-only.bps' : 'dpe.bps';
  const jsonName = args.skipDpe ? 'cfru-only.json' : 'dpe.json';
  await fsp.writeFile(path.join(assetsDir, bpsName), Buffer.from(bpsBytes));
  // Keep the raw final ROM alongside for diagnostic comparison.
  const diagnosticDir = path.join(stageRoot, 'output');
  await fsp.mkdir(diagnosticDir, { recursive: true });
  await fsp.writeFile(
    path.join(diagnosticDir, args.skipDpe ? 'cfru-only-test.gba' : 'dpe-test.gba'),
    finalBytes,
  );

  const metadata = {
    schemaVersion: 1,
    pipeline: args.skipDpe ? 'cfru-only' : 'vanilla → DPE → CFRU',
    sourceFingerprint: {
      cfruRepo: args.cfruRepo,
      ...(args.skipDpe ? {} : { dpeRepo: args.dpeRepo }),
      builtAtUtc: new Date().toISOString(),
    },
    producesSha1: finalSha,
    vanillaSha1: VANILLA_SHA1,
    bytesProduced: finalBytes.length,
    bpsBytes: bpsBytes.byteLength,
    notes:
      args.skipDpe
        ? 'CFRU-only bundle (diagnostic build). For the production DPE-enhanced bundle, re-run without --skip-dpe.'
        : 'CFRU + Dynamic Pokémon Expansion bundle. Apply via the modernize service after the fingerprint at engine/src/identity/hack-fingerprints.ts is updated with the SHA-1 reported above. Both CFRU and DPE are non-commercial; honor Skeli789\'s license terms (no monetization).',
  };
  await fsp.writeFile(
    path.join(assetsDir, jsonName),
    JSON.stringify(metadata, null, 2),
  );

  // ── Cleanup ───────────────────────────────────────────────────
  if (!args.keepStaging) {
    console.log('');
    console.log(`[6] Cleaning up staging at ${stageRoot} (pass --keep-staging to inspect it)…`);
    await fsp.rm(stageRoot, { recursive: true, force: true });
  } else {
    console.log('');
    console.log(`[6] Keeping staging at ${stageRoot} per --keep-staging.`);
  }

  console.log('');
  console.log('=== DONE ===');
  console.log(`Bundle BPS:    ${path.join(assetsDir, bpsName)}`);
  console.log(`Metadata:      ${path.join(assetsDir, jsonName)}`);
  console.log(`Produces SHA-1: ${finalSha}`);
  console.log('');
  console.log('Next steps:');
  console.log('  1. Update engine/src/identity/hack-fingerprints.ts: add an entry mapping');
  console.log(`     SHA-1 ${finalSha}`);
  console.log(args.skipDpe
    ? '     to displayName "FireRed (Modernized) - diagnostic CFRU-only build".'
    : '     to displayName "FireRed (Modernized + Gen 9 species)".');
  console.log('  2. Rebuild the engine: cd engine && npm run build');
  console.log('  3. Restart the editor backend.');
  console.log('  4. Open a fresh vanilla FRLG ROM - the Modernize card will offer the bundle.');
}

main().catch((e) => {
  console.error('Build failed:', e);
  process.exit(1);
});
