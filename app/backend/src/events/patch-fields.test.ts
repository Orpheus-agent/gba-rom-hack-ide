import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PatchFieldsError, patchEventFields } from './patch-fields.js';

describe('patchEventFields', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'rom-editor-patch-'));
    mkdirSync(path.join(dir, 'data', 'maps', 'LittlerootTown'), { recursive: true });
    writeFileSync(
      path.join(dir, 'data', 'maps', 'LittlerootTown', 'map.json'),
      JSON.stringify({
        id: 'MAP_LITTLEROOT_TOWN',
        name: 'LITTLEROOT_TOWN',
        map_type: 'MAP_TYPE_TOWN',
        object_events: [
          {
            graphics_id: 'OBJ_EVENT_GFX_BOY',
            x: 10,
            y: 12,
            elevation: 3,
            trainer_type: 'TRAINER_TYPE_NONE',
            trainer_sight_or_berry_tree_id: '0',
            script: 'SomeScript',
            flag: '0',
          },
        ],
        warp_events: [
          { x: 4, y: 5, elevation: 0, dest_map: 'MAP_X', dest_warp_id: '0' },
        ],
        coord_events: [
          { type: 'trigger', x: 7, y: 8, var: 'VAR_X', var_value: '1', script: 'CoordScript' },
        ],
        bg_events: [
          {
            type: 'sign',
            x: 2,
            y: 3,
            player_facing_dir: 'BG_EVENT_PLAYER_FACING_ANY',
            script: 'SignScript',
          },
        ],
      }),
    );
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const mapDirByMapId = (): ReadonlyMap<string, string> =>
    new Map([['MAP_LITTLEROOT_TOWN', 'LittlerootTown']]);

  it('patches a coord_event trigger var + var_value atomically', async () => {
    const result = await patchEventFields(
      'trigger',
      'MAP_LITTLEROOT_TOWN_coord_0',
      { var: 'VAR_NEW', var_value: '5' },
      { projectRoot: dir, mapDirByMapId: mapDirByMapId() },
    );
    expect(result.previous).toEqual({ var: 'VAR_X', var_value: '1' });
    expect(result.next).toEqual({ var: 'VAR_NEW', var_value: '5' });
    const onDisk = JSON.parse(
      readFileSync(path.join(dir, 'data', 'maps', 'LittlerootTown', 'map.json'), 'utf8'),
    );
    expect(onDisk.coord_events[0].var).toBe('VAR_NEW');
    expect(onDisk.coord_events[0].var_value).toBe('5');
    // Untouched fields preserved
    expect(onDisk.coord_events[0].script).toBe('CoordScript');
    expect(onDisk.coord_events[0].x).toBe(7);
  });

  it('patches a bg_event trigger facing direction', async () => {
    await patchEventFields(
      'trigger',
      'MAP_LITTLEROOT_TOWN_bg_0',
      { player_facing_dir: 'BG_EVENT_PLAYER_FACING_NORTH' },
      { projectRoot: dir, mapDirByMapId: mapDirByMapId() },
    );
    const onDisk = JSON.parse(
      readFileSync(path.join(dir, 'data', 'maps', 'LittlerootTown', 'map.json'), 'utf8'),
    );
    expect(onDisk.bg_events[0].player_facing_dir).toBe('BG_EVENT_PLAYER_FACING_NORTH');
  });

  it('patches an object_event script + flag', async () => {
    await patchEventFields(
      'objectEvent',
      'MAP_LITTLEROOT_TOWN_obj_0',
      { script: 'NewScript', flag: 'FLAG_NEW' },
      { projectRoot: dir, mapDirByMapId: mapDirByMapId() },
    );
    const onDisk = JSON.parse(
      readFileSync(path.join(dir, 'data', 'maps', 'LittlerootTown', 'map.json'), 'utf8'),
    );
    expect(onDisk.object_events[0].script).toBe('NewScript');
    expect(onDisk.object_events[0].flag).toBe('FLAG_NEW');
  });

  it('preserves on-disk JSON type: number input keeps string fields quoted, number fields unquoted', async () => {
    // The editor sends sight distance / elevation as NUMBERS. pret's map.json
    // stores trainer_sight_or_berry_tree_id as a quoted string ("0") but
    // elevation as a bare number (3). Each must keep its on-disk type, or
    // mapjson chokes. (Regression: an Ajv coerceTypes union used to turn the
    // number into a string before it ever reached here.)
    await patchEventFields(
      'objectEvent',
      'MAP_LITTLEROOT_TOWN_obj_0',
      { trainer_sight_or_berry_tree_id: 7, elevation: 9 },
      { projectRoot: dir, mapDirByMapId: mapDirByMapId() },
    );
    const raw = readFileSync(
      path.join(dir, 'data', 'maps', 'LittlerootTown', 'map.json'),
      'utf8',
    );
    const onDisk = JSON.parse(raw);
    // String field stays a string ("7"); number field stays a number (9).
    expect(onDisk.object_events[0].trainer_sight_or_berry_tree_id).toBe('7');
    expect(typeof onDisk.object_events[0].trainer_sight_or_berry_tree_id).toBe('string');
    expect(onDisk.object_events[0].elevation).toBe(9);
    expect(typeof onDisk.object_events[0].elevation).toBe('number');
    // And the serialized text reflects it (quoted vs unquoted).
    expect(raw).toContain('"trainer_sight_or_berry_tree_id": "7"');
    expect(raw).toContain('"elevation": 9');
  });

  it('rejects an over-long string value', async () => {
    await expect(
      patchEventFields(
        'objectEvent',
        'MAP_LITTLEROOT_TOWN_obj_0',
        { script: 'x'.repeat(501) },
        { projectRoot: dir, mapDirByMapId: mapDirByMapId() },
      ),
    ).rejects.toMatchObject({ code: 'invalid_coord' });
  });

  it('rejects fields not on the kind allowlist', async () => {
    await expect(
      patchEventFields(
        'trigger',
        'MAP_LITTLEROOT_TOWN_coord_0',
        { not_a_field: 'oops' },
        { projectRoot: dir, mapDirByMapId: mapDirByMapId() },
      ),
    ).rejects.toMatchObject({ code: 'invalid_coord' });
  });

  it('rejects empty patch (no fields provided)', async () => {
    await expect(
      patchEventFields(
        'trigger',
        'MAP_LITTLEROOT_TOWN_coord_0',
        {},
        { projectRoot: dir, mapDirByMapId: mapDirByMapId() },
      ),
    ).rejects.toMatchObject({ code: 'invalid_coord' });
  });

  it('rejects non-string/number/boolean values', async () => {
    await expect(
      patchEventFields(
        'trigger',
        'MAP_LITTLEROOT_TOWN_coord_0',
        { var: { nested: 'object' } as unknown as string },
        { projectRoot: dir, mapDirByMapId: mapDirByMapId() },
      ),
    ).rejects.toMatchObject({ code: 'invalid_coord' });
  });

  it('throws entity_not_found when the array index is out of range', async () => {
    await expect(
      patchEventFields(
        'trigger',
        'MAP_LITTLEROOT_TOWN_coord_99',
        { var: 'X' },
        { projectRoot: dir, mapDirByMapId: mapDirByMapId() },
      ),
    ).rejects.toBeInstanceOf(PatchFieldsError);
  });
});
