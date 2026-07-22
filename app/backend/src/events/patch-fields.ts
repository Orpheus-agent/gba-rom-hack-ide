import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { MoveEventErrorCode, MoveEventKind } from '@rom-editor/shared';
import { parseEventId } from './move.js';

export class PatchFieldsError extends Error {
  constructor(public readonly code: MoveEventErrorCode, message: string) {
    super(message);
    this.name = 'PatchFieldsError';
  }
}

export type FieldValue = string | number | boolean | null;

/**
 * Per-kind whitelist of fields that may be patched. Trying to set anything not
 * in this list is rejected with `invalid_coord` (re-using the code for
 * "input rejected by validation"; future work can split error codes further).
 */
const ALLOWED_FIELDS_BY_KIND: Readonly<
  Record<MoveEventKind, ReadonlyArray<string>>
> = {
  objectEvent: [
    'graphics_id',
    'elevation',
    'movement_type',
    'movement_range_x',
    'movement_range_y',
    'trainer_type',
    'trainer_sight_or_berry_tree_id',
    'script',
    'flag',
  ],
  warp: ['elevation', 'dest_map', 'dest_warp_id'],
  trigger: [
    // coord_event-shape
    'var',
    'var_value',
    'script',
    'elevation',
    // bg_event-shape
    'player_facing_dir',
  ],
};

export interface PatchFieldsResult {
  readonly mapId: string;
  readonly previous: Readonly<Record<string, FieldValue>>;
  readonly next: Readonly<Record<string, FieldValue>>;
  readonly mapJsonPath: string;
}

export interface PatchFieldsOptions {
  readonly projectRoot: string;
  readonly mapDirByMapId: ReadonlyMap<string, string>;
}

export async function patchEventFields(
  kind: MoveEventKind,
  id: string,
  fields: Readonly<Record<string, unknown>>,
  options: PatchFieldsOptions,
): Promise<PatchFieldsResult> {
  const parsed = parseEventId(kind, id);
  if (!parsed) {
    throw new PatchFieldsError('entity_not_found', `Could not parse entity id '${id}'`);
  }
  const mapDir = options.mapDirByMapId.get(parsed.mapId);
  if (!mapDir) {
    throw new PatchFieldsError('map_not_found', `No directory for mapId '${parsed.mapId}'`);
  }

  const allowed = ALLOWED_FIELDS_BY_KIND[kind];
  const sanitized: Record<string, FieldValue> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!allowed.includes(key)) {
      throw new PatchFieldsError(
        'invalid_coord',
        `Field '${key}' is not editable on kind '${kind}'. Allowed: ${allowed.join(', ')}`,
      );
    }
    if (
      value !== null &&
      typeof value !== 'string' &&
      typeof value !== 'number' &&
      typeof value !== 'boolean'
    ) {
      throw new PatchFieldsError(
        'invalid_coord',
        `Field '${key}' value must be string/number/boolean/null; got ${typeof value}`,
      );
    }
    // Sanity cap on string length (the route schema no longer constrains value
    // types - see patchFieldsBodySchema - so the bound is enforced here).
    if (typeof value === 'string' && value.length > 500) {
      throw new PatchFieldsError(
        'invalid_coord',
        `Field '${key}' string is too long (${String(value.length)} > 500)`,
      );
    }
    sanitized[key] = value;
  }
  if (Object.keys(sanitized).length === 0) {
    throw new PatchFieldsError('invalid_coord', 'No fields provided to patch');
  }

  const mapJsonRelPath = path.join('data', 'maps', mapDir, 'map.json');
  const mapJsonAbsPath = path.join(options.projectRoot, mapJsonRelPath);
  let raw: string;
  try {
    raw = await fsp.readFile(mapJsonAbsPath, 'utf8');
  } catch (e) {
    throw new PatchFieldsError(
      'map_not_found',
      `Could not read ${mapJsonRelPath}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new PatchFieldsError(
      'mutation_failed',
      `Could not parse ${mapJsonRelPath}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (typeof json !== 'object' || json === null) {
    throw new PatchFieldsError('mutation_failed', `${mapJsonRelPath} root is not an object`);
  }
  const obj = json as Record<string, unknown>;
  const arr = obj[parsed.arrayKey];
  if (!Array.isArray(arr) || parsed.index >= arr.length) {
    throw new PatchFieldsError(
      'entity_not_found',
      `${mapJsonRelPath} has no ${parsed.arrayKey}[${parsed.index}]`,
    );
  }
  const entry = arr[parsed.index];
  if (typeof entry !== 'object' || entry === null) {
    throw new PatchFieldsError(
      'mutation_failed',
      `${mapJsonRelPath} ${parsed.arrayKey}[${parsed.index}] is not an object`,
    );
  }
  const entryObj = entry as Record<string, unknown>;

  const previous: Record<string, FieldValue> = {};
  for (const [key, value] of Object.entries(sanitized)) {
    const prevRaw = entryObj[key];
    previous[key] =
      prevRaw === null ||
      typeof prevRaw === 'string' ||
      typeof prevRaw === 'number' ||
      typeof prevRaw === 'boolean'
        ? prevRaw
        : null;
    // Preserve the on-disk JSON type: pret's map.json quotes some numeric
    // fields (trainer sight range, flag, …) as strings. If the field was a
    // string on disk and the editor produced a number, write it back as a
    // string so the file stays format-consistent and mapjson sees what it
    // expects.
    entryObj[key] =
      typeof prevRaw === 'string' && typeof value === 'number' ? String(value) : value;
  }

  const tmpPath = mapJsonAbsPath + '.tmp';
  try {
    await fsp.writeFile(tmpPath, JSON.stringify(json, null, 2) + '\n', 'utf8');
    await fsp.rename(tmpPath, mapJsonAbsPath);
  } catch (e) {
    try {
      await fsp.unlink(tmpPath);
    } catch {
      /* ignore */
    }
    throw new PatchFieldsError(
      'mutation_failed',
      `Atomic write failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  return {
    mapId: parsed.mapId,
    previous,
    next: sanitized,
    mapJsonPath: mapJsonRelPath.replace(/\\/g, '/'),
  };
}
