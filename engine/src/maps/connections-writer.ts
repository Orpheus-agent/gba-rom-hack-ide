/**
 * Gen-3 MapConnections + MapConnection encoder (Phase 3.1).
 *
 * Inverse of `parseMapConnections`. Produces both halves:
 *
 *   - The 8-byte MapConnections envelope: { s32 count, void* arrayPtr }
 *   - The (count * 12)-byte MapConnection array
 *
 * The two halves are returned separately so the caller can allocate
 * them independently via the free-space registry (Phase 3.2). The
 * envelope's `arrayPtr` is filled in by the caller AFTER the array's
 * file offset is known - we accept the file offset as part of the
 * envelope encode call.
 */

import { GBA_ROM_BASE_ADDRESS } from '../pointers/index.js';
import {
  MAP_CONNECTIONS_HEADER_SIZE_BYTES,
  MAP_CONNECTION_STRUCT_SIZE_BYTES,
} from './connections.js';

export interface MapConnectionSpec {
  /** Direction enum: 1=down, 2=up, 3=left, 4=right, 5=dive, 6=emerge. */
  readonly direction: number;
  /** s32 offset along the shared edge (signed; vanilla typically -7..+7). */
  readonly offset: number;
  /** Destination map group (u8). */
  readonly destMapGroup: number;
  /** Destination map number within group (u8). */
  readonly destMapNum: number;
}

export class MapConnectionEncodeError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(`MapConnectionEncodeError: ${field}: ${message}`);
    this.name = 'MapConnectionEncodeError';
    this.field = field;
  }
}

/** Encode a single 12-byte MapConnection struct. */
export function encodeMapConnection(spec: MapConnectionSpec): Uint8Array {
  if (!Number.isInteger(spec.direction) || spec.direction < 1 || spec.direction > 15) {
    throw new MapConnectionEncodeError('direction', `must be an integer in [1, 15]; got ${String(spec.direction)}`);
  }
  if (!Number.isInteger(spec.offset) || spec.offset < -0x80000000 || spec.offset > 0x7fffffff) {
    throw new MapConnectionEncodeError('offset', `must fit in s32; got ${String(spec.offset)}`);
  }
  if (!Number.isInteger(spec.destMapGroup) || spec.destMapGroup < 0 || spec.destMapGroup > 0xff) {
    throw new MapConnectionEncodeError('destMapGroup', `must be u8; got ${String(spec.destMapGroup)}`);
  }
  if (!Number.isInteger(spec.destMapNum) || spec.destMapNum < 0 || spec.destMapNum > 0xff) {
    throw new MapConnectionEncodeError('destMapNum', `must be u8; got ${String(spec.destMapNum)}`);
  }
  const out = new Uint8Array(MAP_CONNECTION_STRUCT_SIZE_BYTES);
  out[0x00] = spec.direction & 0xff;
  out[0x01] = 0; // padding[3]
  out[0x02] = 0;
  out[0x03] = 0;
  writeS32Le(out, 0x04, spec.offset);
  out[0x08] = spec.destMapGroup & 0xff;
  out[0x09] = spec.destMapNum & 0xff;
  out[0x0a] = 0; // padding2 u16
  out[0x0b] = 0;
  return out;
}

/** Encode the (count * 12)-byte array of MapConnection structs. */
export function encodeMapConnectionsArray(
  connections: ReadonlyArray<MapConnectionSpec>,
): Uint8Array {
  if (connections.length === 0) {
    return new Uint8Array(0);
  }
  const out = new Uint8Array(connections.length * MAP_CONNECTION_STRUCT_SIZE_BYTES);
  for (let i = 0; i < connections.length; i++) {
    const c = encodeMapConnection(connections[i]!);
    out.set(c, i * MAP_CONNECTION_STRUCT_SIZE_BYTES);
  }
  return out;
}

/**
 * Encode the 8-byte MapConnections envelope. The caller passes the file
 * offset where the (count * 12)-byte array WILL live; the encoder
 * converts to GBA pointer. Pass null for an empty connections set
 * (count = 0, arrayPtr = NULL).
 */
export function encodeMapConnectionsHeader(
  count: number,
  arrayFileOffset: number | null,
): Uint8Array {
  if (!Number.isInteger(count) || count < 0 || count > 64) {
    throw new MapConnectionEncodeError('count', `must be in [0, 64]; got ${String(count)}`);
  }
  if (count > 0 && arrayFileOffset === null) {
    throw new MapConnectionEncodeError(
      'arrayFileOffset',
      `count is ${String(count)} but arrayFileOffset is null - connection array must have a real ROM home`,
    );
  }
  const out = new Uint8Array(MAP_CONNECTIONS_HEADER_SIZE_BYTES);
  // s32 count
  writeS32Le(out, 0x00, count);
  // void* arrayPtr
  if (arrayFileOffset === null) {
    out[0x04] = 0;
    out[0x05] = 0;
    out[0x06] = 0;
    out[0x07] = 0;
  } else {
    if (!Number.isInteger(arrayFileOffset) || arrayFileOffset < 0 || arrayFileOffset > 0x01ffffff) {
      throw new MapConnectionEncodeError(
        'arrayFileOffset',
        `must fit in 25 bits (GBA ROM is ≤ 32 MiB); got ${String(arrayFileOffset)}`,
      );
    }
    const ptr = (arrayFileOffset + GBA_ROM_BASE_ADDRESS) >>> 0;
    out[0x04] = ptr & 0xff;
    out[0x05] = (ptr >>> 8) & 0xff;
    out[0x06] = (ptr >>> 16) & 0xff;
    out[0x07] = (ptr >>> 24) & 0xff;
  }
  return out;
}

function writeS32Le(out: Uint8Array, byteOffset: number, value: number): void {
  const u = value >>> 0;
  out[byteOffset + 0] = u & 0xff;
  out[byteOffset + 1] = (u >>> 8) & 0xff;
  out[byteOffset + 2] = (u >>> 16) & 0xff;
  out[byteOffset + 3] = (u >>> 24) & 0xff;
}
