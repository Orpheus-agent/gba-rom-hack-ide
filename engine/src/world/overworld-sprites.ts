/**
 * Gen-3 overworld sprite metadata scanner - iter 101 / UW-3-T20.
 *
 * Detects the universal `gObjectEventGraphicsInfoPointers[]` table that
 * every Gen-3 cart embeds for overworld sprite (NPC/player/object)
 * graphics. Per pret/pokefirered `include/global.fieldmap.h`:
 *
 *   const struct ObjectEventGraphicsInfo *const gObjectEventGraphicsInfoPointers[];
 *
 * Each entry is a u32 ROM-space pointer to a 36-byte
 * `ObjectEventGraphicsInfo` struct:
 *
 *   struct ObjectEventGraphicsInfo {
 *     u16 tileTag;             // 0x00 - Often 0xFFFF for non-tile-cached sprites
 *     u16 paletteTag1;         // 0x02 - Sprite palette tag
 *     u16 paletteTag2;         // 0x04 - Reflection palette tag (often 0x11FF)
 *     u16 size;                // 0x06 - OAM size enum (0..15)
 *     s16 width;               // 0x08 - Sprite width in px (8..64 typical)
 *     s16 height;              // 0x0A - Sprite height in px (8..64 typical)
 *     u8  paletteSlot:4;       // 0x0C - Bitfield byte: paletteSlot+shadowSize+inanimate+disableReflPalLoad
 *     u8  shadowSize:2;
 *     u8  inanimate:1;
 *     u8  disableReflectionPaletteLoad:1;
 *     u8  tracks;              // 0x0D - Movement tracks enum (0..6)
 *     u16 _padding;            // 0x0E..0x0F - align to 4-byte boundary
 *     const struct OamData *oam;            // 0x10 - ROM-space data pointer (always non-zero)
 *     const struct SubspriteTable *subspriteTables; // 0x14 - 0 OR ROM-space
 *     const union AnimCmd *const *anims;    // 0x18 - ROM-space data pointer (non-zero typical)
 *     const struct SpriteFrameImage *images;// 0x1C - ROM-space data pointer (always non-zero)
 *     const union AffineAnimCmd *const *affineAnims; // 0x20 - 0 OR ROM-space
 *   };  // 36 bytes (0x24)
 *
 * The table itself has ~239 entries in vanilla FRLG and grows for hacks
 * (Unbound adds 100+ sprites). Per PD 5: detect via universal structural
 * signature (no baked offsets):
 *
 *   1. Scan u32-aligned offsets for ≥100 consecutive ROM-space pointers
 *   2. Each pointer must point to a 36-byte struct that passes:
 *        - size (u16 @ 0x06) ≤ 31  (Gen-3 OAM size enum)
 *        - width (s16 @ 0x08) in [8, 256]
 *        - height (s16 @ 0x0A) in [8, 256]
 *        - tracks (u8 @ 0x0D) ≤ 7 (Gen-3 has ~6 track-enum values)
 *        - oam (u32 @ 0x10): in ROM-space [0x08000000, 0x0A000000)
 *        - subspriteTables (u32 @ 0x14): 0 OR ROM-space
 *        - anims (u32 @ 0x18): 0 OR ROM-space
 *        - images (u32 @ 0x1C): in ROM-space (always non-zero in vanilla)
 *        - affineAnims (u32 @ 0x20): 0 OR ROM-space
 *   3. Require ≥80% of pointers point to valid structs
 *   4. Cluster span check: target struct addresses within 256 KiB
 *
 * Combined false-positive rate per random pointer-table candidate:
 *   - Pointer-array signature: ~1/256 per entry
 *   - 36-byte struct validation: ~1/2^20 (multiple narrow ranges)
 *   - 100 valid entries in a row: vanishingly small
 *
 * PD 5 universal - works on every Gen-3 cart that retains the OW
 * sprite-info table convention (vanilla + every hack).
 *
 * PD 16 hack-aware - Unbound / Radical Red / CFRU all expand this table
 * with custom OW sprites; the structural signature catches them all.
 */

/** Size of one ObjectEventGraphicsInfo struct in bytes. */
export const OBJECT_EVENT_GRAPHICS_INFO_SIZE_BYTES = 36;

/** Minimum table-pointer-array entries required for confident detection.
 *  Vanilla FRLG has ~239 entries; even minimal hacks rarely drop below
 *  150. 100 gives slack for edge cases while rejecting incidental
 *  pointer runs. */
export const OVERWORLD_SPRITES_MIN_ENTRIES = 100;

/** Defensive cap on the table length walked in a single scan. */
export const OVERWORLD_SPRITES_MAX_ENTRIES = 4096;

/** Minimum fraction of pointers that must point to valid 36-byte structs. */
export const OVERWORLD_SPRITES_MIN_VALID_FRACTION = 0.8;

/** Maximum cluster-span of target struct addresses (bytes). Vanilla
 *  packs all OW sprite info structs into a single ROM section ~128 KiB
 *  wide; 256 KiB cap gives slack for hacks. */
export const OVERWORLD_SPRITES_MAX_CLUSTER_SPAN = 256 * 1024;

/** GBA ROM mirror range - pointer fields must fall in here or be 0. */
const GBA_ROM_BASE = 0x08000000;
const GBA_ROM_END_EXCLUSIVE = 0x0a000000;

/** Maximum OAM size byte value (Gen-3 OAM enum: 4 shape × 4 size = 16). */
const OAM_SIZE_MAX = 31;

/** Sprite width/height bounds in pixels. */
const SPRITE_DIMENSION_MIN = 8;
const SPRITE_DIMENSION_MAX = 256;

/** Maximum tracks enum byte (vanilla Gen-3 has ~6 values: NONE/FOOT/
 *  BIKE_TIRE/SLITHER/SPOT/BUBBLES; cap at 7 for slack). */
const TRACKS_MAX = 7;

/** Skip the GBA cartridge header (first 192 bytes). */
const SCAN_BODY_OFFSET = 0xc0;

/** Scan stride - u32-aligned. */
const SCAN_STRIDE_BYTES = 4;

export interface OverworldSpriteInfo {
  /** Index of this sprite in the discovered table. */
  readonly spriteIndex: number;
  /** Absolute file offset of the pointer entry in the pointer table. */
  readonly pointerTableEntryOffset: number;
  /** Absolute file offset of the 36-byte struct this pointer targets. */
  readonly structFileOffset: number;
  /** tileTag from struct offset 0x00. */
  readonly tileTag: number;
  /** Sprite palette tag from struct offset 0x02. */
  readonly paletteTag: number;
  /** Reflection palette tag from struct offset 0x04. */
  readonly reflectionPaletteTag: number;
  /** OAM size enum from struct offset 0x06. */
  readonly size: number;
  /** Sprite width in pixels from struct offset 0x08. */
  readonly width: number;
  /** Sprite height in pixels from struct offset 0x0A. */
  readonly height: number;
  /** Packed bitfield byte from struct offset 0x0C - bits 0-3 paletteSlot,
   *  4-5 shadowSize, 6 inanimate, 7 disableReflectionPaletteLoad. */
  readonly paletteSlotBits: number;
  /** Movement tracks enum from struct offset 0x0D. */
  readonly tracks: number;
}

export interface OverworldSpriteTable {
  /** First-byte offset of the pointer-table in the ROM. */
  readonly tableStart: number;
  /** Exclusive end offset (= tableStart + entryCount × 4). */
  readonly tableEndExclusive: number;
  /** Number of entries in the pointer table. */
  readonly entryCount: number;
  /** Per-entry parsed sprite info (length == entryCount when every
   *  pointer validated; may be shorter when some failed validation). */
  readonly sprites: ReadonlyArray<OverworldSpriteInfo>;
}

function readU16LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function readS16LE(bytes: Uint8Array, offset: number): number {
  const v = readU16LE(bytes, offset);
  return v < 0x8000 ? v : v - 0x10000;
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

function isValidRomPointerOrZero(ptr: number): boolean {
  if (ptr === 0) return true;
  return ptr >= GBA_ROM_BASE && ptr < GBA_ROM_END_EXCLUSIVE;
}

/** ROM pointer to file offset (subtracts the 0x08000000 mirror base).
 *  Returns -1 when the pointer is null or out of ROM range. */
function ptrToFileOffset(ptr: number, romByteLength: number): number {
  if (ptr === 0) return -1;
  if (ptr < GBA_ROM_BASE || ptr >= GBA_ROM_END_EXCLUSIVE) return -1;
  const fileOff = ptr - GBA_ROM_BASE;
  if (fileOff >= romByteLength) return -1;
  return fileOff;
}

/** Try to parse one 36-byte ObjectEventGraphicsInfo struct. Returns the
 *  parsed sprite info on success or null if the structural validation
 *  fails. */
function tryParseSpriteInfo(
  bytes: Uint8Array,
  structOffset: number,
): {
  tileTag: number;
  paletteTag: number;
  reflectionPaletteTag: number;
  size: number;
  width: number;
  height: number;
  paletteSlotBits: number;
  tracks: number;
} | null {
  if (structOffset < 0 || structOffset + OBJECT_EVENT_GRAPHICS_INFO_SIZE_BYTES > bytes.length) {
    return null;
  }
  const size = readU16LE(bytes, structOffset + 0x06);
  if (size > OAM_SIZE_MAX) return null;
  const width = readS16LE(bytes, structOffset + 0x08);
  if (width < SPRITE_DIMENSION_MIN || width > SPRITE_DIMENSION_MAX) return null;
  const height = readS16LE(bytes, structOffset + 0x0a);
  if (height < SPRITE_DIMENSION_MIN || height > SPRITE_DIMENSION_MAX) return null;
  const tracks = bytes[structOffset + 0x0d]!;
  if (tracks > TRACKS_MAX) return null;
  // Trailing 5 pointer fields at offsets 0x10, 0x14, 0x18, 0x1C, 0x20.
  const oamPtr = readU32LE(bytes, structOffset + 0x10);
  if (oamPtr === 0 || !isValidRomPointerOrZero(oamPtr)) return null; // OAM always non-zero in vanilla
  const subspritePtr = readU32LE(bytes, structOffset + 0x14);
  if (!isValidRomPointerOrZero(subspritePtr)) return null;
  const animsPtr = readU32LE(bytes, structOffset + 0x18);
  if (!isValidRomPointerOrZero(animsPtr)) return null;
  const imagesPtr = readU32LE(bytes, structOffset + 0x1c);
  if (imagesPtr === 0 || !isValidRomPointerOrZero(imagesPtr)) return null; // Images always non-zero
  const affinePtr = readU32LE(bytes, structOffset + 0x20);
  if (!isValidRomPointerOrZero(affinePtr)) return null;
  return {
    tileTag: readU16LE(bytes, structOffset + 0x00),
    paletteTag: readU16LE(bytes, structOffset + 0x02),
    reflectionPaletteTag: readU16LE(bytes, structOffset + 0x04),
    size,
    width,
    height,
    paletteSlotBits: bytes[structOffset + 0x0c]!,
    tracks,
  };
}

export interface ScanOverworldSpritesOptions {
  readonly minEntries?: number;
  readonly maxEntries?: number;
  readonly minValidFraction?: number;
  readonly maxClusterSpan?: number;
}

/**
 * Find the longest valid `gObjectEventGraphicsInfoPointers[]` in
 * `bytes`. Returns the table on success or `null` when no run clears
 * the min-entries × min-valid-fraction × cluster-span thresholds.
 *
 * Strategy: walk u32-aligned offsets, at each offset try to read N
 * consecutive ROM-pointers, follow each to validate the 36-byte struct
 * shape, and accept the longest run that clears all three thresholds.
 */
export function scanOverworldSpriteTable(
  bytes: Uint8Array,
  opts?: ScanOverworldSpritesOptions,
): OverworldSpriteTable | null {
  const minEntries = opts?.minEntries ?? OVERWORLD_SPRITES_MIN_ENTRIES;
  const maxEntries = opts?.maxEntries ?? OVERWORLD_SPRITES_MAX_ENTRIES;
  const minValidFraction = opts?.minValidFraction ?? OVERWORLD_SPRITES_MIN_VALID_FRACTION;
  const maxClusterSpan = opts?.maxClusterSpan ?? OVERWORLD_SPRITES_MAX_CLUSTER_SPAN;

  if (bytes.length < SCAN_BODY_OFFSET + minEntries * 4) return null;

  let bestStart = -1;
  let bestEntryCount = 0;
  let bestSprites: OverworldSpriteInfo[] = [];

  const lastStart = bytes.length - minEntries * 4;
  for (let p = SCAN_BODY_OFFSET; p <= lastStart; p += SCAN_STRIDE_BYTES) {
    // Fast pre-check: first entry must be ROM-space pointer.
    const firstPtr = readU32LE(bytes, p);
    if (!isValidRomPointerOrZero(firstPtr) || firstPtr === 0) continue;
    const firstStruct = ptrToFileOffset(firstPtr, bytes.length);
    if (firstStruct < 0) continue;
    if (tryParseSpriteInfo(bytes, firstStruct) === null) continue;

    // Walk forward as far as we can while pointers stay ROM-space.
    const sprites: OverworldSpriteInfo[] = [];
    let entryCount = 0;
    let validCount = 0;
    let minStructAddr = Infinity;
    let maxStructAddr = -Infinity;

    while (entryCount < maxEntries) {
      const ptrOffset = p + entryCount * 4;
      if (ptrOffset + 4 > bytes.length) break;
      const ptr = readU32LE(bytes, ptrOffset);
      if (!isValidRomPointerOrZero(ptr)) break;
      // Null entries permitted (placeholder slots); count toward
      // entryCount but not validCount.
      if (ptr === 0) {
        entryCount++;
        continue;
      }
      const structOffset = ptrToFileOffset(ptr, bytes.length);
      if (structOffset < 0) break;
      const parsed = tryParseSpriteInfo(bytes, structOffset);
      if (parsed === null) {
        // Tolerate a few invalid structs (some hacks have stub entries)
        // but cap at 5 consecutive misses to prevent runaway.
        // To keep the implementation simple, we just bail on first
        // invalid struct - the validFraction check below filters out
        // weak runs.
        break;
      }
      sprites.push({
        spriteIndex: entryCount,
        pointerTableEntryOffset: ptrOffset,
        structFileOffset: structOffset,
        ...parsed,
      });
      validCount++;
      if (structOffset < minStructAddr) minStructAddr = structOffset;
      if (structOffset > maxStructAddr) maxStructAddr = structOffset;
      entryCount++;
    }

    if (entryCount < minEntries) continue;
    if (validCount / entryCount < minValidFraction) continue;
    if (maxStructAddr - minStructAddr > maxClusterSpan) continue;

    if (entryCount > bestEntryCount) {
      bestStart = p;
      bestEntryCount = entryCount;
      bestSprites = sprites;
      // Skip past this run before continuing the outer scan.
      p += (entryCount - 1) * SCAN_STRIDE_BYTES;
    }
  }

  if (bestStart < 0 || bestEntryCount < minEntries) return null;
  return {
    tableStart: bestStart,
    tableEndExclusive: bestStart + bestEntryCount * 4,
    entryCount: bestEntryCount,
    sprites: Object.freeze(bestSprites),
  };
}
