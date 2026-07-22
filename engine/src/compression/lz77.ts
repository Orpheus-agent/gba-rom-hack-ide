/**
 * GBA BIOS LZ77 reader.
 *
 * The GBA hardware BIOS provides two LZ77 decompression routines
 * (`SWI 0x11` LZ77UnCompReadByByte, `SWI 0x12` LZ77UnCompReadByWord)
 * that consume a public, well-documented compressed-data format.
 * Reference: gbatek (https://problemkaputt.de/gbatek.htm#biosdecompressionfunctions).
 *
 * Format (universal - used by every Pokémon GBA cart + most other GBA carts):
 *
 *   Header (4 bytes, little-endian 32-bit word):
 *     bits  0..3   reserved (typically 0)
 *     bits  4..7   compression type (= 1 for LZ77)
 *     bits  8..31  uncompressed size in bytes
 *
 *     In RAW bytes this is normally observed as:
 *       byte 0  =  0x10                       (high nibble = type 1, low nibble = 0)
 *       byte 1  =  uncompressed_size & 0xFF
 *       byte 2  =  (uncompressed_size >> 8)  & 0xFF
 *       byte 3  =  (uncompressed_size >> 16) & 0xFF
 *
 *   Data: repeating <flag byte><eight chunks>:
 *     flag byte:  8 flag bits, MSB-first, one per chunk
 *       flag = 0  → next chunk is 1 literal byte (copied as-is)
 *       flag = 1  → next chunk is a 2-byte back-reference:
 *                     byte 0:  (length - 3) << 4  |  (displacement >> 8) & 0x0F
 *                     byte 1:   displacement & 0xFF
 *                   then copy `length` bytes from `displacement + 1` positions
 *                   back in the OUTPUT buffer.
 *   length is in [3, 18] (4-bit field + 3); displacement is in [1, 4096]
 *   (12-bit field + 1).
 *
 *   Decompression terminates once `uncompressed_size` output bytes have been
 *   written. Trailing zero-fill in the compressed buffer is normal.
 *
 * This module is PURE: header parsing + decompression with no I/O, no
 * BIOS dependency, no Pokémon-specific assumptions (PD 5). Decompression
 * always yields the exact bytes the GBA hardware would produce.
 */

/** Compression-type nibble for LZ77 per the BIOS spec. */
export const LZ77_TYPE_NIBBLE = 0x1;
/** Conventional first byte of an LZ77-compressed buffer (type=1, reserved=0). */
export const LZ77_HEADER_FIRST_BYTE = 0x10;

/** Soft cap on accepted uncompressed sizes - protects against malformed
 *  headers claiming gigabyte-scale outputs. 4 MiB is well above any
 *  plausible single GBA asset (the largest vanilla compressed asset in
 *  Gen-3 ROMs is under 256 KiB). */
export const LZ77_MAX_UNCOMPRESSED_BYTES = 4 * 1024 * 1024;

export type Lz77ReadFailure =
  | { kind: 'too_short'; bytesAvailable: number; bytesRequired: number }
  | { kind: 'wrong_header_type'; observedByte: number; expectedByte: number }
  | { kind: 'oversize'; declaredSize: number; maxAllowed: number }
  | { kind: 'zero_uncompressed_size' }
  | { kind: 'compressed_data_truncated'; bytesNeeded: number; bytesAvailable: number }
  | { kind: 'back_reference_underflow'; outputOffset: number; displacement: number };

export type Lz77ReadResult =
  | {
      ok: true;
      readonly uncompressedSize: number;
      readonly compressedLength: number;
      readonly decompressedBytes: Uint8Array;
    }
  | { ok: false; readonly failure: Lz77ReadFailure };

/**
 * Read a single LZ77 stream starting at `offset` in `bytes`. Returns the
 * full decompressed payload + the number of compressed bytes consumed.
 *
 * Soft failures (wrong header byte, truncation, etc.) return an `ok:false`
 * result with a typed failure kind - does NOT throw. This lets the scanner
 * cheaply probe many candidate offsets without exception overhead.
 */
export function readLz77(bytes: Uint8Array, offset: number): Lz77ReadResult {
  if (offset < 0 || offset + 4 > bytes.length) {
    return {
      ok: false,
      failure: {
        kind: 'too_short',
        bytesAvailable: Math.max(0, bytes.length - offset),
        bytesRequired: 4,
      },
    };
  }

  const headerByte = bytes[offset] ?? 0;
  // The compression-type nibble lives in the HIGH 4 bits (bits 4..7) of
  // byte 0 per the GBA BIOS spec. For LZ77 we expect (byte0 >> 4) === 1
  // → the conventional first byte 0x10. We don't strictly require the
  // reserved low nibble to be zero - some emitters leave it un-cleared.
  if ((headerByte >> 4) !== LZ77_TYPE_NIBBLE) {
    return {
      ok: false,
      failure: {
        kind: 'wrong_header_type',
        observedByte: headerByte,
        expectedByte: LZ77_HEADER_FIRST_BYTE,
      },
    };
  }

  const uncompressedSize =
    ((bytes[offset + 1] ?? 0) |
      ((bytes[offset + 2] ?? 0) << 8) |
      ((bytes[offset + 3] ?? 0) << 16)) >>>
    0;

  if (uncompressedSize === 0) {
    return { ok: false, failure: { kind: 'zero_uncompressed_size' } };
  }
  if (uncompressedSize > LZ77_MAX_UNCOMPRESSED_BYTES) {
    return {
      ok: false,
      failure: {
        kind: 'oversize',
        declaredSize: uncompressedSize,
        maxAllowed: LZ77_MAX_UNCOMPRESSED_BYTES,
      },
    };
  }

  const out = new Uint8Array(uncompressedSize);
  let outPos = 0;
  let inPos = offset + 4;

  while (outPos < uncompressedSize) {
    if (inPos >= bytes.length) {
      return {
        ok: false,
        failure: {
          kind: 'compressed_data_truncated',
          bytesNeeded: 1,
          bytesAvailable: 0,
        },
      };
    }
    const flagByte = bytes[inPos++] ?? 0;

    for (let bit = 7; bit >= 0 && outPos < uncompressedSize; bit--) {
      const isBackRef = ((flagByte >> bit) & 1) === 1;
      if (!isBackRef) {
        // Literal chunk: copy 1 byte verbatim.
        if (inPos >= bytes.length) {
          return {
            ok: false,
            failure: {
              kind: 'compressed_data_truncated',
              bytesNeeded: 1,
              bytesAvailable: 0,
            },
          };
        }
        out[outPos++] = bytes[inPos++] ?? 0;
      } else {
        // Back-reference chunk: 2 bytes, decode length + displacement.
        if (inPos + 2 > bytes.length) {
          return {
            ok: false,
            failure: {
              kind: 'compressed_data_truncated',
              bytesNeeded: 2,
              bytesAvailable: bytes.length - inPos,
            },
          };
        }
        const b0 = bytes[inPos] ?? 0;
        const b1 = bytes[inPos + 1] ?? 0;
        inPos += 2;
        const length = ((b0 >> 4) & 0x0f) + 3;
        const displacement = (((b0 & 0x0f) << 8) | b1) + 1;

        if (displacement > outPos) {
          return {
            ok: false,
            failure: {
              kind: 'back_reference_underflow',
              outputOffset: outPos,
              displacement,
            },
          };
        }
        const copyFrom = outPos - displacement;
        // Byte-by-byte (NOT a fixed slice copy) - back-reference RLE is
        // common (e.g. displacement=1, length=18 fills 18 bytes by
        // repeating the previous byte). Slice would corrupt that.
        for (let i = 0; i < length && outPos < uncompressedSize; i++) {
          out[outPos++] = out[copyFrom + i] ?? 0;
        }
      }
    }
  }

  return {
    ok: true,
    uncompressedSize,
    compressedLength: inPos - offset,
    decompressedBytes: out,
  };
}

/**
 * Encode bytes as an LZ77 stream. Used by tests to plant verified-decodable
 * compressed blocks into synthetic ROM fixtures. NOT optimal compression
 * (always emits 1-bit-per-byte = 9 bits per input byte plus header), but
 * always produces a stream that `readLz77` decodes back to the original
 * input - which is the only contract a test fixture needs.
 *
 * Output layout:
 *   - 4-byte LZ77 header (type=1, uncompressed_size = bytes.length)
 *   - For each input byte, a flag-byte=0 indicating "literal" followed by
 *     the byte. (Flag byte covers up to 8 chunks; we emit one flag per
 *     group of 8 literals.)
 *
 * Round-trip property: `readLz77(encodeLz77Literal(input), 0).decompressed
 * Bytes` equals `input`.
 */
export function encodeLz77Literal(input: Uint8Array): Uint8Array {
  if (input.length > LZ77_MAX_UNCOMPRESSED_BYTES) {
    throw new Error(
      `encodeLz77Literal: input length ${String(input.length)} > LZ77_MAX_UNCOMPRESSED_BYTES`,
    );
  }
  const numChunks = input.length;
  const numFlagGroups = Math.ceil(numChunks / 8);
  // 4 header bytes + numFlagGroups flag bytes + numChunks literal bytes
  const out = new Uint8Array(4 + numFlagGroups + numChunks);
  out[0] = LZ77_HEADER_FIRST_BYTE;
  out[1] = input.length & 0xff;
  out[2] = (input.length >> 8) & 0xff;
  out[3] = (input.length >> 16) & 0xff;

  let outPos = 4;
  let chunkIdx = 0;
  while (chunkIdx < numChunks) {
    out[outPos++] = 0x00; // all 8 flags = literal
    const groupEnd = Math.min(chunkIdx + 8, numChunks);
    for (let i = chunkIdx; i < groupEnd; i++) {
      out[outPos++] = input[i] ?? 0;
    }
    chunkIdx = groupEnd;
  }
  return out.subarray(0, outPos);
}
