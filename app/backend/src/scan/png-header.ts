// Pure PNG IHDR parser. Reads width/height/bitDepth/colorType from the first
// chunk after the magic signature. No external dependencies; works on the
// first 33 bytes of any PNG. Returns null for non-PNG, truncated, or
// IHDR-malformed inputs - never throws.
//
// PNG layout (from RFC 2083):
//   bytes  0..7   = magic signature 89 50 4E 47 0D 0A 1A 0A
//   bytes  8..11  = IHDR chunk length (4 bytes, big-endian, always 13)
//   bytes 12..15  = chunk type "IHDR"
//   bytes 16..19  = width (4 bytes, big-endian)
//   bytes 20..23  = height (4 bytes, big-endian)
//   byte  24      = bit depth
//   byte  25      = color type (0=gray, 2=RGB, 3=indexed, 4=grayA, 6=RGBA)
//   bytes 26..28  = compression / filter / interlace (always 0/0/0 or 0/0/1)
//   bytes 29..32  = CRC

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export type PngColorType = 0 | 2 | 3 | 4 | 6;

export interface PngHeader {
  readonly width: number;
  readonly height: number;
  readonly bitDepth: number;
  readonly colorType: PngColorType;
}

export function isPng(buf: Buffer): boolean {
  if (buf.length < PNG_SIGNATURE.length) return false;
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (buf[i] !== PNG_SIGNATURE[i]) return false;
  }
  return true;
}

export function parsePngHeader(buf: Buffer): PngHeader | null {
  if (!isPng(buf)) return null;
  if (buf.length < 26) return null;
  // IHDR chunk type
  const chunkType = buf.subarray(12, 16).toString('ascii');
  if (chunkType !== 'IHDR') return null;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const bitDepth = buf.readUInt8(24);
  const colorTypeRaw = buf.readUInt8(25);
  if (width === 0 || height === 0) return null;
  // Validate color type matches one of the legal values
  if (
    colorTypeRaw !== 0 &&
    colorTypeRaw !== 2 &&
    colorTypeRaw !== 3 &&
    colorTypeRaw !== 4 &&
    colorTypeRaw !== 6
  ) {
    return null;
  }
  return {
    width,
    height,
    bitDepth,
    colorType: colorTypeRaw as PngColorType,
  };
}

export function colorTypeLabel(colorType: PngColorType): string {
  switch (colorType) {
    case 0:
      return 'grayscale';
    case 2:
      return 'RGB';
    case 3:
      return 'indexed';
    case 4:
      return 'grayscale+alpha';
    case 6:
      return 'RGBA';
  }
}
