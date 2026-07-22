/**
 * Gen-3 MapEvents struct + child-array parsers.
 *
 * Per pret/pokefirered + pret/pokeemerald (public decomp), each MapHeader
 * points (via its `eventsPointer` at offset 0x04) at a 20-byte MapEvents
 * struct describing the map's interactive elements:
 *
 *   struct MapEvents {
 *     u8  objectEventCount;          // 0x00
 *     u8  warpCount;                 // 0x01
 *     u8  coordEventCount;           // 0x02
 *     u8  bgEventCount;              // 0x03
 *     void *objectEventsPointer;     // 0x04
 *     void *warpsPointer;            // 0x08
 *     void *coordEventsPointer;      // 0x0C
 *     void *bgEventsPointer;         // 0x10
 *   };
 *
 * Child-array shapes:
 *
 *   struct WarpEvent (8 bytes):
 *     s16 x, y; u8 elevation; u8 warpId; u8 destMapNum; u8 destMapGroup;
 *
 *   struct ObjectEventTemplate (24 bytes):
 *     u8 localId; u8 graphicsId; u8 inConnection; u8 _pad1;
 *     s16 x, y;
 *     u8 elevation; u8 movementType;
 *     u8 movementRangeX:4, movementRangeY:4; u8 _pad2;
 *     u16 trainerType; u16 trainerRange;
 *     void *scriptPointer;            // NULL allowed
 *     u16 flagId;
 *     u16 _pad3;
 *
 *   struct CoordEvent (16 bytes - pret/pokefirered shape):
 *     s16 x, y;
 *     u8 elevation; u8 _pad1;
 *     u16 trigger; u16 index;
 *     u16 _pad2;
 *     void *scriptPointer;            // NULL allowed
 *
 *   struct BgEvent (12 bytes - pret/pokefirered shape, signs/hidden items):
 *     s16 x, y;
 *     u8 elevation; u8 kind;
 *     u16 _pad;
 *     void *data;                     // script pointer OR item-data pointer
 *
 * PD 5: structural detection - no baked offsets. Each parser validates
 * struct shape (plausible counts, valid in-ROM pointers when non-NULL).
 */

import { GBA_ROM_BASE_ADDRESS } from '../pointers/index.js';

export const MAP_EVENTS_STRUCT_SIZE_BYTES = 20;
export const WARP_EVENT_STRUCT_SIZE_BYTES = 8;
export const OBJECT_EVENT_STRUCT_SIZE_BYTES = 24;
export const COORD_EVENT_STRUCT_SIZE_BYTES = 16;
export const BG_EVENT_STRUCT_SIZE_BYTES = 12;

/** Plausible upper-bound on element counts per map. Real Gen-3 vanilla
 *  maxes around 64 object events; setting 255 captures any well-behaved
 *  hack while rejecting random 0xFF garbage at the count byte. */
const MAX_EVENT_COUNT = 255;

export interface WarpEvent {
  readonly x: number;
  readonly y: number;
  readonly elevation: number;
  readonly warpId: number;
  readonly destMapNum: number;
  readonly destMapGroup: number;
  readonly fileOffset: number;
}

export interface ObjectEvent {
  readonly localId: number;
  readonly graphicsId: number;
  readonly x: number;
  readonly y: number;
  readonly elevation: number;
  readonly movementType: number;
  /** Phase O.62 - packed nibble byte at struct offset +0x0a. High
   *  nibble = movementRangeX, low nibble = movementRangeY. Both are
   *  4-bit values (0..15). */
  readonly movementRangeXY: number;
  readonly trainerType: number;
  /** Phase O.62 - u16 at struct offset +0x0e. For trainer NPCs
   *  (trainerType > 0) this is the line-of-sight range in tiles.
   *  For OBJ_EVENT_GFX_BERRY_TREE entries this is the berry-tree id
   *  (used for the daily-growth system, not vision). */
  readonly trainerSightOrBerryTreeId: number;
  readonly flagId: number;
  /** ROM offset of the script - null if NULL pointer. */
  readonly scriptOffset: number | null;
  readonly fileOffset: number;
}

export interface CoordEvent {
  readonly x: number;
  readonly y: number;
  readonly elevation: number;
  readonly trigger: number;
  readonly index: number;
  readonly scriptOffset: number | null;
  readonly fileOffset: number;
}

export interface BgEvent {
  readonly x: number;
  readonly y: number;
  readonly elevation: number;
  /** Sub-type: 0=script, 1=paired-hidden-item, etc. (vanilla enum). */
  readonly kind: number;
  /** Data pointer - usually a script pointer when kind=0. */
  readonly dataOffset: number | null;
  /** Raw 4 bytes at offset +0x08. For sign kinds (0-4) this is the script
   *  pointer (also reflected as dataOffset). For BG_EVENT_HIDDEN_ITEM
   *  (kinds 5 and 7) the 4 bytes are a packed struct:
   *     u16 itemId; u8 flagOffset; u8 quantity;
   *  The hidden-item inspector unpacks this client-side. */
  readonly dataRaw: number;
  readonly fileOffset: number;
}

export interface MapEventsParsed {
  readonly objectEventCount: number;
  readonly warpCount: number;
  readonly coordEventCount: number;
  readonly bgEventCount: number;
  readonly warps: ReadonlyArray<WarpEvent>;
  readonly objectEvents: ReadonlyArray<ObjectEvent>;
  readonly coordEvents: ReadonlyArray<CoordEvent>;
  readonly bgEvents: ReadonlyArray<BgEvent>;
  /** ROM offsets of the struct + sub-arrays - useful for coverage. */
  readonly eventsStructOffset: number;
  readonly warpsArrayOffset: number | null;
  readonly warpsArrayByteLength: number;
  readonly objectEventsArrayOffset: number | null;
  readonly objectEventsArrayByteLength: number;
  readonly coordEventsArrayOffset: number | null;
  readonly coordEventsArrayByteLength: number;
  readonly bgEventsArrayOffset: number | null;
  readonly bgEventsArrayByteLength: number;
}

export type MapEventsArrayKind =
  | 'warps'
  | 'objectEvents'
  | 'coordEvents'
  | 'bgEvents';

export type MapEventsParseFailure =
  | { kind: 'too_short'; bytesAvailable: number; bytesRequired: number }
  | {
      kind: 'implausible_count';
      field: 'objectEventCount' | 'warpCount' | 'coordEventCount' | 'bgEventCount';
      observed: number;
      max: number;
    }
  | { kind: 'invalid_array_pointer'; arrayKind: MapEventsArrayKind; rawAddress: number }
  | { kind: 'array_truncated'; arrayKind: MapEventsArrayKind; needed: number; available: number };

export type MapEventsParseResult =
  | { ok: true; events: MapEventsParsed }
  | { ok: false; failure: MapEventsParseFailure };

/**
 * Try to parse 20 bytes at `offset` as a Gen-3 MapEvents struct. Walks
 * every populated child array (warps, object events, coord events, bg
 * events). Strict on struct shape - first violation returns ok:false.
 */
export function parseMapEvents(bytes: Uint8Array, offset: number): MapEventsParseResult {
  if (offset < 0 || offset + MAP_EVENTS_STRUCT_SIZE_BYTES > bytes.length) {
    return {
      ok: false,
      failure: {
        kind: 'too_short',
        bytesAvailable: Math.max(0, bytes.length - offset),
        bytesRequired: MAP_EVENTS_STRUCT_SIZE_BYTES,
      },
    };
  }

  const objectEventCount = bytes[offset + 0x00] ?? 0;
  const warpCount = bytes[offset + 0x01] ?? 0;
  const coordEventCount = bytes[offset + 0x02] ?? 0;
  const bgEventCount = bytes[offset + 0x03] ?? 0;

  for (const [name, count] of [
    ['objectEventCount', objectEventCount],
    ['warpCount', warpCount],
    ['coordEventCount', coordEventCount],
    ['bgEventCount', bgEventCount],
  ] as const) {
    if (count > MAX_EVENT_COUNT) {
      return {
        ok: false,
        failure: { kind: 'implausible_count', field: name, observed: count, max: MAX_EVENT_COUNT },
      };
    }
  }

  // Resolve each child-array pointer + length.
  const resolveArray = (
    arrayKind: MapEventsArrayKind,
    pointerOffset: number,
    count: number,
    elementSize: number,
  ): { ok: true; offset: number | null } | { ok: false; failure: MapEventsParseFailure } => {
    if (count === 0) return { ok: true, offset: null };
    const raw = readUint32Le(bytes, pointerOffset);
    if (raw === 0) {
      return { ok: false, failure: { kind: 'invalid_array_pointer', arrayKind, rawAddress: raw } };
    }
    const highByte = (raw >>> 24) & 0xff;
    if (highByte !== 0x08 && highByte !== 0x09) {
      return { ok: false, failure: { kind: 'invalid_array_pointer', arrayKind, rawAddress: raw } };
    }
    const fileOffset = raw - GBA_ROM_BASE_ADDRESS;
    if (fileOffset >= bytes.length) {
      return { ok: false, failure: { kind: 'invalid_array_pointer', arrayKind, rawAddress: raw } };
    }
    const requiredBytes = count * elementSize;
    if (fileOffset + requiredBytes > bytes.length) {
      return {
        ok: false,
        failure: {
          kind: 'array_truncated',
          arrayKind,
          needed: requiredBytes,
          available: bytes.length - fileOffset,
        },
      };
    }
    return { ok: true, offset: fileOffset };
  };

  // Object events at pointer 0x04, warps at 0x08, coord events at 0x0C, bg events at 0x10.
  const objR = resolveArray('objectEvents', offset + 0x04, objectEventCount, OBJECT_EVENT_STRUCT_SIZE_BYTES);
  if (!objR.ok) return { ok: false, failure: objR.failure };
  const warpsR = resolveArray('warps', offset + 0x08, warpCount, WARP_EVENT_STRUCT_SIZE_BYTES);
  if (!warpsR.ok) return { ok: false, failure: warpsR.failure };
  const coordR = resolveArray('coordEvents', offset + 0x0c, coordEventCount, COORD_EVENT_STRUCT_SIZE_BYTES);
  if (!coordR.ok) return { ok: false, failure: coordR.failure };
  const bgR = resolveArray('bgEvents', offset + 0x10, bgEventCount, BG_EVENT_STRUCT_SIZE_BYTES);
  if (!bgR.ok) return { ok: false, failure: bgR.failure };

  // Walk each array.
  const warps: WarpEvent[] = [];
  if (warpsR.offset !== null) {
    for (let i = 0; i < warpCount; i++) {
      const o = warpsR.offset + i * WARP_EVENT_STRUCT_SIZE_BYTES;
      warps.push(
        Object.freeze({
          x: readInt16Le(bytes, o + 0x00),
          y: readInt16Le(bytes, o + 0x02),
          elevation: bytes[o + 0x04] ?? 0,
          warpId: bytes[o + 0x05] ?? 0,
          destMapNum: bytes[o + 0x06] ?? 0,
          destMapGroup: bytes[o + 0x07] ?? 0,
          fileOffset: o,
        }),
      );
    }
  }

  const objectEvents: ObjectEvent[] = [];
  if (objR.offset !== null) {
    for (let i = 0; i < objectEventCount; i++) {
      const o = objR.offset + i * OBJECT_EVENT_STRUCT_SIZE_BYTES;
      objectEvents.push(
        Object.freeze({
          localId: bytes[o + 0x00] ?? 0,
          graphicsId: bytes[o + 0x01] ?? 0,
          x: readInt16Le(bytes, o + 0x04),
          y: readInt16Le(bytes, o + 0x06),
          elevation: bytes[o + 0x08] ?? 0,
          movementType: bytes[o + 0x09] ?? 0,
          movementRangeXY: bytes[o + 0x0a] ?? 0,
          trainerType: readUint16Le(bytes, o + 0x0c),
          trainerSightOrBerryTreeId: readUint16Le(bytes, o + 0x0e),
          flagId: readUint16Le(bytes, o + 0x14),
          scriptOffset: maybePointerFileOffset(bytes, o + 0x10),
          fileOffset: o,
        }),
      );
    }
  }

  const coordEvents: CoordEvent[] = [];
  if (coordR.offset !== null) {
    for (let i = 0; i < coordEventCount; i++) {
      const o = coordR.offset + i * COORD_EVENT_STRUCT_SIZE_BYTES;
      coordEvents.push(
        Object.freeze({
          x: readInt16Le(bytes, o + 0x00),
          y: readInt16Le(bytes, o + 0x02),
          elevation: bytes[o + 0x04] ?? 0,
          trigger: readUint16Le(bytes, o + 0x06),
          index: readUint16Le(bytes, o + 0x08),
          scriptOffset: maybePointerFileOffset(bytes, o + 0x0c),
          fileOffset: o,
        }),
      );
    }
  }

  const bgEvents: BgEvent[] = [];
  if (bgR.offset !== null) {
    for (let i = 0; i < bgEventCount; i++) {
      const o = bgR.offset + i * BG_EVENT_STRUCT_SIZE_BYTES;
      bgEvents.push(
        Object.freeze({
          x: readInt16Le(bytes, o + 0x00),
          y: readInt16Le(bytes, o + 0x02),
          elevation: bytes[o + 0x04] ?? 0,
          kind: bytes[o + 0x05] ?? 0,
          dataOffset: maybePointerFileOffset(bytes, o + 0x08),
          dataRaw: readUint32Le(bytes, o + 0x08),
          fileOffset: o,
        }),
      );
    }
  }

  return {
    ok: true,
    events: Object.freeze({
      objectEventCount,
      warpCount,
      coordEventCount,
      bgEventCount,
      warps: Object.freeze(warps),
      objectEvents: Object.freeze(objectEvents),
      coordEvents: Object.freeze(coordEvents),
      bgEvents: Object.freeze(bgEvents),
      eventsStructOffset: offset,
      warpsArrayOffset: warpsR.offset,
      warpsArrayByteLength: warpCount * WARP_EVENT_STRUCT_SIZE_BYTES,
      objectEventsArrayOffset: objR.offset,
      objectEventsArrayByteLength: objectEventCount * OBJECT_EVENT_STRUCT_SIZE_BYTES,
      coordEventsArrayOffset: coordR.offset,
      coordEventsArrayByteLength: coordEventCount * COORD_EVENT_STRUCT_SIZE_BYTES,
      bgEventsArrayOffset: bgR.offset,
      bgEventsArrayByteLength: bgEventCount * BG_EVENT_STRUCT_SIZE_BYTES,
    }),
  };
}

/** Read a pointer at offset; return null for NULL or non-ROM pointers
 *  (caller treats both the same: "no script attached"). */
function maybePointerFileOffset(bytes: Uint8Array, offset: number): number | null {
  if (offset + 4 > bytes.length) return null;
  const raw = readUint32Le(bytes, offset);
  if (raw === 0) return null;
  const highByte = (raw >>> 24) & 0xff;
  if (highByte !== 0x08 && highByte !== 0x09) return null;
  const fileOffset = raw - GBA_ROM_BASE_ADDRESS;
  if (fileOffset >= bytes.length) return null;
  return fileOffset;
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

function readUint16Le(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8)) >>> 0;
}

function readInt16Le(bytes: Uint8Array, offset: number): number {
  const v = ((bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8)) & 0xffff;
  return v >= 0x8000 ? v - 0x10000 : v;
}
