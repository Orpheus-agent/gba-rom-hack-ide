import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { MoveEventErrorCode, MoveEventKind } from '@rom-editor/shared';

export class MoveEventError extends Error {
  constructor(public readonly code: MoveEventErrorCode, message: string) {
    super(message);
    this.name = 'MoveEventError';
  }
}

interface ParsedEventId {
  readonly mapId: string;
  readonly index: number;
  readonly arrayKey: 'object_events' | 'warp_events' | 'coord_events' | 'bg_events';
}

const SUFFIX_TO_KEY: Readonly<Record<string, ParsedEventId['arrayKey']>> = {
  obj: 'object_events',
  warp: 'warp_events',
  coord: 'coord_events',
  bg: 'bg_events',
};

/** Parses an entity id of the form `<MAP_ID>_<suffix>_<index>` produced by the
 *  decomp scanner. Returns null if the id doesn't match the pattern.
 */
export function parseEventId(
  kind: MoveEventKind,
  id: string,
): ParsedEventId | null {
  const validSuffixes =
    kind === 'objectEvent'
      ? ['obj']
      : kind === 'warp'
        ? ['warp']
        : ['coord', 'bg'];
  for (const suffix of validSuffixes) {
    const marker = `_${suffix}_`;
    const idx = id.lastIndexOf(marker);
    if (idx <= 0) continue;
    const mapId = id.slice(0, idx);
    const indexStr = id.slice(idx + marker.length);
    const index = Number.parseInt(indexStr, 10);
    if (!Number.isFinite(index) || index < 0) continue;
    const arrayKey = SUFFIX_TO_KEY[suffix];
    if (!arrayKey) continue;
    return { mapId, index, arrayKey };
  }
  return null;
}

interface MoveResult {
  readonly mapId: string;
  readonly previous: { x: number; y: number };
  readonly next: { x: number; y: number };
  readonly mapJsonPath: string;
}

interface MoveOptions {
  readonly projectRoot: string;
  readonly mapDirByMapId: ReadonlyMap<string, string>;
  /** Optional bounds. If provided, the new coord must satisfy 0 <= x < width / y < height. */
  readonly bounds?: ReadonlyMap<string, { width: number; height: number }>;
}

export async function moveEvent(
  kind: MoveEventKind,
  id: string,
  x: number,
  y: number,
  options: MoveOptions,
): Promise<MoveResult> {
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0) {
    throw new MoveEventError('invalid_coord', `Coords must be non-negative integers; got x=${x} y=${y}`);
  }
  const parsed = parseEventId(kind, id);
  if (!parsed) {
    throw new MoveEventError(
      'entity_not_found',
      `Could not parse entity id '${id}' for kind '${kind}'`,
    );
  }
  const mapDir = options.mapDirByMapId.get(parsed.mapId);
  if (!mapDir) {
    throw new MoveEventError(
      'map_not_found',
      `No data/maps/<dir>/ for mapId '${parsed.mapId}'`,
    );
  }
  const bound = options.bounds?.get(parsed.mapId);
  if (bound && (x >= bound.width || y >= bound.height)) {
    throw new MoveEventError(
      'coord_out_of_bounds',
      `Coord (${x},${y}) outside map bounds (${bound.width}×${bound.height})`,
    );
  }

  const mapJsonRelPath = path.join('data', 'maps', mapDir, 'map.json');
  const mapJsonAbsPath = path.join(options.projectRoot, mapJsonRelPath);
  let raw: string;
  try {
    raw = await fsp.readFile(mapJsonAbsPath, 'utf8');
  } catch (e) {
    throw new MoveEventError(
      'map_not_found',
      `Could not read ${mapJsonRelPath}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new MoveEventError(
      'mutation_failed',
      `Could not parse ${mapJsonRelPath}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (typeof json !== 'object' || json === null) {
    throw new MoveEventError('mutation_failed', `${mapJsonRelPath} root is not an object`);
  }
  const obj = json as Record<string, unknown>;
  const arr = obj[parsed.arrayKey];
  if (!Array.isArray(arr) || parsed.index >= arr.length) {
    throw new MoveEventError(
      'entity_not_found',
      `${mapJsonRelPath} has no ${parsed.arrayKey}[${parsed.index}]`,
    );
  }
  const entry = arr[parsed.index];
  if (typeof entry !== 'object' || entry === null) {
    throw new MoveEventError(
      'mutation_failed',
      `${mapJsonRelPath} ${parsed.arrayKey}[${parsed.index}] is not an object`,
    );
  }
  const entryObj = entry as Record<string, unknown>;
  const prevX = typeof entryObj.x === 'number' ? entryObj.x : 0;
  const prevY = typeof entryObj.y === 'number' ? entryObj.y : 0;
  entryObj.x = x;
  entryObj.y = y;

  // Atomic write: write to tmp then rename so a partial write never lands.
  const tmpPath = mapJsonAbsPath + '.tmp';
  try {
    await fsp.writeFile(tmpPath, JSON.stringify(json, null, 2) + '\n', 'utf8');
    await fsp.rename(tmpPath, mapJsonAbsPath);
  } catch (e) {
    try {
      await fsp.unlink(tmpPath);
    } catch {
      /* ignore */
    }
    throw new MoveEventError(
      'mutation_failed',
      `Atomic write of ${mapJsonRelPath} failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  return {
    mapId: parsed.mapId,
    previous: { x: prevX, y: prevY },
    next: { x, y },
    mapJsonPath: mapJsonRelPath.replace(/\\/g, '/'),
  };
}
