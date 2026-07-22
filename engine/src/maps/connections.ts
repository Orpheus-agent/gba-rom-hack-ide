/**
 * Gen-3 MapConnections struct parser.
 *
 * Per pret/pokefirered + pret/pokeemerald, each MapHeader points (via
 * its connectionsPointer at offset 0x0C) at an 8-byte MapConnections
 * envelope:
 *
 *   struct MapConnections {
 *     s32 count;                          // 0x00
 *     void *connectionsArrayPointer;      // 0x04
 *   };
 *
 * Each MapConnection (12 bytes) at connectionsArrayPointer[i]:
 *
 *   struct MapConnection {
 *     u8 direction;     // 0x00 (1=down, 2=up, 3=left, 4=right, 5=dive,
 *                       //       6=emerge - vanilla enum; hacks may add)
 *     u8 padding[3];
 *     s32 offset;       // 0x04 (tile offset along the shared edge)
 *     u8 mapGroup;      // 0x08
 *     u8 mapNum;        // 0x09
 *     u16 padding2;     // 0x0A
 *   };
 *
 * PD 5: structural detection - validates shape, no baked offsets.
 */

import { GBA_ROM_BASE_ADDRESS } from '../pointers/index.js';

export const MAP_CONNECTIONS_HEADER_SIZE_BYTES = 8;
export const MAP_CONNECTION_STRUCT_SIZE_BYTES = 12;

/** Plausible upper bound on per-map connection count. Vanilla maps top
 *  out at 6 (the cardinal-direction enum max); hacks rarely exceed 10.
 *  Setting 64 lets unusually-rich custom engines through. */
const MAX_CONNECTIONS_PER_MAP = 64;

/** Vanilla direction enum values + a safety margin for hacks. */
const MAX_DIRECTION_VALUE = 15;

export interface MapConnection {
  readonly direction: number;
  readonly offset: number;
  readonly destMapGroup: number;
  readonly destMapNum: number;
  /** ROM offset where this MapConnection struct lives. */
  readonly fileOffset: number;
}

export interface MapConnectionsParsed {
  readonly count: number;
  readonly connections: ReadonlyArray<MapConnection>;
  readonly headerStructOffset: number;
  readonly connectionsArrayOffset: number | null;
  readonly connectionsArrayByteLength: number;
}

export type MapConnectionsParseFailure =
  | { kind: 'too_short'; bytesAvailable: number; bytesRequired: number }
  | { kind: 'implausible_count'; observed: number; max: number }
  | { kind: 'invalid_connections_pointer'; rawAddress: number }
  | { kind: 'connections_array_truncated'; needed: number; available: number }
  | { kind: 'implausible_direction'; index: number; observed: number; max: number };

export type MapConnectionsParseResult =
  | { ok: true; connections: MapConnectionsParsed }
  | { ok: false; failure: MapConnectionsParseFailure };

/**
 * Try to parse 8 bytes at `offset` as a Gen-3 MapConnections envelope,
 * then walk the count×12-byte connections array.
 */
export function parseMapConnections(bytes: Uint8Array, offset: number): MapConnectionsParseResult {
  if (offset < 0 || offset + MAP_CONNECTIONS_HEADER_SIZE_BYTES > bytes.length) {
    return {
      ok: false,
      failure: {
        kind: 'too_short',
        bytesAvailable: Math.max(0, bytes.length - offset),
        bytesRequired: MAP_CONNECTIONS_HEADER_SIZE_BYTES,
      },
    };
  }

  const count = readInt32Le(bytes, offset + 0x00);
  if (count < 0 || count > MAX_CONNECTIONS_PER_MAP) {
    return {
      ok: false,
      failure: { kind: 'implausible_count', observed: count, max: MAX_CONNECTIONS_PER_MAP },
    };
  }

  if (count === 0) {
    // Legal: a map can have zero connections (a self-contained room).
    return {
      ok: true,
      connections: Object.freeze({
        count: 0,
        connections: Object.freeze([]),
        headerStructOffset: offset,
        connectionsArrayOffset: null,
        connectionsArrayByteLength: 0,
      }),
    };
  }

  const arrayRaw = readUint32Le(bytes, offset + 0x04);
  const highByte = (arrayRaw >>> 24) & 0xff;
  if (highByte !== 0x08 && highByte !== 0x09) {
    return { ok: false, failure: { kind: 'invalid_connections_pointer', rawAddress: arrayRaw } };
  }
  const arrayFileOffset = arrayRaw - GBA_ROM_BASE_ADDRESS;
  if (arrayFileOffset >= bytes.length) {
    return { ok: false, failure: { kind: 'invalid_connections_pointer', rawAddress: arrayRaw } };
  }
  const requiredBytes = count * MAP_CONNECTION_STRUCT_SIZE_BYTES;
  if (arrayFileOffset + requiredBytes > bytes.length) {
    return {
      ok: false,
      failure: {
        kind: 'connections_array_truncated',
        needed: requiredBytes,
        available: bytes.length - arrayFileOffset,
      },
    };
  }

  const connections: MapConnection[] = [];
  for (let i = 0; i < count; i++) {
    const connFileOffset = arrayFileOffset + i * MAP_CONNECTION_STRUCT_SIZE_BYTES;
    const direction = bytes[connFileOffset + 0x00] ?? 0;
    if (direction === 0 || direction > MAX_DIRECTION_VALUE) {
      return {
        ok: false,
        failure: { kind: 'implausible_direction', index: i, observed: direction, max: MAX_DIRECTION_VALUE },
      };
    }
    connections.push(
      Object.freeze({
        direction,
        offset: readInt32Le(bytes, connFileOffset + 0x04),
        destMapGroup: bytes[connFileOffset + 0x08] ?? 0,
        destMapNum: bytes[connFileOffset + 0x09] ?? 0,
        fileOffset: connFileOffset,
      }),
    );
  }

  return {
    ok: true,
    connections: Object.freeze({
      count,
      connections: Object.freeze(connections),
      headerStructOffset: offset,
      connectionsArrayOffset: arrayFileOffset,
      connectionsArrayByteLength: requiredBytes,
    }),
  };
}

function readInt32Le(bytes: Uint8Array, offset: number): number {
  // Signed 32-bit interpretation of LE bytes.
  const u = readUint32Le(bytes, offset);
  return u >= 0x80000000 ? u - 0x100000000 : u;
}

function readUint32Le(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) |
      ((bytes[offset + 1] ?? 0) << 8) |
      ((bytes[offset + 2] ?? 0) << 16) |
      ((bytes[offset + 3] ?? 0) << 24)) >>>
    0
  );
}
