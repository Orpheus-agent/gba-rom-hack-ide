/**
 * Gen-3 overworld-sprite palette table scanner - Phase F / "Rendering
 * Truth" iter (semantic-world plan §Phase 1.1).
 *
 * Detects the universal Gen-3 `sObjectEventSpritePalettes[]` table that
 * every Gen-3 cart embeds for overworld sprite palette resolution. Per
 * pret/pokefirered `src/event_object_movement.c`:
 *
 *   const struct SpritePalette sObjectEventSpritePalettes[] = {
 *     {gObjectEventPalette0, OBJ_EVENT_PAL_TAG_BRENDAN},     // 0x1100
 *     {gObjectEventPalette1, OBJ_EVENT_PAL_TAG_BRENDAN_REFL}, // 0x1101
 *     ...
 *     {NULL, OBJ_EVENT_PAL_TAG_NONE},                         // 0x11FF
 *   };
 *
 *   struct SpritePalette {
 *     const u16 *data;  // 4 bytes - ROM-space pointer to a 32-byte
 *                       // BGR555 palette block
 *     u16 tag;          // 2 bytes
 *   };                  // 8 bytes total (2 padding for alignment)
 *
 * Each per-sprite OverworldSpriteInfo struct carries a `paletteTag1`
 * field at offset 0x02. The renderer cross-references the tag against
 * this table to load the correct 16-color palette. Without this table
 * detected, OW sprites render as grayscale silhouettes.
 *
 * Detection signature (PD 5 universal):
 *   1. Walk 4-byte aligned offsets past the cartridge header
 *   2. At each candidate, parse as a `SpritePalette` first entry:
 *      - u32 pointer in ROM-space [0x08000000, 0x0A000000) and non-zero
 *      - Pointer's target = valid 32-byte BGR555 palette region
 *        (bit 15 clear for every color, ≥3 distinct colors)
 *      - u16 tag != 0xFFFF (first entry can't be sentinel)
 *      - u16 padding == 0
 *   3. Walk forward in 8-byte strides; each entry passes the same
 *      check OR is the NULL sentinel (pointer=0, pad=0)
 *   4. Require ≥ MIN_ENTRIES non-sentinel entries + sentinel termination
 *      within MAX_ENTRIES
 *   5. Pick the longest valid run
 *
 * Combined false-positive rate per random 8-byte window:
 *   - ROM-pointer signature: ~1/256
 *   - Pointed-to-region BGR555 validity: ~1/65,536 (bit 15 across 16 u16s)
 *   - 8 consecutive valid entries: vanishingly small
 *
 * PD 5 universal - works on every Gen-3 cart with the SpritePalette
 * convention (vanilla FRLG/RSE + Emerald + every hack that retains it).
 *
 * PD 16 hack-aware - Unbound / Radical Red / CFRU expand this table
 * with custom palettes; the structural signature catches them all.
 */

import { isValidPaletteRegion, bgr555ToRgba, PALETTE_BYTES } from '../graphics/index.js';

/** Size of one SpritePalette entry in bytes (4-byte pointer + 2-byte
 *  tag + 2-byte padding for alignment). */
export const SPRITE_PALETTE_ENTRY_SIZE_BYTES = 8;

/** Minimum entries (excluding sentinel) required for confident detection.
 *  Vanilla FRLG has ~25; Emerald has ~30; even minimal hacks ≥ 8. */
export const OBJECT_EVENT_PALETTES_MIN_ENTRIES = 8;

/** Defensive cap on entries walked in a single scan. */
export const OBJECT_EVENT_PALETTES_MAX_ENTRIES = 256;

/** Sentinel tag (OBJ_EVENT_PAL_TAG_NONE) - surfaces but not strictly
 *  required since detection terminates on NULL pointer. */
export const OBJECT_EVENT_PAL_TAG_NONE = 0x11ff;

/** GBA ROM mirror range - pointers must fall in here or be 0. */
const GBA_ROM_BASE = 0x08000000;
const GBA_ROM_END_EXCLUSIVE = 0x0a000000;

/** Skip the GBA cartridge header (first 192 bytes). */
const SCAN_BODY_OFFSET = 0xc0;

/** Scan stride - u32-aligned. */
const SCAN_STRIDE_BYTES = 4;

export interface ObjectEventPaletteEntry {
  /** Entry index in the table (0-based, before sentinel). */
  readonly entryIndex: number;
  /** Absolute file offset of the 8-byte entry slot in the table. */
  readonly entryFileOffset: number;
  /** Palette tag from entry+0x04 (matches paletteTag1 of an
   *  OverworldSpriteInfo struct). */
  readonly tag: number;
  /** Absolute file offset of the 32-byte BGR555 palette block this
   *  entry points to. */
  readonly paletteFileOffset: number;
  /** Decoded 16-color palette as RGBA u32 array (length 16). Palette
   *  index 0 is returned as 0x00000000 (transparent) per the Gen-3 4bpp
   *  sprite convention. */
  readonly paletteRgba: ReadonlyArray<number>;
}

export interface ObjectEventPaletteTable {
  /** Absolute file offset of the table's first byte. */
  readonly tableStart: number;
  /** Exclusive end offset, including the 8-byte NULL sentinel. */
  readonly tableEndExclusive: number;
  /** Number of non-sentinel entries. */
  readonly entryCount: number;
  /** Per-entry data - length == entryCount. */
  readonly entries: ReadonlyArray<ObjectEventPaletteEntry>;
}

function readU16LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function readU32LE(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset]! |
      (bytes[offset + 1]! << 8) |
      (bytes[offset + 2]! << 16) |
      (bytes[offset + 3]! << 24)) >>>
    0
  );
}

function isRomPointer(ptr: number): boolean {
  return ptr >= GBA_ROM_BASE && ptr < GBA_ROM_END_EXCLUSIVE;
}

function ptrToFileOffset(ptr: number, romByteLength: number): number {
  if (ptr < GBA_ROM_BASE || ptr >= GBA_ROM_END_EXCLUSIVE) return -1;
  const off = ptr - GBA_ROM_BASE;
  if (off + PALETTE_BYTES > romByteLength) return -1;
  return off;
}

/** Try to parse one 8-byte SpritePalette entry. Returns
 *  - { kind: 'sentinel' } when pointer=0 (table terminator)
 *  - { kind: 'entry', tag, paletteFileOffset, paletteRgba } when valid
 *  - null when the slot doesn't shape-match. */
function tryParseEntry(
  bytes: Uint8Array,
  entryOffset: number,
):
  | { kind: 'sentinel' }
  | {
      kind: 'entry';
      tag: number;
      paletteFileOffset: number;
      paletteRgba: ReadonlyArray<number>;
    }
  | null {
  if (entryOffset < 0 || entryOffset + SPRITE_PALETTE_ENTRY_SIZE_BYTES > bytes.length) {
    return null;
  }
  const ptr = readU32LE(bytes, entryOffset);
  const tag = readU16LE(bytes, entryOffset + 4);
  const pad = readU16LE(bytes, entryOffset + 6);

  if (pad !== 0) return null;

  if (ptr === 0) {
    // Sentinel slot - accept regardless of tag value (vanilla uses
    // 0x11FF but hacks may differ).
    return { kind: 'sentinel' };
  }

  if (!isRomPointer(ptr)) return null;
  const paletteFileOffset = ptrToFileOffset(ptr, bytes.length);
  if (paletteFileOffset < 0) return null;
  if (!isValidPaletteRegion(bytes, paletteFileOffset)) return null;

  // Decode the 32-byte BGR555 palette to 16 u32 RGBA colors.
  const paletteBytes = bytes.subarray(paletteFileOffset, paletteFileOffset + PALETTE_BYTES);
  const rgba = bgr555ToRgba(paletteBytes);

  return {
    kind: 'entry',
    tag,
    paletteFileOffset,
    paletteRgba: Array.from(rgba),
  };
}

export interface ScanObjectEventPalettesOptions {
  readonly minEntries?: number;
  readonly maxEntries?: number;
}

/**
 * Find the longest valid `sObjectEventSpritePalettes[]` table in
 * `bytes`. Returns the table on success or `null` when no run clears
 * the min-entries threshold.
 *
 * Strategy: walk u32-aligned offsets, try each as the first entry, walk
 * forward until sentinel or invalid entry, accept the longest valid
 * run that terminates with a sentinel.
 */
export function scanObjectEventPaletteTable(
  bytes: Uint8Array,
  opts?: ScanObjectEventPalettesOptions,
): ObjectEventPaletteTable | null {
  const minEntries = opts?.minEntries ?? OBJECT_EVENT_PALETTES_MIN_ENTRIES;
  const maxEntries = opts?.maxEntries ?? OBJECT_EVENT_PALETTES_MAX_ENTRIES;

  // Need at least (minEntries + 1) entries × 8 bytes past the header.
  const minBytesAfterHeader = (minEntries + 1) * SPRITE_PALETTE_ENTRY_SIZE_BYTES;
  if (bytes.length < SCAN_BODY_OFFSET + minBytesAfterHeader) return null;

  let bestStart = -1;
  let bestEntries: ObjectEventPaletteEntry[] = [];

  const lastStart = bytes.length - minBytesAfterHeader;
  for (let p = SCAN_BODY_OFFSET; p <= lastStart; p += SCAN_STRIDE_BYTES) {
    // Fast pre-check: first entry must be a non-sentinel valid entry.
    const first = tryParseEntry(bytes, p);
    if (first === null || first.kind !== 'entry') continue;

    // Walk forward collecting entries.
    const entries: ObjectEventPaletteEntry[] = [];
    let foundSentinel = false;
    let entryCount = 0;
    while (entryCount < maxEntries) {
      const off = p + entryCount * SPRITE_PALETTE_ENTRY_SIZE_BYTES;
      const parsed = tryParseEntry(bytes, off);
      if (parsed === null) break;
      if (parsed.kind === 'sentinel') {
        foundSentinel = true;
        break;
      }
      entries.push({
        entryIndex: entryCount,
        entryFileOffset: off,
        tag: parsed.tag,
        paletteFileOffset: parsed.paletteFileOffset,
        paletteRgba: parsed.paletteRgba,
      });
      entryCount++;
    }

    if (!foundSentinel) continue;
    if (entries.length < minEntries) continue;

    if (entries.length > bestEntries.length) {
      bestStart = p;
      bestEntries = entries;
      // Skip past this run before continuing the outer scan.
      p += (entries.length - 1) * SCAN_STRIDE_BYTES;
    }
  }

  if (bestStart < 0 || bestEntries.length < minEntries) return null;

  // tableEndExclusive includes the 8-byte sentinel slot.
  const tableEndExclusive =
    bestStart + (bestEntries.length + 1) * SPRITE_PALETTE_ENTRY_SIZE_BYTES;

  return {
    tableStart: bestStart,
    tableEndExclusive,
    entryCount: bestEntries.length,
    entries: Object.freeze(bestEntries),
  };
}
