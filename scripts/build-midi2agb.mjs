#!/usr/bin/env node
// Phase 5.2 - Install midi2agb.
//
// midi2agb is ipatix's open-source reimplementation of Nintendo's
// mid2agb (https://github.com/ipatix/midi2agb). The editor's audio
// import pipeline (propose_import_music) calls this binary to
// convert MIDI files into Sappy .s assembly, which the CFRU build
// pipeline then assembles into the game.
//
// Resolution order (Phase 5.6 update - prefer the prebuilt
// release over building from source since most users hit
// toolchain gaps and the prebuilt is functionally identical):
//
//   1. If <output-dir>/midi2agb<.exe> already exists, exit 0
//      (idempotent - re-running after a successful install is a
//      no-op).
//   2. Try to download the latest tagged release from
//      https://github.com/ipatix/midi2agb/releases (permanent
//      assets; survive past the 90-day artifact expiry that
//      affects GitHub Actions). Extract midi2agb.exe to the
//      output dir. This is the recommended path on Windows.
//   3. Fall back to compiling from a local source clone:
//      a. Verify cppmidi/ submodule is populated (git-clone if
//         missing).
//      b. Detect a working host C++17 compiler.
//      c. Invoke the makefile.
//      d. Copy the resulting binary to the output dir.
//   4. When (2) and (3) both fail, surface a clear "install
//      <foo>" message.
//
// Usage:
//   node scripts/build-midi2agb.mjs                # auto: prebuilt → source → fail with hints
//   node scripts/build-midi2agb.mjs --no-download  # skip step 2 (force compile)
//   node scripts/build-midi2agb.mjs --source <path>
//   node scripts/build-midi2agb.mjs --output <dir>
//
// Exit codes: 0 = installed or already present; 1 = soft failure
// with actionable next steps; 2 = hard error (bad args).

import { spawn, spawnSync } from 'node:child_process';
import { promises as fsp, createWriteStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import https from 'node:https';
import zlib from 'node:zlib';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const DEFAULT_SOURCE = 'C:\\path\\to\\midi2agb-master\\midi2agb-master';
const DEFAULT_OUTPUT_DIR = path.join(REPO_ROOT, 'tools');
const CPPMIDI_GIT_URL = 'https://github.com/ipatix/cppmidi.git';

// Phase 5.6 - direct download URL for the latest tagged release.
// Pinned to v1.0.3 (Jan 5 2026 - most recent at the time of writing).
// When ipatix ships a new release we bump this URL.
const RELEASE_TAG = 'v1.0.3';
const RELEASE_ZIP_URL =
  `https://github.com/ipatix/midi2agb/releases/download/${RELEASE_TAG}/midi2agb-windows-clang64.zip`;

function parseArgs(argv) {
  const args = {
    source: DEFAULT_SOURCE,
    outputDir: DEFAULT_OUTPUT_DIR,
    download: true, // Phase 5.6 - auto-download the prebuilt release first.
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--source') args.source = argv[++i];
    else if (a === '--output') args.outputDir = argv[++i];
    else if (a === '--no-download') args.download = false;
    else if (a === '--help' || a === '-h') {
      console.log(`Usage: node scripts/build-midi2agb.mjs [--source <path>] [--output <dir>] [--no-download]`);
      console.log(``);
      console.log(`Defaults:`);
      console.log(`  --source ${DEFAULT_SOURCE}`);
      console.log(`  --output ${DEFAULT_OUTPUT_DIR}`);
      console.log(``);
      console.log(`Resolution order:`);
      console.log(`  1. If <output>/midi2agb<.exe> already exists, do nothing.`);
      console.log(`  2. Download + extract the latest tagged release (${RELEASE_TAG}) from`);
      console.log(`     https://github.com/ipatix/midi2agb/releases. Pass --no-download`);
      console.log(`     to skip this step.`);
      console.log(`  3. Fall back to compiling from --source (needs cppmidi submodule`);
      console.log(`     + host C++17 compiler).`);
      console.log(`  4. Print install instructions when (2) and (3) both fail.`);
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

async function pathExists(p) {
  try {
    await fsp.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function dirIsEmpty(p) {
  try {
    const entries = await fsp.readdir(p);
    return entries.length === 0;
  } catch {
    return true;
  }
}

function probeCommand(cmd, args = ['--version']) {
  try {
    const r = spawnSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    if (r.error) return null;
    if (r.status !== 0 && r.status !== null) return null;
    const out = (r.stdout || r.stderr || Buffer.from('')).toString().split(/\r?\n/)[0] ?? '';
    return out.trim() || cmd;
  } catch {
    return null;
  }
}

/** Pick a working host C++17 compiler. Returns the make-target name
 *  ('linux' / 'mingw') + the cxx command path the makefile will use. */
function detectToolchain() {
  // Windows: prefer the mingw-w64 cross-compiler (matches mingw.makefile).
  if (process.platform === 'win32') {
    const mingwCxx = probeCommand('x86_64-w64-mingw32-g++');
    if (mingwCxx) return { kind: 'mingw', cxx: 'x86_64-w64-mingw32-g++', strip: 'x86_64-w64-mingw32-strip', cxxVersion: mingwCxx };
    // Fall back to plain g++ if it's on PATH (msys2 mingw shell).
    const gpp = probeCommand('g++');
    if (gpp) return { kind: 'plain-g++', cxx: 'g++', strip: 'strip', cxxVersion: gpp };
    return null;
  }
  // Unix: g++ / clang++ both fine.
  const gpp = probeCommand('g++');
  if (gpp) return { kind: 'linux', cxx: 'g++', strip: 'strip', cxxVersion: gpp };
  const clang = probeCommand('clang++');
  if (clang) return { kind: 'linux', cxx: 'clang++', strip: 'strip', cxxVersion: clang };
  return null;
}

function spawnAndStream(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', ...opts });
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(' ')} exited with code ${code}`));
    });
    child.on('error', (e) => reject(e));
  });
}

async function ensureCppmidi(source) {
  const cppmidiDir = path.join(source, 'cppmidi');
  if (!(await pathExists(cppmidiDir)) || (await dirIsEmpty(cppmidiDir))) {
    const git = probeCommand('git', ['--version']);
    if (!git) {
      console.error('');
      console.error('--- ACTION REQUIRED ---');
      console.error(`cppmidi/ submodule is empty at ${cppmidiDir}`);
      console.error('and git is not on PATH so we cannot clone it for you.');
      console.error('');
      console.error('Install git and re-run, or clone the submodule manually:');
      console.error(`  cd "${source}"`);
      console.error(`  git clone ${CPPMIDI_GIT_URL} cppmidi`);
      console.error('');
      return false;
    }
    console.log(`[setup] cppmidi/ submodule is missing - cloning from ${CPPMIDI_GIT_URL}…`);
    // Clean any stub dir + re-clone.
    await fsp.rm(cppmidiDir, { recursive: true, force: true });
    try {
      await spawnAndStream('git', ['clone', '--depth', '1', CPPMIDI_GIT_URL, cppmidiDir]);
    } catch (e) {
      console.error('git clone failed:', e.message);
      return false;
    }
  }
  // Sanity check: the makefile compiles cppmidi/cppmidi.cpp.
  const expectedSrc = path.join(cppmidiDir, 'cppmidi.cpp');
  if (!(await pathExists(expectedSrc))) {
    console.error(`cppmidi/cppmidi.cpp missing after clone - submodule layout may have changed.`);
    return false;
  }
  return true;
}

/** Phase 5.6 - download the latest tagged release ZIP, extract
 *  midi2agb<.exe>, place in outputDir. Returns true on success.
 *  On failure (network down, server returned non-200, extraction
 *  failed) logs the error + returns false so the caller can fall
 *  through to the compile-from-source path. */
async function tryDownloadRelease(outputDir) {
  if (process.platform !== 'win32') {
    // The release ZIP is Windows-only (clang64 build). Other OSes
    // need to compile from source.
    return false;
  }
  console.log(`[download] Fetching ${RELEASE_ZIP_URL} …`);
  const tmpZip = path.join(outputDir, `midi2agb-${RELEASE_TAG}.zip`);
  try {
    await downloadFollowingRedirects(RELEASE_ZIP_URL, tmpZip);
  } catch (e) {
    console.error(`[download] failed: ${e.message}`);
    try {
      await fsp.rm(tmpZip, { force: true });
    } catch {
      /* ignore */
    }
    return false;
  }
  console.log(`[download] saved ${(await fsp.stat(tmpZip)).size} bytes`);
  // Extract using PowerShell's Expand-Archive (built-in on Windows
  // since 5.0, ships with every supported version).
  const tmpExtractDir = path.join(outputDir, `.extract-${RELEASE_TAG}`);
  await fsp.rm(tmpExtractDir, { recursive: true, force: true });
  await fsp.mkdir(tmpExtractDir, { recursive: true });
  console.log(`[download] extracting via PowerShell Expand-Archive…`);
  const ps = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `Expand-Archive -Path '${tmpZip}' -DestinationPath '${tmpExtractDir}' -Force`,
    ],
    { stdio: ['ignore', 'inherit', 'inherit'] },
  );
  if (ps.status !== 0) {
    console.error(`[download] Expand-Archive failed (exit ${String(ps.status)})`);
    await fsp.rm(tmpZip, { force: true });
    await fsp.rm(tmpExtractDir, { recursive: true, force: true });
    return false;
  }
  // Find midi2agb.exe inside the extracted tree (might be nested).
  const exePath = await findFileRecursive(tmpExtractDir, 'midi2agb.exe');
  if (!exePath) {
    console.error(`[download] midi2agb.exe not found inside extracted archive`);
    await fsp.rm(tmpZip, { force: true });
    await fsp.rm(tmpExtractDir, { recursive: true, force: true });
    return false;
  }
  const dst = path.join(outputDir, 'midi2agb.exe');
  await fsp.copyFile(exePath, dst);
  // Clean up temp files.
  await fsp.rm(tmpZip, { force: true });
  await fsp.rm(tmpExtractDir, { recursive: true, force: true });
  console.log(`[download] installed midi2agb.exe at ${dst}`);
  return true;
}

function downloadFollowingRedirects(url, dst, redirectsLeft = 6) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (response) => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400 && response.headers.location) {
          if (redirectsLeft <= 0) {
            reject(new Error('Too many redirects'));
            return;
          }
          response.resume();
          downloadFollowingRedirects(response.headers.location, dst, redirectsLeft - 1)
            .then(resolve, reject);
          return;
        }
        if (status !== 200) {
          reject(new Error(`HTTP ${String(status)} from ${url}`));
          return;
        }
        const file = createWriteStream(dst);
        const encoding = (response.headers['content-encoding'] ?? '').toString().toLowerCase();
        const stream = encoding === 'gzip' ? response.pipe(zlib.createGunzip()) : response;
        stream.pipe(file);
        file.on('finish', () => file.close(() => resolve()));
        file.on('error', reject);
        response.on('error', reject);
      })
      .on('error', reject);
  });
}

async function findFileRecursive(dir, name) {
  let queue = [dir];
  while (queue.length > 0) {
    const cur = queue.shift();
    let entries;
    try {
      entries = await fsp.readdir(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isFile() && e.name.toLowerCase() === name.toLowerCase()) return full;
      if (e.isDirectory()) queue.push(full);
    }
  }
  return null;
}

async function main() {
  const args = parseArgs(process.argv);
  console.log('=== Phase 5.2 - midi2agb build ===');
  console.log(`Source: ${args.source}`);
  console.log(`Output dir: ${args.outputDir}`);
  console.log('');

  // If the user already dropped a pre-built midi2agb.exe at the
  // output path, we're done - surface that + exit success.
  await fsp.mkdir(args.outputDir, { recursive: true });
  const expectedBinary = path.join(
    args.outputDir,
    process.platform === 'win32' ? 'midi2agb.exe' : 'midi2agb',
  );
  if (await pathExists(expectedBinary)) {
    console.log(`[skip] ${expectedBinary} already exists - nothing to do.`);
    console.log('Delete that file + re-run if you want to rebuild from source.');
    console.log('Restart the editor backend if you haven\'t already; the bridge will');
    console.log('detect this binary on next call to propose_import_music.');
    process.exit(0);
  }

  // Phase 5.6 - try the prebuilt release first. Most users want
  // this; building from source needs a host C++17 compiler that
  // devkitPro msys2 doesn't supply by default.
  if (args.download) {
    const downloaded = await tryDownloadRelease(args.outputDir);
    if (downloaded) {
      console.log('');
      console.log('=== DONE (downloaded prebuilt release) ===');
      console.log(`Installed midi2agb.exe at: ${expectedBinary}`);
      console.log('');
      console.log('Next: restart the editor backend so the bridge re-runs detection.');
      process.exit(0);
    }
    console.log('[download] could not install from release; falling back to compile-from-source.');
    console.log('');
  }

  // Pre-check the source for the compile path.
  if (!(await pathExists(args.source))) {
    console.error(`ERROR: midi2agb source not found at ${args.source}`);
    console.error('Download from https://github.com/ipatix/midi2agb (use Code → Download ZIP)');
    console.error(`OR clone with: git clone --recurse-submodules ${CPPMIDI_GIT_URL.replace('cppmidi', 'midi2agb')} ${args.source}`);
    process.exit(1);
  }
  const makefile = path.join(args.source, process.platform === 'win32' ? 'mingw.makefile' : 'Makefile');
  if (!(await pathExists(makefile))) {
    console.error(`ERROR: makefile not found at ${makefile}`);
    process.exit(1);
  }

  // Ensure cppmidi submodule.
  const cppmidiOk = await ensureCppmidi(args.source);
  if (!cppmidiOk) {
    process.exit(1);
  }

  // Detect toolchain.
  const toolchain = detectToolchain();
  if (!toolchain) {
    console.error('');
    console.error('--- ACTION REQUIRED ---');
    if (process.platform === 'win32') {
      console.error('No C++17 host compiler found on PATH. midi2agb needs one to build.');
      console.error('');
      console.error('-- RECOMMENDED: Pre-built binary (no compile required) --');
      console.error('1. Open https://github.com/ipatix/midi2agb/actions in your browser.');
      console.error('2. Click the most recent green "Windows Build (MinGW)" run.');
      console.error('3. Scroll to the bottom - under "Artifacts" download the .zip');
      console.error('   (you may need to be logged in to GitHub - free account works).');
      console.error('4. Extract the zip; copy midi2agb.exe to:');
      console.error(`   ${args.outputDir}\\midi2agb.exe`);
      console.error(`   (create the tools\\ folder first if it doesn't exist)`);
      console.error('5. Restart the editor backend.');
      console.error('');
      console.error('-- ALTERNATIVE: Compile from source --');
      console.error('Your devkitPro msys2 doesn\'t expose the mingw64 package repo by');
      console.error('default. Two ways to install a working mingw-w64 g++:');
      console.error('');
      console.error('  Option A - install full MSYS2 separately:');
      console.error('     https://www.msys2.org/  → grab the installer, run, then');
      console.error('     open MSYS2 MINGW64 (the orange shortcut), run:');
      console.error('        pacman -Syu');
      console.error('        pacman -S mingw-w64-x86_64-gcc make git');
      console.error('     Then from that shell:');
      console.error(`        cd "$(cygpath '${args.source}')"`);
      console.error('        make -f mingw.makefile');
      console.error(`        cp midi2agb.exe "$(cygpath '${args.outputDir}')"/`);
      console.error('');
      console.error('  Option B - enable the mingw64 repo inside devkitPro msys2:');
      console.error('     Edit C:\\devkitPro\\msys2\\etc\\pacman.conf and uncomment the');
      console.error('     [mingw64] section. Run `pacman -Sy` then the pacman -S above.');
      console.error('');
      console.error('Either compilation path produces midi2agb.exe; copy it to');
      console.error(`${args.outputDir}\\midi2agb.exe and restart the backend.`);
    } else {
      console.error('No C++17 host compiler (g++ or clang++) found on PATH.');
      console.error('Install one (e.g. `sudo apt install g++ make git` on Debian / Ubuntu)');
      console.error('and re-run this script.');
    }
    process.exit(1);
  }
  console.log(`[toolchain] Using ${toolchain.cxx} (${toolchain.cxxVersion})`);

  // Pick the makefile that matches the toolchain.
  const makefileName = process.platform === 'win32' ? 'mingw.makefile' : 'Makefile';
  const binaryName = process.platform === 'win32' ? 'midi2agb.exe' : 'midi2agb';

  console.log(`[build] Running make in ${args.source}…`);
  try {
    // Override CXX/STRIP via env so the bundled Makefile doesn't fail
    // when the user's binary names diverge from the default (e.g.
    // plain g++ on PATH instead of x86_64-w64-mingw32-g++).
    const env = {
      ...process.env,
      CXX: toolchain.cxx,
      STRIP: toolchain.strip,
    };
    await spawnAndStream('make', ['-f', makefileName], { cwd: args.source, env });
  } catch (e) {
    console.error(`make failed: ${e.message}`);
    console.error('');
    console.error('Common causes:');
    console.error('  - cppmidi/ submodule not populated (check cppmidi.cpp exists)');
    console.error('  - missing make (install via `pacman -S make` in msys2 / `apt install make` on Linux)');
    console.error('  - mingw toolchain incomplete (the Makefile references `strip` too)');
    process.exit(1);
  }

  // Copy the built binary to the editor's tools/ dir so the bridge
  // detects it.
  const srcBinary = path.join(args.source, binaryName);
  if (!(await pathExists(srcBinary))) {
    console.error(`ERROR: build succeeded but ${srcBinary} doesn't exist. Makefile changed?`);
    process.exit(1);
  }
  await fsp.mkdir(args.outputDir, { recursive: true });
  const dstBinary = path.join(args.outputDir, binaryName);
  await fsp.copyFile(srcBinary, dstBinary);

  console.log('');
  console.log('=== DONE ===');
  console.log(`Built binary at: ${dstBinary}`);
  console.log(`Source-clone binary at: ${srcBinary} (also detected by the bridge)`);
  console.log('');
  console.log('Next steps:');
  console.log('  1. Restart the editor backend so the bridge re-locates the binary.');
  console.log('  2. Try propose_import_music - the tool should now find midi2agb.');
}

main().catch((e) => {
  console.error('Build failed:', e);
  process.exit(1);
});
