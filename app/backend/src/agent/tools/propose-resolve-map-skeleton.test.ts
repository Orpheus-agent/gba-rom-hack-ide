/**
 * Smoke tests for propose_resolve_map_skeleton (Phase 8G-2).
 */

import { promises as fsp, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { TileIntelClient } from '../../tile-intel/client.js';
import type { ResolveSkeletonResponse } from '../../tile-intel/types.js';
import { proposeResolveMapSkeleton } from './propose-resolve-map-skeleton.js';

function makeClient(
  response: ResolveSkeletonResponse,
): { client: TileIntelClient; requests: unknown[] } {
  const requests: unknown[] = [];
  const fetchFn = async (
    _input: string,
    init?: { body?: string; method?: string },
  ) => {
    if (init?.body) {
      try {
        requests.push(JSON.parse(init.body));
      } catch {
        requests.push(init.body);
      }
    }
    return {
      ok: true,
      status: 200,
      async json() {
        return response;
      },
      async text() {
        return JSON.stringify(response);
      },
    };
  };
  return {
    client: new TileIntelClient('http://stub', fetchFn),
    requests,
  };
}

const fakeResolved: ResolveSkeletonResponse = {
  primary_tileset_slug: 'pret-frlg-general',
  secondary_tileset_slug: 'pret-frlg-route1',
  width: 4,
  height: 3,
  grid: [
    [
      { tileset_slug: 'pret-frlg-general', metatile_index: 7 },
      { tileset_slug: 'pret-frlg-general', metatile_index: 8 },
      { tileset_slug: 'pret-frlg-route1', metatile_index: 9 },
      { tileset_slug: 'unknown-pack', metatile_index: 99 },
    ],
    [
      { tileset_slug: 'pret-frlg-general', metatile_index: 7 },
      null,
      { tileset_slug: 'pret-frlg-general', metatile_index: 8 },
      { tileset_slug: 'pret-frlg-general', metatile_index: 7 },
    ],
    [
      { tileset_slug: 'pret-frlg-route1', metatile_index: 11 },
      { tileset_slug: 'pret-frlg-route1', metatile_index: 12 },
      { tileset_slug: 'pret-frlg-route1', metatile_index: 13 },
      { tileset_slug: 'pret-frlg-route1', metatile_index: 14 },
    ],
  ],
  tag_grid: [
    [['terrain.grass'], ['terrain.grass'], ['terrain.grass'], ['terrain.grass']],
    [['terrain.grass'], ['terrain.unknown'], ['terrain.grass'], ['terrain.grass']],
    [['terrain.path'], ['terrain.path'], ['terrain.path'], ['terrain.path']],
  ],
  border_blocks: [
    [
      { tileset_slug: 'pret-frlg-general', metatile_index: 7 },
      { tileset_slug: 'pret-frlg-general', metatile_index: 7 },
    ],
    [
      { tileset_slug: 'pret-frlg-general', metatile_index: 7 },
      { tileset_slug: 'pret-frlg-general', metatile_index: 7 },
    ],
  ],
  pois: [
    { id: 'entrance', kind: 'warp', x: 0, y: 1, rect: null },
    { id: 'exit', kind: 'warp', x: 3, y: 1, rect: null },
  ],
  report: {
    seed: 42,
    width: 4,
    height: 3,
    assigned_cells: 11,
    unassigned_cells: 1,
    template_anchors_placed: 0,
    template_anchors_skipped: 0,
    rule_violations: 0,
    rules_consulted: 5,
    paths_solved: 1,
    paths_failed: 0,
    warnings: ['1 cells unassigned'],
  },
};

const fakeSkeleton = {
  version: '1.0',
  map: {
    name: 'Test Route',
    size: { w: 4, h: 3 },
    primary_tileset: 'pret-frlg-general',
    secondary_tileset: 'pret-frlg-route1',
    default_biome: 'biome.route',
  },
  regions: [],
  paths: [],
  templates: [],
  pois: [],
  constraints: [],
};

describe('propose_resolve_map_skeleton', () => {
  let projectRoot: string;
  beforeEach(() => {
    projectRoot = mkdtempSync(path.join(tmpdir(), 'resolve-test-'));
  });
  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  async function seedSkeleton(slug: string): Promise<void> {
    const dir = path.join(projectRoot, '.editor', 'skeletons');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(
      path.join(dir, `${slug}.map.json`),
      JSON.stringify(fakeSkeleton, null, 2),
      'utf8',
    );
  }

  it('rejects an invalid slug', async () => {
    const { client } = makeClient(fakeResolved);
    const result = await proposeResolveMapSkeleton(
      { projectRoot },
      {
        skeletonSlug: '../escape',
        mapGroup: 3,
        primaryTilesetOffset: 0x100000,
        secondaryTilesetOffset: 0x200000,
      },
      { clientForTests: client },
    );
    // ".." gets stripped to "escape" which is a valid slug - but the
    // file doesn't exist, so we get a not-found.
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.reason).toBe('skeleton_not_found');
  });

  it('fails clearly when the skeleton file is missing', async () => {
    const { client } = makeClient(fakeResolved);
    const result = await proposeResolveMapSkeleton(
      { projectRoot },
      {
        skeletonSlug: 'missing',
        mapGroup: 3,
        primaryTilesetOffset: 0x100000,
        secondaryTilesetOffset: 0x200000,
      },
      { clientForTests: client },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.reason).toBe('skeleton_not_found');
  });

  it('produces a 2-step plan + persists the resolved grid', async () => {
    await seedSkeleton('test-route');
    const { client, requests } = makeClient(fakeResolved);
    const result = await proposeResolveMapSkeleton(
      { projectRoot },
      {
        skeletonSlug: 'test-route',
        mapGroup: 3,
        mapNum: 11,
        primaryTilesetOffset: 0x123_4567,
        secondaryTilesetOffset: 0x089_abcd,
        seed: 42,
      },
      { clientForTests: client },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.plan.length).toBe(2);
    expect(result.plan[0]!.tool).toBe('propose_create_map');
    expect(result.plan[0]!.args).toMatchObject({
      width: 4,
      height: 3,
      mapGroup: 3,
      mapNum: 11,
      primaryTilesetOffset: 0x123_4567,
      secondaryTilesetOffset: 0x089_abcd,
      mapType: 3,
    });
    expect(result.plan[1]!.tool).toBe('propose_paint_map_blocks');
    const paintArgs = result.plan[1]!.args as {
      blockIds: number[];
      rect: { w: number; h: number };
    };
    expect(paintArgs.rect.w).toBe(4);
    expect(paintArgs.rect.h).toBe(3);
    expect(paintArgs.blockIds.length).toBe(12);
    // Cell (3, 0) referenced unknown-pack - should fall back to
    // the default block id 0x001.
    expect(paintArgs.blockIds[3]).toBe(0x001);
    // Cell (1, 1) was null - should also fall back.
    expect(paintArgs.blockIds[5]).toBe(0x001);
    // Cell (0, 0) was (general, 7).
    expect(paintArgs.blockIds[0]).toBe(7);
    // Resolved file persisted to disk.
    expect(result.resolvedPath).toBeTruthy();
    const persisted = JSON.parse(
      await fsp.readFile(result.resolvedPath!, 'utf8'),
    );
    expect(persisted.report.assigned_cells).toBe(11);
    // Summary mentions the unbound + unassigned cells.
    expect(result.summary).toContain('Cells filled: 11 / 12');
    expect(result.summary).toContain('outside the two you bound');
    expect(result.summary).toContain('propose_batch_apply');
    // Sidecar was called once with the skeleton + seed.
    expect(requests.length).toBe(1);
    expect((requests[0] as { seed: number }).seed).toBe(42);
  });

  it('forwards user-supplied defaultBlockId to unassigned cells', async () => {
    await seedSkeleton('test-route');
    const { client } = makeClient(fakeResolved);
    const result = await proposeResolveMapSkeleton(
      { projectRoot },
      {
        skeletonSlug: 'test-route',
        mapGroup: 3,
        primaryTilesetOffset: 0x100000,
        secondaryTilesetOffset: 0x200000,
        defaultBlockId: 0x042,
      },
      { clientForTests: client },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    const paintArgs = result.plan[1]!.args as { blockIds: number[] };
    // Unassigned cell at index 5 should use the user-supplied default.
    expect(paintArgs.blockIds[5]).toBe(0x042);
    // unknown-pack at index 3.
    expect(paintArgs.blockIds[3]).toBe(0x042);
  });

  it('returns sidecar_error when the resolver throws', async () => {
    await seedSkeleton('test-route');
    const fetchFn = async () => {
      throw new Error('boom');
    };
    const client = new TileIntelClient('http://stub', fetchFn);
    const result = await proposeResolveMapSkeleton(
      { projectRoot },
      {
        skeletonSlug: 'test-route',
        mapGroup: 3,
        primaryTilesetOffset: 0x100000,
        secondaryTilesetOffset: 0x200000,
      },
      { clientForTests: client },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.reason).toBe('sidecar_error');
    expect(result.message).toContain('boom');
  });
});
