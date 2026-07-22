import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import {
  SaveStateError,
  createSaveState,
  deleteSaveState,
  getSaveState,
  listSaveStates,
  readSaveStateBytes,
  updateSaveState,
  SAVE_STATE_NAME_MAX_LENGTH,
  SAVE_STATE_NOTES_MAX_LENGTH,
  SAVE_STATE_MAX_COUNT,
} from './store.js';

describe('save-state store (Phase 4.1A)', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(path.join(tmpdir(), 'rom-editor-savestate-'));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  function makeBytes(length: number, fill = 0x41): Uint8Array {
    const b = new Uint8Array(length);
    b.fill(fill);
    return b;
  }

  it('list is empty when no save states have been recorded', async () => {
    const states = await listSaveStates(projectRoot);
    expect(states).toEqual([]);
  });

  it('create + list round-trip', async () => {
    const record = await createSaveState({
      projectRoot,
      name: 'after-cosmog',
      notes: 'just got Cosmog from Oak',
      gameSha1: '0'.repeat(40),
      bytes: makeBytes(0x61000),
    });
    expect(record.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(record.name).toBe('after-cosmog');
    expect(record.notes).toBe('just got Cosmog from Oak');
    expect(record.byteLength).toBe(0x61000);
    expect(record.lastLoaded).toBe(false);

    const list = await listSaveStates(projectRoot);
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe(record.id);
  });

  it('writes the .state bytes file alongside the index', async () => {
    const record = await createSaveState({
      projectRoot,
      name: 'test',
      gameSha1: 'a'.repeat(40),
      bytes: makeBytes(64),
    });
    const bytesPath = path.join(projectRoot, '.editor', 'save-states', `${record.id}.state`);
    const onDisk = await fsp.readFile(bytesPath);
    expect(onDisk.byteLength).toBe(64);
    expect(onDisk[0]).toBe(0x41);
  });

  it('readSaveStateBytes round-trips the bytes', async () => {
    const record = await createSaveState({
      projectRoot,
      name: 'a',
      gameSha1: 'b'.repeat(40),
      bytes: makeBytes(0x100, 0x55),
    });
    const restored = await readSaveStateBytes(projectRoot, record.id);
    expect(restored.byteLength).toBe(0x100);
    expect(restored[0]).toBe(0x55);
  });

  it('list returns newest-first ordering', async () => {
    const a = await createSaveState({ projectRoot, name: 'A', gameSha1: '0'.repeat(40), bytes: makeBytes(16) });
    await new Promise((r) => setTimeout(r, 5));
    const b = await createSaveState({ projectRoot, name: 'B', gameSha1: '0'.repeat(40), bytes: makeBytes(16) });
    await new Promise((r) => setTimeout(r, 5));
    const c = await createSaveState({ projectRoot, name: 'C', gameSha1: '0'.repeat(40), bytes: makeBytes(16) });

    const list = await listSaveStates(projectRoot);
    expect(list.map((s) => s.id)).toEqual([c.id, b.id, a.id]);
  });

  it('rejects an empty name', async () => {
    await expect(
      createSaveState({
        projectRoot,
        name: '',
        gameSha1: '0'.repeat(40),
        bytes: makeBytes(16),
      }),
    ).rejects.toBeInstanceOf(SaveStateError);
  });

  it('rejects a name longer than the configured cap', async () => {
    await expect(
      createSaveState({
        projectRoot,
        name: 'x'.repeat(SAVE_STATE_NAME_MAX_LENGTH + 1),
        gameSha1: '0'.repeat(40),
        bytes: makeBytes(16),
      }),
    ).rejects.toBeInstanceOf(SaveStateError);
  });

  it('rejects notes longer than the configured cap', async () => {
    await expect(
      createSaveState({
        projectRoot,
        name: 'name',
        notes: 'y'.repeat(SAVE_STATE_NOTES_MAX_LENGTH + 1),
        gameSha1: '0'.repeat(40),
        bytes: makeBytes(16),
      }),
    ).rejects.toBeInstanceOf(SaveStateError);
  });

  it('rejects empty bytes', async () => {
    await expect(
      createSaveState({
        projectRoot,
        name: 'name',
        gameSha1: '0'.repeat(40),
        bytes: new Uint8Array(0),
      }),
    ).rejects.toBeInstanceOf(SaveStateError);
  });

  it('rejects bytes larger than the mGBA savestate ceiling', async () => {
    await expect(
      createSaveState({
        projectRoot,
        name: 'name',
        gameSha1: '0'.repeat(40),
        bytes: makeBytes(0x100001),
      }),
    ).rejects.toBeInstanceOf(SaveStateError);
  });

  it('updateSaveState renames + changes notes', async () => {
    const record = await createSaveState({
      projectRoot,
      name: 'before',
      notes: 'original note',
      gameSha1: '0'.repeat(40),
      bytes: makeBytes(16),
    });
    const updated = await updateSaveState({
      projectRoot,
      stateId: record.id,
      name: 'after',
      notes: 'new note',
    });
    expect(updated.name).toBe('after');
    expect(updated.notes).toBe('new note');
    const fetched = await getSaveState(projectRoot, record.id);
    expect(fetched?.name).toBe('after');
  });

  it('markLastLoaded sets the flag on this record + clears it on every other', async () => {
    const a = await createSaveState({ projectRoot, name: 'A', gameSha1: '0'.repeat(40), bytes: makeBytes(16) });
    const b = await createSaveState({ projectRoot, name: 'B', gameSha1: '0'.repeat(40), bytes: makeBytes(16) });
    const c = await createSaveState({ projectRoot, name: 'C', gameSha1: '0'.repeat(40), bytes: makeBytes(16) });
    await updateSaveState({ projectRoot, stateId: a.id, markLastLoaded: true });
    await updateSaveState({ projectRoot, stateId: c.id, markLastLoaded: true });
    const list = await listSaveStates(projectRoot);
    const byId = new Map(list.map((s) => [s.id, s]));
    expect(byId.get(a.id)!.lastLoaded).toBe(false);
    expect(byId.get(b.id)!.lastLoaded).toBe(false);
    expect(byId.get(c.id)!.lastLoaded).toBe(true);
  });

  it('update throws state_not_found for an unknown id', async () => {
    await expect(
      updateSaveState({ projectRoot, stateId: 'no-such-id', name: 'x' }),
    ).rejects.toMatchObject({ code: 'state_not_found' });
  });

  it('deleteSaveState removes the record + bytes file', async () => {
    const record = await createSaveState({
      projectRoot,
      name: 'temp',
      gameSha1: '0'.repeat(40),
      bytes: makeBytes(32),
    });
    const bytesPath = path.join(projectRoot, '.editor', 'save-states', `${record.id}.state`);
    expect(await fsp.stat(bytesPath).then(() => true).catch(() => false)).toBe(true);
    await deleteSaveState(projectRoot, record.id);
    expect(await fsp.stat(bytesPath).then(() => true).catch(() => false)).toBe(false);
    const list = await listSaveStates(projectRoot);
    expect(list).toHaveLength(0);
  });

  it('deleteSaveState is a no-op for an unknown id', async () => {
    await expect(deleteSaveState(projectRoot, 'no-such-id')).resolves.toBeUndefined();
  });

  it('listSaveStates trims malformed records from the index', async () => {
    await createSaveState({ projectRoot, name: 'real', gameSha1: '0'.repeat(40), bytes: makeBytes(16) });
    const indexPath = path.join(projectRoot, '.editor', 'save-states', 'index.json');
    const raw = JSON.parse(await fsp.readFile(indexPath, 'utf-8')) as { schemaVersion: number; states: unknown[] };
    raw.states.push({ junk: true });
    await fsp.writeFile(indexPath, JSON.stringify(raw));
    const list = await listSaveStates(projectRoot);
    expect(list).toHaveLength(1);
    expect(list[0]!.name).toBe('real');
  });

  it('readIndex throws index_corrupt on invalid JSON', async () => {
    const dir = path.join(projectRoot, '.editor', 'save-states');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'index.json'), '{not valid');
    await expect(listSaveStates(projectRoot)).rejects.toMatchObject({ code: 'index_corrupt' });
  });

  it('enforces the per-project save-state cap', async () => {
    // Don't actually create 200 records - fake the index by pre-loading
    // SAVE_STATE_MAX_COUNT placeholder records, then attempt one more.
    const dir = path.join(projectRoot, '.editor', 'save-states');
    await fsp.mkdir(dir, { recursive: true });
    const filler = Array.from({ length: SAVE_STATE_MAX_COUNT }, (_, i) => ({
      id: `00000000-0000-0000-0000-00000000${String(i).padStart(4, '0')}`,
      name: `slot-${i}`,
      notes: null,
      createdAt: new Date(Date.now() - i * 1000).toISOString(),
      gameSha1: '0'.repeat(40),
      byteLength: 16,
      lastLoaded: false,
    }));
    await fsp.writeFile(
      path.join(dir, 'index.json'),
      JSON.stringify({ schemaVersion: 1, states: filler }),
    );
    await expect(
      createSaveState({
        projectRoot,
        name: 'overflow',
        gameSha1: '0'.repeat(40),
        bytes: makeBytes(16),
      }),
    ).rejects.toMatchObject({ code: 'limit_exceeded' });
  });
});
