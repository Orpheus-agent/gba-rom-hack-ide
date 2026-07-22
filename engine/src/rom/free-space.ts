/**
 * Phase O.6 - ROM free-space allocator.
 *
 * Foundational primitive for "grow an in-ROM array" operations:
 * trainer party append, encounter slot append, multichoice grow,
 * map connection append, etc. All of these need to relocate the
 * existing array to a larger region elsewhere in ROM and rewrite
 * the parent struct's pointer + count.
 *
 * Strategy: scan from the END of the ROM backward, looking for the
 * longest run of fill bytes (0xFF - the standard "unprogrammed"
 * sentinel that linkers / build tools leave in the cartridge image,
 * AND 0x00 - the alternate sentinel some hacks use). Return the
 * START offset of the LATEST run that's at least `sizeNeeded` bytes
 * AND 4-byte aligned (Gen-3 reads u32 pointers; misaligned data
 * would crash on hardware).
 *
 * Why scan from the end:
 *   - Vanilla Gen-3 ROMs (16 MB) have ~10-12 MB of 0xFF padding past
 *     the last linker-written byte. Plenty of room.
 *   - Even hack ROMs often expand the file to 32 MB with 0xFF
 *     padding past the original data.
 *   - Scanning from the END finds the largest contiguous run first.
 *
 * Per PD 1: explicit failure mode - returns -1 when no run is large
 *   enough OR the ROM is too small to scan past the cartridge header.
 *
 * Per PD 5: structural - works on any Gen-3 cart regardless of base
 *   game / hack variant.
 */

/** Cartridge-header skip - never allocate over the header bytes. */
const CARTRIDGE_HEADER_END = 0xc0;

/** Required alignment for allocated regions (GBA u32 pointer reads). */
const ALIGNMENT_BYTES = 4;

/** Both standard fill sentinels - vanilla / hack toolchains may use
 *  either depending on linker config. */
function isFillByte(b: number): boolean {
  return b === 0xff || b === 0x00;
}

export interface FreeSpaceResult {
  /** Aligned file offset where the new region starts. */
  readonly offset: number;
  /** Length in bytes of the contiguous fill run that contained the
   *  allocation (so callers can sanity-check). Always ≥ sizeNeeded. */
  readonly runLength: number;
  /** The fill byte that was found (0xff or 0x00). */
  readonly fillByte: number;
}

/**
 * Find a 4-byte-aligned region of ≥ `sizeNeeded` consecutive fill bytes
 * (0xFF or 0x00) starting after the cartridge header. Scans from the
 * end of the ROM backward so the latest (and typically largest)
 * free run is found first.
 *
 * Returns null when no run is large enough.
 *
 * `minOffset` (optional) caps the lower bound - pass an offset past
 * the last known used region to skip scanning over recognized data
 * (e.g. past `binaryRom.lastUsedOffset` if tracked). Defaults to
 * CARTRIDGE_HEADER_END (0xc0).
 */
export function findFreeRomSpace(
  bytes: Uint8Array,
  sizeNeeded: number,
  minOffset = CARTRIDGE_HEADER_END,
): FreeSpaceResult | null {
  if (sizeNeeded <= 0) return null;
  if (bytes.length < minOffset + sizeNeeded) return null;

  // Walk backward from end-of-ROM finding fill runs. When we see a
  // non-fill byte, the current run ends. After enough fill bytes
  // (≥ sizeNeeded + alignment-slack) we know the run is usable.
  //
  // We collect ALL qualifying runs and pick the one closest to the
  // end (highest offset) - that minimizes interference with any
  // not-yet-detected ROM data we might be sitting in front of.
  let bestOffset = -1;
  let bestRunLength = 0;
  let bestFillByte = 0xff;

  let runEnd = bytes.length; // exclusive
  let cursor = bytes.length - 1;
  while (cursor >= minOffset) {
    const b = bytes[cursor]!;
    if (isFillByte(b)) {
      // Walk back as long as we see the SAME fill byte. Mixed
      // 0xFF/0x00 runs are split - easier on the operator to
      // reason about, and 0x00 inside 0xFF padding is often
      // accidental zero-init data, not free space.
      const fillByte = b;
      let runStart = cursor;
      while (runStart > minOffset && bytes[runStart - 1] === fillByte) runStart--;
      const runLength = runEnd - runStart;
      if (runLength >= sizeNeeded) {
        // Allocate at the END of the run so any preceding data is
        // untouched. Align DOWN to 4 bytes.
        const candidateOffset = (runEnd - sizeNeeded) & ~(ALIGNMENT_BYTES - 1);
        // Validate the aligned offset is still within the run.
        if (candidateOffset >= runStart && candidateOffset + sizeNeeded <= runEnd) {
          if (candidateOffset > bestOffset) {
            bestOffset = candidateOffset;
            bestRunLength = runLength;
            bestFillByte = fillByte;
          }
        }
      }
      cursor = runStart - 1;
      runEnd = cursor + 1;
    } else {
      cursor--;
      runEnd = cursor + 1;
    }
  }

  if (bestOffset < 0) return null;
  return Object.freeze({
    offset: bestOffset,
    runLength: bestRunLength,
    fillByte: bestFillByte,
  });
}
