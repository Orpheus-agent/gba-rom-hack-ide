import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ROM_MAX_BYTES,
  ROM_MIN_BYTES,
  RomLoadError,
  loadRomFromBytes,
  loadRomFromPath,
} from './loader.js';

describe('loadRomFromBytes', () => {
  it('accepts a buffer at the min size and computes sha1', () => {
    const bytes = Buffer.alloc(ROM_MIN_BYTES);
    const r = loadRomFromBytes({ bytes });
    expect(r.byteLength).toBe(ROM_MIN_BYTES);
    expect(r.sha1).toMatch(/^[0-9a-f]{40}$/);
    expect(r.synthetic).toBe(false);
    expect(r.sourcePath).toBeNull();
    expect(r.corpusClass).toBeNull();
  });

  it('rejects under-min buffers with kind=too_small', () => {
    expect(() => loadRomFromBytes({ bytes: Buffer.alloc(ROM_MIN_BYTES - 1) })).toThrow(RomLoadError);
    try {
      loadRomFromBytes({ bytes: Buffer.alloc(ROM_MIN_BYTES - 1) });
    } catch (e) {
      const err = e as RomLoadError;
      expect(err.failure.kind).toBe('too_small');
    }
  });

  it('rejects over-max buffers with kind=too_large', () => {
    // Allocate just one byte past the 32 MiB cap. ~32 MiB of heap during a
    // single test on a modern dev box is fine; the test runner releases it
    // immediately after the throw.
    const bytes = Buffer.alloc(ROM_MAX_BYTES + 1);
    expect(() => loadRomFromBytes({ bytes })).toThrow(RomLoadError);
    try {
      loadRomFromBytes({ bytes });
    } catch (e) {
      const err = e as RomLoadError;
      expect(err.failure.kind).toBe('too_large');
    }
  });

  it('passes through synthetic + corpusClass markers', () => {
    const bytes = Buffer.alloc(ROM_MIN_BYTES);
    const r = loadRomFromBytes({
      bytes,
      sourcePath: 'synthetic://test',
      corpusClass: 'vanilla',
      synthetic: true,
    });
    expect(r.synthetic).toBe(true);
    expect(r.corpusClass).toBe('vanilla');
    expect(r.sourcePath).toBe('synthetic://test');
  });

  it('produces the same sha1 for identical bytes', () => {
    const a = loadRomFromBytes({ bytes: Buffer.alloc(ROM_MIN_BYTES, 0x42) });
    const b = loadRomFromBytes({ bytes: Buffer.alloc(ROM_MIN_BYTES, 0x42) });
    expect(a.sha1).toBe(b.sha1);
  });

  it('produces different sha1 for different bytes', () => {
    const a = loadRomFromBytes({ bytes: Buffer.alloc(ROM_MIN_BYTES, 0x00) });
    const b = loadRomFromBytes({ bytes: Buffer.alloc(ROM_MIN_BYTES, 0xff) });
    expect(a.sha1).not.toBe(b.sha1);
  });

  it('freezes the returned RomImage', () => {
    const r = loadRomFromBytes({ bytes: Buffer.alloc(ROM_MIN_BYTES) });
    expect(Object.isFrozen(r)).toBe(true);
  });
});

describe('loadRomFromPath', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'engine-loader-'));
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it('loads a file and computes sha1 over its bytes', async () => {
    const filePath = path.join(tmpDir, 'test.gba');
    const bytes = Buffer.alloc(ROM_MIN_BYTES, 0x42);
    await fsp.writeFile(filePath, bytes);
    const r = await loadRomFromPath({ filePath });
    expect(r.byteLength).toBe(ROM_MIN_BYTES);
    expect(r.sourcePath).toBe(path.resolve(filePath));
    expect(r.sha1).toMatch(/^[0-9a-f]{40}$/);
  });

  it('throws file_not_found for missing paths', async () => {
    const filePath = path.join(tmpDir, 'no-such-file.gba');
    await expect(loadRomFromPath({ filePath })).rejects.toMatchObject({
      name: 'RomLoadError',
      failure: { kind: 'file_not_found' },
    });
  });

  it('throws too_small for tiny files', async () => {
    const filePath = path.join(tmpDir, 'tiny.gba');
    await fsp.writeFile(filePath, Buffer.alloc(10));
    await expect(loadRomFromPath({ filePath })).rejects.toMatchObject({
      failure: { kind: 'too_small' },
    });
  });

  it('records corpusClass when supplied', async () => {
    const filePath = path.join(tmpDir, 'v.gba');
    await fsp.writeFile(filePath, Buffer.alloc(ROM_MIN_BYTES));
    const r = await loadRomFromPath({ filePath, corpusClass: 'vanilla' });
    expect(r.corpusClass).toBe('vanilla');
  });
});
