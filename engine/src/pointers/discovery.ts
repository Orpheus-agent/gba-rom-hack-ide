/**
 * GBA ROM pointer discovery.
 *
 * The GBA hardware memory map (Nintendo published spec) places cartridge
 * ROM at 0x08000000–0x09FFFFFF (32 MiB). ARM7 code uses 32-bit pointers
 * little-endian; every internal data reference inside cartridge code or
 * data tables looks like:
 *
 *   <low byte> <mid byte> <high byte> <0x08 or 0x09>
 *
 * stored at a 4-byte-aligned offset. This module discovers every such
 * candidate pointer in a ROM buffer and returns the (source → target)
 * pairs the table/cluster/repoint analyzers consume.
 *
 * Important universality note (PD 5): NO Pokémon-specific assumptions are
 * baked here. The algorithm works on ANY GBA cartridge - it's the same
 * hardware contract Nintendo published for every Game Boy Advance title.
 *
 * Performance: scanning a 32 MiB ROM at stride 4 is 8 M iterations. On a
 * modern Node 22 it completes in ~50 ms (single-pass linear scan with
 * tight integer-only ops). Memory: the returned pointer array carries
 * one 8-byte record per candidate (source + target as uint32). Typical
 * Gen-3 ROMs have ~50–500 K candidates → 0.4–4 MB. Acceptable.
 */

/** GBA hardware-spec ROM region. */
export const GBA_ROM_BASE_ADDRESS = 0x08000000;
export const GBA_ROM_END_ADDRESS_EXCLUSIVE = 0x0a000000;

/** Per-pointer record. */
export interface RomPointer {
  /** Byte offset within the ROM file where the 4-byte pointer LIVES. */
  readonly sourceOffset: number;
  /** Byte offset within the ROM file where the pointer POINTS to.
   *  Always < rom.length (we filter out pointers past actual ROM size). */
  readonly targetOffset: number;
  /** Raw little-endian 32-bit value at sourceOffset (the actual stored
   *  ARM address, e.g. 0x081A2B3C). Useful for evidence / debugging. */
  readonly rawAddress: number;
}

/**
 * True iff the 4 bytes at `offset` in `bytes` look like a GBA ROM pointer
 * pointing into the same ROM. Used by both the bulk discovery function
 * and per-position predicate checks (e.g. table-shape validation).
 */
export function isProbableRomPointer(bytes: Uint8Array, offset: number): boolean {
  if (offset < 0 || offset + 4 > bytes.length) return false;
  // Stored little-endian → high byte is at offset+3.
  const highByte = bytes[offset + 3] ?? 0;
  if (highByte !== 0x08 && highByte !== 0x09) return false;
  const rawAddress = readUint32Le(bytes, offset);
  if (rawAddress < GBA_ROM_BASE_ADDRESS || rawAddress >= GBA_ROM_END_ADDRESS_EXCLUSIVE) {
    return false;
  }
  const targetOffset = rawAddress - GBA_ROM_BASE_ADDRESS;
  // The pointer must land inside the actual ROM bytes (a cart's pointer
  // could in theory address ROM past the file's end if the cart has been
  // truncated - we reject those because they can't be followed).
  return targetOffset < bytes.length;
}

export interface DiscoveryOptions {
  /** Stride between candidate positions. Default 4 (word-aligned, the
   *  ARM ABI requirement for pointer storage). Set to 1 to look at every
   *  byte position - slower + drastically more false positives, only
   *  useful for adversarial / repointed-data forensics. */
  readonly stride?: number;
  /** Optional inclusive start offset (default 0). */
  readonly startOffset?: number;
  /** Optional exclusive end offset (default rom.length). */
  readonly endOffsetExclusive?: number;
}

/**
 * Scan the entire ROM at 4-byte stride and return every position whose
 * stored 32-bit value parses as a GBA ROM pointer into the same ROM.
 *
 * Empty array is a legitimate result (e.g. a corrupt/empty buffer).
 * Callers that need a typed `Detection` wrap this and surface a
 * `not_detected` with reason; this function stays pure.
 */
export function discoverPointers(bytes: Uint8Array, opts?: DiscoveryOptions): RomPointer[] {
  const stride = opts?.stride ?? 4;
  if (!Number.isInteger(stride) || stride < 1) {
    throw new Error(`stride must be a positive integer, got ${String(stride)}`);
  }
  const start = opts?.startOffset ?? 0;
  const endExclusive = opts?.endOffsetExclusive ?? bytes.length;
  if (start < 0 || endExclusive > bytes.length || endExclusive < start) {
    throw new Error(
      `discovery window invalid: [${String(start)}, ${String(endExclusive)}) for buffer of length ${String(bytes.length)}`,
    );
  }
  const results: RomPointer[] = [];
  const limit = endExclusive - 4;
  for (let i = start; i <= limit; i += stride) {
    if (!isProbableRomPointer(bytes, i)) continue;
    const rawAddress = readUint32Le(bytes, i);
    results.push({
      sourceOffset: i,
      targetOffset: rawAddress - GBA_ROM_BASE_ADDRESS,
      rawAddress,
    });
  }
  return results;
}

/** Read a little-endian uint32 at offset. Assumes offset+4 ≤ bytes.length. */
function readUint32Le(bytes: Uint8Array, offset: number): number {
  // Use unsigned right shift to coerce to uint32.
  return (
    ((bytes[offset] ?? 0) |
      ((bytes[offset + 1] ?? 0) << 8) |
      ((bytes[offset + 2] ?? 0) << 16) |
      ((bytes[offset + 3] ?? 0) << 24)) >>>
    0
  );
}
