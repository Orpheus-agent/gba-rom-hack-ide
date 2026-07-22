/**
 * mid2agb / midi2agb bridge (Phase 3.6 + 3.36 + Phase 5.1).
 *
 * Locates a MIDI → GBA-sound-format converter for music import. Two
 * binaries are recognised:
 *
 *   - mid2agb - Nintendo's original (proprietary, lives inside the
 *                pre-2020 devkitPro tool dump; reproduces the Sappy
 *                .s output format).
 *   - midi2agb - ipatix's open-source reimplementation
 *                (https://github.com/ipatix/midi2agb). Same .s output
 *                shape, fixes a bunch of bugs in the original.
 *
 * The bridge looks for either name on PATH or under common install
 * locations (devkitPro, the user's CFRU/DPE clones). When neither
 * is found, the result includes build instructions for the
 * reimplementation (since that's the recommended path now).
 *
 * The bridge does NOT run the converter - that's the tool layer's
 * job (propose_import_music). The bridge just locates the binary +
 * returns the path.
 */

import { promises as fsp } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repo root resolved relative to this compiled file. The engine
 *  ships as `engine/dist/audio/mid2agb-bridge.js`; walk three levels
 *  up to reach the workspace root. Used to anchor the `tools/`
 *  candidate path so the bridge finds the binary regardless of the
 *  backend's launch directory. */
const ENGINE_FILE = fileURLToPath(import.meta.url);
const WORKSPACE_ROOT = path.resolve(path.dirname(ENGINE_FILE), '..', '..', '..');

/** Tool variant - surfaced so callers can adjust their CLI args if
 *  the two binaries diverge on flag names (today they agree). */
export type Mid2agbVariant = 'mid2agb' | 'midi2agb';

export interface Mid2agbLocationResult {
  readonly found: boolean;
  readonly variant: Mid2agbVariant | null;
  readonly path: string | null;
  readonly version: string | null;
  readonly suggestedInstallPath: string | null;
  readonly suggestion: string;
  /** Locations we scanned. Useful for surfacing "we looked here…" in
   *  the install-instructions surface. */
  readonly searchedPaths: ReadonlyArray<string>;
}

/** Windows candidate path list. Each entry's basename also has a
 *  no-.exe variant tried automatically. The first entry - the
 *  editor's own tools/ folder - is anchored via `path.join`
 *  against the engine's resolved workspace root so the lookup
 *  works whether the backend was launched from `app/backend/`,
 *  the repo root, or anywhere else. */
const CANDIDATE_PATHS_WINDOWS: ReadonlyArray<string> = [
  // 1. Pre-built binary the user dropped (or build-midi2agb.mjs
  //    placed) inside the editor's own tools/ folder. Anchored to
  //    the workspace root rather than process.cwd() so the lookup
  //    survives the backend being launched from a subdirectory.
  path.join(WORKSPACE_ROOT, 'tools', 'midi2agb.exe'),
  path.join(WORKSPACE_ROOT, 'tools', 'mid2agb.exe'),
  // 2. ipatix midi2agb - built locally next to the source clone.
  'C:\\path\\to\\midi2agb-master\\midi2agb-master\\midi2agb.exe',
  // 3. Nintendo mid2agb - devkitPro classic install.
  'C:\\devkitPro\\tools\\bin\\mid2agb.exe',
  'C:\\devkitPro\\tools\\bin\\midi2agb.exe',
  // 4. CFRU clones sometimes ship a tools/ subfolder with the binary.
  'C:\\path\\to\\Complete-Fire-Red-Upgrade-master\\Complete-Fire-Red-Upgrade-master\\tools\\mid2agb.exe',
  'C:\\path\\to\\Complete-Fire-Red-Upgrade-master\\Complete-Fire-Red-Upgrade-master\\tools\\midi2agb.exe',
];
const CANDIDATE_PATHS_UNIX: ReadonlyArray<string> = [
  '/opt/devkitpro/tools/bin/mid2agb',
  '/opt/devkitpro/tools/bin/midi2agb',
  '/usr/local/bin/mid2agb',
  '/usr/local/bin/midi2agb',
  '/usr/bin/mid2agb',
  '/usr/bin/midi2agb',
];

function variantFromPath(p: string): Mid2agbVariant {
  return /midi2agb/i.test(path.basename(p)) ? 'midi2agb' : 'mid2agb';
}

/** Locate mid2agb or midi2agb. Returns the resolved path when found;
 *  otherwise a structured "missing" result with install + build
 *  instructions. */
export async function locateMid2agb(): Promise<Mid2agbLocationResult> {
  const candidates =
    process.platform === 'win32' ? CANDIDATE_PATHS_WINDOWS : CANDIDATE_PATHS_UNIX;
  const searched: string[] = [];

  // 1. Try each candidate directly.
  for (const p of candidates) {
    searched.push(p);
    if (await fileExists(p)) {
      const variant = variantFromPath(p);
      const version = await probeVersion(p);
      return Object.freeze({
        found: true,
        variant,
        path: p,
        version,
        suggestedInstallPath: null,
        suggestion: `${variant} located at ${p}${version ? ` (${version})` : ''}.`,
        searchedPaths: Object.freeze([...searched]),
      });
    }
  }

  // 2. Try PATH lookup via `which` / `where`. Try both binary names.
  const finder = process.platform === 'win32' ? 'where' : 'which';
  for (const name of ['midi2agb', 'mid2agb'] as const) {
    try {
      searched.push(`(PATH:${name})`);
      const pathResult = await spawnCapture(finder, [name]);
      if (pathResult.code === 0 && pathResult.stdout.trim().length > 0) {
        const found = pathResult.stdout.split(/\r?\n/)[0]!.trim();
        if (await fileExists(found)) {
          const variant = variantFromPath(found);
          const version = await probeVersion(found);
          return Object.freeze({
            found: true,
            variant,
            path: found,
            version,
            suggestedInstallPath: null,
            suggestion: `${variant} located on PATH at ${found}${version ? ` (${version})` : ''}.`,
            searchedPaths: Object.freeze([...searched]),
          });
        }
      }
    } catch {
      /* fall through to next name / install-suggest */
    }
  }

  // 3. Not found. Compose the install instructions.
  const suggestedInstallPath = candidates[0]!;
  const isWin = process.platform === 'win32';
  const suggestion =
    `Neither mid2agb nor midi2agb found. ` +
    `Recommended path: build ipatix's midi2agb (open-source, ` +
    `bug-fixed reimplementation of Nintendo's mid2agb). ` +
    (isWin
      ? `Run ${path.relative(process.cwd(), 'scripts/build-midi2agb.mjs') || 'scripts/build-midi2agb.mjs'} ` +
        `against the source clone at ` +
        `C:\\path\\to\\midi2agb-master\\midi2agb-master, ` +
        `OR drop a pre-built midi2agb.exe at ${suggestedInstallPath}. `
      : `Build from https://github.com/ipatix/midi2agb (make + g++ ` +
        `required), OR install Nintendo's mid2agb via the devkitPro ` +
        `legacy toolchain. `) +
    `Restart the editor backend after install; the tool will detect it automatically.`;

  return Object.freeze({
    found: false,
    variant: null,
    path: null,
    version: null,
    suggestedInstallPath,
    suggestion,
    searchedPaths: Object.freeze([...searched]),
  });
}

export interface RunMid2agbArgs {
  readonly midiPath: string;
  readonly outputPath: string;
  /** Resolved binary path from `locateMid2agb`. */
  readonly mid2agbPath: string;
  /** Which variant we're calling - different binaries may accept
   *  different flag names; today they agree but kept here so callers
   *  can adapt. */
  readonly variant?: Mid2agbVariant;
  /** Extra CLI flags appended after the input/output args. */
  readonly extraArgs?: ReadonlyArray<string>;
}

/** Run mid2agb / midi2agb against a MIDI file. Returns stdout/stderr
 *  + the exit code. The caller is expected to have already located
 *  the binary via `locateMid2agb`.
 *
 *  CLI shape (both variants):
 *    <binary> [options] <input.mid> [<output.s>]
 *
 *  We always pass input + output explicitly (no positional inference)
 *  so the result lands where the caller expects. */
export async function runMid2agb(
  argsOrLegacyMidiPath: RunMid2agbArgs | string,
  outputM4aPath?: string,
  mid2agbPath?: string,
  legacyExtraArgs: ReadonlyArray<string> = [],
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  // Support the old positional signature (Phase 3.6) + the new object
  // signature (Phase 5.1) so existing callers don't break.
  const args: RunMid2agbArgs =
    typeof argsOrLegacyMidiPath === 'string'
      ? {
          midiPath: argsOrLegacyMidiPath,
          outputPath: outputM4aPath!,
          mid2agbPath: mid2agbPath!,
          extraArgs: legacyExtraArgs,
        }
      : argsOrLegacyMidiPath;
  const result = await spawnCapture(args.mid2agbPath, [
    ...(args.extraArgs ?? []),
    args.midiPath,
    args.outputPath,
  ]);
  return {
    ok: result.code === 0,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

async function fileExists(p: string): Promise<boolean> {
  try {
    const stat = await fsp.stat(p);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function probeVersion(p: string): Promise<string | null> {
  // ipatix midi2agb v1.0.x has no --version or --help flag - calling
  // it with no args prints "midi2agb, version <git-sha>" to stderr
  // and the usage info immediately after. We try (in order):
  //   1. --version (in case a future build adds it)
  //   2. --help    (older bridge expectation; some builds support it)
  //   3. <no args> (ipatix v1.x's actual version-dump path)
  // First non-empty first-line that mentions "version" or "midi" wins.
  for (const argv of [['--version'], ['--help'], [] as string[]]) {
    try {
      const r = await spawnCapture(p, argv);
      const out = (r.stdout || r.stderr).trim();
      if (out.length === 0) continue;
      const firstLine = out.split(/\r?\n/)[0]!.trim();
      if (firstLine.length === 0) continue;
      // Filter out non-informative "cppmidi lib error" lines (those
      // appear when midi2agb runs with --version but treats it as a
      // bad MIDI filename). Prefer a line that mentions version/midi.
      if (/version|midi2agb|mid2agb/i.test(firstLine)) {
        return firstLine.slice(0, 120);
      }
    } catch {
      /* try next */
    }
  }
  return null;
}

function spawnCapture(
  cmd: string,
  args: ReadonlyArray<string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, [...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
    child.on('close', (code: number) => {
      resolve({ code: code ?? -1, stdout, stderr });
    });
    child.on('error', (e: Error) => {
      resolve({ code: -1, stdout, stderr: stderr + (e instanceof Error ? e.message : String(e)) });
    });
  });
}
