/**
 * GBA palette format substrate - Phase UW-2 / Category 8 (iter 78 /
 * UW-2-T12).
 *
 * GBA hardware uses BGR555 color: each 16-bit color stores 5 bits of
 * blue (bits 0-4), 5 bits of green (5-9), 5 bits of red (10-14), and
 * bit 15 is UNUSED - the hardware ignores it and pret/gbatek convention
 * stores it as 0 in every palette literal. A standard palette is
 * 16 colors × 2 bytes = 32 bytes; palette banks pack 8 such palettes
 * into 256 bytes.
 *
 * Detection signal:
 *   - Every 16th u16 in a 32-byte window has bit 15 = 0 (the unused
 *     bit). The probability of this happening by chance in a random
 *     32-byte window is (1/2)^16 = 1 / 65,536.
 *   - At least 3 distinct colors (rules out flat-padding zeros which
 *     trivially pass bit-15 = 0).
 *   - Combined: false-positive rate per random 32-byte window is
 *     extremely low; a real ROM typically contains hundreds of
 *     palette regions distributed across sprite / tileset / UI data.
 *
 * Per PD 5: BGR555 is the GBA hardware format, not a Pokémon-specific
 * convention; works on every GBA cart. Cat 8 advance applies broadly.
 *
 * Per PD 12: the scanner returns ALL detected palette region offsets
 * (capped at a sane limit to avoid unbounded memory growth on a
 * pathological corpus).
 */

/** Size in bytes of one standard 16-color GBA palette. */
export const PALETTE_BYTES = 32;

/** Number of colors in one standard palette. */
export const COLORS_PER_PALETTE = 16;

/** Size of one full palette bank (8 palettes × 32 bytes). */
export const PALETTE_BANK_BYTES = 256;

/** Minimum number of DISTINCT colors a 32-byte window must contain to
 *  count as a real palette (vs flat padding or single-color fills). */
export const PALETTE_MIN_DISTINCT_COLORS = 3;

/** Phase H-RC4 (semantic-world plan §H.4) - how many BGR555 colors per
 *  16-color palette are allowed to have bit 15 set (the "unused" bit
 *  per the GBA hardware spec). Strict pret-compiled palettes have 0;
 *  heavy hacks (Unbound, Radical Red, CFRU, etc.) occasionally have
 *  1-2 colors with stray high bits, especially in OW palette tables
 *  that the linker stitched together from multiple source files.
 *
 *  Setting this to 0 made `object_event_palettes_system` return
 *  `not_detected` on hack ROMs → no spritePaletteRgbaHex → every NPC
 *  rendered as a flat colored rectangle. 2 tolerates the most common
 *  hack-ROM noise while still rejecting random data (the bit-15-clear
 *  + distinct-colors signal is still 14/16 strong). */
export const PALETTE_MAX_HIGH_BIT_COLORS = 2;

/** Maximum number of palette region offsets to collect in a single
 *  scan. Sane cap to bound memory on pathological corpora. Vanilla
 *  FRLG has ~1500-3000 palettes; 8192 leaves comfortable headroom. */
export const PALETTE_SCAN_MAX_REGIONS = 8192;

/** Cartridge-header skip (well-known not to contain palettes). */
const CARTRIDGE_HEADER_END = 0xc0;

/**
 * Validate that the 32 bytes at `bytes[offset..offset+32]` form a
 * plausible BGR555 palette region: at most `PALETTE_MAX_HIGH_BIT_COLORS`
 * colors have bit 15 set (the GBA hardware "unused" bit), AND the
 * region contains at least `PALETTE_MIN_DISTINCT_COLORS` distinct
 * color values.
 *
 * Returns `false` if `offset` doesn't have 32 bytes available.
 */
export function isValidPaletteRegion(bytes: Uint8Array, offset: number): boolean {
  if (offset < 0 || offset + PALETTE_BYTES > bytes.byteLength) return false;
  const seen = new Set<number>();
  let highBitCount = 0;
  for (let i = 0; i < COLORS_PER_PALETTE; i++) {
    const lo = bytes[offset + i * 2]!;
    const hi = bytes[offset + i * 2 + 1]!;
    // Bit 15 of the u16 → bit 7 of the HIGH byte (little-endian u16).
    if ((hi & 0x80) !== 0) {
      highBitCount++;
      if (highBitCount > PALETTE_MAX_HIGH_BIT_COLORS) return false;
    }
    seen.add((hi << 8) | lo);
  }
  return seen.size >= PALETTE_MIN_DISTINCT_COLORS;
}

export interface PaletteScanResult {
  /** All offsets where a valid palette region starts. Sorted ascending. */
  readonly regionOffsets: ReadonlyArray<number>;
  /** Total count of regions found (== regionOffsets.length unless the
   *  scan hit the PALETTE_SCAN_MAX_REGIONS cap, in which case this
   *  exposes the true count up to the cap). */
  readonly regionCount: number;
}

/**
 * Scan `romBytes` for all valid 32-byte BGR555 palette regions starting
 * at 32-byte-aligned offsets past the cartridge header. Returns the
 * sorted list of region start offsets, capped at
 * PALETTE_SCAN_MAX_REGIONS.
 *
 * 32-byte alignment matches the GBA hardware palette RAM layout
 * (BG_PALETTE_RAM and OBJ_PALETTE_RAM are 256-byte segments at
 * 32-byte aligned addresses). Most pret palette literals are
 * 4-byte aligned at minimum, but the 32-byte alignment we enforce
 * matches the canonical palette-bank layout AND avoids reporting
 * mid-palette offsets as separate regions.
 */
export function scanPaletteRegions(romBytes: Uint8Array): PaletteScanResult {
  const regionOffsets: number[] = [];
  // Align start to 32-byte boundary past the cartridge header.
  const startAligned = Math.ceil(CARTRIDGE_HEADER_END / PALETTE_BYTES) * PALETTE_BYTES;
  for (
    let p = startAligned;
    p + PALETTE_BYTES <= romBytes.byteLength && regionOffsets.length < PALETTE_SCAN_MAX_REGIONS;
    p += PALETTE_BYTES
  ) {
    if (isValidPaletteRegion(romBytes, p)) {
      regionOffsets.push(p);
    }
  }
  return { regionOffsets, regionCount: regionOffsets.length };
}
