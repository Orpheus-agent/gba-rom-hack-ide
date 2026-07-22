/**
 * Phase 8I-3 - Frontend client for the project-scoped skeleton /
 * resolved-map endpoints registered alongside the tile-intel proxy.
 *
 * Lives next to `tileIntelApi.ts` because the actions the
 * SkeletonEditor exposes (resolve, validate) bounce through that
 * client. Listing + reading the on-disk files is project-scoped
 * (per session) and goes through these routes.
 */

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

export interface ListSkeletonsResponse {
  readonly sessionId: string;
  readonly entries: ReadonlyArray<SkeletonEntry>;
}

export interface SkeletonBodyResponse {
  readonly slug: string;
  readonly body: Record<string, unknown>;
}

export async function listSkeletons(
  sessionId: string,
): Promise<ListSkeletonsResponse> {
  const response = await fetch(`/api/projects/${sessionId}/skeletons`, {
    headers: { accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} while listing skeletons`);
  }
  return (await response.json()) as ListSkeletonsResponse;
}

export async function fetchSkeletonBody(
  sessionId: string,
  slug: string,
): Promise<SkeletonBodyResponse> {
  const response = await fetch(
    `/api/projects/${sessionId}/skeletons/${encodeURIComponent(slug)}`,
    { headers: { accept: 'application/json' } },
  );
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} while fetching skeleton ${slug}`);
  }
  return (await response.json()) as SkeletonBodyResponse;
}

export async function fetchResolvedMapBody(
  sessionId: string,
  slug: string,
): Promise<SkeletonBodyResponse> {
  const response = await fetch(
    `/api/projects/${sessionId}/resolved-maps/${encodeURIComponent(slug)}`,
    { headers: { accept: 'application/json' } },
  );
  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status} while fetching resolved-map ${slug}`,
    );
  }
  return (await response.json()) as SkeletonBodyResponse;
}
