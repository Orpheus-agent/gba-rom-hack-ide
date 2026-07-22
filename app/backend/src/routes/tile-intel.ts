/**
 * Phase 8I - Tile-intel proxy routes.
 *
 * Frontend → Fastify backend → Python sidecar.  The frontend never
 * talks directly to the sidecar (different port, would need CORS),
 * and the supervisor lives in the Node backend anyway.  These
 * routes are thin shims over `TileIntelClient`.
 *
 * Every route returns a discriminated union mirroring the sidecar
 * client pattern: `{ available: true, … }` or `{ available: false,
 * reason }` - frontend renders the disabled state without throwing.
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';

import type { FastifyInstance } from 'fastify';

import type { ProjectSessionStore } from '../projects/session-store.js';
import {
  getDefaultTileIntelSupervisor,
  type TileIntelSupervisor,
} from '../tile-intel/supervisor.js';
import { TileIntelClient, TileIntelHttpError } from '../tile-intel/client.js';
import type {
  ApplyTemplateResponse,
  CompleteRegionResponse,
  GenerateSkeletonResponse,
  ResolveSkeletonResponse,
  SuggestNeighborsResponse,
  TileIntelUnavailable,
  TilesetLibraryResponse,
  ValidateTraversalResponse,
} from '../tile-intel/types.js';

export interface RegisterTileIntelRouteOptions {
  /** Inject a supervisor for tests. Production uses
   *  `getDefaultTileIntelSupervisor()`. */
  readonly supervisorFactory?: () => TileIntelSupervisor;
  /** Session store used by the Phase 8I-3 skeleton-listing routes
   *  to resolve `<projectRoot>/.editor/skeletons/`. Optional - when
   *  omitted, those routes return 503. */
  readonly sessionStore?: ProjectSessionStore;
}

/** Discriminated union mirror of the sidecar's TileIntelUnavailable +
 *  the wrapped success body. The frontend renders `available:false`
 *  states inline (e.g. "Tile intelligence is offline - start the
 *  sidecar to enable this panel"). */
export type TileIntelProxyResult<T> =
  | ({ readonly available: true } & T)
  | TileIntelUnavailable;

async function withClient<T>(
  factory: () => TileIntelSupervisor,
  fn: (client: TileIntelClient) => Promise<T>,
): Promise<TileIntelProxyResult<T>> {
  const supervisor = factory();
  const status = await supervisor.ensureReady();
  if (!status.available) {
    return status;
  }
  // Build the client via supervisor.client() so the supervisor's
  // fetchFn (real fetch in production, stub in tests) flows through.
  const client = supervisor.client
    ? supervisor.client()
    : new TileIntelClient(status.baseUrl);
  try {
    const body = await fn(client);
    return { available: true, ...body };
  } catch (e) {
    // Map TileIntelHttpError 5xx → sidecar_offline so the UI degrades
    // cleanly. 4xx surfaces verbatim through Fastify's error path
    // (the route handler re-throws below).
    if (e instanceof TileIntelHttpError && e.status >= 500) {
      return {
        available: false,
        reason: 'sidecar_offline',
        details: e.body,
      };
    }
    throw e;
  }
}

export async function registerTileIntelRoute(
  app: FastifyInstance,
  options: RegisterTileIntelRouteOptions = {},
): Promise<void> {
  const factory =
    options.supervisorFactory ?? (() => getDefaultTileIntelSupervisor());

  // --- Health / readiness ---------------------------------------------------

  app.get('/api/tile-intel/health', async () => {
    const supervisor = factory();
    const status = await supervisor.ensureReady();
    if (!status.available) {
      return status;
    }
    return {
      available: true as const,
      health: status.health,
      version: status.version,
      baseUrl: status.baseUrl,
    };
  });

  // --- Library browse (8I-1, 8I-3) -----------------------------------------

  app.get<{
    Querystring: {
      family?: string;
      isSecondary?: string;
      source?: string;
      licenseSpdx?: string;
      limit?: string;
      offset?: string;
    };
  }>('/api/tile-intel/library', async (request) => {
    const q = request.query;
    return withClient<TilesetLibraryResponse>(factory, (client) =>
      client.browseTilesetLibrary({
        family: q.family,
        isSecondary:
          q.isSecondary === undefined
            ? undefined
            : q.isSecondary.toLowerCase() === 'true',
        source: q.source,
        licenseSpdx: q.licenseSpdx,
        limit: q.limit ? Number.parseInt(q.limit, 10) : undefined,
        offset: q.offset ? Number.parseInt(q.offset, 10) : undefined,
      }),
    );
  });

  // --- Neighbours (8I-2) ----------------------------------------------------

  app.post<{
    Body: {
      tileset_slug: string;
      metatile_index: number;
      direction: number;
      limit?: number;
    };
  }>('/api/tile-intel/neighbors', async (request) => {
    return withClient<SuggestNeighborsResponse>(factory, (client) =>
      client.suggestNeighbors(request.body),
    );
  });

  // --- Region completion (8I-2) --------------------------------------------

  app.post<{
    Body: {
      width: number;
      height: number;
      tag_grid: string[][][];
      seed_cells?: Record<
        string,
        { tileset_slug: string; metatile_index: number }
      >;
      primary_tileset_slug: string;
      secondary_tileset_slug: string;
      seed?: number;
    };
  }>('/api/tile-intel/regions/complete', async (request) => {
    return withClient<CompleteRegionResponse>(factory, (client) =>
      client.completeRegion(request.body),
    );
  });

  // --- Template apply (8I-2) -----------------------------------------------

  app.post<{
    Body: {
      template_slug: string;
      anchor: { x: number; y: number };
      tag_bindings?: Record<string, string>;
      map_width?: number;
      map_height?: number;
    };
  }>('/api/tile-intel/templates/apply', async (request) => {
    return withClient<ApplyTemplateResponse>(factory, (client) =>
      client.applyTemplate(request.body),
    );
  });

  // --- Templates list (8I-1) -----------------------------------------------

  app.get<{
    Querystring: {
      role?: string;
      limit?: string;
    };
  }>('/api/tile-intel/templates', async (request) => {
    const q = request.query;
    return withClient(factory, async (client) => {
      // Re-use the raw fetch since browseTilesetLibrary doesn't cover
      // this endpoint - we call /v1/grammar/templates directly.
      const params = new URLSearchParams();
      if (q.role) params.set('role', q.role);
      if (q.limit) params.set('limit', q.limit);
      const url = `${client['baseUrl'].replace(/\/$/, '')}/v1/grammar/templates${
        params.toString() ? `?${params.toString()}` : ''
      }`;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const response = await (client as unknown as { fetchFn: any }).fetchFn(
        url,
        { method: 'GET' },
      );
      const body = await response.json();
      return body as { templates: ReadonlyArray<unknown> };
    });
  });

  // --- Templates by biome (8I-1) -------------------------------------------

  app.get<{
    Querystring: { biome: string; limit?: string };
  }>('/api/tile-intel/templates/by-biome', async (request) => {
    const q = request.query;
    return withClient(factory, async (client) => {
      const params = new URLSearchParams();
      params.set('biome', q.biome);
      if (q.limit) params.set('limit', q.limit);
      const url = `${client['baseUrl'].replace(/\/$/, '')}/v1/grammar/templates/by-biome?${params.toString()}`;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const response = await (client as unknown as { fetchFn: any }).fetchFn(
        url,
        { method: 'GET' },
      );
      const body = await response.json();
      return body as {
        biome: string;
        templates: ReadonlyArray<unknown>;
      };
    });
  });

  // --- Biome coverage (8I-1) -----------------------------------------------

  app.get('/api/tile-intel/biome-coverage', async () => {
    return withClient(factory, async (client) => {
      const url = `${client['baseUrl'].replace(/\/$/, '')}/v1/grammar/templates/biome-coverage`;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const response = await (client as unknown as { fetchFn: any }).fetchFn(
        url,
        { method: 'GET' },
      );
      const body = await response.json();
      return body as { biomes: Record<string, number> };
    });
  });

  // --- Generation passthroughs (8I-3 skeleton editor) ----------------------

  app.post<{
    Body: {
      theme: string;
      biome: string;
      width?: number;
      height?: number;
      density?: 'low' | 'medium' | 'high';
      elevation_layers?: number;
      seed?: number;
      name?: string;
      primary_tileset?: string;
      secondary_tileset?: string;
      skip_templates?: boolean;
    };
  }>('/api/tile-intel/generate/skeleton', async (request) => {
    return withClient<GenerateSkeletonResponse>(factory, (client) =>
      // The request body matches the sidecar shape verbatim.
      client.generateSkeleton(
        request.body as Parameters<TileIntelClient['generateSkeleton']>[0],
      ),
    );
  });

  app.post<{
    Body: { skeleton: Record<string, unknown>; seed?: number };
  }>('/api/tile-intel/generate/resolve', async (request) => {
    return withClient<ResolveSkeletonResponse>(factory, (client) =>
      client.resolveSkeleton(request.body),
    );
  });

  app.post<{
    Body: { resolved: Record<string, unknown> };
  }>('/api/tile-intel/generate/validate-traversal', async (request) => {
    return withClient<ValidateTraversalResponse>(factory, (client) =>
      client.validateTraversal(request.body),
    );
  });

  // -------------------------------------------------------------------------
  // Phase 8J-1 - Generated-map harness proxy
  // -------------------------------------------------------------------------

  app.post<{
    Body: {
      resolved: Record<string, unknown>;
      baseline_fingerprint?: string;
    };
  }>('/api/tile-intel/generate/harness', async (request) => {
    return withClient(factory, async (client) => {
      const url = `${client['baseUrl'].replace(/\/$/, '')}/v1/generate/harness`;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const response = await (client as unknown as { fetchFn: any }).fetchFn(
        url,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request.body),
        },
      );
      return (await response.json()) as Record<string, unknown>;
    });
  });

  // -------------------------------------------------------------------------
  // Phase 8J-2 - Curation overrides proxy
  // -------------------------------------------------------------------------

  app.get<{
    Querystring: {
      kind?: string;
      label?: string;
      project_id?: string;
      limit?: string;
      offset?: string;
    };
  }>('/api/tile-intel/curation/overrides', async (request) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(request.query)) {
      if (value !== undefined) params.set(key, String(value));
    }
    const qs = params.toString();
    return withClient(factory, async (client) => {
      const url = `${client['baseUrl'].replace(/\/$/, '')}/v1/curation/overrides${qs ? `?${qs}` : ''}`;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const response = await (client as unknown as { fetchFn: any }).fetchFn(
        url,
        { method: 'GET' },
      );
      return (await response.json()) as Record<string, unknown>;
    });
  });

  app.post<{
    Body: {
      kind: string;
      label: string;
      weight?: number;
      payload: Record<string, unknown>;
      note?: string;
      scope?: 'global' | 'project';
      project_id?: string;
    };
  }>('/api/tile-intel/curation/overrides', async (request) => {
    return withClient(factory, async (client) => {
      const url = `${client['baseUrl'].replace(/\/$/, '')}/v1/curation/overrides`;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const response = await (client as unknown as { fetchFn: any }).fetchFn(
        url,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request.body),
        },
      );
      return (await response.json()) as Record<string, unknown>;
    });
  });

  app.delete<{ Params: { id: string } }>(
    '/api/tile-intel/curation/overrides/:id',
    async (request) => {
      return withClient(factory, async (client) => {
        const url = `${client['baseUrl'].replace(/\/$/, '')}/v1/curation/overrides/${request.params.id}`;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const response = await (client as unknown as { fetchFn: any }).fetchFn(
          url,
          { method: 'DELETE' },
        );
        return (await response.json()) as Record<string, unknown>;
      });
    },
  );

  app.get<{ Querystring: { project_id?: string } }>(
    '/api/tile-intel/curation/summary',
    async (request) => {
      const params = new URLSearchParams();
      if (request.query.project_id !== undefined) {
        params.set('project_id', request.query.project_id);
      }
      return withClient(factory, async (client) => {
        const url = `${client['baseUrl'].replace(/\/$/, '')}/v1/curation/overrides/summary${
          params.toString() ? `?${params.toString()}` : ''
        }`;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const response = await (client as unknown as { fetchFn: any }).fetchFn(
          url,
          { method: 'GET' },
        );
        return (await response.json()) as Record<string, unknown>;
      });
    },
  );

  // -------------------------------------------------------------------------
  // Phase 8I-3 - Skeleton + resolved-map file listing (project-scoped)
  // -------------------------------------------------------------------------

  const sessionStore = options.sessionStore;
  const SAFE_SLUG = /^[a-zA-Z0-9._-]+$/;

  /** Lift a skeleton document into its essential metadata so the
   *  frontend list view doesn't need to render the whole JSON. */
  function skeletonMetadata(slug: string, raw: unknown): SkeletonEntry {
    const safe = (raw ?? {}) as {
      version?: string;
      map?: {
        name?: string;
        size?: { w?: number; h?: number };
        primary_tileset?: string;
        secondary_tileset?: string;
        default_biome?: string;
      };
      regions?: ReadonlyArray<unknown>;
      pois?: ReadonlyArray<unknown>;
      paths?: ReadonlyArray<unknown>;
      templates?: ReadonlyArray<unknown>;
      constraints?: ReadonlyArray<unknown>;
    };
    return {
      slug,
      name: safe.map?.name ?? slug,
      version: safe.version ?? 'unknown',
      width: safe.map?.size?.w ?? 0,
      height: safe.map?.size?.h ?? 0,
      primaryTileset: safe.map?.primary_tileset ?? '',
      secondaryTileset: safe.map?.secondary_tileset ?? '',
      defaultBiome: safe.map?.default_biome ?? '',
      regionCount: safe.regions?.length ?? 0,
      poiCount: safe.pois?.length ?? 0,
      pathCount: safe.paths?.length ?? 0,
      templateCount: safe.templates?.length ?? 0,
      constraintCount: safe.constraints?.length ?? 0,
    };
  }

  app.get<{
    Params: { id: string };
  }>('/api/projects/:id/skeletons', async (request, reply) => {
    if (!sessionStore) {
      return reply.code(503).send({ error: 'session_store_not_wired' });
    }
    const session = sessionStore.get(request.params.id);
    if (!session) {
      return reply.code(404).send({ error: 'session_not_found' });
    }
    const dir = path.join(session.projectRoot, '.editor', 'skeletons');
    let files: string[] = [];
    try {
      files = await fsp.readdir(dir);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return { sessionId: session.id, entries: [] as SkeletonEntry[] };
      }
      throw e;
    }
    const entries: SkeletonEntry[] = [];
    for (const file of files) {
      if (!file.endsWith('.map.json')) continue;
      const slug = file.slice(0, -'.map.json'.length);
      if (!SAFE_SLUG.test(slug)) continue;
      try {
        const raw = await fsp.readFile(path.join(dir, file), 'utf8');
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        entries.push(skeletonMetadata(slug, parsed));
      } catch {
        // Skip corrupt skeletons silently - surface only the list of
        // readable ones.
      }
    }
    return {
      sessionId: session.id,
      entries,
    };
  });

  app.get<{
    Params: { id: string; slug: string };
  }>(
    '/api/projects/:id/skeletons/:slug',
    async (request, reply) => {
      if (!sessionStore) {
        return reply.code(503).send({ error: 'session_store_not_wired' });
      }
      const session = sessionStore.get(request.params.id);
      if (!session) {
        return reply.code(404).send({ error: 'session_not_found' });
      }
      if (!SAFE_SLUG.test(request.params.slug)) {
        return reply.code(400).send({ error: 'invalid_slug' });
      }
      const file = path.join(
        session.projectRoot,
        '.editor',
        'skeletons',
        `${request.params.slug}.map.json`,
      );
      try {
        const raw = await fsp.readFile(file, 'utf8');
        return { slug: request.params.slug, body: JSON.parse(raw) };
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          return reply.code(404).send({ error: 'skeleton_not_found' });
        }
        throw e;
      }
    },
  );

  app.get<{
    Params: { id: string; slug: string };
  }>(
    '/api/projects/:id/resolved-maps/:slug',
    async (request, reply) => {
      if (!sessionStore) {
        return reply.code(503).send({ error: 'session_store_not_wired' });
      }
      const session = sessionStore.get(request.params.id);
      if (!session) {
        return reply.code(404).send({ error: 'session_not_found' });
      }
      if (!SAFE_SLUG.test(request.params.slug)) {
        return reply.code(400).send({ error: 'invalid_slug' });
      }
      const file = path.join(
        session.projectRoot,
        '.editor',
        'resolved-maps',
        `${request.params.slug}.resolved.json`,
      );
      try {
        const raw = await fsp.readFile(file, 'utf8');
        return { slug: request.params.slug, body: JSON.parse(raw) };
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          return reply.code(404).send({ error: 'resolved_map_not_found' });
        }
        throw e;
      }
    },
  );
}

export interface SkeletonEntry {
  readonly slug: string;
  readonly name: string;
  readonly version: string;
  readonly width: number;
  readonly height: number;
  readonly primaryTileset: string;
  readonly secondaryTileset: string;
  readonly defaultBiome: string;
  readonly regionCount: number;
  readonly poiCount: number;
  readonly pathCount: number;
  readonly templateCount: number;
  readonly constraintCount: number;
}
