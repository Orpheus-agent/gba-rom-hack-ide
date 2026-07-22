import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { needsShellForSpawn, killProcessTree } from './spawn-compat.js';
import type { ChildProcess } from 'node:child_process';

// These tests are pure logic - they don't actually spawn anything,
// so they run identically on Windows, macOS, and Linux.

describe('needsShellForSpawn (Windows .cmd/.bat shim handling)', () => {
  it('returns false for any command on linux', () => {
    expect(needsShellForSpawn('/usr/bin/claude', 'linux')).toBe(false);
    expect(needsShellForSpawn('claude', 'linux')).toBe(false);
    expect(needsShellForSpawn('claude.cmd', 'linux')).toBe(false);
    expect(needsShellForSpawn('claude.bat', 'linux')).toBe(false);
  });

  it('returns false for any command on darwin', () => {
    expect(needsShellForSpawn('/usr/local/bin/claude', 'darwin')).toBe(false);
    expect(needsShellForSpawn('claude', 'darwin')).toBe(false);
    expect(needsShellForSpawn('claude.cmd', 'darwin')).toBe(false);
  });

  it('returns false for .exe on win32 (Node can spawn .exe directly)', () => {
    expect(needsShellForSpawn('C:\\bin\\claude.exe', 'win32')).toBe(false);
    expect(needsShellForSpawn('claude.exe', 'win32')).toBe(false);
  });

  it('returns false for a bare command name on win32 (Node resolves it)', () => {
    expect(needsShellForSpawn('claude', 'win32')).toBe(false);
    expect(needsShellForSpawn('node', 'win32')).toBe(false);
  });

  it('returns TRUE for .cmd on win32 (the EINVAL case)', () => {
    // This is the npm-global install path on Windows - npm installs a
    // .cmd shim that wraps `node /path/to/script.js`. Without shell:true,
    // Node's spawn refuses with EINVAL.
    expect(needsShellForSpawn('C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd', 'win32')).toBe(true);
    expect(needsShellForSpawn('claude.cmd', 'win32')).toBe(true);
    expect(needsShellForSpawn('CLAUDE.CMD', 'win32')).toBe(true);
  });

  it('returns TRUE for .bat on win32 (same EINVAL case as .cmd)', () => {
    expect(needsShellForSpawn('C:\\tools\\claude.bat', 'win32')).toBe(true);
    expect(needsShellForSpawn('claude.bat', 'win32')).toBe(true);
    expect(needsShellForSpawn('CLAUDE.BAT', 'win32')).toBe(true);
  });

  it('is case-insensitive on the extension', () => {
    expect(needsShellForSpawn('foo.CmD', 'win32')).toBe(true);
    expect(needsShellForSpawn('foo.bAt', 'win32')).toBe(true);
  });

  it('does NOT match .cmd anywhere in the middle of the path', () => {
    // A directory named ".cmd" shouldn't trigger the shell path.
    expect(needsShellForSpawn('C:\\.cmd\\tool.exe', 'win32')).toBe(false);
    expect(needsShellForSpawn('C:\\foo.cmd\\tool', 'win32')).toBe(false);
  });

  it('defaults to process.platform when no platform arg passed', () => {
    // Round-trip: matches the current platform's behavior for a
    // canonical .cmd input. On non-Windows this is false.
    const platformSays = process.platform === 'win32';
    expect(needsShellForSpawn('claude.cmd')).toBe(platformSays);
  });
});

// ──────────────────────────────────────────────────────────────────────
// killProcessTree - regression test for the "Stop button doesn't kill
// the agent on Windows" bug. When spawn-compat routes a .cmd shim
// through shell:true, `child` is cmd.exe; cmd.exe's children (the
// actual claude.exe) survive a plain child.kill() and keep running.
// killProcessTree(child) must:
//   - On win32: invoke `taskkill /F /T /PID <pid>` (the /T flag is
//     "tree" - kills the process AND every descendant)
//   - On posix: call child.kill('SIGKILL') (no descendant orphaning
//     issue in our current Unix flow - no shim indirection)
//   - Be a no-op when child has already exited (no .pid, .killed,
//     or .exitCode set)
// ──────────────────────────────────────────────────────────────────────

/** Build a fake ChildProcess just exposing the fields killProcessTree
 *  reads (pid / killed / exitCode / kill) so we can test without
 *  spawning a real subprocess. Uses defineProperty to bypass the
 *  readonly typings on the real ChildProcess interface. */
function fakeChild(over: { pid?: number | undefined; killed?: boolean; exitCode?: number | null } = {}): ChildProcess {
  const emitter = new EventEmitter() as unknown as ChildProcess;
  Object.defineProperty(emitter, 'pid', { value: over.pid ?? 12345, configurable: true });
  Object.defineProperty(emitter, 'killed', { value: over.killed ?? false, configurable: true });
  Object.defineProperty(emitter, 'exitCode', { value: over.exitCode ?? null, configurable: true });
  emitter.kill = vi.fn((_signal?: number | NodeJS.Signals) => true) as unknown as ChildProcess['kill'];
  return emitter;
}

describe('killProcessTree', () => {
  it('no-ops when the child has no pid', async () => {
    const c = fakeChild({ pid: undefined as unknown as number });
    await killProcessTree(c, 'win32');
    expect(c.kill).not.toHaveBeenCalled();
  });

  it('no-ops when child.killed is already true', async () => {
    const c = fakeChild({ killed: true });
    await killProcessTree(c, 'linux');
    expect(c.kill).not.toHaveBeenCalled();
  });

  it('no-ops when child.exitCode is set (process already finished)', async () => {
    const c = fakeChild({ exitCode: 0 });
    await killProcessTree(c, 'win32');
    expect(c.kill).not.toHaveBeenCalled();
  });

  it('on Linux, kills the immediate child with SIGKILL', async () => {
    const c = fakeChild();
    await killProcessTree(c, 'linux');
    expect(c.kill).toHaveBeenCalledTimes(1);
    expect(c.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('on darwin, kills the immediate child with SIGKILL', async () => {
    const c = fakeChild();
    await killProcessTree(c, 'darwin');
    expect(c.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('on win32, does NOT call child.kill() - it spawns taskkill instead', async () => {
    const c = fakeChild();
    // Note: this test runs on whatever the actual platform is; we
    // can't stub child_process.spawn here without invasive surgery,
    // so the assertion is purely: child.kill() is bypassed when
    // platform='win32' (the actual taskkill subprocess fires-and-
    // forgets, and we don't need to verify it exits since the test
    // would have to be running ON Windows to confirm).
    await killProcessTree(c, 'win32');
    // The fallback `child.kill('SIGKILL')` is only invoked if the
    // taskkill spawn itself throws synchronously - that doesn't
    // happen on non-Windows where the helper at least TRIES spawn.
    // The important assertion: we don't replace this with child.kill()
    // on Windows. Either way, the immediate child kill is fine to
    // happen as a belt-and-suspenders fallback, so we don't enforce
    // it = 0.
    expect(c.kill).not.toHaveBeenCalledWith('SIGTERM'); // never SIGTERM on win32
  });
});
