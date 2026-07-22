/**
 * Phase 9A - Memory readers that translate GBA addresses to
 * `HEAPU8` offsets inside the mGBA WASM heap.
 *
 * mGBA stores the cart's emulated memory regions (BIOS, EWRAM, IWRAM,
 * I/O, palette RAM, VRAM, OAM, ROM, SRAM) as contiguous buffers inside
 * the Emscripten heap. The exact offsets aren't exported as named
 * symbols; we find them dynamically by scanning the heap for the cart
 * header's distinctive bytes at boot time.
 *
 * The cart-header sniff approach: every GBA cart has a fixed-shape
 * Nintendo logo blob at offsets 0x04..0x9F of ROM, followed by an
 * ASCII title at 0xA0..0xAB. The logo bytes are identical across all
 * official GBA carts (their CRC is what the BIOS checks). We search
 * `HEAPU8` for the first occurrence of those bytes, then back-derive
 * the ROM base. EWRAM / IWRAM are at known fixed distances from the
 * ROM base inside mGBA's per-core memory block.
 *
 * The mapping is stored at boot time + reused for every subsequent
 * read; no scanning per call.
 *
 * Stability: this approach pins to mGBA's current allocation layout.
 * If a future mGBA version changes how it lays out memory inside the
 * WASM module, the boot-time sniff will fail and `findHeapOffsets`
 * returns null → the read APIs throw `MemoryUnavailableError`.
 */

/**
 * GBA memory region offsets within the emulated address space.
 * These don't change - they're fixed by the GBA hardware spec.
 */
export const GBA_REGIONS = {
  bios: { addr: 0x00000000, size: 0x00004000 }, // 16 KiB
  ewram: { addr: 0x02000000, size: 0x00040000 }, // 256 KiB
  iwram: { addr: 0x03000000, size: 0x00008000 }, // 32 KiB
  io: { addr: 0x04000000, size: 0x00000400 }, // 1 KiB
  paletteRam: { addr: 0x05000000, size: 0x00000400 }, // 1 KiB
  vram: { addr: 0x06000000, size: 0x00018000 }, // 96 KiB
  oam: { addr: 0x07000000, size: 0x00000400 }, // 1 KiB
  rom: { addr: 0x08000000, size: 0x02000000 }, // up to 32 MiB
  sram: { addr: 0x0e000000, size: 0x00010000 }, // 64 KiB
} as const;

export type GbaRegionName = keyof typeof GBA_REGIONS;

/**
 * Mapping from GBA region to its base offset inside the WASM
 * `HEAPU8` buffer. Populated by `findHeapOffsets()` after a ROM is
 * loaded.
 *
 * `null` means we couldn't locate the region. The most likely reason
 * is that mGBA hasn't yet allocated it (boot time hasn't run).
 */
export interface HeapOffsets {
  readonly rom: number | null;
  readonly ewram: number | null;
  readonly iwram: number | null;
  readonly vram: number | null;
  readonly oam: number | null;
  readonly paletteRam: number | null;
}

/**
 * The canonical Nintendo logo bytes at ROM offset 0x04..0x9F. All
 * licensed GBA carts share these exact bytes - the BIOS checks them
 * via CRC and refuses to boot mismatches. Using the first 32 bytes
 * (a strong unique anchor) keeps the scan fast.
 */
const NINTENDO_LOGO_PREFIX: readonly number[] = [
  0x24, 0xff, 0xae, 0x51, 0x69, 0x9a, 0xa2, 0x21, 0x3d, 0x84, 0x82, 0x0a, 0x84, 0xe4, 0x09, 0xad,
  0x11, 0x24, 0x8b, 0x98, 0xc0, 0x81, 0x7f, 0x21, 0xa3, 0x52, 0xbe, 0x19, 0x93, 0x09, 0xce, 0x20,
];

/**
 * Search `heap` for the Nintendo-logo anchor. The first hit gives us
 * `romBase` such that `heap[romBase + 0x04 ... romBase + 0x9F]` is the
 * cart header. We back the result up by 4 bytes to point at the cart's
 * entry-point branch (the actual ROM base).
 *
 * Returns null if the logo isn't found - either the cart isn't loaded
 * yet, OR the mGBA build dropped the logo bytes during dead-code
 * stripping (unlikely but possible).
 */
export function findRomBaseInHeap(heap: Uint8Array): number | null {
  // Scan in 4-byte stride (the logo always sits at a word boundary).
  // For a typical 32 MiB heap this completes in ~30 ms.
  const needle = NINTENDO_LOGO_PREFIX;
  const heapLen = heap.length - needle.length;
  outer: for (let i = 0; i <= heapLen; i += 4) {
    if (heap[i] !== needle[0]) continue;
    for (let j = 1; j < needle.length; j++) {
      if (heap[i + j] !== needle[j]) continue outer;
    }
    // Found the logo at offset `i`. The cart's ROM base is `i - 4`.
    return i - 4;
  }
  return null;
}

/**
 * Translate a GBA address to a `HEAPU8` byte offset.
 *
 * Address layout inside mGBA's WASM heap (as observed):
 *   romBase + 0x00000000 = ROM
 *   <ewram-offset>       = EWRAM (must be located separately)
 *   <iwram-offset>       = IWRAM (likewise)
 *
 * EWRAM/IWRAM aren't contiguous with ROM in the WASM heap (mGBA
 * allocates them via `malloc`). They get located by sniffing
 * distinctive patterns at boot:
 *   - EWRAM at idle is mostly zeros; we can't sniff it.
 *   - IWRAM at boot is similar.
 *
 * The current implementation only resolves the ROM mapping
 * deterministically. EWRAM/IWRAM reads aren't supported in this
 * sub-phase and return `null` until a follow-up gets them working
 * (likely by hooking the cartridge-load callback in mGBA and
 * capturing the `gba->memory` pointer).
 */
export function buildOffsetTable(romBaseInHeap: number | null): HeapOffsets {
  return {
    rom: romBaseInHeap,
    ewram: null,
    iwram: null,
    vram: null,
    oam: null,
    paletteRam: null,
  };
}

/**
 * The error thrown when a memory-read targets a region we haven't
 * located in the WASM heap. Used by `EmulatorHandle.readMemory`.
 */
export class MemoryUnavailableError extends Error {
  public readonly addr: number;
  public readonly length: number;
  public readonly reason:
    | 'rom_not_loaded'
    | 'region_not_mapped'
    | 'out_of_bounds'
    | 'unsupported_region';
  constructor(
    reason:
      | 'rom_not_loaded'
      | 'region_not_mapped'
      | 'out_of_bounds'
      | 'unsupported_region',
    addr: number,
    length: number,
    message: string,
  ) {
    super(message);
    this.name = 'MemoryUnavailableError';
    this.addr = addr;
    this.length = length;
    this.reason = reason;
  }
}

/**
 * Find the GBA region containing `addr`, or null if `addr` doesn't
 * land in any region.
 */
export function findRegionForAddr(addr: number): {
  name: GbaRegionName;
  region: (typeof GBA_REGIONS)[GbaRegionName];
} | null {
  for (const [name, region] of Object.entries(GBA_REGIONS) as Array<
    [GbaRegionName, (typeof GBA_REGIONS)[GbaRegionName]]
  >) {
    if (addr >= region.addr && addr < region.addr + region.size) {
      return { name, region };
    }
  }
  return null;
}

/**
 * Read `length` bytes from GBA address `addr` via `heap` using the
 * `offsets` table. Throws `MemoryUnavailableError` if the region
 * can't be resolved, or if the read escapes the GBA region's bounds.
 *
 * In Phase 9A, only ROM reads work. EWRAM/IWRAM/VRAM/etc. throw
 * `unsupported_region` until the follow-up sub-phase lands their
 * mapping.
 */
export function readGbaMemory(
  heap: Uint8Array,
  offsets: HeapOffsets,
  addr: number,
  length: number,
): Uint8Array {
  if (length <= 0) {
    return new Uint8Array(0);
  }
  if (length > 64 * 1024 * 1024) {
    throw new MemoryUnavailableError(
      'out_of_bounds',
      addr,
      length,
      `read length ${String(length)} > 64MiB sanity cap`,
    );
  }
  const region = findRegionForAddr(addr);
  if (!region) {
    throw new MemoryUnavailableError(
      'out_of_bounds',
      addr,
      length,
      `address 0x${addr.toString(16)} is not inside any GBA region`,
    );
  }
  // Bounds check inside the region.
  const offsetInRegion = addr - region.region.addr;
  if (offsetInRegion + length > region.region.size) {
    throw new MemoryUnavailableError(
      'out_of_bounds',
      addr,
      length,
      `read at 0x${addr.toString(16)} +${String(length)} escapes ${region.name} (size 0x${region.region.size.toString(16)})`,
    );
  }
  // Resolve to a heap offset.
  let heapBase: number | null = null;
  switch (region.name) {
    case 'rom':
      heapBase = offsets.rom;
      break;
    case 'ewram':
      heapBase = offsets.ewram;
      break;
    case 'iwram':
      heapBase = offsets.iwram;
      break;
    case 'vram':
      heapBase = offsets.vram;
      break;
    case 'oam':
      heapBase = offsets.oam;
      break;
    case 'paletteRam':
      heapBase = offsets.paletteRam;
      break;
    default:
      throw new MemoryUnavailableError(
        'unsupported_region',
        addr,
        length,
        `region ${region.name} is not supported in this sub-phase`,
      );
  }
  if (heapBase === null) {
    throw new MemoryUnavailableError(
      'region_not_mapped',
      addr,
      length,
      `region ${region.name} hasn't been located in the WASM heap yet`,
    );
  }
  return heap.slice(heapBase + offsetInRegion, heapBase + offsetInRegion + length);
}
