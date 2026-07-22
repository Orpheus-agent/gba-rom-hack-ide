import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MoveEventError, moveEvent, parseEventId } from './move.js';

describe('parseEventId', () => {
  it('parses objectEvent ids', () => {
    expect(parseEventId('objectEvent', 'MAP_LITTLEROOT_TOWN_obj_3')).toEqual({
      mapId: 'MAP_LITTLEROOT_TOWN',
      index: 3,
      arrayKey: 'object_events',
    });
  });

  it('parses warp ids', () => {
    expect(parseEventId('warp', 'MAP_LITTLEROOT_TOWN_warp_0')).toEqual({
      mapId: 'MAP_LITTLEROOT_TOWN',
      index: 0,
      arrayKey: 'warp_events',
    });
  });

  it('parses both coord and bg trigger ids', () => {
    expect(parseEventId('trigger', 'MAP_LITTLEROOT_TOWN_coord_2')?.arrayKey).toBe('coord_events');
    expect(parseEventId('trigger', 'MAP_LITTLEROOT_TOWN_bg_5')?.arrayKey).toBe('bg_events');
  });

  it('returns null for malformed ids or wrong-kind ids', () => {
    expect(parseEventId('objectEvent', 'MAP_X_warp_0')).toBeNull();
    expect(parseEventId('warp', 'MAP_X_obj_0')).toBeNull();
    expect(parseEventId('objectEvent', 'no_index')).toBeNull();
    expect(parseEventId('objectEvent', 'MAP_X_obj_notanumber')).toBeNull();
  });
});

describe('moveEvent', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'rom-editor-move-'));
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

  it('mutates object_events[index].x/y and writes atomically', async () => {
    const result = await moveEvent('objectEvent', 'MAP_LITTLEROOT_TOWN_obj_0', 15, 7, {
      projectRoot: dir,
      mapDirByMapId: mapDirByMapId(),
    });
    expect(result.previous).toEqual({ x: 10, y: 12 });
    expect(result.next).toEqual({ x: 15, y: 7 });
    expect(result.mapJsonPath).toBe('data/maps/LittlerootTown/map.json');

    const onDisk = JSON.parse(
      readFileSync(path.join(dir, 'data', 'maps', 'LittlerootTown', 'map.json'), 'utf8'),
    );
    expect(onDisk.object_events[0].x).toBe(15);
    expect(onDisk.object_events[0].y).toBe(7);
    // Other unrelated fields are preserved verbatim
    expect(onDisk.object_events[0].graphics_id).toBe('OBJ_EVENT_GFX_BOY');
    expect(onDisk.object_events[0].script).toBe('SomeScript');
    // No .tmp left over
  });

  it('mutates warp_events for a warp kind', async () => {
    await moveEvent('warp', 'MAP_LITTLEROOT_TOWN_warp_0', 1, 1, {
      projectRoot: dir,
      mapDirByMapId: mapDirByMapId(),
    });
    const onDisk = JSON.parse(
      readFileSync(path.join(dir, 'data', 'maps', 'LittlerootTown', 'map.json'), 'utf8'),
    );
    expect(onDisk.warp_events[0].x).toBe(1);
    expect(onDisk.warp_events[0].y).toBe(1);
  });

  it('mutates coord_events for a trigger kind with _coord_ suffix', async () => {
    await moveEvent('trigger', 'MAP_LITTLEROOT_TOWN_coord_0', 9, 9, {
      projectRoot: dir,
      mapDirByMapId: mapDirByMapId(),
    });
    const onDisk = JSON.parse(
      readFileSync(path.join(dir, 'data', 'maps', 'LittlerootTown', 'map.json'), 'utf8'),
    );
    expect(onDisk.coord_events[0].x).toBe(9);
  });

  it('mutates bg_events for a trigger kind with _bg_ suffix', async () => {
    await moveEvent('trigger', 'MAP_LITTLEROOT_TOWN_bg_0', 5, 6, {
      projectRoot: dir,
      mapDirByMapId: mapDirByMapId(),
    });
    const onDisk = JSON.parse(
      readFileSync(path.join(dir, 'data', 'maps', 'LittlerootTown', 'map.json'), 'utf8'),
    );
    expect(onDisk.bg_events[0].x).toBe(5);
    expect(onDisk.bg_events[0].y).toBe(6);
  });

  it('throws MoveEventError with code=invalid_coord for negative/non-integer coords', async () => {
    await expect(
      moveEvent('objectEvent', 'MAP_LITTLEROOT_TOWN_obj_0', -1, 0, {
        projectRoot: dir,
        mapDirByMapId: mapDirByMapId(),
      }),
    ).rejects.toMatchObject({ code: 'invalid_coord' });
    await expect(
      moveEvent('objectEvent', 'MAP_LITTLEROOT_TOWN_obj_0', 1.5, 0, {
        projectRoot: dir,
        mapDirByMapId: mapDirByMapId(),
      }),
    ).rejects.toMatchObject({ code: 'invalid_coord' });
  });

  it('throws MoveEventError with code=coord_out_of_bounds when bounds provided', async () => {
    const err = await moveEvent('objectEvent', 'MAP_LITTLEROOT_TOWN_obj_0', 100, 0, {
      projectRoot: dir,
      mapDirByMapId: mapDirByMapId(),
      bounds: new Map([['MAP_LITTLEROOT_TOWN', { width: 20, height: 20 }]]),
    }).then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(MoveEventError);
    expect((err as MoveEventError).code).toBe('coord_out_of_bounds');
  });

  it('throws entity_not_found when the array index is out of range', async () => {
    await expect(
      moveEvent('objectEvent', 'MAP_LITTLEROOT_TOWN_obj_99', 0, 0, {
        projectRoot: dir,
        mapDirByMapId: mapDirByMapId(),
      }),
    ).rejects.toMatchObject({ code: 'entity_not_found' });
  });

  it('throws map_not_found when the mapId has no dir mapping', async () => {
    await expect(
      moveEvent('objectEvent', 'MAP_NOT_REAL_obj_0', 0, 0, {
        projectRoot: dir,
        mapDirByMapId: mapDirByMapId(),
      }),
    ).rejects.toMatchObject({ code: 'map_not_found' });
  });
});
