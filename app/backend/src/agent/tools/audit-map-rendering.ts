import { readManifest } from '../../scan/manifest-io.js';
import type { ToolContext } from '../types.js';

export const AUDIT_MAP_RENDERING_TOOL_NAME = 'audit_map_rendering';

export const AUDIT_MAP_RENDERING_DESCRIPTION =
  'Diagnose which maps in the current project will render correctly vs ' +
  'fall back to placeholder tiles (the "grey/black tile" complaint). For ' +
  'each map, the tool reports its primary + secondary tileset references ' +
  'and whether each tileset was extracted by the engine. Maps whose ' +
  'tilesets are MISSING from the manifest cannot render their real tiles ' +
  'and will fall back to the diagnostic placeholder pattern in the ' +
  'PixiJS scene.\n\n' +
  'Use this when:\n' +
  '  - The user complains about black/grey/missing tiles on a specific ' +
  'map. Call audit_map_rendering and look up the map by id.\n' +
  '  - You want to triage rendering quality across the project before ' +
  'recommending a fix path.\n' +
  '  - The agent is in dev mode planning an engine extension (e.g. add ' +
  'LZ77 decompression for a tileset format the engine doesn\'t yet ' +
  'handle) and needs to know how many maps are affected.\n\n' +
  'Output groups maps by rendering status:\n' +
  '  - "ok": both primary + secondary tilesets present in manifest.\n' +
  '  - "missing_secondary": primary present but secondary tileset not ' +
  'found by the engine.\n' +
  '  - "missing_primary": primary not in manifest (rare; means the ' +
  'tileset detector missed it).\n' +
  '  - "no_tileset_offsets": map metadata lacks primaryTilesetOffset ' +
  '(decomp project or scanner failed).';

export const auditMapRenderingInputShape = {} as const;

interface MapStatusRow {
  readonly mapId: string;
  readonly mapName: string;
  readonly primaryTilesetOffset: number | null;
  readonly secondaryTilesetOffset: number | null;
  readonly primaryFound: boolean;
  readonly secondaryFound: boolean;
  readonly status: 'ok' | 'missing_primary' | 'missing_secondary' | 'no_tileset_offsets';
}

export interface AuditMapRenderingResult {
  readonly available: boolean;
  readonly reason?: string;
  readonly message?: string;
  readonly totalMaps: number;
  readonly summary: { ok: number; missing_primary: number; missing_secondary: number; no_tileset_offsets: number };
  /** First N affected maps per status, for at-a-glance triage. */
  readonly affectedSamples: ReadonlyArray<MapStatusRow>;
  readonly totalTilesetsInManifest: number;
}

interface MapMetadataLike {
  readonly binaryRomPrimaryTilesetOffset?: number;
  readonly binaryRomSecondaryTilesetOffset?: number;
}

interface TilesetEntryLike {
  readonly tilesOffset?: number;
  readonly sourceFileOffset?: number;
  readonly id?: string;
}

export async function auditMapRendering(
  ctx: ToolContext,
): Promise<AuditMapRenderingResult> {
  const manifest = await readManifest(ctx.projectRoot);
  if (!manifest) {
    return {
      available: false,
      reason: 'manifest_not_found',
      message: `No scanned manifest at ${ctx.projectRoot}/.editor/manifest.json.`,
      totalMaps: 0,
      summary: { ok: 0, missing_primary: 0, missing_secondary: 0, no_tileset_offsets: 0 },
      affectedSamples: [],
      totalTilesetsInManifest: 0,
    };
  }

  // Build a fast lookup of "known" tileset offsets. The manifest stores
  // tilesets via the binary-rom registry; each tileset entry carries an
  // offset that matches map metadata's primaryTilesetOffset value.
  const tilesetOffsets = new Set<number>();
  const tilesets = (manifest.tilesets as ReadonlyArray<TilesetEntryLike> | undefined) ?? [];
  for (const ts of tilesets) {
    const off = ts.tilesOffset ?? ts.sourceFileOffset;
    if (typeof off === 'number' && off > 0) tilesetOffsets.add(off);
  }

  const summary = { ok: 0, missing_primary: 0, missing_secondary: 0, no_tileset_offsets: 0 };
  const affected: MapStatusRow[] = [];

  for (const map of manifest.maps) {
    const meta = (map.metadata ?? {}) as MapMetadataLike;
    const primaryOff = typeof meta.binaryRomPrimaryTilesetOffset === 'number'
      ? meta.binaryRomPrimaryTilesetOffset
      : null;
    const secondaryOff = typeof meta.binaryRomSecondaryTilesetOffset === 'number'
      ? meta.binaryRomSecondaryTilesetOffset
      : null;

    let status: MapStatusRow['status'];
    if (primaryOff === null || primaryOff <= 0) {
      status = 'no_tileset_offsets';
    } else {
      const primaryFound = tilesetOffsets.has(primaryOff);
      const secondaryFound =
        secondaryOff === null || secondaryOff <= 0 ? true : tilesetOffsets.has(secondaryOff);
      if (!primaryFound) status = 'missing_primary';
      else if (!secondaryFound) status = 'missing_secondary';
      else status = 'ok';
    }
    summary[status]++;

    if (status !== 'ok' && affected.length < 40) {
      affected.push({
        mapId: map.id,
        mapName: map.name ?? map.id,
        primaryTilesetOffset: primaryOff,
        secondaryTilesetOffset: secondaryOff,
        primaryFound: primaryOff !== null && primaryOff > 0 && tilesetOffsets.has(primaryOff),
        secondaryFound:
          secondaryOff === null || secondaryOff <= 0
            ? true
            : tilesetOffsets.has(secondaryOff),
        status,
      });
    }
  }

  return {
    available: true,
    totalMaps: manifest.maps.length,
    summary,
    affectedSamples: affected,
    totalTilesetsInManifest: tilesetOffsets.size,
  };
}
