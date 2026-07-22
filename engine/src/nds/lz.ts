/**
 * Nintendo DS LZ decompression (read-only, pure).
 *
 * DS data files are often wrapped in a 4-byte Nitro compression header whose
 * first byte selects the codec:
 *   0x10 → LZ10  (byte-identical to the GBA BIOS LZ77 - we delegate to readLz77)
 *   0x11 → LZ11  (extended length encoding - implemented here)
 * Header bytes 1..3 = uncompressed size (LE). For LZ11, a 24-bit size of 0 means
 * the real size is the next 4 bytes (LE) - the "extended" form for >16 MiB.
 *
 * Reference: GBATEK + CUE's NDS LZSS notes. No I/O; soft failures return ok:false.
 */
import { readLz77 } from '../compression/lz77.js';

const MAX_UNCOMPRESSED = 16 * 1024 * 1024;

export type NdsLzResult =
  | { ok: true; bytes: Uint8Array; consumed: number; codec: 'lz10' | 'lz11' }
  | { ok: false; reason: string };

/** Decompress a Nitro LZ stream at `offset`. Auto-detects LZ10 vs LZ11. */
export function decompressNdsLz(data: Uint8Array, offset = 0): NdsLzResult {
  const type = data[offset];
  if (type === 0x10) {
    const r = readLz77(data, offset);
    if (!r.ok) return { ok: false, reason: `lz10: ${r.failure.kind}` };
    return { ok: true, bytes: r.decompressedBytes, consumed: r.compressedLength, codec: 'lz10' };
  }
  if (type === 0x11) return decompressLz11(data, offset);
  return { ok: false, reason: `not an LZ stream (first byte 0x${(type ?? 0).toString(16)})` };
}

/** True if the bytes at `offset` look like a Nitro LZ10/LZ11 stream. */
export function isNdsLz(data: Uint8Array, offset = 0): boolean {
  return data[offset] === 0x10 || data[offset] === 0x11;
}

function decompressLz11(data: Uint8Array, offset: number): NdsLzResult {
  let inPos = offset;
  if (inPos + 4 > data.length) return { ok: false, reason: 'lz11: truncated header' };
  inPos += 1; // skip 0x11
  let size = (data[inPos]! | (data[inPos + 1]! << 8) | (data[inPos + 2]! << 16)) >>> 0;
  inPos += 3;
  if (size === 0) {
    // Extended: real size in the next 4 bytes.
    if (inPos + 4 > data.length) return { ok: false, reason: 'lz11: truncated extended size' };
    size =
      (data[inPos]! | (data[inPos + 1]! << 8) | (data[inPos + 2]! << 16) | (data[inPos + 3]! << 24)) >>>
      0;
    inPos += 4;
  }
  if (size === 0 || size > MAX_UNCOMPRESSED) {
    return { ok: false, reason: `lz11: implausible size ${String(size)}` };
  }

  const out = new Uint8Array(size);
  let outPos = 0;

  while (outPos < size) {
    if (inPos >= data.length) return { ok: false, reason: 'lz11: ran out of input (flags)' };
    const flags = data[inPos++]!;
    for (let bit = 7; bit >= 0 && outPos < size; bit--) {
      if (((flags >> bit) & 1) === 0) {
        // Literal.
        if (inPos >= data.length) return { ok: false, reason: 'lz11: truncated literal' };
        out[outPos++] = data[inPos++]!;
        continue;
      }
      // Back-reference with variable-length count.
      if (inPos >= data.length) return { ok: false, reason: 'lz11: truncated match' };
      const b0 = data[inPos++]!;
      const indicator = b0 >> 4;
      let count: number;
      let disp: number;
      if (indicator === 0) {
        // count in [0x11, 0x110]; 3 total match bytes.
        if (inPos + 2 > data.length) return { ok: false, reason: 'lz11: truncated match(0)' };
        const b1 = data[inPos++]!;
        const b2 = data[inPos++]!;
        count = (((b0 & 0x0f) << 4) | (b1 >> 4)) + 0x11;
        disp = (((b1 & 0x0f) << 8) | b2) + 1;
      } else if (indicator === 1) {
        // count in [0x111, 0x10110]; 4 total match bytes.
        if (inPos + 3 > data.length) return { ok: false, reason: 'lz11: truncated match(1)' };
        const b1 = data[inPos++]!;
        const b2 = data[inPos++]!;
        const b3 = data[inPos++]!;
        count = (((b0 & 0x0f) << 12) | (b1 << 4) | (b2 >> 4)) + 0x111;
        disp = (((b2 & 0x0f) << 8) | b3) + 1;
      } else {
        // count = indicator+1 in [3, 16]; 2 total match bytes.
        if (inPos >= data.length) return { ok: false, reason: 'lz11: truncated match(n)' };
        const b1 = data[inPos++]!;
        count = indicator + 1;
        disp = (((b0 & 0x0f) << 8) | b1) + 1;
      }
      if (disp > outPos) {
        return { ok: false, reason: `lz11: back-ref underflow (disp ${String(disp)} > out ${String(outPos)})` };
      }
      const from = outPos - disp;
      for (let i = 0; i < count && outPos < size; i++) out[outPos++] = out[from + i]!;
    }
  }
  return { ok: true, bytes: out, consumed: inPos - offset, codec: 'lz11' };
}
