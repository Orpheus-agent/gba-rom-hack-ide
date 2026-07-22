/**
 * GBA LZ77 encoder with back-reference search (Phase 3.3).
 *
 * The existing `encodeLz77Literal` emits the 1-bit-per-byte degenerate
 * form - always 9 bits per input byte plus header. That's fine for
 * test fixtures, but a real CFRU sprite is ~2 KiB of indexed tile data
 * that compresses to ~700 bytes with a real encoder. Without
 * compression we'd blow free space.
 *
 * Algorithm: standard sliding-window LZ77 with a 4096-byte history
 * window + a 16-byte maximum match length. For each input byte:
 *
 *   1. Scan the window for the LONGEST run of bytes matching the
 *      input here. If the run is ≥ 3 bytes, emit a back-reference.
 *   2. Otherwise, emit a literal.
 *
 * Greedy (not optimal) - picks the longest match at each step rather
 * than searching for the globally-best parse. Optimal LZ77 parsing
 * (Storer-Szymanski / lazy matching) costs another ~5% savings; the
 * greedy form is ~95th-percentile vs flips for vanilla Gen-3 sprites
 * and is much simpler to verify.
 *
 * Match search uses a 3-byte hash chain (a hash of the next three
 * input bytes selects which chain to scan). Linear scan of the chain
 * to find the longest match. Chain depth is capped so worst-case
 * compression on degenerate inputs stays O(n × CHAIN_DEPTH) instead
 * of O(n²).
 *
 * Round-trip property: `readLz77(encodeLz77(input), 0).decompressedBytes`
 * equals `input` for every input.
 */

import { LZ77_HEADER_FIRST_BYTE, LZ77_MAX_UNCOMPRESSED_BYTES } from './lz77.js';

/** Min match length (the 4-bit length field stores `length - 3`). */
const MIN_MATCH = 3;
/** Max match length (4-bit field max = 15, + 3 = 18). */
const MAX_MATCH = 18;
/** Window size - back-references reach 1..4096 bytes behind cursor. */
const WINDOW_SIZE = 4096;
/** Hash chain depth - limits worst-case quadratic blowup on degenerate
 *  inputs (e.g. a million zeros). Larger = better compression but
 *  slower; 256 is a typical sweet spot for short asset blobs. */
const MAX_CHAIN_DEPTH = 256;
/** Hash table size (must be a power of 2). 2^16 = 64k slots - large
 *  enough that the 24-bit input hashes don't collide pathologically. */
const HASH_TABLE_SIZE = 1 << 16;
const HASH_MASK = HASH_TABLE_SIZE - 1;

/** Hash a 3-byte sequence. Uses multiplicative hashing - fast + good
 *  distribution on typical sprite data. */
function hash3(b0: number, b1: number, b2: number): number {
  // Adler-style mix; not cryptographic, just decorrelates.
  return ((b0 << 8) ^ (b1 << 4) ^ b2) & HASH_MASK;
}

/**
 * Encode `input` as a GBA LZ77 stream. Returns the compressed bytes,
 * including the 4-byte header. Round-trips with `readLz77`.
 *
 * Throws when input exceeds LZ77_MAX_UNCOMPRESSED_BYTES (4 MiB).
 */
export function encodeLz77(input: Uint8Array): Uint8Array {
  if (input.length > LZ77_MAX_UNCOMPRESSED_BYTES) {
    throw new Error(
      `encodeLz77: input length ${String(input.length)} > LZ77_MAX_UNCOMPRESSED_BYTES`,
    );
  }
  if (input.length === 0) {
    // Empty input - emit a header with size=0. Caller should typically
    // avoid empty inputs; the reader rejects them as zero_uncompressed
    // _size, so we throw rather than emit unreadable output.
    throw new Error('encodeLz77: refusing to encode empty input (readLz77 rejects size=0)');
  }

  // Hash-chain index: head[hash] = position of the most recent
  // occurrence of the 3-byte sequence with that hash. prev[pos] =
  // previous occurrence (linked list).
  const head = new Int32Array(HASH_TABLE_SIZE).fill(-1);
  const prev = new Int32Array(input.length).fill(-1);

  // Output accumulator. Worst case (all literals): 4 header + ceil(N/8)
  // flag bytes + N literal bytes ≈ 1.125 * N + 4. We start with a
  // generous Uint8Array and slice at the end.
  const out = new Uint8Array(input.length + Math.ceil(input.length / 8) + 16);
  // Write header.
  out[0] = LZ77_HEADER_FIRST_BYTE;
  out[1] = input.length & 0xff;
  out[2] = (input.length >> 8) & 0xff;
  out[3] = (input.length >> 16) & 0xff;
  let outPos = 4;

  // Group buffer: 8 chunks at a time. We write the flag byte FIRST
  // (its slot is reserved as the group is built; we backpatch when
  // the group fills).
  let flagSlotPos = outPos;
  out[flagSlotPos] = 0; // placeholder
  outPos++;
  let flagByte = 0;
  let chunksInGroup = 0;

  const flushGroup = (): void => {
    out[flagSlotPos] = flagByte;
    // Open a new group slot.
    if (outPos < out.length) {
      flagSlotPos = outPos;
      out[flagSlotPos] = 0;
      outPos++;
    }
    flagByte = 0;
    chunksInGroup = 0;
  };

  let pos = 0;
  while (pos < input.length) {
    // Find the longest match at pos.
    const matchEndCap = Math.min(pos + MAX_MATCH, input.length);
    const remaining = matchEndCap - pos;
    let bestLen = 1; // at least a 1-byte literal
    let bestDisp = 0;

    if (remaining >= MIN_MATCH) {
      const h = hash3(input[pos]!, input[pos + 1]!, input[pos + 2]!);
      let chainCursor = head[h]!;
      let chainSteps = 0;
      const windowStart = Math.max(0, pos - WINDOW_SIZE);
      while (chainCursor >= windowStart && chainSteps < MAX_CHAIN_DEPTH) {
        // Quick reject: skip if the byte at bestLen positions ahead
        // doesn't match the current best's end (this is the classic
        // "longest-match-so-far" speed-up).
        if (input[chainCursor + bestLen] === input[pos + bestLen]) {
          // Walk forward as long as bytes match.
          let len = 0;
          const limit = Math.min(MAX_MATCH, input.length - pos);
          while (
            len < limit &&
            input[chainCursor + len] === input[pos + len]
          ) {
            len++;
          }
          if (len > bestLen) {
            bestLen = len;
            bestDisp = pos - chainCursor;
            if (bestLen >= MAX_MATCH) break;
          }
        }
        chainCursor = prev[chainCursor]!;
        chainSteps++;
      }
    }

    if (bestLen >= MIN_MATCH) {
      // Emit a back-reference chunk. Set this chunk's flag bit.
      const bitIndex = 7 - chunksInGroup;
      flagByte |= 1 << bitIndex;
      const lenField = (bestLen - MIN_MATCH) & 0x0f;
      const dispField = (bestDisp - 1) & 0x0fff;
      out[outPos++] = (lenField << 4) | ((dispField >> 8) & 0x0f);
      out[outPos++] = dispField & 0xff;
    } else {
      // Literal chunk; flag bit stays 0 in this slot.
      out[outPos++] = input[pos]!;
      bestLen = 1;
    }

    // Update hash chains for the bytes covered by this chunk so future
    // searches see them. Walk forward by bestLen.
    for (let i = 0; i < bestLen && pos + i + MIN_MATCH - 1 < input.length; i++) {
      const p = pos + i;
      const h = hash3(input[p]!, input[p + 1]!, input[p + 2]!);
      prev[p] = head[h]!;
      head[h] = p;
    }
    pos += bestLen;

    chunksInGroup++;
    if (chunksInGroup === 8) {
      flushGroup();
    }
  }
  // Final partial group: backpatch the flag byte.
  if (chunksInGroup > 0) {
    out[flagSlotPos] = flagByte;
  } else {
    // We reserved a flag slot but never used it. Rewind so the
    // compressed stream doesn't have a stray 0 at the end.
    outPos = flagSlotPos;
  }

  return out.subarray(0, outPos);
}
