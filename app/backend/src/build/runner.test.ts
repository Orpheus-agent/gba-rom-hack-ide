import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseCommand, runCommand } from './runner.js';

describe('parseCommand', () => {
  it('splits on whitespace', () => {
    expect(parseCommand('make')).toEqual(['make']);
    expect(parseCommand('make modern')).toEqual(['make', 'modern']);
    expect(parseCommand('flips --apply patch.ips base.gba out.gba')).toEqual([
      'flips',
      '--apply',
      'patch.ips',
      'base.gba',
      'out.gba',
    ]);
  });

  it('collapses repeated whitespace', () => {
    expect(parseCommand('  make   modern  ')).toEqual(['make', 'modern']);
  });

  it('returns empty array for an empty string', () => {
    expect(parseCommand('')).toEqual([]);
    expect(parseCommand('   ')).toEqual([]);
  });
});

describe('runCommand', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'rom-editor-runner-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('invokes a real process and captures stdout + exit code 0 on success', async () => {
    // Use `node -e 'console.log("hi")'` - node is always available in this build.
    const result = await runCommand(`${process.execPath} -e console.log("hi-from-runner")`, {
      cwd: dir,
      argvOverride: [process.execPath, '-e', 'console.log("hi-from-runner")'],
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('hi-from-runner');
    expect(result.spawnError).toBeNull();
    expect(result.timedOut).toBe(false);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('captures stderr and a non-zero exit code on failure', async () => {
    const result = await runCommand(`${process.execPath} -e process.exit(7)`, {
      cwd: dir,
      argvOverride: [process.execPath, '-e', 'console.error("oops");process.exit(7)'],
    });
    expect(result.exitCode).toBe(7);
    expect(result.stderr).toContain('oops');
  });

  it('reports spawn failure when the command does not exist (platform-agnostic)', async () => {
    const result = await runCommand('definitely-not-a-real-binary-12345', {
      cwd: dir,
    });
    // POSIX surfaces this via the 'error' event (spawnError set, exitCode null).
    // Windows can surface it via 'close' with a negative libuv-style exit code.
    // Either form is honest evidence that the binary failed to launch.
    const spawnFailed =
      result.spawnError !== null ||
      (result.exitCode !== null && result.exitCode < 0);
    expect(spawnFailed).toBe(true);
  });

  it('returns an empty-command result without spawning when given a blank command', async () => {
    const result = await runCommand('', { cwd: dir });
    expect(result.spawnError).toBe('empty command');
    expect(result.exitCode).toBeNull();
  });

  it('kills a long-running process after the timeout and reports timedOut', async () => {
    const result = await runCommand(
      `${process.execPath} -e while(true){}`,
      {
        cwd: dir,
        argvOverride: [process.execPath, '-e', 'setInterval(()=>{},1000)'],
        timeoutMs: 250,
      },
    );
    expect(result.timedOut).toBe(true);
    // Exit code or signal will reflect the kill - both indicate non-clean exit.
    expect(result.exitCode === null || result.exitCode !== 0 || result.signal !== null).toBe(true);
  });
});
