/**
 * `engine/src/graphics/` - Gen-3 graphics substrate.
 *
 * Phase UW-2 / Category 8. Iter 78 (UW-2-T12) ships the BGR555 palette
 * region scanner. Future iters can add per-format graphics decoders
 * (4bpp/8bpp tile decoder, sprite header parser, tileset structure,
 * palette-animation tables, etc.).
 *
 * Engine root namespace surfaces this as
 * `import { graphics } from '@rom-introspection/engine'` per the same
 * convention as `moves`, `items`, `abilities`, `saveData`, `menus`.
 */

export {
  PALETTE_BYTES,
  COLORS_PER_PALETTE,
  PALETTE_BANK_BYTES,
  PALETTE_MIN_DISTINCT_COLORS,
  PALETTE_SCAN_MAX_REGIONS,
  isValidPaletteRegion,
  scanPaletteRegions,
  type PaletteScanResult,
} from './palette.js';

export {
  LZ77_POINTER_TABLE_ANCHOR_CONFIRMATION_ENTRIES,
  LZ77_POINTER_TABLE_MAX_ENTRIES_PER_TABLE,
  LZ77_POINTER_TABLE_MAX_TABLES_PER_SCAN,
  LZ77_POINTER_TABLE_MIN_PAYLOAD_BYTES,
  LZ77_POINTER_TABLE_MIN_VALID_ENTRIES,
  findLz77PointerTables,
  type Lz77PointerTable,
  type Lz77PointerTableEntry,
} from './lz77-pointer-tables.js';

export {
  PALETTE_4BPP_SIZE_BYTES,
  PIXELS_PER_METATILE,
  PIXELS_PER_TILE,
  TILE_4BPP_SIZE_BYTES,
  TRANSPARENT_PALETTE_INDEX,
  bgr555ToRgba,
  composeMetatile,
  decode4bppTile,
  decodeMetatile,
  decodeMetatileTileAttribute,
  type MetatileTileSpec,
} from './tile-pixels.js';

// Phase 3.3 - encode side of the graphics codec stack.
export {
  encode4bppTile,
  encode4bppTileSheet,
  pixelGridToTiles,
  TileEncodeError,
} from './tile-pixels-encoder.js';

export {
  quantizeRgbaToIndexed,
  rgbToBgr555,
  PaletteQuantizerError,
  type QuantizeResult,
} from './palette-quantizer.js';

export {
  decodePng,
  PngDecodeError,
  type DecodedPng,
} from './png-decoder.js';

// Phase 4.2C - inverse of png-decoder.ts. Encodes RGBA pixels to PNG
// bytes for the Pokémon-sprite endpoint.
export {
  encodeRgbaPng,
  PngEncodeError,
} from './png-encoder.js';
