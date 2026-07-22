/**
 * Phase 4.1B - Scene-boot recipe store.
 *
 * Persists per-project scene-boot recipes (warp + flag/var seed +
 * optional script trigger) under:
 *
 *   <projectRoot>/.editor/scene-boots/index.json
 *
 * Like the save-state store, the index is atomically rewritten via
 * a `.tmp` + rename. There are no per-recipe payload files - every
 * recipe is fully metadata.
 *
 * The orchestrator (`app/frontend/src/lib/sceneBoot.ts`) is the
 * actual "warp + seed + trigger" code. This module just persists
 * the spec.
 */

import { promises as fsp } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { SceneBootFacing, SceneBootRecipe, SceneBootVarSeed } from '@rom-editor/shared';

const SCENE_BOOTS_DIR = path.join('.editor', 'scene-boots');
const INDEX_FILE = 'index.json';
const INDEX_SCHEMA_VERSION = 1;

export const SCENE_BOOT_NAME_MAX_LENGTH = 80;
export const SCENE_BOOT_NOTES_MAX_LENGTH = 1024;
export const SCENE_BOOT_MAX_COUNT = 500;
export const SCENE_BOOT_MAX_FLAGS = 256;
export const SCENE_BOOT_MAX_VARS = 256;

export class SceneBootError extends Error {
  constructor(
    public readonly code:
      | 'invalid_name'
      | 'invalid_notes'
      | 'invalid_starting_map'
      | 'invalid_position'
      | 'invalid_flag'
      | 'invalid_var'
      | 'invalid_script_id'
      | 'recipe_not_found'
      | 'limit_exceeded'
      | 'index_corrupt',
    message: string,
  ) {
    super(message);
    this.name = 'SceneBootError';
  }
}

interface IndexFile {
  readonly schemaVersion: number;
  readonly recipes: SceneBootRecipe[];
}

function dirFor(projectRoot: string): string {
  return path.join(projectRoot, SCENE_BOOTS_DIR);
}
function indexPathFor(projectRoot: string): string {
  return path.join(dirFor(projectRoot), INDEX_FILE);
}

async function ensureDir(projectRoot: string): Promise<void> {
  await fsp.mkdir(dirFor(projectRoot), { recursive: true });
}

function isFacing(x: unknown): x is SceneBootFacing {
  return x === 'down' || x === 'up' || x === 'left' || x === 'right';
}

function isRecipe(x: unknown): x is SceneBootRecipe {
  if (!x || typeof x !== 'object') return false;
  const r = x as Partial<SceneBootRecipe>;
  if (
    typeof r.id !== 'string' ||
    typeof r.name !== 'string' ||
    (r.notes !== null && typeof r.notes !== 'string') ||
    typeof r.createdAt !== 'string' ||
    typeof r.startingMapId !== 'string' ||
    typeof r.skipIntro !== 'boolean' ||
    !Array.isArray(r.initialFlags) ||
    !Array.isArray(r.initialVars)
  ) {
    return false;
  }
  if (r.startingPosition !== null) {
    const pos = r.startingPosition;
    if (
      !pos ||
      typeof pos.x !== 'number' ||
      typeof pos.y !== 'number' ||
      !isFacing(pos.facing)
    ) {
      return false;
    }
  }
  if (r.triggerScriptId !== null && typeof r.triggerScriptId !== 'string') return false;
  // Defensive: filter out malformed flag/var entries instead of bailing.
  return (r.initialFlags as unknown[]).every((f) => typeof f === 'number') &&
    (r.initialVars as unknown[]).every(
      (v) =>
        v && typeof v === 'object' &&
        typeof (v as SceneBootVarSeed).varId === 'number' &&
        typeof (v as SceneBootVarSeed).value === 'number',
    );
}

async function readIndex(projectRoot: string): Promise<SceneBootRecipe[]> {
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
    throw new SceneBootError('index_corrupt', 'scene-boots/index.json is not valid JSON');
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    !Array.isArray((parsed as IndexFile).recipes)
  ) {
    throw new SceneBootError('index_corrupt', 'scene-boots/index.json missing { recipes: [...] }');
  }
  return (parsed as IndexFile).recipes.filter(isRecipe);
}

async function writeIndex(projectRoot: string, recipes: SceneBootRecipe[]): Promise<void> {
  await ensureDir(projectRoot);
  const tmp = indexPathFor(projectRoot) + '.tmp';
  const payload: IndexFile = { schemaVersion: INDEX_SCHEMA_VERSION, recipes };
  await fsp.writeFile(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
  await fsp.rename(tmp, indexPathFor(projectRoot));
}

function validateName(name: unknown): string {
  if (typeof name !== 'string') throw new SceneBootError('invalid_name', 'name must be a string');
  const trimmed = name.trim();
  if (trimmed.length === 0) throw new SceneBootError('invalid_name', 'name must not be empty');
  if (trimmed.length > SCENE_BOOT_NAME_MAX_LENGTH) {
    throw new SceneBootError('invalid_name', `name length exceeds ${String(SCENE_BOOT_NAME_MAX_LENGTH)}`);
  }
  return trimmed;
}

function validateNotes(notes: unknown): string | null {
  if (notes === undefined || notes === null) return null;
  if (typeof notes !== 'string') throw new SceneBootError('invalid_notes', 'notes must be a string or null');
  if (notes.length > SCENE_BOOT_NOTES_MAX_LENGTH) {
    throw new SceneBootError('invalid_notes', `notes length exceeds ${String(SCENE_BOOT_NOTES_MAX_LENGTH)}`);
  }
  const trimmed = notes.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function validateStartingMapId(id: unknown): string {
  if (typeof id !== 'string' || id.trim().length === 0) {
    throw new SceneBootError('invalid_starting_map', 'startingMapId must be a non-empty string');
  }
  return id.trim();
}

function validatePosition(
  pos: unknown,
): SceneBootRecipe['startingPosition'] {
  if (pos === undefined || pos === null) return null;
  if (typeof pos !== 'object') {
    throw new SceneBootError('invalid_position', 'startingPosition must be { x, y, facing } or null');
  }
  const { x, y, facing } = pos as { x?: unknown; y?: unknown; facing?: unknown };
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) {
    throw new SceneBootError('invalid_position', 'startingPosition x + y must be finite numbers');
  }
  if (x < 0 || x > 255 || y < 0 || y > 255) {
    throw new SceneBootError('invalid_position', 'startingPosition x + y must be in [0, 255]');
  }
  if (!isFacing(facing)) {
    throw new SceneBootError('invalid_position', `startingPosition facing must be down|up|left|right`);
  }
  return { x: Math.floor(x), y: Math.floor(y), facing };
}

function validateFlags(flags: unknown): ReadonlyArray<number> {
  if (flags === undefined) return [];
  if (!Array.isArray(flags)) {
    throw new SceneBootError('invalid_flag', 'initialFlags must be a number[]');
  }
  if (flags.length > SCENE_BOOT_MAX_FLAGS) {
    throw new SceneBootError('invalid_flag', `initialFlags length exceeds ${String(SCENE_BOOT_MAX_FLAGS)}`);
  }
  return flags.map((f) => {
    if (typeof f !== 'number' || !Number.isInteger(f) || f < 0 || f > 0xffff) {
      throw new SceneBootError('invalid_flag', `flag ${String(f)} is not a u16 integer`);
    }
    return f;
  });
}

function validateVars(vars: unknown): ReadonlyArray<SceneBootVarSeed> {
  if (vars === undefined) return [];
  if (!Array.isArray(vars)) {
    throw new SceneBootError('invalid_var', 'initialVars must be SceneBootVarSeed[]');
  }
  if (vars.length > SCENE_BOOT_MAX_VARS) {
    throw new SceneBootError('invalid_var', `initialVars length exceeds ${String(SCENE_BOOT_MAX_VARS)}`);
  }
  return vars.map((v): SceneBootVarSeed => {
    if (
      !v ||
      typeof v !== 'object' ||
      typeof (v as SceneBootVarSeed).varId !== 'number' ||
      typeof (v as SceneBootVarSeed).value !== 'number'
    ) {
      throw new SceneBootError('invalid_var', 'each initialVars entry must be { varId: number, value: number }');
    }
    const { varId, value } = v as SceneBootVarSeed;
    if (!Number.isInteger(varId) || varId < 0 || varId > 0xffff) {
      throw new SceneBootError('invalid_var', `varId ${String(varId)} is not a u16 integer`);
    }
    if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
      throw new SceneBootError('invalid_var', `varId ${String(varId)} value ${String(value)} is not a u16 integer`);
    }
    return { varId, value };
  });
}

function validateTriggerScriptId(scriptId: unknown): string | null {
  if (scriptId === undefined || scriptId === null) return null;
  if (typeof scriptId !== 'string') {
    throw new SceneBootError('invalid_script_id', 'triggerScriptId must be a string or null');
  }
  const trimmed = scriptId.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** List every recipe for the project, newest-first. */
export async function listSceneBoots(projectRoot: string): Promise<SceneBootRecipe[]> {
  const recipes = await readIndex(projectRoot);
  return [...recipes].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/** Look up a single recipe by id. */
export async function getSceneBoot(
  projectRoot: string,
  recipeId: string,
): Promise<SceneBootRecipe | null> {
  const recipes = await readIndex(projectRoot);
  return recipes.find((r) => r.id === recipeId) ?? null;
}

export interface CreateSceneBootOptions {
  readonly projectRoot: string;
  readonly name: string;
  readonly notes?: string | null;
  readonly startingMapId: string;
  readonly startingPosition?: {
    readonly x: number;
    readonly y: number;
    readonly facing: SceneBootFacing;
  } | null;
  readonly initialFlags?: ReadonlyArray<number>;
  readonly initialVars?: ReadonlyArray<SceneBootVarSeed>;
  readonly triggerScriptId?: string | null;
  readonly skipIntro?: boolean;
}

/** Persist a new scene-boot recipe. Returns the created record. */
export async function createSceneBoot(opts: CreateSceneBootOptions): Promise<SceneBootRecipe> {
  const name = validateName(opts.name);
  const notes = validateNotes(opts.notes);
  const startingMapId = validateStartingMapId(opts.startingMapId);
  const startingPosition = validatePosition(opts.startingPosition);
  const initialFlags = validateFlags(opts.initialFlags);
  const initialVars = validateVars(opts.initialVars);
  const triggerScriptId = validateTriggerScriptId(opts.triggerScriptId);
  const skipIntro = opts.skipIntro === true;

  const existing = await readIndex(opts.projectRoot);
  if (existing.length >= SCENE_BOOT_MAX_COUNT) {
    throw new SceneBootError(
      'limit_exceeded',
      `project has ${String(existing.length)} scene-boot recipes; the cap is ${String(SCENE_BOOT_MAX_COUNT)}.`,
    );
  }

  const recipe: SceneBootRecipe = {
    id: randomUUID(),
    name,
    notes,
    createdAt: new Date().toISOString(),
    startingMapId,
    startingPosition,
    initialFlags,
    initialVars,
    triggerScriptId,
    skipIntro,
  };

  await writeIndex(opts.projectRoot, [...existing, recipe]);
  return recipe;
}

export interface UpdateSceneBootOptions {
  readonly projectRoot: string;
  readonly recipeId: string;
  readonly name?: string;
  readonly notes?: string | null;
  readonly startingMapId?: string;
  readonly startingPosition?: {
    readonly x: number;
    readonly y: number;
    readonly facing: SceneBootFacing;
  } | null;
  readonly initialFlags?: ReadonlyArray<number>;
  readonly initialVars?: ReadonlyArray<SceneBootVarSeed>;
  readonly triggerScriptId?: string | null;
  readonly skipIntro?: boolean;
}

/** Apply a partial update. Returns the updated record. */
export async function updateSceneBoot(opts: UpdateSceneBootOptions): Promise<SceneBootRecipe> {
  const recipes = await readIndex(opts.projectRoot);
  const idx = recipes.findIndex((r) => r.id === opts.recipeId);
  if (idx < 0) {
    throw new SceneBootError('recipe_not_found', `scene-boot recipe ${opts.recipeId} not found`);
  }
  const current = recipes[idx]!;
  let next: SceneBootRecipe = current;
  if (opts.name !== undefined) next = { ...next, name: validateName(opts.name) };
  if (opts.notes !== undefined) next = { ...next, notes: validateNotes(opts.notes) };
  if (opts.startingMapId !== undefined) next = { ...next, startingMapId: validateStartingMapId(opts.startingMapId) };
  if (opts.startingPosition !== undefined) next = { ...next, startingPosition: validatePosition(opts.startingPosition) };
  if (opts.initialFlags !== undefined) next = { ...next, initialFlags: validateFlags(opts.initialFlags) };
  if (opts.initialVars !== undefined) next = { ...next, initialVars: validateVars(opts.initialVars) };
  if (opts.triggerScriptId !== undefined) next = { ...next, triggerScriptId: validateTriggerScriptId(opts.triggerScriptId) };
  if (opts.skipIntro !== undefined) next = { ...next, skipIntro: opts.skipIntro };

  const updated = [...recipes];
  updated[idx] = next;
  await writeIndex(opts.projectRoot, updated);
  return next;
}

/** Delete a recipe. No-op if it's not there. */
export async function deleteSceneBoot(
  projectRoot: string,
  recipeId: string,
): Promise<void> {
  const recipes = await readIndex(projectRoot);
  const next = recipes.filter((r) => r.id !== recipeId);
  if (next.length === recipes.length) return;
  await writeIndex(projectRoot, next);
}
