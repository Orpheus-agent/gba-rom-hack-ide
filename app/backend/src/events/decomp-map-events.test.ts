import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { addObjectEventToMap } from './decomp-map-events.js';

const SAMPLE_MAP = {
  id: 'MAP_PALLET_TOWN',
  name: 'PALLET_TOWN',
  object_events: [
    {
      local_id: 'LOCALID_PALLET_SIGN_LADY',
      type: 'object',
      graphics_id: 'OBJ_EVENT_GFX_WOMAN_1',
      x: 3,
      y: 10,
      elevation: 3,
      movement_type: 'MOVEMENT_TYPE_WANDER_AROUND',
      movement_range_x: 1,
      movement_range_y: 4,
      trainer_type: 'TRAINER_TYPE_NONE',
      trainer_sight_or_berry_tree_id: '0',
      script: 'PalletTown_EventScript_SignLady',
      flag: '0',
    },
  ],
  warp_events: [],
};

describe('addObjectEventToMap', () => {
  let dir: string;
  let sourceDir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'rom-editor-mapjson-'));
    sourceDir = 'data/maps/PalletTown';
    mkdirSync(path.join(dir, sourceDir), { recursive: true });
    writeFileSync(
      path.join(dir, sourceDir, 'map.json'),
      `${JSON.stringify(SAMPLE_MAP, null, 2)}\n`,
    );
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('appends a new object event, preserving existing ones', async () => {
    const r = await addObjectEventToMap(dir, sourceDir, { x: 5, y: 6 });
    expect(r.newIndex).toBe(1);
    const json = JSON.parse(readFileSync(path.join(dir, sourceDir, 'map.json'), 'utf8'));
    expect(json.object_events).toHaveLength(2);
    // Original untouched.
    expect(json.object_events[0].script).toBe('PalletTown_EventScript_SignLady');
    // New entry has sensible defaults + the requested coords.
    const added = json.object_events[1];
    expect(added).toMatchObject({
      type: 'object',
      x: 5,
      y: 6,
      elevation: 3,
      movement_type: 'MOVEMENT_TYPE_FACE_DOWN',
      trainer_type: 'TRAINER_TYPE_NONE',
      script: '0x0',
    });
  });

  it('defaults graphics to an existing object on the map (valid constant)', async () => {
    const r = await addObjectEventToMap(dir, sourceDir, { x: 1, y: 1 });
    // Falls back to the map's existing gfx, not an arbitrary constant.
    expect(r.graphicsId).toBe('OBJ_EVENT_GFX_WOMAN_1');
  });

  it('respects an explicit graphicsId / script / trainer type', async () => {
    await addObjectEventToMap(dir, sourceDir, {
      x: 2,
      y: 2,
      graphicsId: 'OBJ_EVENT_GFX_BOY_1',
      script: 'MyMap_EventScript_NewGuy',
      trainerType: 'TRAINER_TYPE_NORMAL',
      trainerSightRange: 4,
    });
    const json = JSON.parse(readFileSync(path.join(dir, sourceDir, 'map.json'), 'utf8'));
    expect(json.object_events[1]).toMatchObject({
      graphics_id: 'OBJ_EVENT_GFX_BOY_1',
      script: 'MyMap_EventScript_NewGuy',
      trainer_type: 'TRAINER_TYPE_NORMAL',
      trainer_sight_or_berry_tree_id: '4',
    });
  });

  it('round-trips porymap JSON format (clean diff)', async () => {
    const before = readFileSync(path.join(dir, sourceDir, 'map.json'), 'utf8');
    await addObjectEventToMap(dir, sourceDir, { x: 9, y: 9 });
    const after = readFileSync(path.join(dir, sourceDir, 'map.json'), 'utf8');
    // The unchanged head of the file (through the first object event) is byte-identical.
    const headLen = before.indexOf('PalletTown_EventScript_SignLady');
    expect(after.slice(0, headLen)).toBe(before.slice(0, headLen));
    expect(after.endsWith('\n')).toBe(true);
  });
});
