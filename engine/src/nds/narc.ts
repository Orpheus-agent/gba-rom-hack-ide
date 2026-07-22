/**
 * NARC ("Nitro ARChive") reader (read-only, pure).
 *
 * A NARC bundles many sub-files. Layout:
 *   "NARC" magic, 0xFFFE BOM, u16 version, u32 fileSize, u16 headerSize(0x10), u16 numChunks
 *   then chunks (each: 4-char magic + u32 size):
 *     "BTAF" - file allocation: u16 fileCount, u16 reserved, then fileCount × {u32 start, u32 end}
 *              (start/end are offsets into the GMIF data section)
 *     "BTNF" - filenames (usually empty in game NARCs)
 *     "GMIF" - raw file image; sub-file data begins 8 bytes into this chunk
 * Reference: GBATEK / Project Pokémon file-format notes. No I/O.
 */

function u16(b: Uint8Array, o: number): number {
  return ((b[o] ?? 0) | ((b[o + 1] ?? 0) << 8)) & 0xffff;
}
function u32(b: Uint8Array, o: number): number {
  return (
    ((b[o] ?? 0) | ((b[o + 1] ?? 0) << 8) | ((b[o + 2] ?? 0) << 16) | ((b[o + 3] ?? 0) << 24)) >>> 0
  );
}
function magic4(b: Uint8Array, o: number): string {
  return String.fromCharCode(b[o] ?? 0, b[o + 1] ?? 0, b[o + 2] ?? 0, b[o + 3] ?? 0);
}

export interface Narc {
  readonly count: number;
  /** Sub-file i as a view into the source buffer; null if out of range. */
  subfile(i: number): Uint8Array | null;
  /** All sub-files (views). */
  subfiles(): Uint8Array[];
}

/** True if the bytes look like a NARC. */
export function isNarc(data: Uint8Array): boolean {
  return data.length >= 16 && magic4(data, 0) === 'NARC';
}

/** Parse a NARC buffer. Returns null if the magic/structure is invalid. */
export function parseNarc(data: Uint8Array): Narc | null {
  if (!isNarc(data)) return null;
  const headerSize = u16(data, 0x0c) || 0x10;

  const fat: Array<{ start: number; end: number }> = [];
  let gmifDataStart = -1;

  let p = headerSize;
  let guard = 0;
  while (p + 8 <= data.length && guard++ < 16) {
    const m = magic4(data, p);
    const size = u32(data, p + 4);
    if (m === 'BTAF') {
      const count = u16(data, p + 8);
      for (let i = 0; i < count; i++) {
        const eo = p + 12 + i * 8;
        fat.push({ start: u32(data, eo), end: u32(data, eo + 4) });
      }
    } else if (m === 'GMIF') {
      gmifDataStart = p + 8;
    }
    if (size < 8) break;
    p += size;
  }

  if (gmifDataStart < 0) return null;

  const subfile = (i: number): Uint8Array | null => {
    const e = fat[i];
    if (!e) return null;
    const s = gmifDataStart + e.start;
    const en = gmifDataStart + e.end;
    if (s < 0 || en > data.length || en < s) return null;
    return data.subarray(s, en);
  };

  return {
    count: fat.length,
    subfile,
    subfiles(): Uint8Array[] {
      const out: Uint8Array[] = [];
      for (let i = 0; i < fat.length; i++) {
        const f = subfile(i);
        if (f) out.push(f);
      }
      return out;
    },
  };
}
