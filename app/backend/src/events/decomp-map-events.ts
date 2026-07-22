/**
 * Decomp map-event creation - append a new ObjectEvent (NPC) to a decomp map's
 * `data/maps/<Map>/map.json`. The binary-ROM path (propose_add_object_event)
 * relocates a struct array in raw .gba free space; decomp keeps events in the
 * map.json, so adding one is a structured JSON append.
 *
 * map.json is plain `JSON.stringify(obj, null, 2)` (porymap's format), so a
 * parse → push → stringify round-trip reproduces the file byte-for-byte except
 * the appended entry - a clean one-object diff. local_id is omitted so the
 * mapjson build tool auto-assigns it (only scripts that reference the NPC need
 * a named LOCALID_ constant).
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';

export interface NewObjectEventInput {
  x: number;
  y: number;
  graphicsId?: string; // OBJ_EVENT_GFX_*
  movementType?: string; // MOVEMENT_TYPE_*
  elevation?: number;
  trainerType?: string; // TRAINER_TYPE_*
  trainerSightRange?: number;
  flag?: string;
  script?: string; // label, or "0x0" for none
}

export interface AddObjectEventResult {
  readonly newIndex: number;
  readonly graphicsId: string;
  readonly x: number;
  readonly y: number;
  /** map.json contents before/after, for the op-log. */
  readonly before: string;
  readonly after: string;
}

function asObjectEventArray(json: unknown): Array<Record<string, unknown>> {
  if (typeof json !== 'object' || json === null) throw new Error('map.json root is not an object');
  const oe = (json as Record<string, unknown>)['object_events'];
  return Array.isArray(oe) ? (oe as Array<Record<string, unknown>>) : [];
}

/** Append a new object event to `<projectRoot>/<sourceDir>/map.json`. */
export async function addObjectEventToMap(
  projectRoot: string,
  sourceDir: string,
  input: NewObjectEventInput,
): Promise<AddObjectEventResult> {
  const abs = path.join(projectRoot, sourceDir, 'map.json');
  const before = await fsp.readFile(abs, 'utf8');
  const json = JSON.parse(before) as Record<string, unknown>;
  const existing = asObjectEventArray(json);

  // Default graphics to an existing object on this map (guaranteed-valid
  // constant) so a brand-new NPC never references an undefined gfx symbol.
  const fallbackGfx =
    (existing.find((e) => typeof e['graphics_id'] === 'string')?.['graphics_id'] as string | undefined) ??
    'OBJ_EVENT_GFX_BOY_1';

  const entry: Record<string, unknown> = {
    type: 'object',
    graphics_id: input.graphicsId ?? fallbackGfx,
    x: Math.trunc(input.x),
    y: Math.trunc(input.y),
    elevation: input.elevation ?? 3,
    movement_type: input.movementType ?? 'MOVEMENT_TYPE_FACE_DOWN',
    movement_range_x: 0,
    movement_range_y: 0,
    trainer_type: input.trainerType ?? 'TRAINER_TYPE_NONE',
    trainer_sight_or_berry_tree_id: String(input.trainerSightRange ?? 0),
    script: input.script && input.script.trim() ? input.script.trim() : '0x0',
    flag: input.flag && input.flag.trim() ? input.flag.trim() : '0',
  };

  const nextArray = [...existing, entry];
  json['object_events'] = nextArray;
  const after = `${JSON.stringify(json, null, 2)}\n`;

  const tmp = `${abs}.tmp`;
  await fsp.writeFile(tmp, after, 'utf8');
  await fsp.rename(tmp, abs);

  return {
    newIndex: nextArray.length - 1,
    graphicsId: entry['graphics_id'] as string,
    x: entry['x'] as number,
    y: entry['y'] as number,
    before,
    after,
  };
}

/** Set fields (script, trainer_type, …) on the object event at (x, y) in a
 *  map's map.json. Used to bind a freshly-created script / make an existing
 *  NPC a trainer. Returns whether a matching object was found. */
export async function setObjectEventFields(
  projectRoot: string,
  sourceDir: string,
  locate: { x: number; y: number },
  fields: Record<string, string | number>,
): Promise<{ matched: boolean; before: string; after: string }> {
  const abs = path.join(projectRoot, sourceDir, 'map.json');
  const before = await fsp.readFile(abs, 'utf8');
  const json = JSON.parse(before) as Record<string, unknown>;
  const arr = asObjectEventArray(json);
  const idx = arr.findIndex(
    (e) => Number(e['x']) === Math.trunc(locate.x) && Number(e['y']) === Math.trunc(locate.y),
  );
  if (idx < 0) return { matched: false, before, after: before };
  arr[idx] = { ...arr[idx], ...fields };
  json['object_events'] = arr;
  const after = `${JSON.stringify(json, null, 2)}\n`;
  const tmp = `${abs}.tmp`;
  await fsp.writeFile(tmp, after, 'utf8');
  await fsp.rename(tmp, abs);
  return { matched: true, before, after };
}
