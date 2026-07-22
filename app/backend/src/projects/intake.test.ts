import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import { execSync } from 'node:child_process';
import { intakeFile, IntakeError } from './intake.js';

// We can't easily build a real .gba/.zip from scratch in pure Node without
// adding write-deps; for the rom case we just need a file with the `.gba`
// extension and arbitrary bytes (intake doesn't parse the header - the
// detector does). For the zip case we use Node's built-in `tar` is missing
// → we shell to PowerShell's Compress-Archive which is guaranteed-present
// on Windows. Tests skip the archive case off-Windows.

describe('intakeFile', () => {
  let workspace: string;
  let managedRoot: string;

  beforeEach(() => {
    workspace = mkdtempSync(path.join(tmpdir(), 'rom-editor-intake-'));
    managedRoot = path.join(workspace, 'managed');
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it('rejects a file that does not exist with file_not_found', async () => {
    try {
      await intakeFile(path.join(workspace, 'nope.gba'), { managedRootOverride: managedRoot });
      throw new Error('expected IntakeError');
    } catch (e) {
      expect(e).toBeInstanceOf(IntakeError);
      expect((e as IntakeError).code).toBe('file_not_found');
    }
  });

  it('rejects an unsupported file extension with unsupported_file_kind', async () => {
    const p = path.join(workspace, 'something.txt');
    writeFileSync(p, 'hello');
    try {
      await intakeFile(p, { managedRootOverride: managedRoot });
      throw new Error('expected IntakeError');
    } catch (e) {
      expect((e as IntakeError).code).toBe('unsupported_file_kind');
    }
  });

  it('intakes a .gba file: copies it + writes .editor/intake.json', async () => {
    const gba = path.join(workspace, 'FireRed.gba');
    writeFileSync(gba, Buffer.from('not-really-a-rom-but-thats-ok'));
    const r = await intakeFile(gba, { managedRootOverride: managedRoot });
    expect(r.intakeKind).toBe('rom');
    expect(r.sha1).toMatch(/^[0-9a-f]{40}$/);
    expect(r.managedProjectRoot).toBe(path.join(managedRoot, r.sha1));
    // The ROM was copied in.
    expect(existsSync(path.join(r.managedProjectRoot, 'FireRed.gba'))).toBe(true);
    // intake.json is shaped + valid.
    const meta = JSON.parse(
      readFileSync(path.join(r.managedProjectRoot, '.editor', 'intake.json'), 'utf-8'),
    );
    expect(meta.kind).toBe('rom');
    expect(meta.sha1).toBe(r.sha1);
    expect(meta.originalFileName).toBe('FireRed.gba');
    expect(meta.intakedAtUtc).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('re-intaking the same .gba lands in the same managed dir (SHA-1 stable)', async () => {
    const gba = path.join(workspace, 'FireRed.gba');
    writeFileSync(gba, Buffer.from('content-A'));
    const r1 = await intakeFile(gba, { managedRootOverride: managedRoot });
    const r2 = await intakeFile(gba, { managedRootOverride: managedRoot });
    expect(r1.sha1).toBe(r2.sha1);
    expect(r1.managedProjectRoot).toBe(r2.managedProjectRoot);
  });

  it('different .gba contents → different managed dirs', async () => {
    const a = path.join(workspace, 'a.gba');
    const b = path.join(workspace, 'b.gba');
    writeFileSync(a, Buffer.from('content-A'));
    writeFileSync(b, Buffer.from('content-B-different'));
    const r1 = await intakeFile(a, { managedRootOverride: managedRoot });
    const r2 = await intakeFile(b, { managedRootOverride: managedRoot });
    expect(r1.sha1).not.toBe(r2.sha1);
    expect(r1.managedProjectRoot).not.toBe(r2.managedProjectRoot);
  });

  it('intakes a .zip file: extracts entries + writes .editor/intake.json with count', async () => {
    if (process.platform !== 'win32') {
      // Building a .zip cleanly here requires PowerShell Compress-Archive;
      // skip on non-Windows runners.
      return;
    }
    // Build a small ZIP using PowerShell's Compress-Archive.
    const src = path.join(workspace, 'src');
    const a = path.join(src, 'file-a.txt');
    const subdir = path.join(src, 'sub');
    const b = path.join(subdir, 'file-b.txt');
    const zip = path.join(workspace, 'project.zip');
    execSync(`powershell -NoProfile -Command "New-Item -ItemType Directory -Path '${subdir}' -Force | Out-Null; Set-Content -Path '${a}' -Value 'AAA'; Set-Content -Path '${b}' -Value 'BBB'; Compress-Archive -Path '${src}\\*' -DestinationPath '${zip}' -Force"`);
    expect(existsSync(zip)).toBe(true);

    const r = await intakeFile(zip, { managedRootOverride: managedRoot });
    expect(r.intakeKind).toBe('archive');
    expect(r.extractedEntryCount).toBeGreaterThanOrEqual(2);
    expect(existsSync(path.join(r.managedProjectRoot, 'file-a.txt'))).toBe(true);
    expect(existsSync(path.join(r.managedProjectRoot, 'sub', 'file-b.txt'))).toBe(true);
    const meta = JSON.parse(
      readFileSync(path.join(r.managedProjectRoot, '.editor', 'intake.json'), 'utf-8'),
    );
    expect(meta.kind).toBe('archive');
    expect(meta.extractedEntryCount).toBe(r.extractedEntryCount);
  });
});
