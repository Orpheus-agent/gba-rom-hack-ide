import { describe, expect, it, vi } from 'vitest';
import { pickPath } from './file-picker.js';
import { EventEmitter } from 'node:events';

// We can't actually open a Windows dialog in a unit test - `spawn` is mocked
// so the tests cover the typed result shapes + non-Windows fallback.

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
}

function makeChild(): FakeChild {
  const c = new EventEmitter() as FakeChild;
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  return c;
}

// pickPath now writes a temp .ps1 file before calling spawn (so PowerShell
// can use -File for robust quoting). That means the mocked spawnFn isn't
// invoked synchronously - it's deferred behind an `await fsp.writeFile`.
// This helper polls until spawnFn has been called so emits land on the
// child after listeners are attached.
async function waitForSpawn(spawnFn: ReturnType<typeof vi.fn>): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (spawnFn.mock.calls.length > 0) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('spawnFn was not called within 1s');
}

describe('pickPath', () => {
  it('returns platform_not_supported on non-Windows without spawning', async () => {
    const spawnFn = vi.fn();
    const r = await pickPath('folder', { platform: 'linux', spawnFn: spawnFn as never });
    expect(r.error).toBe('platform_not_supported');
    expect(r.path).toBeNull();
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('resolves with the picked path when PowerShell exits 0 with stdout', async () => {
    const child = makeChild();
    const spawnFn = vi.fn().mockReturnValue(child);
    const promise = pickPath('rom-or-archive', { platform: 'win32', spawnFn: spawnFn as never });
    await waitForSpawn(spawnFn);
    child.stdout.emit('data', Buffer.from('C:\\path\\to\\FireRed.gba\n'));
    child.emit('exit', 0);
    const r = await promise;
    expect(r.error).toBeUndefined();
    expect(r.path).toBe('C:\\path\\to\\FireRed.gba');
    expect(r.kind).toBe('rom-or-archive');
  });

  it('returns path: null (no error) when PowerShell exits 0 with empty stdout (user cancelled)', async () => {
    const child = makeChild();
    const spawnFn = vi.fn().mockReturnValue(child);
    const promise = pickPath('folder', { platform: 'win32', spawnFn: spawnFn as never });
    await waitForSpawn(spawnFn);
    child.emit('exit', 0);
    const r = await promise;
    expect(r.error).toBeUndefined();
    expect(r.path).toBeNull();
  });

  it('returns picker_failed when PowerShell exits non-zero', async () => {
    const child = makeChild();
    const spawnFn = vi.fn().mockReturnValue(child);
    const promise = pickPath('folder', { platform: 'win32', spawnFn: spawnFn as never });
    await waitForSpawn(spawnFn);
    child.stderr.emit('data', Buffer.from('Add-Type : Could not load type\n'));
    child.emit('exit', 1);
    const r = await promise;
    expect(r.error).toBe('picker_failed');
    expect(r.message).toContain('Could not load type');
  });

  it('returns picker_failed when spawn itself errors (powershell not on PATH)', async () => {
    const child = makeChild();
    const spawnFn = vi.fn().mockReturnValue(child);
    const promise = pickPath('folder', { platform: 'win32', spawnFn: spawnFn as never });
    await waitForSpawn(spawnFn);
    child.emit('error', new Error('spawn powershell ENOENT'));
    const r = await promise;
    expect(r.error).toBe('picker_failed');
    expect(r.message).toContain('ENOENT');
  });

  it('uses -File <path> to invoke a temp .ps1 (not -Command) for robust quoting', async () => {
    const child = makeChild();
    const spawnFn = vi.fn().mockReturnValue(child);
    const promise = pickPath('rom-or-archive', { platform: 'win32', spawnFn: spawnFn as never });
    await waitForSpawn(spawnFn);
    child.emit('exit', 0);
    await promise;
    const callArgs = spawnFn.mock.calls[0]!;
    const args = callArgs[1] as string[];
    expect(args).toContain('-File');
    const filePathIdx = args.indexOf('-File');
    expect(args[filePathIdx + 1]).toMatch(/rom-editor-picker-[0-9a-f-]+\.ps1$/);
    expect(args).not.toContain('-Command');
  });
});
