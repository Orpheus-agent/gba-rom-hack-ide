/**
 * Phase 8A-4 - Typed REST client for tile-intel-svc.
 *
 * Tools NEVER instantiate this directly. They call
 * `TileIntelSupervisor.ensureReady()`; on `{available:true}` the
 * supervisor hands back a client. This way every tool gets the
 * version-mismatch guard + lazy-start semantics for free.
 *
 * The client itself is a thin wrapper around `fetch` - no retries,
 * no circuit breaker, no timeouts beyond fetch's default. The
 * supervisor handles those concerns at startup; once the sidecar
 * is up, a misbehaving endpoint should surface as an error rather
 * than be silently retried.
 */

import type {
  ApplyTemplateRequest,
  ApplyTemplateResponse,
  CompleteRegionRequest,
  CompleteRegionResponse,
  GenerateSkeletonRequest,
  GenerateSkeletonResponse,
  ResolveSkeletonRequest,
  ResolveSkeletonResponse,
  SidecarHealthResponse,
  SidecarVersionResponse,
  SuggestNeighborsRequest,
  SuggestNeighborsResponse,
  TilesetLibraryQuery,
  TilesetLibraryResponse,
  ValidateTraversalRequest,
  ValidateTraversalResponse,
} from './types.js';

/** Subset of the global fetch API the client uses. Typed as a
 *  generic so tests can inject a mock without lying about the
 *  shape. */
export type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

/** Error thrown for any non-2xx response. Tile-intel tools catch
 *  this + map to their own structured error vocabularies. */
export class TileIntelHttpError extends Error {
  constructor(
    readonly status: number,
    readonly endpoint: string,
    readonly body: string,
  ) {
    super(`tile-intel ${endpoint} returned ${String(status)}: ${body}`);
    this.name = 'TileIntelHttpError';
  }
}

export class TileIntelClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchFn: FetchLike = (input, init) =>
      fetch(input, init) as ReturnType<FetchLike>,
  ) {}

  /** Liveness ping. */
  async health(): Promise<SidecarHealthResponse> {
    return this.get<SidecarHealthResponse>('/health');
  }

  /** Version + schema + test_mode contract. The supervisor uses this
   *  to enforce api_version parity before considering the sidecar
   *  ready. */
  async version(): Promise<SidecarVersionResponse> {
    return this.get<SidecarVersionResponse>('/v1/version');
  }

  /** Phase 8G-1 - Compose a MapSkeleton DSL document from theme +
   *  biome + size + density. Deterministic given `seed`. */
  async generateSkeleton(
    request: GenerateSkeletonRequest,
  ): Promise<GenerateSkeletonResponse> {
    return this.post<GenerateSkeletonResponse>('/v1/generate/skeleton', request);
  }

  /** Phase 8G-2 - Resolve a MapSkeleton into a metatile grid. */
  async resolveSkeleton(
    request: ResolveSkeletonRequest,
  ): Promise<ResolveSkeletonResponse> {
    return this.post<ResolveSkeletonResponse>('/v1/generate/resolve', request);
  }

  /** Phase 8G-3 - Validate a resolved map's traversal. */
  async validateTraversal(
    request: ValidateTraversalRequest,
  ): Promise<ValidateTraversalResponse> {
    return this.post<ValidateTraversalResponse>(
      '/v1/generate/validate-traversal',
      request,
    );
  }

  /** Phase 8H-1 - Top-N legal-neighbor suggestions in a direction. */
  async suggestNeighbors(
    request: SuggestNeighborsRequest,
  ): Promise<SuggestNeighborsResponse> {
    return this.post<SuggestNeighborsResponse>('/v1/neighbors/suggest', request);
  }

  /** Phase 8H-2 - Greedy-fill a rect with metatiles consistent with
   *  surrounding tags + seed cells. */
  async completeRegion(
    request: CompleteRegionRequest,
  ): Promise<CompleteRegionResponse> {
    return this.post<CompleteRegionResponse>('/v1/regions/complete', request);
  }

  /** Phase 8H-3 - Filterable list of tilesets in the global library. */
  async browseTilesetLibrary(
    query: TilesetLibraryQuery = {},
  ): Promise<TilesetLibraryResponse> {
    const params = new URLSearchParams();
    if (query.family !== undefined) params.set('family', query.family);
    if (query.isSecondary !== undefined)
      params.set('is_secondary', String(query.isSecondary));
    if (query.source !== undefined) params.set('source', query.source);
    if (query.licenseSpdx !== undefined)
      params.set('license_spdx', query.licenseSpdx);
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    if (query.offset !== undefined) params.set('offset', String(query.offset));
    const qs = params.toString();
    return this.get<TilesetLibraryResponse>(
      `/v1/tilesets/library${qs ? `?${qs}` : ''}`,
    );
  }

  /** Phase 8H-4 - Emit the metatile placements for a template anchor. */
  async applyTemplate(
    request: ApplyTemplateRequest,
  ): Promise<ApplyTemplateResponse> {
    return this.post<ApplyTemplateResponse>('/v1/templates/apply', request);
  }

  /** Internal - raw GET helper. Phase 8B-2 onwards will add POST
   *  helpers for ingestion + queries. */
  private async get<T>(path: string): Promise<T> {
    const url = this.baseUrl.replace(/\/$/, '') + path;
    const response = await this.fetchFn(url, { method: 'GET' });
    if (!response.ok) {
      throw new TileIntelHttpError(response.status, path, await response.text());
    }
    return (await response.json()) as T;
  }

  /** Internal - raw POST helper for JSON bodies. */
  private async post<T>(path: string, body: unknown): Promise<T> {
    const url = this.baseUrl.replace(/\/$/, '') + path;
    const response = await this.fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new TileIntelHttpError(response.status, path, await response.text());
    }
    return (await response.json()) as T;
  }
}
