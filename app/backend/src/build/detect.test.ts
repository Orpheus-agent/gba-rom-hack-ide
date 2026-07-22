import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { detectBuildProfile } from './detect.js';

describe('detectBuildProfile', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'rom-editor-build-detect-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('detects agbcc+make profile for a pokeemerald-shape tree', async () => {
    writeFileSync(path.join(dir, 'Makefile'), 'all:\n\techo build\n');
    writeFileSync(path.join(dir, 'pokeemerald.ld'), '/* linker */\n');
    mkdirSync(path.join(dir, 'tools', 'agbcc'), { recursive: true });
    const p = await detectBuildProfile(dir);
    expect(p).not.toBeNull();
    expect(p?.toolchain).toBe('agbcc+make');
    expect(p?.buildCommand).toBe('make');
    expect(p?.outputPaths).toEqual(['pokeemerald.gba', 'pokeemerald.elf']);
  });

  it('detects devkitARM+make profile when only devkitARM is present', async () => {
    writeFileSync(path.join(dir, 'Makefile'), 'all:\n');
    mkdirSync(path.join(dir, 'tools', 'devkitARM'), { recursive: true });
    const p = await detectBuildProfile(dir);
    expect(p?.toolchain).toBe('devkitARM+make');
  });

  it('falls back to plain make profile for a bare Makefile', async () => {
    writeFileSync(path.join(dir, 'Makefile'), 'all:\n');
    const p = await detectBuildProfile(dir);
    expect(p?.toolchain).toBe('make');
    expect(p?.buildCommand).toBe('make');
    expect(p?.outputPaths).toEqual(['*.gba']);
  });

  it('detects pokefirered.ld and uses pokefirered outputs', async () => {
    writeFileSync(path.join(dir, 'Makefile'), 'all:\n');
    writeFileSync(path.join(dir, 'pokefirered.ld'), '/* linker */\n');
    const p = await detectBuildProfile(dir);
    expect(p?.outputPaths).toEqual(['pokefirered.gba', 'pokefirered.elf']);
  });

  it('detects a `compare` target and surfaces it as testCommand', async () => {
    writeFileSync(
      path.join(dir, 'Makefile'),
      'all:\n\techo build\n\ncompare: all\n\techo compare\n',
    );
    const p = await detectBuildProfile(dir);
    expect(p?.testCommand).toBe('make compare');
  });

  it('detects a flips patch pipeline when .ips + .gba are present in the root', async () => {
    writeFileSync(path.join(dir, 'rom_hack.ips'), 'patch');
    writeFileSync(path.join(dir, 'base.gba'), 'rom');
    const p = await detectBuildProfile(dir);
    expect(p?.toolchain).toBe('flips');
    expect(p?.buildCommand).toContain('flips --apply rom_hack.ips base.gba');
    expect(p?.outputPaths[0]).toMatch(/\.patched\.gba$/);
  });

  it('detects patches in a patches/ subdirectory', async () => {
    mkdirSync(path.join(dir, 'patches'), { recursive: true });
    writeFileSync(path.join(dir, 'patches', 'mod.ips'), 'patch');
    writeFileSync(path.join(dir, 'base.gba'), 'rom');
    const p = await detectBuildProfile(dir);
    expect(p?.toolchain).toBe('flips');
    expect(p?.buildCommand).toContain('patches/mod.ips');
  });

  it('returns null when neither a Makefile nor a patch+ROM pair is present', async () => {
    const p = await detectBuildProfile(dir);
    expect(p).toBeNull();
  });
});
