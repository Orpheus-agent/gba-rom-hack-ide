/**
 * Gen-3 LZ77-pointer-table scanner - finds u32 pointer tables where
 * each entry resolves to an LZ77-compressed graphics block.
 *
 * Gen-3 cartridges store the vast majority of graphics (sprites,
 * tilesets, portraits, UI graphics, battle backgrounds, animation
 * frames) as LZ77-compressed 4bpp tile data. The asset references are
 * typically organized as flat pointer arrays:
 *   - gMonFrontPicTable[] - Pokémon front-sprite ptrs
 *   - gMonBackPicTable[] - Pokémon back-sprite ptrs
 *   - gTrainerFrontPicTable[] - trainer-class portrait ptrs
 *   - gTrainerBackPicTable[] - trainer back-sprite ptrs
 *   - gMonPaletteTable / gMonShinyPaletteTable - palette ptrs (NOT
 *     LZ77 - these are 32-byte palette regions; this detector skips
 *     them)
 *   - many hack-introduced sprite tables
 *
 * Detection approach (PD 5 - no baked offsets, universal across all
 * Gen-3 family carts incl. heavy hacks that have relocated tables):
 *  - 4-byte stride anchor scan over the ROM.
 *  - Per-pointer validity:
 *      • u32 pointer in ROM space (0x08000000-0x09FFFFFF)
 *      • resolved file offset within romByteLength
 *      • byte at target offset = 0x10 (LZ77 header first byte)
 *      • u24 decompressed size at target+1..target+3 is in
 *        (0, LZ77_MAX_UNCOMPRESSED_BYTES] range
 *      • target offset + ~16 bytes is within romByteLength (compressed
 *        payload sanity)
 *  - Anchor: ANCHOR_CONFIRMATION_ENTRIES consecutive valid pointers.
 *  - Forward-walk until MAX_CONSECUTIVE_BAD invalid pointers in a row.
 *  - Accept the run as a table iff ≥MIN_VALID_ENTRIES.
 *  - After accepting, scanning resumes past the table.
 *
 * Per PD 1: typed failure paths; never returns empty-as-success.
 * Per PD 12: each detected table's first 8 entries' decompressed-size
 *   summaries are surfaced so the editor can show what's there
 *   ("~4096 bytes / typical sprite frame").
 * Per PD 16: tables aren't named (could be Pokémon front sprites /
 *   trainer back sprites / etc.) - the editor displays decompressed
 *   sizes + offsets so operators can identify by content size.
 */

import { GBA_ROM_BASE_ADDRESS, GBA_ROM_END_ADDRESS_EXCLUSIVE } from '../pointers/index.js';
import { LZ77_HEADER_FIRST_BYTE, LZ77_MAX_UNCOMPRESSED_BYTES } from '../compression/lz77.js';

/** Minimum consecutive valid pointers to claim an anchor candidate. */
export const LZ77_POINTER_TABLE_ANCHOR_CONFIRMATION_ENTRIES = 10;

/** Minimum entries in a run to accept as a graphics-pointer table. */
export const LZ77_POINTER_TABLE_MIN_VALID_ENTRIES = 10;

/** Min compressed-payload bytes that must exist past the LZ77 header. */
export const LZ77_POINTER_TABLE_MIN_PAYLOAD_BYTES = 8;

/** Cap on entries walked per candidate table (Pokémon front-pic ~411). */
export const LZ77_POINTER_TABLE_MAX_ENTRIES_PER_TABLE = 4096;

/** Cap on total tables surfaced (prevents pathological output). */
export const LZ77_POINTER_TABLE_MAX_TABLES_PER_SCAN = 16;

export interface Lz77PointerTableEntry {
  /** ROM file offset of THIS 4-byte pointer slot. */
  readonly pointerOffset: number;
  /** Resolved file offset of the LZ77 block. */
  readonly targetOffset: number;
  /** Decompressed size as declared by the LZ77 header (u24). */
  readonly decompressedSize: number;
}

export interface Lz77PointerTable {
  readonly tableOffset: number;
  readonly tableEndExclusive: number;
  readonly entryCount: number;
  /** First 8 entries' decoded metadata (offset + decompressedSize). */
  readonly samplePreview: ReadonlyArray<Lz77PointerTableEntry>;
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

function readUint24Le(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) |
      ((bytes[offset + 1] ?? 0) << 8) |
      ((bytes[offset + 2] ?? 0) << 16)) >>>
    0
  );
}

/**
 * Validate a u32 candidate as a pointer to an LZ77-compressed block.
 * Returns the resolved entry on success, null otherwise.
 */
function validateLz77Pointer(
  bytes: Uint8Array,
  pointerOffset: number,
): Lz77PointerTableEntry | null {
  if (pointerOffset + 4 > bytes.length) return null;
  const rawAddr = readUint32Le(bytes, pointerOffset);
  if (rawAddr < GBA_ROM_BASE_ADDRESS || rawAddr >= GBA_ROM_END_ADDRESS_EXCLUSIVE) {
    return null;
  }
  const targetOffset = rawAddr - GBA_ROM_BASE_ADDRESS;
  if (targetOffset < 0 || targetOffset >= bytes.length) return null;
  // Need at least 4 bytes for the header.
  if (targetOffset + 4 > bytes.length) return null;
  // LZ77 header first byte must be 0x10.
  if (bytes[targetOffset] !== LZ77_HEADER_FIRST_BYTE) return null;
  // Decompressed size must be positive and within sane range.
  const decompressedSize = readUint24Le(bytes, targetOffset + 1);
  if (decompressedSize === 0 || decompressedSize > LZ77_MAX_UNCOMPRESSED_BYTES) {
    return null;
  }
  // Payload sanity: at least N more bytes must exist past the header.
  if (targetOffset + 4 + LZ77_POINTER_TABLE_MIN_PAYLOAD_BYTES > bytes.length) {
    return null;
  }
  return Object.freeze({
    pointerOffset,
    targetOffset,
    decompressedSize,
  });
}

function confirmAnchor(bytes: Uint8Array, candidateOffset: number): boolean {
  for (let i = 0; i < LZ77_POINTER_TABLE_ANCHOR_CONFIRMATION_ENTRIES; i++) {
    if (validateLz77Pointer(bytes, candidateOffset + i * 4) === null) return false;
  }
  return true;
}

function walkTable(
  bytes: Uint8Array,
  tableStart: number,
): ReadonlyArray<Lz77PointerTableEntry> {
  const MAX_CONSECUTIVE_BAD = 3;
  const entries: Lz77PointerTableEntry[] = [];
  let consecutiveBad = 0;
  for (let i = 0; i < LZ77_POINTER_TABLE_MAX_ENTRIES_PER_TABLE; i++) {
    const entry = validateLz77Pointer(bytes, tableStart + i * 4);
    if (entry === null) {
      consecutiveBad++;
      if (consecutiveBad >= MAX_CONSECUTIVE_BAD) break;
      continue;
    }
    consecutiveBad = 0;
    entries.push(entry);
  }
  return entries;
}

/**
 * Scan the ROM for all LZ77-pointer tables. Returns at most
 * MAX_TABLES_PER_SCAN tables, sorted by entryCount descending.
 *
 * Strategy:
 *  - 4-byte stride scan past 0xC0 header skip.
 *  - First anchor-confirmed candidate with ≥MIN_VALID_ENTRIES wins.
 *  - After accepting, scanning resumes past the table to avoid
 *    overlap re-detection.
 */
export function findLz77PointerTables(bytes: Uint8Array): ReadonlyArray<Lz77PointerTable> {
  const limit = bytes.length - LZ77_POINTER_TABLE_ANCHOR_CONFIRMATION_ENTRIES * 4;
  if (limit <= 0xc0) return Object.freeze([]);

  const tables: Lz77PointerTable[] = [];
  let candidate = 0xc0;
  while (
    candidate <= limit &&
    tables.length < LZ77_POINTER_TABLE_MAX_TABLES_PER_SCAN
  ) {
    if (!confirmAnchor(bytes, candidate)) {
      candidate += 4;
      continue;
    }
    const entries = walkTable(bytes, candidate);
    if (entries.length < LZ77_POINTER_TABLE_MIN_VALID_ENTRIES) {
      candidate += 4;
      continue;
    }
    const tableEndExclusive = candidate + entries.length * 4;
    tables.push(
      Object.freeze({
        tableOffset: candidate,
        tableEndExclusive,
        entryCount: entries.length,
        samplePreview: Object.freeze(entries.slice(0, 8)),
      }),
    );
    candidate = tableEndExclusive;
  }

  const sorted = [...tables].sort((a, b) => b.entryCount - a.entryCount);
  return Object.freeze(sorted);
}
