/**
 * Cross-platform child_process.spawn wrapper that handles Windows
 * .cmd / .bat shims correctly.
 *
 * The bug this fixes: Node's `child_process.spawn` on Windows refuses
 * to execute .cmd / .bat files directly - it throws EINVAL. This is
 * a well-known Windows-only quirk (Linux/macOS don't have shim
 * indirection; on Windows every npm-globally-installed CLI is a
 * `<name>.cmd` batch shim that wraps a `node /path/to/script.js`).
 *
 * The agent panel reported "Failed to spawn claude: spawn EINVAL"
 * because binary-discovery.ts resolves `%APPDATA%/npm/claude.cmd`
 * (the npm-global install location, tried first per the discovery
 * order) and we passed that .cmd straight to `spawn()` without
 * shell:true.
 *
 * The fix mirrors what the `cross-spawn` npm package does (50M+
 * weekly downloads) but inlined here as a ~20-line helper to avoid
 * a new dep. For .cmd / .bat targets on Windows we set `shell: true`,
 * which routes the invocation through `cmd.exe /d /s /c <cmd> <args>`
 * and lets the OS resolve the batch shim. For .exe targets and on
 * Linux/macOS we use spawn() directly - no shell-injection surface
 * to widen.
 *
 * Shell-injection note: with shell:true, arguments are passed through
 * cmd.exe's parser. Args containing cmd metacharacters (`&`, `|`,
 * `^`, `>`, `<`, `%`) could be misinterpreted. The agent invocation
 * passes UUID session ids, file paths (with `:` and spaces - safe
 * for cmd quoting), and optionally a multi-line system prompt. None
 * of these are attacker-controlled (the user invokes us; we don't
 * accept external requests). The risk surface is the dev-mode system
 * prompt string - and dev mode is opt-in via a UI toggle the user
 * controls. Acceptable.
 */

import {
  spawn as nodeSpawn,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from 'node:child_process';

const WINDOWS_BATCH_SHIM_RE = /\.(cmd|bat)$/i;

/** Decide whether the given command needs `shell: true` to spawn
 *  correctly. True on Windows when the command ends in .cmd or .bat;
 *  false everywhere else.
 *
 *  Exposed as a pure function (separate from `spawnCompat`) so tests
 *  can exercise the decision logic per-platform without having to
 *  mock node:child_process or invoke a real subprocess. */
export function needsShellForSpawn(
  command: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === 'win32' && WINDOWS_BATCH_SHIM_RE.test(command);
}

/** Same signature as node:child_process.spawn, but on Windows .cmd /
 *  .bat targets get routed through cmd.exe via `shell: true`. */
export function spawnCompat(
  command: string,
  args: ReadonlyArray<string>,
  options: SpawnOptionsWithoutStdio = {},
): ChildProcessWithoutNullStreams {
  const needsShell = needsShellForSpawn(command);
  return nodeSpawn(command, args as string[], {
    ...options,
    ...(needsShell ? { shell: true } : {}),
  }) as ChildProcessWithoutNullStreams;
}

/** Re-export the spawn function type so call sites can take a
 *  `spawnFn?: typeof spawn` injection point + default to spawnCompat. */
export type SpawnFn = typeof nodeSpawn;

/**
 * Kill a child process AND every descendant it spawned. The plain
 * `child.kill()` is not sufficient when we routed through `shell: true`
 * to handle a .cmd/.bat shim - in that setup the `child` we hold is
 * `cmd.exe`, and `cmd.exe`'s OWN children (the .cmd shim's wrapped
 * node.exe / claude.exe) survive `cmd.exe`'s termination as orphaned
 * processes. The Stop button in the AgentPanel "doesn't work" because
 * cmd.exe dies but the real claude process keeps running, holding the
 * session lock and burning CPU.
 *
 * Implementation:
 *   - Windows: `taskkill /F /T /PID <pid>` - `/T` recurses to children,
 *     `/F` forces termination. Authoritative cross-process-tree kill.
 *   - POSIX: child.kill('SIGKILL'). If callers want true tree kills
 *     they should spawn with `{ detached: true }` + use
 *     `process.kill(-child.pid, 'SIGKILL')` themselves; we don't do
 *     that today because our Unix flow doesn't go through any shim.
 *
 * Returns a promise that resolves when the kill operation has been
 * issued (NOT when the children have actually exited - that's signalled
 * via the child's 'exit' event as usual).
 */
export async function killProcessTree(
  child: ChildProcess,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (!child.pid || child.killed || child.exitCode !== null) return;
  if (platform === 'win32') {
    // taskkill is reliable + ships with every Windows install. We
    // intentionally don't await its exit - it fires-and-forgets so
    // the Stop button feels instant. The child.kill() below is a
    // belt-and-suspenders in case taskkill failed silently.
    try {
      const tk = nodeSpawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], {
        stdio: 'ignore',
        windowsHide: true,
      });
      tk.on('error', () => {
        // taskkill not on PATH (rare - System32 is normally on every
        // PATH). Fall back to plain kill; orphaned children may persist
        // until manually killed via Task Manager.
        try {
          child.kill('SIGKILL');
        } catch {
          /* already dead */
        }
      });
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already dead */
      }
    }
  } else {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already dead */
    }
  }
}
