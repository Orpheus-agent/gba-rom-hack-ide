/**
 * Phase 4.1A - Save-state library store.
 *
 * Persists per-project mGBA save states + metadata under
 * `<projectRoot>/.editor/save-states/`:
 *
 *   index.json           array of SaveStateRecord (metadata, no bytes)
 *   <uuid>.state         raw mGBA savestate bytes (~390 KB each)
 *
 * The bytes-file is opaque to us - we hand it off to mGBA-WASM's
 * `uploadAutoSaveState` + `loadAutoSaveState` round-trip. We never
 * parse the mgba serialize format ourselves.
 *
 * Operations are best-effort atomic at the index-file level: each
 * mutation rewrites index.json via a tmp file + rename. The .state
 * files are write-once / delete-once so a torn write would only
 * affect the in-flight record.
 */

import { promises as fsp } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { SaveStateRecord } from '@rom-editor/shared';

const SAVE_STATES_DIR = path.join('.editor', 'save-states');
const INDEX_FILE = 'index.json';

/** Schema version of the on-disk index.json. Bump if the shape changes. */
const INDEX_SCHEMA_VERSION = 1;

/** Hard cap on display-name length (matches Zod validation on the route). */
export const SAVE_STATE_NAME_MAX_LENGTH = 80;
/** Hard cap on notes length. 1 KB is plenty for "after Cosmog handoff". */
export const SAVE_STATE_NOTES_MAX_LENGTH = 1024;

/** Hard cap on persisted records per project. mGBA states are ~390 KB
 *  each; 200 records ≈ 80 MiB which is the same scale as the user's
 *  existing op-log + manifest cache. Beyond that we'd start to bloat
 *  the project folder; if users hit it the right answer is to add
 *  a "delete oldest" affordance, not raise the cap silently. */
export const SAVE_STATE_MAX_COUNT = 200;

export class SaveStateError extends Error {
  constructor(
    public readonly code:
      | 'invalid_name'
      | 'invalid_notes'
      | 'invalid_bytes'
      | 'state_not_found'
      | 'limit_exceeded'
      | 'index_corrupt',
    message: string,
  ) {
    super(message);
    this.name = 'SaveStateError';
  }
}

interface IndexFile {
  readonly schemaVersion: number;
  readonly states: SaveStateRecord[];
}

function dirFor(projectRoot: string): string {
  return path.join(projectRoot, SAVE_STATES_DIR);
}

function indexPathFor(projectRoot: string): string {
  return path.join(dirFor(projectRoot), INDEX_FILE);
}

function bytesPathFor(projectRoot: string, stateId: string): string {
  return path.join(dirFor(projectRoot), `${stateId}.state`);
}

async function ensureDir(projectRoot: string): Promise<void> {
  await fsp.mkdir(dirFor(projectRoot), { recursive: true });
}

async function readIndex(projectRoot: string): Promise<SaveStateRecord[]> {
  let text: string;
  try {
    text = await fsp.readFile(indexPathFor(projectRoot), 'utf-8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SaveStateError('index_corrupt', 'save-states/index.json is not valid JSON');
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    !Array.isArray((parsed as IndexFile).states)
  ) {
    throw new SaveStateError('index_corrupt', 'save-states/index.json missing { states: [...] }');
  }
  // Defensive: drop any malformed entries instead of failing the whole list.
  return (parsed as IndexFile).states.filter(isSaveStateRecord);
}

function isSaveStateRecord(x: unknown): x is SaveStateRecord {
  if (!x || typeof x !== 'object') return false;
  const r = x as Partial<SaveStateRecord>;
  return (
    typeof r.id === 'string' &&
    typeof r.name === 'string' &&
    (r.notes === null || typeof r.notes === 'string') &&
    typeof r.createdAt === 'string' &&
    typeof r.gameSha1 === 'string' &&
    typeof r.byteLength === 'number' &&
    typeof r.lastLoaded === 'boolean'
  );
}

async function writeIndex(projectRoot: string, states: SaveStateRecord[]): Promise<void> {
  await ensureDir(projectRoot);
  const tmp = indexPathFor(projectRoot) + '.tmp';
  const payload: IndexFile = { schemaVersion: INDEX_SCHEMA_VERSION, states };
  await fsp.writeFile(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
  await fsp.rename(tmp, indexPathFor(projectRoot));
}

function validateName(name: unknown): string {
  if (typeof name !== 'string') throw new SaveStateError('invalid_name', 'name must be a string');
  const trimmed = name.trim();
  if (trimmed.length === 0) throw new SaveStateError('invalid_name', 'name must not be empty');
  if (trimmed.length > SAVE_STATE_NAME_MAX_LENGTH) {
    throw new SaveStateError(
      'invalid_name',
      `name length ${String(trimmed.length)} exceeds ${String(SAVE_STATE_NAME_MAX_LENGTH)}`,
    );
  }
  return trimmed;
}

function validateNotes(notes: unknown): string | null {
  if (notes === undefined || notes === null) return null;
  if (typeof notes !== 'string') throw new SaveStateError('invalid_notes', 'notes must be a string or null');
  if (notes.length > SAVE_STATE_NOTES_MAX_LENGTH) {
    throw new SaveStateError(
      'invalid_notes',
      `notes length ${String(notes.length)} exceeds ${String(SAVE_STATE_NOTES_MAX_LENGTH)}`,
    );
  }
  const trimmed = notes.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** List every save state for the project, newest-first. */
export async function listSaveStates(projectRoot: string): Promise<SaveStateRecord[]> {
  const states = await readIndex(projectRoot);
  return [...states].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/** Look up a single record by id. Returns null when missing. */
export async function getSaveState(
  projectRoot: string,
  stateId: string,
): Promise<SaveStateRecord | null> {
  const states = await readIndex(projectRoot);
  return states.find((s) => s.id === stateId) ?? null;
}

/** Stream the raw .state bytes for a record. Throws state_not_found
 *  when the id is not in the index. */
export async function readSaveStateBytes(
  projectRoot: string,
  stateId: string,
): Promise<Uint8Array> {
  const record = await getSaveState(projectRoot, stateId);
  if (!record) {
    throw new SaveStateError('state_not_found', `save state ${stateId} not found in index`);
  }
  return new Uint8Array(await fsp.readFile(bytesPathFor(projectRoot, stateId)));
}

export interface CreateSaveStateOptions {
  readonly projectRoot: string;
  readonly name: string;
  readonly notes?: string | null;
  readonly gameSha1: string;
  readonly bytes: Uint8Array;
}

/** Persist a new save state. Returns the created record. */
export async function createSaveState(opts: CreateSaveStateOptions): Promise<SaveStateRecord> {
  const name = validateName(opts.name);
  const notes = validateNotes(opts.notes);
  if (!(opts.bytes instanceof Uint8Array) || opts.bytes.byteLength === 0) {
    throw new SaveStateError('invalid_bytes', 'bytes must be a non-empty Uint8Array');
  }
  // mGBA savestates are exactly 0x61000 bytes (397,312) per the serialize
  // header. Anything else is suspicious - surface it loudly rather than
  // letting mGBA fail at load time.
  if (opts.bytes.byteLength > 0x100000) {
    throw new SaveStateError(
      'invalid_bytes',
      `bytes length ${String(opts.bytes.byteLength)} is too large for a mGBA savestate (expected ~0x61000)`,
    );
  }

  const existing = await readIndex(opts.projectRoot);
  if (existing.length >= SAVE_STATE_MAX_COUNT) {
    throw new SaveStateError(
      'limit_exceeded',
      `project has ${String(existing.length)} save states; the cap is ${String(SAVE_STATE_MAX_COUNT)}. Delete unused ones first.`,
    );
  }

  const id = randomUUID();
  const record: SaveStateRecord = {
    id,
    name,
    notes,
    createdAt: new Date().toISOString(),
    gameSha1: opts.gameSha1,
    byteLength: opts.bytes.byteLength,
    lastLoaded: false,
  };

  await ensureDir(opts.projectRoot);
  // Write the bytes first so the index never points to a missing file.
  const tmpBytes = bytesPathFor(opts.projectRoot, id) + '.tmp';
  await fsp.writeFile(tmpBytes, opts.bytes);
  await fsp.rename(tmpBytes, bytesPathFor(opts.projectRoot, id));
  await writeIndex(opts.projectRoot, [...existing, record]);
  return record;
}

export interface UpdateSaveStateOptions {
  readonly projectRoot: string;
  readonly stateId: string;
  readonly name?: string;
  readonly notes?: string | null;
  readonly markLastLoaded?: boolean;
}

/** Rename a state, change its notes, and/or mark it as the most-recently
 *  loaded one. Returns the updated record. */
export async function updateSaveState(opts: UpdateSaveStateOptions): Promise<SaveStateRecord> {
  const states = await readIndex(opts.projectRoot);
  const idx = states.findIndex((s) => s.id === opts.stateId);
  if (idx < 0) {
    throw new SaveStateError('state_not_found', `save state ${opts.stateId} not found`);
  }
  const current = states[idx]!;
  let next: SaveStateRecord = current;

  if (opts.name !== undefined) {
    const name = validateName(opts.name);
    next = { ...next, name };
  }
  if (opts.notes !== undefined) {
    next = { ...next, notes: validateNotes(opts.notes) };
  }
  if (opts.markLastLoaded === true) {
    // Clear the flag everywhere else, then set it on this record.
    const cleared = states.map((s) => (s.lastLoaded ? { ...s, lastLoaded: false } : s));
    cleared[idx] = { ...next, lastLoaded: true };
    await writeIndex(opts.projectRoot, cleared);
    return cleared[idx]!;
  }

  const updated = [...states];
  updated[idx] = next;
  await writeIndex(opts.projectRoot, updated);
  return next;
}

/** Delete a save state record + its bytes file. No-ops when the id
 *  is already gone. */
export async function deleteSaveState(
  projectRoot: string,
  stateId: string,
): Promise<void> {
  const states = await readIndex(projectRoot);
  const next = states.filter((s) => s.id !== stateId);
  if (next.length === states.length) {
    // Nothing to delete - but try to clean up an orphaned bytes file just
    // in case the previous write left one behind.
    await fsp.rm(bytesPathFor(projectRoot, stateId), { force: true });
    return;
  }
  await writeIndex(projectRoot, next);
  await fsp.rm(bytesPathFor(projectRoot, stateId), { force: true });
}
