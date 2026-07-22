import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { probeBuildArtifacts } from './build-artifacts.js';

describe('probeBuildArtifacts', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(path.join(tmpdir(), 'rom-editor-artifacts-'));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('returns empty array when no outputPaths are provided', async () => {
    const r = await probeBuildArtifacts(projectRoot, []);
    expect(r).toEqual([]);
  });

  it('reports a missing artifact with exists=false / null size + mtime', async () => {
    const r = await probeBuildArtifacts(projectRoot, ['pokeemerald.gba']);
    expect(r).toHaveLength(1);
    expect(r[0]?.relativePath).toBe('pokeemerald.gba');
    expect(r[0]?.exists).toBe(false);
    expect(r[0]?.sizeBytes).toBeNull();
    expect(r[0]?.mtimeUtc).toBeNull();
    expect(r[0]?.isPatchFormat).toBe(false);
  });

  it('reports a real on-disk file with correct size + ISO mtime', async () => {
    const contents = Buffer.from('R'.repeat(1234));
    writeFileSync(path.join(projectRoot, 'pokeemerald.gba'), contents);
    const r = await probeBuildArtifacts(projectRoot, ['pokeemerald.gba']);
    expect(r[0]?.exists).toBe(true);
    expect(r[0]?.sizeBytes).toBe(1234);
    expect(r[0]?.mtimeUtc).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('detects patch-format extensions (.ips / .bps / .ups) regardless of presence', async () => {
    const r = await probeBuildArtifacts(projectRoot, [
      'patches/my-mod.ips',
      'patches/my-mod.bps',
      'patches/my-mod.ups',
      'pokeemerald.gba',
    ]);
    expect(r[0]?.isPatchFormat).toBe(true);
    expect(r[1]?.isPatchFormat).toBe(true);
    expect(r[2]?.isPatchFormat).toBe(true);
    expect(r[3]?.isPatchFormat).toBe(false);
  });

  it('handles a mix of existing + missing files in a single call', async () => {
    writeFileSync(path.join(projectRoot, 'pokeemerald.gba'), Buffer.from('rom'));
    const r = await probeBuildArtifacts(projectRoot, ['pokeemerald.gba', 'pokefirered.gba']);
    expect(r[0]?.exists).toBe(true);
    expect(r[0]?.sizeBytes).toBe(3);
    expect(r[1]?.exists).toBe(false);
    expect(r[1]?.sizeBytes).toBeNull();
  });
});
