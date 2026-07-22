/**
 * Smoke tests for propose_generate_map_skeleton (Phase 8G-1).
 *
 * Uses an injected `clientForTests` (no sidecar process, no network)
 * to verify:
 *   - Input validation (mismatched width/height pair).
 *   - Happy path persists the skeleton to disk + composes a
 *     plain-English summary.
 *   - Sidecar errors surface as structured failures, not exceptions.
 */

import { promises as fsp } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { TileIntelClient } from '../../tile-intel/client.js';
import type { GenerateSkeletonResponse } from '../../tile-intel/types.js';
import { proposeGenerateMapSkeleton } from './propose-generate-map-skeleton.js';

/**
 * Build a TileIntelClient whose generateSkeleton() returns a canned
 * response. We construct a real TileIntelClient with a stub fetch
 * because the tool only calls `generateSkeleton`, but other tests
 * may want to assert the request body - so we capture it.
 */
function clientStub(
  response: GenerateSkeletonResponse,
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
  const client = new TileIntelClient('http://stub', fetchFn);
  return { client, requests };
}

function clientErrorStub(message: string): TileIntelClient {
  const fetchFn = async () => {
    throw new Error(message);
  };
  return new TileIntelClient('http://stub', fetchFn);
}

const fakeSkeleton: GenerateSkeletonResponse = {
  skeleton: {
    version: '1.0',
    map: {
      name: 'Forest (auto-generated)',
      size: { w: 28, h: 32 },
      primary_tileset: 'pret-frlg-general',
      secondary_tileset: 'pret-frlg-viridian-forest',
      default_biome: 'biome.forest',
      elevation: { layers: 1, default_layer: 0 },
    },
    regions: [
      {
        id: 'bg',
        shape: { kind: 'rect', x: 0, y: 0, w: 28, h: 32 },
        biome: 'biome.forest',
        tags: { terrain: 'terrain.grass.tall', density: 'medium' },
        elevation: 0,
        priority: 0,
      },
    ],
    paths: [],
    templates: [],
    pois: [
      {
        id: 'entrance',
        kind: 'warp',
        shape: null,
        x: 14,
        y: 1,
        metadata: { role: 'entrance' },
      },
      {
        id: 'exit',
        kind: 'warp',
        shape: null,
        x: 14,
        y: 30,
        metadata: { role: 'exit' },
      },
    ],
    constraints: [],
  },
  report: {
    seed: 7,
    chosen_templates: [],
    chosen_primary_tileset: 'pret-frlg-general',
    chosen_secondary_tileset: 'pret-frlg-viridian-forest',
    warnings: ['no templates in DB for biome=\'biome.forest\''],
    region_count: 1,
    poi_count: 2,
    path_count: 0,
    template_anchor_count: 0,
    constraint_count: 0,
  },
};

describe('propose_generate_map_skeleton', () => {
  let projectRoot: string;
  beforeEach(() => {
    projectRoot = mkdtempSync(path.join(tmpdir(), 'skeleton-test-'));
  });
  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('rejects mismatched width/height pair before calling sidecar', async () => {
    const { client, requests } = clientStub(fakeSkeleton);
    const result = await proposeGenerateMapSkeleton(
      { projectRoot },
      { theme: 'route', biome: 'biome.route', width: 20 },
      { clientForTests: client },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.reason).toBe('invalid_input');
    expect(requests.length).toBe(0); // sidecar never called.
  });

  it('persists the skeleton + returns friendly summary', async () => {
    const { client, requests } = clientStub(fakeSkeleton);
    const result = await proposeGenerateMapSkeleton(
      { projectRoot },
      {
        theme: 'forest',
        biome: 'biome.forest',
        seed: 7,
        density: 'medium',
      },
      { clientForTests: client },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.slug).toBe('forest-auto-generated');
    expect(result.persistedPath).toBeTruthy();
    expect(result.persistedPath!).toMatch(/skeletons[\\/]forest-auto-generated\.map\.json$/);
    // File contains the skeleton.
    const body = await fsp.readFile(result.persistedPath!, 'utf8');
    const parsed = JSON.parse(body);
    expect(parsed.version).toBe('1.0');
    expect(parsed.map.name).toBe('Forest (auto-generated)');
    // Summary is plain-English (no slugs or hex).
    expect(result.summary).toContain('Map outline ready');
    expect(result.summary).toContain('28 × 32');
    expect(result.summary).toContain('Forest (auto-generated)');
    expect(result.summary).toContain('propose_resolve_map_skeleton');
    // Sidecar was called with mapped snake_case fields.
    expect(requests.length).toBe(1);
    expect(requests[0]).toMatchObject({
      theme: 'forest',
      biome: 'biome.forest',
      seed: 7,
      density: 'medium',
    });
  });

  it('forwards user-supplied name + tileset overrides to the sidecar', async () => {
    const { client, requests } = clientStub({
      ...fakeSkeleton,
      skeleton: {
        ...fakeSkeleton.skeleton,
        map: {
          ...(fakeSkeleton.skeleton as { map: object }).map,
          name: 'Whispering Woods',
        },
      },
    });
    const result = await proposeGenerateMapSkeleton(
      { projectRoot },
      {
        theme: 'forest',
        biome: 'biome.forest',
        name: 'Whispering Woods',
        primaryTileset: 'pret-frlg-route1',
        secondaryTileset: 'pret-frlg-viridian-forest',
      },
      { clientForTests: client },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.slug).toBe('whispering-woods');
    expect(requests[0]).toMatchObject({
      name: 'Whispering Woods',
      primary_tileset: 'pret-frlg-route1',
      secondary_tileset: 'pret-frlg-viridian-forest',
    });
  });

  it('returns structured failure when the sidecar errors', async () => {
    const result = await proposeGenerateMapSkeleton(
      { projectRoot },
      { theme: 'route', biome: 'biome.route' },
      { clientForTests: clientErrorStub('ECONNRESET') },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.reason).toBe('sidecar_error');
    expect(result.message).toContain('ECONNRESET');
  });

  it('surfaces sidecar warnings in the summary', async () => {
    const { client } = clientStub(fakeSkeleton);
    const result = await proposeGenerateMapSkeleton(
      { projectRoot },
      { theme: 'forest', biome: 'biome.forest', seed: 7 },
      { clientForTests: client },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.summary).toContain('no templates in DB');
  });
});
