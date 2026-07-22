/**
 * Smoke tests for the four Phase 8H interactive tile tools:
 *
 *   - propose_suggest_tile_neighbors  (8H-1)
 *   - propose_complete_region         (8H-2)
 *   - propose_browse_tileset_library  (8H-3)
 *   - propose_apply_template          (8H-4)
 *
 * All four are read-only / plan-only wrappers around sidecar
 * endpoints, so we test them with the same injected `clientForTests`
 * pattern used for the 8G tools - no real sidecar process needed.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { TileIntelClient } from '../../tile-intel/client.js';
import type {
  ApplyTemplateResponse,
  CompleteRegionResponse,
  SuggestNeighborsResponse,
  TilesetLibraryResponse,
} from '../../tile-intel/types.js';
import { proposeApplyTemplate } from './propose-apply-template.js';
import { proposeBrowseTilesetLibrary } from './propose-browse-tileset-library.js';
import { proposeCompleteRegion } from './propose-complete-region.js';
import { proposeSuggestTileNeighbors } from './propose-suggest-tile-neighbors.js';

function makeClient(response: unknown): {
  client: TileIntelClient;
  requests: { url: string; body: unknown }[];
} {
  const requests: { url: string; body: unknown }[] = [];
  const fetchFn = async (
    input: string,
    init?: { body?: string; method?: string },
  ) => {
    let body: unknown = undefined;
    if (init?.body) {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    requests.push({ url: input, body });
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
  return { client: new TileIntelClient('http://stub', fetchFn), requests };
}

function makeErrorClient(message: string, status = 500): TileIntelClient {
  const fetchFn = async () => ({
    ok: false,
    status,
    async json() {
      return { detail: message };
    },
    async text() {
      return message;
    },
  });
  return new TileIntelClient('http://stub', fetchFn);
}

describe('propose_suggest_tile_neighbors (8H-1)', () => {
  let projectRoot: string;
  beforeEach(() => {
    projectRoot = mkdtempSync(path.join(tmpdir(), 'tools-8h-test-'));
  });
  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  const fakeResponse: SuggestNeighborsResponse = {
    seed_tileset_slug: 'pret-frlg-route1',
    seed_metatile_index: 42,
    direction: 2,
    total_observations: 50,
    entropy: 0.5,
    suggestions: [
      {
        tileset_slug: 'pret-frlg-route1',
        metatile_index: 11,
        probability: 0.7,
        support_count: 35,
        behavior_id: 1,
        is_walkable: true,
        phash_hex: '0b0b0b0b0b0b0b0b',
        seed_tags_sample: [],
      },
      {
        tileset_slug: 'pret-frlg-route1',
        metatile_index: 12,
        probability: 0.3,
        support_count: 15,
        behavior_id: 1,
        is_walkable: false,
        phash_hex: '0c0c0c0c0c0c0c0c',
        seed_tags_sample: [],
      },
    ],
  };

  it('maps direction names to codes + summarises results', async () => {
    const { client, requests } = makeClient(fakeResponse);
    const result = await proposeSuggestTileNeighbors(
      { projectRoot },
      { tilesetSlug: 'pret-frlg-route1', metatileIndex: 42, direction: 'east' },
      { clientForTests: client },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.suggestions.length).toBe(2);
    // east → direction code 2.
    expect((requests[0]!.body as { direction: number }).direction).toBe(2);
    // Plain English summary mentions both suggestions.
    expect(result.summary).toContain('pret-frlg-route1 / 11');
    expect(result.summary).toContain('70%');
    expect(result.summary).toContain('walkable');
    expect(result.summary).toContain('35 maps');
  });

  it('returns empty-state summary when no rule exists', async () => {
    const emptyResponse: SuggestNeighborsResponse = {
      seed_tileset_slug: 'pret-frlg-route1',
      seed_metatile_index: 0,
      direction: 0,
      total_observations: 0,
      entropy: 0,
      suggestions: [],
    };
    const { client } = makeClient(emptyResponse);
    const result = await proposeSuggestTileNeighbors(
      { projectRoot },
      { tilesetSlug: 'pret-frlg-route1', metatileIndex: 0, direction: 'north' },
      { clientForTests: client },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.summary).toContain('No observed neighbours');
  });

  it('surfaces seed_not_found for 404 from sidecar', async () => {
    const client = makeErrorClient('not found', 404);
    const result = await proposeSuggestTileNeighbors(
      { projectRoot },
      { tilesetSlug: 'unknown', metatileIndex: 0, direction: 'east' },
      { clientForTests: client },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.reason).toBe('seed_not_found');
  });
});

describe('propose_complete_region (8H-2)', () => {
  const fakeResponse: CompleteRegionResponse = {
    width: 2,
    height: 2,
    cells: [
      { x: 0, y: 0, tileset_slug: 'ts-pri', metatile_index: 1 },
      { x: 1, y: 0, tileset_slug: 'ts-pri', metatile_index: 1 },
      { x: 0, y: 1, tileset_slug: 'ts-pri', metatile_index: 1 },
      { x: 1, y: 1, tileset_slug: 'ts-pri', metatile_index: 1 },
    ],
    unassigned_cells: 0,
    rule_violations: 1,
    rules_consulted: 4,
  };

  let projectRoot: string;
  beforeEach(() => {
    projectRoot = mkdtempSync(path.join(tmpdir(), 'tools-8h-test-'));
  });
  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('returns the filled cells + computed rule respect %', async () => {
    const { client } = makeClient(fakeResponse);
    const result = await proposeCompleteRegion(
      { projectRoot },
      {
        width: 2,
        height: 2,
        tagGrid: [
          [['terrain.grass'], ['terrain.grass']],
          [['terrain.grass'], ['terrain.grass']],
        ],
        primaryTilesetSlug: 'ts-pri',
        secondaryTilesetSlug: 'ts-sec',
      },
      { clientForTests: client },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.cells.length).toBe(4);
    // 3 of 4 consulted rules respected = 75%.
    expect(result.summary).toContain('Adjacency rule respect: 75%');
  });

  it('rejects mismatched tagGrid dimensions before calling sidecar', async () => {
    const { client, requests } = makeClient(fakeResponse);
    const result = await proposeCompleteRegion(
      { projectRoot },
      {
        width: 2,
        height: 2,
        // Only 1 row, but height says 2.
        tagGrid: [[['terrain.grass'], ['terrain.grass']]],
        primaryTilesetSlug: 'ts-pri',
        secondaryTilesetSlug: 'ts-sec',
      },
      { clientForTests: client },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.reason).toBe('invalid_input');
    expect(requests.length).toBe(0);
  });
});

describe('propose_browse_tileset_library (8H-3)', () => {
  const fakeResponse: TilesetLibraryResponse = {
    total_tilesets: 2,
    entries: [
      {
        slug: 'pret-frlg-route1',
        display_name: 'FRLG Route 1',
        family: 'frlg',
        is_secondary: false,
        source: 'pret-firered',
        source_commit: 'abc1234',
        license_spdx: 'MIT',
        attribution: 'pret/pokefirered',
        metatile_count: 256,
        palette_count: 6,
      },
      {
        slug: 'pret-frlg-route2-secondary',
        display_name: 'FRLG Route 2 (secondary)',
        family: 'frlg',
        is_secondary: true,
        source: 'pret-firered',
        source_commit: 'abc1234',
        license_spdx: 'MIT',
        attribution: 'pret/pokefirered',
        metatile_count: 512,
        palette_count: 10,
      },
    ],
  };

  let projectRoot: string;
  beforeEach(() => {
    projectRoot = mkdtempSync(path.join(tmpdir(), 'tools-8h-test-'));
  });
  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('forwards filters to the sidecar as query params', async () => {
    const { client, requests } = makeClient(fakeResponse);
    const result = await proposeBrowseTilesetLibrary(
      { projectRoot },
      { family: 'frlg', isSecondary: true, source: 'pret-firered', limit: 50 },
      { clientForTests: client },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.entries.length).toBe(2);
    // The fetch URL carries the query string.
    expect(requests[0]!.url).toContain('family=frlg');
    expect(requests[0]!.url).toContain('is_secondary=true');
    expect(requests[0]!.url).toContain('source=pret-firered');
    expect(requests[0]!.url).toContain('limit=50');
    // Summary mentions attribution per entry.
    expect(result.summary).toContain('pret-frlg-route1');
    expect(result.summary).toContain('pret/pokefirered');
  });
});

describe('propose_apply_template (8H-4)', () => {
  const fakeResponse: ApplyTemplateResponse = {
    template_slug: 'pattern-3x3-deadbeef',
    role: 'uniform_terrain.grass.tall',
    width: 3,
    height: 3,
    cells: [
      { x: 5, y: 7, tileset_slug: 'ts-pri', metatile_index: 1 },
      { x: 6, y: 7, tileset_slug: 'ts-pri', metatile_index: 1 },
      { x: 7, y: 7, tileset_slug: 'ts-pri', metatile_index: 1 },
      { x: 5, y: 8, tileset_slug: 'ts-pri', metatile_index: 1 },
      { x: 6, y: 8, tileset_slug: 'ts-pri', metatile_index: 1 },
      { x: 7, y: 8, tileset_slug: 'ts-pri', metatile_index: 1 },
      { x: 5, y: 9, tileset_slug: 'ts-pri', metatile_index: 1 },
      { x: 6, y: 9, tileset_slug: 'ts-pri', metatile_index: 1 },
      { x: 7, y: 9, tileset_slug: 'ts-pri', metatile_index: 1 },
    ],
    cells_out_of_bounds: 0,
  };

  let projectRoot: string;
  beforeEach(() => {
    projectRoot = mkdtempSync(path.join(tmpdir(), 'tools-8h-test-'));
  });
  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('emits a single propose_paint_map_blocks plan covering the template', async () => {
    const { client } = makeClient(fakeResponse);
    const result = await proposeApplyTemplate(
      { projectRoot },
      {
        mapId: 'binary_map_3_19',
        templateSlug: 'pattern-3x3-deadbeef',
        anchorX: 5,
        anchorY: 7,
      },
      { clientForTests: client },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.plan.length).toBe(1);
    const plan = result.plan[0]!;
    expect(plan.tool).toBe('propose_paint_map_blocks');
    expect(plan.args.rect).toEqual({ x: 5, y: 7, w: 3, h: 3 });
    expect(plan.args.mode).toBe('explicit');
    expect(plan.args.blockIds.length).toBe(9);
    expect(plan.args.blockIds.every((id) => id === 1)).toBe(true);
    expect(plan.args.mapId).toBe('binary_map_3_19');
  });

  it('surfaces template_not_found for 404 from sidecar', async () => {
    const client = makeErrorClient('template not found', 404);
    const result = await proposeApplyTemplate(
      { projectRoot },
      {
        mapId: 'binary_map_3_19',
        templateSlug: 'no-such-template',
        anchorX: 0,
        anchorY: 0,
      },
      { clientForTests: client },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.reason).toBe('template_not_found');
  });

  it('returns empty plan when no cells came back', async () => {
    const emptyResponse: ApplyTemplateResponse = {
      ...fakeResponse,
      cells: [],
      cells_out_of_bounds: 9,
    };
    const { client } = makeClient(emptyResponse);
    const result = await proposeApplyTemplate(
      { projectRoot },
      {
        mapId: 'binary_map_3_19',
        templateSlug: 'pattern-3x3-deadbeef',
        anchorX: 1024,
        anchorY: 1024,
      },
      { clientForTests: client },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.plan.length).toBe(0);
    expect(result.cellsOutOfBounds).toBe(9);
  });
});
