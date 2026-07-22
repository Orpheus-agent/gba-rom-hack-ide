/**
 * Phase 8I - Tile-intel proxy route tests.
 *
 * Uses an injected supervisor that hands back a stub TileIntelClient
 * with a captured fetch - same pattern as the propose-* tool tests.
 * No real sidecar process needed.
 */

import { promises as fsp, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import Fastify from 'fastify';

import { registerTileIntelRoute } from './tile-intel.js';
import { ProjectSessionStore } from '../projects/session-store.js';
import type { TileIntelSupervisor } from '../tile-intel/supervisor.js';
import { TileIntelClient, type FetchLike } from '../tile-intel/client.js';
import type { TileIntelStatus } from '../tile-intel/types.js';
import { EXPECTED_SIDECAR_API_VERSION } from '../tile-intel/types.js';

function stubSupervisor(
  fetchFn: FetchLike,
  available: boolean = true,
): TileIntelSupervisor {
  const status: TileIntelStatus = available
    ? {
        available: true,
        baseUrl: 'http://stub',
        health: { ok: true, schema_version: 1, api_version: EXPECTED_SIDECAR_API_VERSION },
        version: {
          package_version: '0.1.0',
          schema_version: 1,
          api_version: EXPECTED_SIDECAR_API_VERSION,
          test_mode: true,
        },
      }
    : {
        available: false,
        reason: 'sidecar_offline',
        details: 'mock down',
      };
  return {
    baseUrl: 'http://stub',
    ensureReady: async () => status,
    shutdown: async () => undefined,
    client: () => new TileIntelClient('http://stub', fetchFn),
    // Cast - the production class has more private bits.
  } as unknown as TileIntelSupervisor;
}

function makeFetchHandler(
  responses: Record<string, unknown>,
): FetchLike {
  return async (input: string) => {
    const url = new URL(input);
    const path = url.pathname;
    const body = responses[path];
    if (body === undefined) {
      return {
        ok: false,
        status: 404,
        async json() {
          return { detail: `no stub for ${path}` };
        },
        async text() {
          return `no stub for ${path}`;
        },
      };
    }
    return {
      ok: true,
      status: 200,
      async json() {
        return body;
      },
      async text() {
        return JSON.stringify(body);
      },
    };
  };
}

async function buildApp(
  fetchFn: FetchLike,
  available = true,
  sessionStore?: ProjectSessionStore,
) {
  const app = Fastify({ logger: false });
  const supervisor = stubSupervisor(fetchFn, available);
  await app.register(async (instance) => {
    await registerTileIntelRoute(instance, {
      supervisorFactory: () => supervisor,
      sessionStore,
    });
  });
  await app.ready();
  return app;
}

describe('GET /api/tile-intel/health', () => {
  it('returns available:true when supervisor is ready', async () => {
    const app = await buildApp(makeFetchHandler({}));
    const res = await app.inject({ method: 'GET', url: '/api/tile-intel/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.available).toBe(true);
    expect(body.baseUrl).toBe('http://stub');
    expect(body.health.api_version).toBe(EXPECTED_SIDECAR_API_VERSION);
    await app.close();
  });

  it('passes through the supervisor unavailable status', async () => {
    const app = await buildApp(makeFetchHandler({}), false);
    const res = await app.inject({ method: 'GET', url: '/api/tile-intel/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.available).toBe(false);
    expect(body.reason).toBe('sidecar_offline');
    await app.close();
  });
});

describe('GET /api/tile-intel/library', () => {
  it('forwards filters as query params to the sidecar', async () => {
    let capturedUrl = '';
    const fetchFn: FetchLike = async (input: string) => {
      capturedUrl = input;
      return {
        ok: true,
        status: 200,
        async json() {
          return { total_tilesets: 0, entries: [] };
        },
        async text() {
          return '{}';
        },
      };
    };
    const app = await buildApp(fetchFn);
    const res = await app.inject({
      method: 'GET',
      url: '/api/tile-intel/library?family=frlg&isSecondary=true&limit=10',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.available).toBe(true);
    expect(body.total_tilesets).toBe(0);
    // Captured URL hit the sidecar with mapped params.
    expect(capturedUrl).toContain('/v1/tilesets/library');
    expect(capturedUrl).toContain('family=frlg');
    expect(capturedUrl).toContain('is_secondary=true');
    expect(capturedUrl).toContain('limit=10');
    await app.close();
  });

  it('returns available:false when supervisor is down', async () => {
    const app = await buildApp(makeFetchHandler({}), false);
    const res = await app.inject({ method: 'GET', url: '/api/tile-intel/library' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.available).toBe(false);
    await app.close();
  });
});

describe('POST /api/tile-intel/neighbors', () => {
  it('proxies the body to the sidecar verbatim', async () => {
    let capturedBody: unknown = null;
    const fetchFn: FetchLike = async (_input, init) => {
      if (init?.body) capturedBody = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            seed_tileset_slug: 'ts-a',
            seed_metatile_index: 0,
            direction: 2,
            total_observations: 5,
            entropy: 0.5,
            suggestions: [],
          };
        },
        async text() {
          return '{}';
        },
      };
    };
    const app = await buildApp(fetchFn);
    const res = await app.inject({
      method: 'POST',
      url: '/api/tile-intel/neighbors',
      payload: {
        tileset_slug: 'ts-a',
        metatile_index: 0,
        direction: 2,
        limit: 6,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.available).toBe(true);
    expect(body.total_observations).toBe(5);
    expect(capturedBody).toMatchObject({
      tileset_slug: 'ts-a',
      metatile_index: 0,
      direction: 2,
      limit: 6,
    });
    await app.close();
  });
});

describe('POST /api/tile-intel/generate/skeleton', () => {
  it('passes the request through and returns the sidecar response', async () => {
    const fetchFn = makeFetchHandler({
      '/v1/generate/skeleton': {
        skeleton: {
          version: '1.0',
          map: { name: 'demo', size: { w: 8, h: 8 } },
        },
        report: {
          seed: 1,
          chosen_templates: [],
          chosen_primary_tileset: 'p',
          chosen_secondary_tileset: 's',
          warnings: [],
          region_count: 1,
          poi_count: 2,
          path_count: 1,
          template_anchor_count: 0,
          constraint_count: 1,
        },
      },
    });
    const app = await buildApp(fetchFn);
    const res = await app.inject({
      method: 'POST',
      url: '/api/tile-intel/generate/skeleton',
      payload: { theme: 'route', biome: 'biome.route', seed: 1 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.available).toBe(true);
    expect(body.skeleton.map.name).toBe('demo');
    await app.close();
  });
});

describe('GET /api/tile-intel/templates/by-biome', () => {
  it('forwards the biome query + returns sidecar body', async () => {
    let captured = '';
    const fetchFn: FetchLike = async (input: string) => {
      captured = input;
      return {
        ok: true,
        status: 200,
        async json() {
          return { biome: 'biome.route', templates: [] };
        },
        async text() {
          return '{}';
        },
      };
    };
    const app = await buildApp(fetchFn);
    const res = await app.inject({
      method: 'GET',
      url: '/api/tile-intel/templates/by-biome?biome=biome.route&limit=5',
    });
    expect(res.statusCode).toBe(200);
    expect(captured).toContain('/v1/grammar/templates/by-biome');
    expect(captured).toContain('biome=biome.route');
    expect(captured).toContain('limit=5');
    await app.close();
  });
});

describe('Phase 8I-3 - skeleton + resolved-map file routes', () => {
  let projectRoot: string;
  let sessionStore: ProjectSessionStore;
  let sessionId: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(path.join(tmpdir(), 'tile-intel-skel-'));
    sessionStore = new ProjectSessionStore();
    sessionId = sessionStore.create(projectRoot).id;
  });
  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  async function seedSkeleton(slug: string, body: object) {
    const dir = path.join(projectRoot, '.editor', 'skeletons');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(
      path.join(dir, `${slug}.map.json`),
      JSON.stringify(body),
      'utf8',
    );
  }

  it('returns empty list when no skeletons exist', async () => {
    const app = await buildApp(
      makeFetchHandler({}),
      true,
      sessionStore,
    );
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${sessionId}/skeletons`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().entries).toEqual([]);
    await app.close();
  });

  it('lists skeleton metadata for every readable .map.json', async () => {
    await seedSkeleton('forest-1', {
      version: '1.0',
      map: {
        name: 'Forest Test',
        size: { w: 24, h: 32 },
        primary_tileset: 'pret-frlg-general',
        secondary_tileset: 'pret-frlg-viridian-forest',
        default_biome: 'biome.forest',
      },
      regions: [{}, {}],
      pois: [{}, {}, {}],
      paths: [{}],
      templates: [],
      constraints: [{}],
    });
    const app = await buildApp(
      makeFetchHandler({}),
      true,
      sessionStore,
    );
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${sessionId}/skeletons`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]).toMatchObject({
      slug: 'forest-1',
      name: 'Forest Test',
      width: 24,
      height: 32,
      defaultBiome: 'biome.forest',
      regionCount: 2,
      poiCount: 3,
      pathCount: 1,
      templateCount: 0,
      constraintCount: 1,
    });
    await app.close();
  });

  it('returns 404 for an unknown skeleton slug', async () => {
    const app = await buildApp(
      makeFetchHandler({}),
      true,
      sessionStore,
    );
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${sessionId}/skeletons/no-such-slug`,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'skeleton_not_found' });
    await app.close();
  });

  it('returns the full skeleton body when fetched by slug', async () => {
    await seedSkeleton('cave-1', {
      version: '1.0',
      map: { name: 'Cave', size: { w: 16, h: 16 } },
    });
    const app = await buildApp(
      makeFetchHandler({}),
      true,
      sessionStore,
    );
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${sessionId}/skeletons/cave-1`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().body.map.name).toBe('Cave');
    await app.close();
  });

  it('rejects path-traversal slugs', async () => {
    const app = await buildApp(
      makeFetchHandler({}),
      true,
      sessionStore,
    );
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${sessionId}/skeletons/..%2Fescape`,
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('returns 404 for an unknown session id', async () => {
    const app = await buildApp(
      makeFetchHandler({}),
      true,
      sessionStore,
    );
    const res = await app.inject({
      method: 'GET',
      url: '/api/projects/no-such-session/skeletons',
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
