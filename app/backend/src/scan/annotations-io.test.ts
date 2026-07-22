import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  annotationsPathFor,
  readAnnotationsSidecar,
  writeAnnotationsSidecar,
} from './annotations-io.js';

describe('annotations-io', () => {
  let root: string;
  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(tmpdir(), 'annotations-io-'));
  });
  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  it('returns an empty side-car when the file does not exist', async () => {
    const sidecar = await readAnnotationsSidecar(root);
    expect(sidecar.schemaVersion).toBe(1);
    expect(sidecar.annotations).toEqual({});
  });

  it('write then read round-trips a single annotation', async () => {
    await writeAnnotationsSidecar(root, {
      'flag:FLAG_BADGE01_GET': {
        name: 'Got Boulder Badge',
        description: 'Player has beaten Pewter Gym',
      },
    });
    const sidecar = await readAnnotationsSidecar(root);
    expect(sidecar.annotations['flag:FLAG_BADGE01_GET']).toEqual({
      name: 'Got Boulder Badge',
      description: 'Player has beaten Pewter Gym',
    });
  });

  it('drops empty entries (no name AND no description) on write', async () => {
    await writeAnnotationsSidecar(root, {
      'flag:KEEP': { name: 'Keep me' },
      'flag:DROP1': {},
      'flag:DROP2': { name: '', description: '' },
      'flag:DROP3': { name: '   ' },
    });
    const sidecar = await readAnnotationsSidecar(root);
    expect(Object.keys(sidecar.annotations).sort()).toEqual(['flag:KEEP']);
  });

  it('trims whitespace on names + descriptions', async () => {
    await writeAnnotationsSidecar(root, {
      'flag:X': { name: '  Boulder Badge  ', description: '   ' },
    });
    const sidecar = await readAnnotationsSidecar(root);
    expect(sidecar.annotations['flag:X']).toEqual({ name: 'Boulder Badge' });
  });

  it('creates .editor directory on first write', async () => {
    await writeAnnotationsSidecar(root, { 'flag:X': { name: 'x' } });
    const editorDir = path.join(root, '.editor');
    const stat = await fsp.stat(editorDir);
    expect(stat.isDirectory()).toBe(true);
  });

  it('persists across multiple writes (last write wins)', async () => {
    await writeAnnotationsSidecar(root, { 'flag:A': { name: 'a' } });
    await writeAnnotationsSidecar(root, { 'flag:B': { name: 'b' } });
    const sidecar = await readAnnotationsSidecar(root);
    // Last write replaces the whole map (PUT semantics).
    expect(Object.keys(sidecar.annotations).sort()).toEqual(['flag:B']);
  });

  it('handles malformed JSON gracefully (returns empty)', async () => {
    const editorDir = path.join(root, '.editor');
    await fsp.mkdir(editorDir, { recursive: true });
    await fsp.writeFile(annotationsPathFor(root), '{not valid json', 'utf8');
    const sidecar = await readAnnotationsSidecar(root);
    expect(sidecar.annotations).toEqual({});
  });

  it('rejects non-string fields on read (legacy string format → null)', async () => {
    const editorDir = path.join(root, '.editor');
    await fsp.mkdir(editorDir, { recursive: true });
    await fsp.writeFile(
      annotationsPathFor(root),
      JSON.stringify({
        schemaVersion: 1,
        updatedAtUtc: '2026-05-25T00:00:00.000Z',
        annotations: {
          // Legacy: stored as a bare string (old localStorage shape).
          // Side-car only accepts the rich {name, description?} shape;
          // legacy bares get dropped on read so we don't silently
          // persist a corrupt shape on the next write.
          'flag:LEGACY': 'should be dropped',
          'flag:OK': { name: 'kept' },
        },
      }),
      'utf8',
    );
    const sidecar = await readAnnotationsSidecar(root);
    expect(Object.keys(sidecar.annotations).sort()).toEqual(['flag:OK']);
  });
});
