import { promises as fsp } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

/**
 * One entry in the discovery trace - records what was tried and why
 * it didn't match. The AgentPanel renders this so the user can see
 * exactly why discovery failed (path didn't exist, env var pointed at
 * a non-file, etc.) and can copy the relevant paths.
 */
export interface DiscoveryStep {
  readonly source: 'env' | 'path' | 'fallback';
  readonly path: string;
  readonly exists: boolean;
  readonly note?: string;
}

/**
 * Locate the local `claude` CLI binary. Discovery order:
 *   1. `CLAUDE_CLI_PATH` env var (explicit override).
 *   2. PATH via `where` (Windows) / `which` (Unix).
 *   3. Known per-platform install locations.
 *
 * Returns the absolute path when found, or null when no claude
 * installation is reachable. The route handler converts null into a
 * typed 503 so the frontend can render a setup prompt.
 */
export interface FindClaudeBinaryDeps {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  /** Test seam: replace the real `where.exe claude` / `which claude`
   *  PATH probe. Useful for tests that don't want the host machine's
   *  actual claude install to leak into expectations. */
  readonly findOnPathImpl?: (platform: NodeJS.Platform) => Promise<string | null>;
}

export async function findClaudeBinary(
  deps: FindClaudeBinaryDeps = {},
): Promise<string | null> {
  const result = await diagnoseClaudeBinary(deps);
  return result.binary;
}

/**
 * Like `findClaudeBinary` but also returns the full discovery trace - 
 * which paths were tried, which exist, which were skipped. Used by
 * the /api/agent/health endpoint so the AgentPanel banner can show
 * actionable diagnostic info when the binary isn't found.
 */
export async function diagnoseClaudeBinary(
  deps: FindClaudeBinaryDeps = {},
): Promise<{ binary: string | null; trace: ReadonlyArray<DiscoveryStep> }> {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const findOnPathFn = deps.findOnPathImpl ?? findOnPath;
  const trace: DiscoveryStep[] = [];

  const override = env.CLAUDE_CLI_PATH;
  if (override) {
    const exists = await isAccessible(override);
    trace.push({
      source: 'env',
      path: override,
      exists,
      note: exists
        ? 'CLAUDE_CLI_PATH set + file accessible - using this'
        : 'CLAUDE_CLI_PATH set but file does not exist (typo? did you restart the backend after setting it?)',
    });
    if (exists) return { binary: override, trace };
  } else {
    trace.push({
      source: 'env',
      path: '(CLAUDE_CLI_PATH not set)',
      exists: false,
      note: 'no override',
    });
  }

  const fromPath = await findOnPathFn(platform);
  if (fromPath) {
    const exists = await isAccessible(fromPath);
    trace.push({
      source: 'path',
      path: fromPath,
      exists,
      note: exists ? 'found on PATH via where/which' : 'where/which returned path but file does not exist',
    });
    if (exists) return { binary: fromPath, trace };
  } else {
    trace.push({
      source: 'path',
      path: '(not on PATH)',
      exists: false,
      note: 'where.exe claude returned nothing',
    });
  }

  const candidates = knownLocations(platform, env);
  for (const candidate of candidates) {
    const exists = await isAccessible(candidate);
    trace.push({ source: 'fallback', path: candidate, exists });
    if (exists) return { binary: candidate, trace };
  }

  return { binary: null, trace };
}

async function isAccessible(p: string): Promise<boolean> {
  try {
    const stat = await fsp.stat(p);
    return stat.isFile();
  } catch {
    return false;
  }
}

function knownLocations(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  const home = env.USERPROFILE ?? env.HOME ?? os.homedir();
  if (platform === 'win32') {
    const appData = env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
    const localAppData = env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');
    const programFiles = env['PROGRAMFILES'] ?? 'C:\\Program Files';
    const programFilesX86 = env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)';
    return [
      // npm-global install (the most common install method).
      path.join(appData, 'npm', 'claude.cmd'),
      path.join(appData, 'npm', 'claude.exe'),
      path.join(appData, 'npm', 'claude'),
      // The `claude` migrate-installer's default location.
      path.join(home, '.claude', 'local', 'claude.cmd'),
      path.join(home, '.claude', 'local', 'claude.exe'),
      path.join(home, '.claude', 'local', 'claude'),
      // Anthropic's native GUI installer - paths vary by version.
      path.join(localAppData, 'Programs', 'claude', 'claude.exe'),
      path.join(localAppData, 'AnthropicClaude', 'claude.exe'),
      path.join(localAppData, 'Anthropic', 'Claude', 'claude.exe'),
      path.join(localAppData, 'anthropic-claude', 'claude.exe'),
      path.join(localAppData, 'Programs', 'AnthropicClaude', 'claude.exe'),
      // System-wide installers.
      path.join(programFiles, 'Anthropic', 'Claude', 'claude.exe'),
      path.join(programFilesX86, 'Anthropic', 'Claude', 'claude.exe'),
      // Scoop / Chocolatey shims (if anyone ships claude that way).
      path.join(home, 'scoop', 'shims', 'claude.exe'),
    ];
  }
  return [
    path.join(home, '.claude', 'local', 'claude'),
    path.join(home, '.local', 'bin', 'claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
  ];
}

async function findOnPath(platform: NodeJS.Platform): Promise<string | null> {
  return new Promise((resolve) => {
    const probe = platform === 'win32' ? 'where' : 'which';
    const child = spawn(probe, ['claude'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '';
    child.stdout?.on('data', (b: Buffer) => {
      out += b.toString('utf8');
    });
    child.on('error', () => resolve(null));
    child.on('exit', (code) => {
      if (code !== 0) return resolve(null);
      const first = out
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l.length > 0);
      resolve(first ?? null);
    });
  });
}
