import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KNOWN_CORPUS_CLASSES, walkCorpus } from './walker.js';

async function makeFile(p: string, bytes: number): Promise<void> {
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.writeFile(p, Buffer.alloc(bytes));
}

describe('walkCorpus', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'engine-walker-'));
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns empty entries when root does not exist', async () => {
    const r = await walkCorpus({ rootDir: path.join(tmpDir, 'does-not-exist') });
    expect(r.entries).toEqual([]);
    expect(r.suppliedClasses).toEqual([]);
    expect(r.missingKnownClasses).toEqual([...KNOWN_CORPUS_CLASSES]);
  });

  it('returns empty entries when root exists but has no ROMs', async () => {
    const r = await walkCorpus({ rootDir: tmpDir });
    expect(r.entries).toEqual([]);
    expect(r.missingKnownClasses).toEqual([...KNOWN_CORPUS_CLASSES]);
  });

  it('classifies ROMs by immediate child-of-root directory name', async () => {
    await makeFile(path.join(tmpDir, 'vanilla', 'firered.gba'), 1024);
    await makeFile(path.join(tmpDir, 'heavyHack', 'unbound.gba'), 1024);
    const r = await walkCorpus({ rootDir: tmpDir });
    expect(r.entries).toHaveLength(2);
    const byBase = Object.fromEntries(r.entries.map((e) => [e.basename, e]));
    expect(byBase['firered.gba']?.corpusClass).toBe('vanilla');
    expect(byBase['firered.gba']?.classRecognized).toBe(true);
    expect(byBase['unbound.gba']?.corpusClass).toBe('heavyHack');
    expect(byBase['unbound.gba']?.classRecognized).toBe(true);
  });

  it('reports suppliedClasses sorted, missingKnownClasses for the rest', async () => {
    await makeFile(path.join(tmpDir, 'vanilla', 'a.gba'), 1024);
    await makeFile(path.join(tmpDir, 'decomp', 'b.gba'), 1024);
    const r = await walkCorpus({ rootDir: tmpDir });
    expect(r.suppliedClasses).toEqual(['decomp', 'vanilla']);
    expect(r.missingKnownClasses).toEqual(['heavyHack', 'cfru', 'customFork']);
  });

  it('marks files in unrecognized class dirs with classRecognized=false', async () => {
    await makeFile(path.join(tmpDir, 'experimental', 'x.gba'), 1024);
    const r = await walkCorpus({ rootDir: tmpDir });
    expect(r.entries[0]?.corpusClass).toBe('experimental');
    expect(r.entries[0]?.classRecognized).toBe(false);
  });

  it('marks files directly in /corpus/ (no class subdir) with corpusClass=null', async () => {
    await makeFile(path.join(tmpDir, 'orphan.gba'), 1024);
    const r = await walkCorpus({ rootDir: tmpDir });
    expect(r.entries[0]?.corpusClass).toBeNull();
  });

  it('recurses into subdirectories under a class dir', async () => {
    await makeFile(path.join(tmpDir, 'vanilla', 'sub', 'deep.gba'), 1024);
    const r = await walkCorpus({ rootDir: tmpDir });
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]?.corpusClass).toBe('vanilla');
  });

  it('skips non-ROM files by default extension filter', async () => {
    await makeFile(path.join(tmpDir, 'vanilla', 'a.gba'), 1024);
    await makeFile(path.join(tmpDir, 'vanilla', 'readme.txt'), 100);
    const r = await walkCorpus({ rootDir: tmpDir });
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]?.basename).toBe('a.gba');
  });

  it('honors an explicit extensions set', async () => {
    await makeFile(path.join(tmpDir, 'vanilla', 'a.zip'), 1024);
    const r = await walkCorpus({ rootDir: tmpDir, extensions: new Set(['.zip']) });
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]?.basename).toBe('a.zip');
  });

  it('returns absolute paths and sorts entries deterministically', async () => {
    await makeFile(path.join(tmpDir, 'vanilla', 'b.gba'), 1024);
    await makeFile(path.join(tmpDir, 'vanilla', 'a.gba'), 1024);
    const r = await walkCorpus({ rootDir: tmpDir });
    expect(r.entries[0]?.basename).toBe('a.gba');
    expect(r.entries[1]?.basename).toBe('b.gba');
    expect(path.isAbsolute(r.entries[0]?.path ?? '')).toBe(true);
  });
});
