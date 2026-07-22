/**
 * Gen-3 Tileset header encoder (Phase 3.1).
 *
 * Inverse of `parseTileset` - emits the 24-byte Tileset struct from a
 * spec. Pointer slots are file offsets; encoder converts to GBA
 * pointers. Padding bytes at 0x02/0x03 are zeroed (parser rejects
 * non-zero padding).
 *
 * Both `tilesOffset` and `palettesOffset` are required (the parser
 * rejects "all data pointers null"); `metatilesOffset`, `slot10Offset`,
 * `slot14Offset` may be null.
 */

import { GBA_ROM_BASE_ADDRESS } from '../pointers/index.js';
import { TILESET_STRUCT_SIZE_BYTES } from './tileset.js';

export interface TilesetSpec {
  readonly isCompressed: boolean;
  readonly isSecondary: boolean;
  readonly tilesOffset: number | null;
  readonly palettesOffset: number | null;
  readonly metatilesOffset: number | null;
  /** Slot 0x10: FireRed callback fn OR Emerald metatileAttributes. */
  readonly slot10Offset: number | null;
  /** Slot 0x14: FireRed metatileAttributes OR Emerald callback fn. */
  readonly slot14Offset: number | null;
}

export class TilesetEncodeError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(`TilesetEncodeError: ${field}: ${message}`);
    this.name = 'TilesetEncodeError';
    this.field = field;
  }
}

export function encodeTileset(spec: TilesetSpec): Uint8Array {
  if (spec.tilesOffset === null && spec.palettesOffset === null) {
    throw new TilesetEncodeError(
      'tilesOffset+palettesOffset',
      'a tileset must point at SOMETHING - parser rejects all-data-pointers-null',
    );
  }
  const out = new Uint8Array(TILESET_STRUCT_SIZE_BYTES);
  out[0x00] = spec.isCompressed ? 1 : 0;
  out[0x01] = spec.isSecondary ? 1 : 0;
  out[0x02] = 0; // padding[2]
  out[0x03] = 0;
  writePointer(out, 0x04, spec.tilesOffset, 'tilesOffset');
  writePointer(out, 0x08, spec.palettesOffset, 'palettesOffset');
  writePointer(out, 0x0c, spec.metatilesOffset, 'metatilesOffset');
  writePointer(out, 0x10, spec.slot10Offset, 'slot10Offset');
  writePointer(out, 0x14, spec.slot14Offset, 'slot14Offset');
  return out;
}

function writePointer(
  out: Uint8Array,
  byteOffset: number,
  fileOffset: number | null,
  field: string,
): void {
  if (fileOffset === null) {
    out[byteOffset + 0] = 0;
    out[byteOffset + 1] = 0;
    out[byteOffset + 2] = 0;
    out[byteOffset + 3] = 0;
    return;
  }
  if (!Number.isInteger(fileOffset) || fileOffset < 0 || fileOffset > 0x01ffffff) {
    throw new TilesetEncodeError(field, `must fit in 25 bits; got ${String(fileOffset)}`);
  }
  const ptr = (fileOffset + GBA_ROM_BASE_ADDRESS) >>> 0;
  out[byteOffset + 0] = ptr & 0xff;
  out[byteOffset + 1] = (ptr >>> 8) & 0xff;
  out[byteOffset + 2] = (ptr >>> 16) & 0xff;
  out[byteOffset + 3] = (ptr >>> 24) & 0xff;
}
