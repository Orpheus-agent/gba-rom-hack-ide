/**
 * LZ77 candidate scanner.
 *
 * Walks the ROM at a configurable stride, attempts an LZ77 decompress at
 * every position whose first byte equals 0x10, and returns the list of
 * positions where decompression actually succeeded. This is the
 * SIGNATURE path for compression detection (per §15 P2 + PD 5): a
 * deterministic structural match against the published GBA BIOS format.
 *
 * Performance: each LZ77 attempt allocates an output buffer of the
 * claimed uncompressed size. On a 16 MiB ROM there are ~65 K offsets
 * where byte 0 == 0x10 (uniformly random data has 1/256 hit rate); we
 * only allocate when we can't reject earlier. The early-rejection paths
 * in readLz77 (zero_uncompressed_size, oversize) bail in O(1) without
 * allocation, so the typical false-positive overhead is bounded.
 *
 * Default stride: 4 (matches the GBA's BIOS DMA word alignment - real
 * compressed assets in carts are word-aligned). Callers needing
 * exhaustive search can pass stride=1.
 */

import { readLz77 } from './lz77.js';

export interface Lz77Block {
  /** First byte of the LZ77 header in the ROM. */
  readonly start: number;
  /** Length of the compressed stream in bytes. */
  readonly compressedLength: number;
  /** Declared uncompressed size from the header. Verified to match the
   *  actual decompressed output length. */
  readonly uncompressedSize: number;
  /** Exclusive end offset (= start + compressedLength). */
  readonly endExclusive: number;
}

export interface ScanLz77Options {
  /** Scan stride. Default 4 (GBA BIOS word alignment). */
  readonly stride?: number;
  /** Optional inclusive start offset. */
  readonly startOffset?: number;
  /** Optional exclusive end offset. */
  readonly endOffsetExclusive?: number;
  /** Maximum number of blocks to return. Default 100 000 (sufficient for
   *  vanilla + hack ROMs; defends against pathological inputs). */
  readonly maxBlocks?: number;
  /** Minimum compressed stream length to keep - filters out tiny "blocks"
   *  that happen to decode to a few bytes by coincidence. Default 8
   *  (header alone is 4 bytes; a real asset is always > 4 bytes of body). */
  readonly minCompressedLength?: number;
}

/**
 * Scan `bytes` for valid LZ77 streams.
 *
 * For each scanned offset:
 *   - If byte != 0x10, skip (constant-time reject).
 *   - Otherwise attempt readLz77; on success and minCompressedLength
 *     reached, add the block to the result.
 *   - Advance by `stride`.
 *
 * Importantly, this scan does NOT consume found blocks - a block at
 * offset 0x1000 is recorded but stride continues from 0x1004, not from
 * end-of-block. This sometimes finds overlapping false-positive blocks
 * inside compressed data; the orchestrating detector dedupes overlaps
 * before registering coverage.
 */
export function findLz77Candidates(
  bytes: Uint8Array,
  opts?: ScanLz77Options,
): Lz77Block[] {
  const stride = opts?.stride ?? 4;
  const start = opts?.startOffset ?? 0;
  const endExclusive = opts?.endOffsetExclusive ?? bytes.length;
  const maxBlocks = opts?.maxBlocks ?? 100_000;
  const minCompressedLength = opts?.minCompressedLength ?? 8;

  if (!Number.isInteger(stride) || stride < 1) {
    throw new Error(`stride must be a positive integer, got ${String(stride)}`);
  }
  if (start < 0 || endExclusive > bytes.length || endExclusive < start) {
    throw new Error(
      `scan window invalid: [${String(start)}, ${String(endExclusive)}) for length ${String(bytes.length)}`,
    );
  }

  const results: Lz77Block[] = [];
  const limit = endExclusive - 4;
  for (let i = start; i <= limit; i += stride) {
    if ((bytes[i] ?? 0) !== 0x10) continue;
    const r = readLz77(bytes, i);
    if (!r.ok) continue;
    if (r.compressedLength < minCompressedLength) continue;
    results.push(
      Object.freeze({
        start: i,
        compressedLength: r.compressedLength,
        uncompressedSize: r.uncompressedSize,
        endExclusive: i + r.compressedLength,
      }),
    );
    if (results.length >= maxBlocks) break;
  }
  return results;
}

/**
 * Reduce a scan result to a NON-OVERLAPPING set of blocks by greedy
 * earliest-start-then-longest selection. Used by the orchestrating
 * detector before registering coverage (since CoverageMap rejects
 * overlaps).
 */
export function dedupeOverlappingBlocks(blocks: ReadonlyArray<Lz77Block>): Lz77Block[] {
  if (blocks.length === 0) return [];
  // Sort by start ASC, length DESC so when two blocks share a start, the
  // longer one wins.
  const sorted = [...blocks].sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    return b.compressedLength - a.compressedLength;
  });
  const kept: Lz77Block[] = [];
  let lastEnd = -1;
  for (const b of sorted) {
    if (b.start < lastEnd) continue; // overlaps the previous kept block
    kept.push(b);
    lastEnd = b.endExclusive;
  }
  return kept;
}
