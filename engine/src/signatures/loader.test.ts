import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SignatureDbLoadError, loadSignatureDb } from './loader.js';

async function writeJson(p: string, value: unknown): Promise<void> {
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.writeFile(p, JSON.stringify(value, null, 2), 'utf8');
}

describe('loadSignatureDb', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'engine-sigdb-'));
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns an empty DB when the directory is empty', async () => {
    const db = await loadSignatureDb({ signaturesDir: tmpDir });
    expect(db.allEntries).toEqual([]);
    expect(db.byGameCode.size).toBe(0);
    expect(db.bySha1.size).toBe(0);
    expect(db.bySizeBytes.size).toBe(0);
    expect(db.markerEntries).toEqual([]);
    expect(db.loadedFiles).toEqual([]);
    expect(db.fileErrors).toEqual([]);
  });

  it('returns an empty DB when the directory does not exist', async () => {
    const db = await loadSignatureDb({ signaturesDir: path.join(tmpDir, 'no-such-dir') });
    expect(db.allEntries).toEqual([]);
  });

  it('loads a valid signature file and indexes by gameCode', async () => {
    await writeJson(path.join(tmpDir, 'gen3.json'), {
      schemaVersion: 1,
      entries: [
        {
          id: 'firered-family',
          displayName: 'Pokémon FireRed (BPRE) family',
          family: 'firered',
          kind: 'vanilla',
          gameCodes: ['BPRE'],
          sources: ['https://example.test/gbatek'],
          confidenceWhenMatched: 0.85,
        },
      ],
    });
    const db = await loadSignatureDb({ signaturesDir: tmpDir });
    expect(db.allEntries).toHaveLength(1);
    expect(db.byGameCode.get('BPRE')).toHaveLength(1);
    expect(db.byGameCode.get('BPRE')?.[0]?.family).toBe('firered');
  });

  it('indexes by sha1 (lowercased) and sizeBytes', async () => {
    await writeJson(path.join(tmpDir, 'a.json'), {
      schemaVersion: 1,
      entries: [
        {
          id: 'with-hash',
          displayName: 'Hashed entry',
          family: 'x',
          kind: 'vanilla',
          gameCodes: ['BPRE'],
          sha1: ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
          sizeBytes: [16777216],
          sources: ['https://example.test'],
          confidenceWhenMatched: 0.95,
        },
      ],
    });
    const db = await loadSignatureDb({ signaturesDir: tmpDir });
    expect(db.bySha1.get('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toHaveLength(1);
    expect(db.bySizeBytes.get(16777216)).toHaveLength(1);
  });

  it('throws SignatureDbLoadError in strict mode on malformed entries', async () => {
    await writeJson(path.join(tmpDir, 'bad.json'), {
      schemaVersion: 1,
      entries: [
        {
          id: 'X', // too short (min 3 chars per schema)
          displayName: 'invalid',
          family: 'x',
          kind: 'vanilla',
          gameCodes: ['BPRE'],
          sources: ['https://example.test'],
          confidenceWhenMatched: 0.5,
        },
      ],
    });
    await expect(loadSignatureDb({ signaturesDir: tmpDir })).rejects.toBeInstanceOf(
      SignatureDbLoadError,
    );
  });

  it('non-strict mode returns valid entries + collects errors', async () => {
    await writeJson(path.join(tmpDir, 'good.json'), {
      schemaVersion: 1,
      entries: [
        {
          id: 'good-entry',
          displayName: 'OK',
          family: 'x',
          kind: 'vanilla',
          gameCodes: ['BPRE'],
          sources: ['https://example.test'],
          confidenceWhenMatched: 0.5,
        },
      ],
    });
    await writeJson(path.join(tmpDir, 'bad.json'), {
      schemaVersion: 1,
      entries: [
        {
          id: 'no-signal-entry',
          displayName: 'No signal',
          family: 'x',
          kind: 'vanilla',
          // Neither gameCodes, sha1, nor sizeBytes+buildMarkers - fails cross-cond.
          sources: ['https://example.test'],
          confidenceWhenMatched: 0.5,
        },
      ],
    });
    const db = await loadSignatureDb({ signaturesDir: tmpDir, strict: false });
    expect(db.allEntries.map((e) => e.id)).toEqual(['good-entry']);
    expect(db.fileErrors.length).toBeGreaterThanOrEqual(1);
    expect(db.fileErrors.some((fe) => fe.errors.some((e) => e.includes('no-signal-entry')))).toBe(
      true,
    );
  });

  it('refuses duplicate entry ids across files', async () => {
    await writeJson(path.join(tmpDir, 'a.json'), {
      schemaVersion: 1,
      entries: [
        {
          id: 'shared-id',
          displayName: 'A',
          family: 'x',
          kind: 'vanilla',
          gameCodes: ['BPRE'],
          sources: ['https://example.test'],
          confidenceWhenMatched: 0.5,
        },
      ],
    });
    await writeJson(path.join(tmpDir, 'b.json'), {
      schemaVersion: 1,
      entries: [
        {
          id: 'shared-id',
          displayName: 'B',
          family: 'y',
          kind: 'fork',
          gameCodes: ['BPRE'],
          sources: ['https://example.test'],
          confidenceWhenMatched: 0.5,
        },
      ],
    });
    const db = await loadSignatureDb({ signaturesDir: tmpDir, strict: false });
    expect(db.allEntries).toHaveLength(1); // one accepted, one rejected
    expect(db.fileErrors.some((fe) => fe.errors.some((e) => e.includes('duplicate id')))).toBe(true);
  });

  it('catches JSON parse errors', async () => {
    await fsp.writeFile(path.join(tmpDir, 'broken.json'), '{ this is not JSON', 'utf8');
    const db = await loadSignatureDb({ signaturesDir: tmpDir, strict: false });
    expect(db.fileErrors).toHaveLength(1);
    expect(db.fileErrors[0]?.errors[0]).toContain('parse JSON');
  });

  it('rejects an entry that fails the JSON Schema (e.g. bad gameCode)', async () => {
    await writeJson(path.join(tmpDir, 'bad.json'), {
      schemaVersion: 1,
      entries: [
        {
          id: 'lowercase-code',
          displayName: 'A',
          family: 'x',
          kind: 'vanilla',
          gameCodes: ['bpre'], // lowercase fails the [A-Z0-9]{4} pattern
          sources: ['https://example.test'],
          confidenceWhenMatched: 0.5,
        },
      ],
    });
    const db = await loadSignatureDb({ signaturesDir: tmpDir, strict: false });
    expect(db.allEntries).toHaveLength(0);
  });

  it('freezes loaded entries (immutable from caller perspective)', async () => {
    await writeJson(path.join(tmpDir, 'a.json'), {
      schemaVersion: 1,
      entries: [
        {
          id: 'firered-family',
          displayName: 'Pokémon FireRed (BPRE) family',
          family: 'firered',
          kind: 'vanilla',
          gameCodes: ['BPRE'],
          sources: ['https://example.test'],
          confidenceWhenMatched: 0.85,
        },
      ],
    });
    const db = await loadSignatureDb({ signaturesDir: tmpDir });
    expect(Object.isFrozen(db)).toBe(true);
    expect(Object.isFrozen(db.allEntries[0])).toBe(true);
  });

  it('loads the in-repo /signatures/ seed and indexes all 5 Gen-3 families', async () => {
    const seedDir = path.join(
      path.dirname(new URL(import.meta.url).pathname),
      '..',
      '..',
      '..',
      'signatures',
    );
    // Skip if the seed dir doesn't exist (e.g. running from a temp work tree).
    let exists = false;
    try {
      const s = await fsp.stat(seedDir);
      exists = s.isDirectory();
    } catch {
      exists = false;
    }
    if (!exists) return;
    const db = await loadSignatureDb({ signaturesDir: seedDir });
    expect(db.byGameCode.get('BPRE')).toBeDefined();
    expect(db.byGameCode.get('BPGE')).toBeDefined();
    expect(db.byGameCode.get('BPEE')).toBeDefined();
    expect(db.byGameCode.get('AXVE')).toBeDefined();
    expect(db.byGameCode.get('AXPE')).toBeDefined();
  });
});
