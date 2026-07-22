#!/usr/bin/env node
// Modernize-and-Ship slice 7 - bundle the CFRU patch.
//
// Builds Complete Fire Red Upgrade from a local clone, diffs the
// resulting test.gba against the user-supplied vanilla FireRed, and
// writes:
//
//   app/backend/src/assets/modernize/cfru.bps - the binary delta
//   app/backend/src/assets/modernize/cfru.json - metadata (hashes etc.)
//
// Then prints a fingerprint diff snippet the user pastes into
// engine/src/identity/hack-fingerprints.ts so the editor recognizes
// the modernized ROM by exact SHA-1 (not just the heuristic).
//
// Usage (PowerShell - single line, the line continuation is backtick `):
//   node scripts/build-cfru-bundle.mjs --vanilla-rom "C:\path\to\FireRed.gba"
//   node scripts/build-cfru-bundle.mjs --vanilla-rom "C:\path\to\FireRed.gba" --cfru-repo "C:\path\to\CFRU"
//
// Usage (bash - line continuation is backslash \):
//   node scripts/build-cfru-bundle.mjs \
//     --vanilla-rom /path/to/FireRed.gba \
//     [--cfru-repo /path/to/CFRU]
//
// Pre-requisites (see CFRU's README for full instructions):
//   - devkitARM installed and on PATH
//   - python 3.6+ installed
//   - The user must agree to CFRU's no-monetization license terms.

import { spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const VANILLA_SHA1 = '41cb23d8dccc8ebd7c649cd8fbb58eeace6e2fdc';

// Phase 5 user-runbook - same vanilla-ROM default as the DPE bundle
// script so the user can run either one with no arguments.
const DEFAULT_VANILLA_ROM = `C:\\path\\to\\roms\\Pokemon - FireRed Version (USA).gba`;
const DEFAULT_CFRU_REPO = `C:\\path\\to\\Complete-Fire-Red-Upgrade-master\\Complete-Fire-Red-Upgrade-master`;

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { vanillaRom: null, cfruRepo: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--vanilla-rom') args.vanillaRom = argv[++i];
    else if (a === '--cfru-repo') args.cfruRepo = argv[++i];
    else if (a === '--help' || a === '-h') {
      console.log(`Usage: node scripts/build-cfru-bundle.mjs [--vanilla-rom <path>] [--cfru-repo <path>]`);
      console.log(``);
      console.log(`Defaults:`);
      console.log(`  --vanilla-rom ${DEFAULT_VANILLA_ROM}`);
      console.log(`  --cfru-repo   ${DEFAULT_CFRU_REPO}`);
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  if (!args.vanillaRom) args.vanillaRom = DEFAULT_VANILLA_ROM;
  if (!args.cfruRepo) args.cfruRepo = DEFAULT_CFRU_REPO;
  return args;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha1Hex(bytes) {
  return createHash('sha1').update(bytes).digest('hex');
}

async function spawnAndStream(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      ...opts,
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(' ')} exited code=${code} signal=${signal ?? '?'}`));
    });
  });
}

async function getGitShortSha(repoRoot) {
  try {
    let stdout = '';
    await new Promise((resolve, reject) => {
      const child = spawn('git', ['rev-parse', '--short', 'HEAD'], {
        cwd: repoRoot,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      child.stdout.on('data', (chunk) => (stdout += chunk.toString()));
      child.on('error', reject);
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`git exit ${code}`))));
    });
    return stdout.trim();
  } catch {
    return 'unknown';
  }
}

// ---------------------------------------------------------------------------
// BPS encoder (mirror of engine/src/patch/bps.ts producer, in pure JS so this
// script doesn't depend on the engine being compiled).
// ---------------------------------------------------------------------------

function writeVarint(value, out) {
  let data = value;
  while (true) {
    const x = data & 0x7f;
    data = Math.floor(data / 128);
    if (data === 0) {
      out.push(0x80 | x);
      return;
    }
    out.push(x);
    data -= 1;
  }
}

function crc32Of(bytes) {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? (0xedb88320 ^ (c >>> 1)) : c >>> 1;
    table[i] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = (table[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)) >>> 0;
  return (crc ^ 0xffffffff) >>> 0;
}

function writeU32LE(value, out) {
  out.push(value & 0xff);
  out.push((value >>> 8) & 0xff);
  out.push((value >>> 16) & 0xff);
  out.push((value >>> 24) & 0xff);
}

function produceAndEncodeBps(source, target) {
  // Simple SourceRead/TargetRead producer - mirrors engine/src/patch/bps.ts.
  const out = [];
  // "BPS1" magic
  out.push(0x42, 0x50, 0x53, 0x31);
  writeVarint(source.length, out);
  writeVarint(target.length, out);
  writeVarint(0, out); // metadata size = 0
  const minSize = Math.min(source.length, target.length);
  let i = 0;
  while (i < target.length) {
    if (i < minSize && source[i] === target[i]) {
      let runEnd = i + 1;
      while (runEnd < minSize && source[runEnd] === target[runEnd]) runEnd++;
      const length = runEnd - i;
      writeVarint((length - 1) * 4 + 0, out); // SourceRead = 0
      i = runEnd;
    } else {
      let runEnd = i + 1;
      while (runEnd < target.length && !(runEnd < minSize && source[runEnd] === target[runEnd])) {
        runEnd++;
      }
      const length = runEnd - i;
      writeVarint((length - 1) * 4 + 1, out); // TargetRead = 1
      for (let k = i; k < runEnd; k++) out.push(target[k]);
      i = runEnd;
    }
  }
  // CRC trailer
  const sourceCrc = crc32Of(source);
  const targetCrc = crc32Of(target);
  writeU32LE(sourceCrc, out);
  writeU32LE(targetCrc, out);
  const patchBytes = Uint8Array.from(out);
  const patchCrc = crc32Of(patchBytes);
  writeU32LE(patchCrc, out);
  return Uint8Array.from(out);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv);

  console.log(`[bundle] CFRU repo: ${args.cfruRepo}`);
  console.log(`[bundle] vanilla ROM: ${args.vanillaRom}`);

  // 1. Read vanilla, verify SHA-1.
  const vanillaBytes = await fsp.readFile(args.vanillaRom);
  const vanillaSha1 = sha1Hex(vanillaBytes);
  if (vanillaSha1 !== VANILLA_SHA1) {
    console.error(
      `[bundle] Vanilla ROM SHA-1 mismatch: expected ${VANILLA_SHA1}, got ${vanillaSha1}`,
    );
    console.error(
      `[bundle] This script only works with the canonical FireRed (USA, v1.0) ROM.`,
    );
    process.exit(3);
  }
  console.log(`[bundle] vanilla SHA-1 verified.`);

  // 2. Drop the vanilla ROM into the CFRU repo as BPRE0.gba.
  const bpre0Path = path.join(args.cfruRepo, 'BPRE0.gba');
  await fsp.writeFile(bpre0Path, vanillaBytes);
  console.log(`[bundle] copied vanilla ROM → ${bpre0Path}`);

  // 3. Run CFRU's build (python scripts/make.py).
  console.log(`[bundle] building CFRU - this may take a minute …`);
  await spawnAndStream('python', ['scripts/make.py'], { cwd: args.cfruRepo });

  // 4. Harvest test.gba.
  const testGbaPath = path.join(args.cfruRepo, 'test.gba');
  const targetBytes = await fsp.readFile(testGbaPath);
  const producesSha1 = sha1Hex(targetBytes);
  console.log(`[bundle] built test.gba (${targetBytes.length} bytes, SHA-1 ${producesSha1})`);

  // 5. Diff vanilla → built.
  console.log(`[bundle] producing BPS delta …`);
  const patchBytes = produceAndEncodeBps(new Uint8Array(vanillaBytes), new Uint8Array(targetBytes));
  const patchSha1 = sha1Hex(patchBytes);
  console.log(`[bundle] BPS produced (${patchBytes.length} bytes, SHA-1 ${patchSha1})`);

  // 6. Read CFRU commit short SHA.
  const cfruCommitShortSha = await getGitShortSha(args.cfruRepo);
  console.log(`[bundle] CFRU commit: ${cfruCommitShortSha}`);

  // 7. Write outputs.
  const outputsDir = path.resolve(REPO_ROOT, 'app/backend/src/assets/modernize');
  await fsp.mkdir(outputsDir, { recursive: true });
  await fsp.writeFile(path.join(outputsDir, 'cfru.bps'), patchBytes);
  const metadata = {
    vanillaSha1: VANILLA_SHA1,
    producesSha1,
    cfruVersion: `CFRU @ ${cfruCommitShortSha}`,
    cfruCommitShortSha,
    buildOffset: 0x900000,
    built: true,
    bundledAtUtc: new Date().toISOString(),
    bundledPatchSha1: patchSha1,
  };
  await fsp.writeFile(
    path.join(outputsDir, 'cfru.json'),
    JSON.stringify(metadata, null, 2) + '\n',
  );
  console.log(`[bundle] wrote ${path.join(outputsDir, 'cfru.bps')}`);
  console.log(`[bundle] wrote ${path.join(outputsDir, 'cfru.json')}`);

  // 8. Print the fingerprint diff snippet for the user to paste into
  //    engine/src/identity/hack-fingerprints.ts.
  const snippet = [
    '',
    '═══════════════════════════════════════════════════════════════════════',
    'Paste this entry into engine/src/identity/hack-fingerprints.ts inside',
    'FINGERPRINTS_BY_SHA1, after the "Modernize-and-Ship bundle" comment:',
    '═══════════════════════════════════════════════════════════════════════',
    '',
    `    [`,
    `      '${producesSha1}',`,
    `      {`,
    `        displayName: 'FireRed (Modernized)',`,
    `        baseGame: 'Pokémon FireRed',`,
    `        family: 'frlg-hack',`,
    `        notes: 'CFRU built at commit ${cfruCommitShortSha}, OFFSET_TO_PUT=0x900000.',`,
    `      },`,
    `    ],`,
    '',
    '═══════════════════════════════════════════════════════════════════════',
    'After pasting, rebuild the engine: cd engine && npm run build',
    '═══════════════════════════════════════════════════════════════════════',
  ];
  console.log(snippet.join('\n'));
}

main().catch((e) => {
  console.error(`[bundle] FAILED: ${e?.message ?? e}`);
  process.exit(1);
});
