/**
 * Gen-3 RegionMapSection encoder + manifest lifter (Phase 3.1).
 *
 * The world-region scanner at `engine/src/world/region-map-sections.ts`
 * already finds + parses the gRegionMapEntries table. What's missing:
 *
 *   1. An ENCODER so propose_set_region_map_label (Phase 3.29) can
 *      write a new entry back into the table in place.
 *   2. A LIFTER that adapts the scanner's `RegionMapSection[]` shape
 *      into a manifest-side `ManifestRegionMapEntry[]` shape.
 *
 * The table supports two layouts:
 *   - 12-byte (Emerald-style): { x, y, width, height, nameRomPointer }
 *     with each field at distinct offsets + padding bytes.
 *   - 8-byte (FRLG-style): tighter packing of the same fields.
 *
 * Encoder writes either layout per the caller's `layoutKind`. The
 * scanner records `layoutKind` on the discovered table, so the propose
 * tool reads it once + threads it through to every encode call for a
 * given project.
 */

import { GBA_ROM_BASE_ADDRESS } from '../pointers/index.js';
import {
  REGION_MAP_SECTION_SIZE_BYTES_12,
  REGION_MAP_SECTION_SIZE_BYTES_8,
  type RegionMapLayoutKind,
  type RegionMapSection,
} from '../world/region-map-sections.js';

export interface RegionMapSectionSpec {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** File offset of the (encoded Gen-3 charset) name string; null = no
   *  name slot (sentinel entry). */
  readonly nameOffset: number | null;
}

export class RegionMapSectionEncodeError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(`RegionMapSectionEncodeError: ${field}: ${message}`);
    this.name = 'RegionMapSectionEncodeError';
    this.field = field;
  }
}

/** Encode a single region-map entry. Layout depends on the family. */
export function encodeRegionMapSection(
  spec: RegionMapSectionSpec,
  layoutKind: RegionMapLayoutKind,
): Uint8Array {
  validateU8('x', spec.x);
  validateU8('y', spec.y);
  validateU8('width', spec.width);
  validateU8('height', spec.height);
  const size =
    layoutKind === '12byte' ? REGION_MAP_SECTION_SIZE_BYTES_12 : REGION_MAP_SECTION_SIZE_BYTES_8;
  const out = new Uint8Array(size);
  if (layoutKind === '12byte') {
    // Emerald-style 12-byte layout:
    //   0x00 u8 x
    //   0x01 u8 y
    //   0x02 u8 width
    //   0x03 u8 height
    //   0x04 u32 namePointer
    //   0x08 u32 padding (typically 0)
    out[0x00] = spec.x & 0xff;
    out[0x01] = spec.y & 0xff;
    out[0x02] = spec.width & 0xff;
    out[0x03] = spec.height & 0xff;
    writeNamePointer(out, 0x04, spec.nameOffset);
    out[0x08] = 0;
    out[0x09] = 0;
    out[0x0a] = 0;
    out[0x0b] = 0;
  } else {
    // FRLG-style 8-byte layout:
    //   0x00 u32 namePointer
    //   0x04 u8 x
    //   0x05 u8 y
    //   0x06 u8 width
    //   0x07 u8 height
    writeNamePointer(out, 0x00, spec.nameOffset);
    out[0x04] = spec.x & 0xff;
    out[0x05] = spec.y & 0xff;
    out[0x06] = spec.width & 0xff;
    out[0x07] = spec.height & 0xff;
  }
  return out;
}

function writeNamePointer(out: Uint8Array, byteOffset: number, fileOffset: number | null): void {
  if (fileOffset === null) {
    out[byteOffset + 0] = 0;
    out[byteOffset + 1] = 0;
    out[byteOffset + 2] = 0;
    out[byteOffset + 3] = 0;
    return;
  }
  if (!Number.isInteger(fileOffset) || fileOffset < 0 || fileOffset > 0x01ffffff) {
    throw new RegionMapSectionEncodeError(
      'nameOffset',
      `must fit in 25 bits; got ${String(fileOffset)}`,
    );
  }
  const ptr = (fileOffset + GBA_ROM_BASE_ADDRESS) >>> 0;
  out[byteOffset + 0] = ptr & 0xff;
  out[byteOffset + 1] = (ptr >>> 8) & 0xff;
  out[byteOffset + 2] = (ptr >>> 16) & 0xff;
  out[byteOffset + 3] = (ptr >>> 24) & 0xff;
}

function validateU8(field: string, v: number): void {
  if (!Number.isInteger(v) || v < 0 || v > 0xff) {
    throw new RegionMapSectionEncodeError(field, `must be u8; got ${String(v)}`);
  }
}

/**
 * Manifest-side shape for one region-map entry, derived from the
 * scanner's RegionMapSection. The lifter at the bottom of the file
 * builds these from a parsed table.
 */
export interface ManifestRegionMapEntry {
  /** Stable id used in cross-refs (e.g. `region_map_section_3`). */
  readonly id: string;
  /** Section index byte (matches MapHeader.regionMapSection). */
  readonly sectionIndex: number;
  /** Top-left tile x. */
  readonly x: number;
  /** Top-left tile y. */
  readonly y: number;
  /** Width in tiles. */
  readonly width: number;
  /** Height in tiles. */
  readonly height: number;
  /** Decoded area name; empty when this is a sentinel/blank slot. */
  readonly name: string;
  /** Absolute file offset of the entry's first byte. */
  readonly fileOffset: number;
}

/**
 * Lift the scanner's RegionMapSection[] into a manifest-side
 * ManifestRegionMapEntry[]. Filters out only sentinel entries whose
 * sectionIndex < 0 (defensive - shouldn't happen but guards against
 * malformed scans).
 */
export function liftRegionMapSections(
  sections: ReadonlyArray<RegionMapSection>,
): ReadonlyArray<ManifestRegionMapEntry> {
  const out: ManifestRegionMapEntry[] = [];
  for (const s of sections) {
    if (s.sectionIndex < 0) continue;
    out.push(
      Object.freeze({
        id: `region_map_section_${String(s.sectionIndex)}`,
        sectionIndex: s.sectionIndex,
        x: s.x,
        y: s.y,
        width: s.width,
        height: s.height,
        name: s.name,
        fileOffset: s.fileOffset,
      }),
    );
  }
  return Object.freeze(out);
}
