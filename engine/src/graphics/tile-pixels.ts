/**
 * Gen-3 4bpp tile pixel decoder + BGR555 palette converter - 
 * Phase UX-C / iter-equivalent.
 *
 * GBA graphics use a planar palette-indexed format that no JS code in
 * the engine has decoded into raw pixels until this module. Decomposed:
 *
 *   - **Tile** = 8×8 pixel block, 32 bytes in 4bpp mode (each byte
 *     stores 2 nibble-pixels, low nibble first). 64 bytes in 8bpp mode
 *     (1 byte per pixel). Gen-3 uses 4bpp almost everywhere except some
 *     special UI tilesets.
 *
 *   - **Palette** = 16 colors × 2 bytes each = 32 bytes total. Each
 *     color is a BGR555 u16: bits 0-4 = red, 5-9 = green, 10-14 = blue,
 *     bit 15 = unused. Color index 0 of a 4bpp palette is conventionally
 *     transparent (the GBA OAM treats it as alpha=0 when sprites blit
 *     over backgrounds).
 *
 *   - **Metatile** = 16×16 composite of 4 8×8 tiles arranged 2×2, with
 *     TWO LAYERS (bottom + top). Each metatile occupies 8 bytes in the
 *     tileset's metatiles table (4 layer-0 tile slots × 16 bits each
 *     packed with hflip/vflip/palette#); layer 1 is an additional 8
 *     bytes. Metatile bytes per pret/pokefirered include/tileset.h:
 *
 *       struct MetatileTilesAttributes {
 *         u16 tile;          // bits 0-9 = tile index, 10 = hflip,
 *                            // 11 = vflip, 12-15 = paletteNumber
 *       }; // 4 entries per layer × 2 layers = 8 u16 = 16 bytes per metatile
 *
 *   - **Layer composition**: layer 0 (bottom) is drawn first, then
 *     layer 1 (top) is composited per-pixel: where layer 1's pixel is
 *     palette index 0 (transparent), keep layer 0's pixel; otherwise
 *     replace with layer 1's pixel.
 *
 * This module provides:
 *   - decode4bppTile: 32 input bytes → Uint8Array(64) of palette indices
 *   - bgr555ToRgba: Uint8Array(32) → Uint32Array(16) of u32 RGBA colors
 *   - composeMetatile: layer-0 tile indices + layer-1 tile indices +
 *     decoded tilesheet + palettes → Uint32Array(256) of u32 RGBA (16×16)
 *
 * PD 5: structural-only; works on every Gen-3 cart whose graphics retain
 * the universal GBA 4bpp + BGR555 conventions (vanilla + every hack).
 */

/** Bytes per 8×8 tile in 4bpp mode. */
export const TILE_4BPP_SIZE_BYTES = 32;

/** Bytes per 16-color palette (16 × 2 bytes per BGR555 u16). */
export const PALETTE_4BPP_SIZE_BYTES = 32;

/** Pixels per tile (8 × 8). */
export const PIXELS_PER_TILE = 64;

/** Pixels per metatile (16 × 16). */
export const PIXELS_PER_METATILE = 256;

/** Palette index 0 conventionally transparent in 4bpp Gen-3 sprites. */
export const TRANSPARENT_PALETTE_INDEX = 0;

/**
 * Decode one 4bpp tile (32 bytes) at `bytes[offset..offset+32]` into a
 * Uint8Array of 64 palette indices in row-major order. Each input byte
 * carries two 4-bit pixels: low nibble = left pixel, high nibble = right.
 *
 * Throws if the offset is out of range (caller should bounds-check).
 */
export function decode4bppTile(bytes: Uint8Array, offset: number): Uint8Array {
  if (offset < 0 || offset + TILE_4BPP_SIZE_BYTES > bytes.length) {
    throw new RangeError(
      `decode4bppTile: offset ${String(offset)} + 32 exceeds buffer length ${String(bytes.length)}`,
    );
  }
  const pixels = new Uint8Array(PIXELS_PER_TILE);
  for (let i = 0; i < TILE_4BPP_SIZE_BYTES; i++) {
    const byte = bytes[offset + i]!;
    pixels[i * 2] = byte & 0x0f;
    pixels[i * 2 + 1] = (byte >> 4) & 0x0f;
  }
  return pixels;
}

/**
 * Convert a 32-byte 16-color BGR555 palette to a Uint32Array(16) of
 * u32 RGBA colors. Index 0 is always returned as 0x00000000 (fully
 * transparent) per the GBA 4bpp convention. RGBA byte order in the u32
 * is little-endian: bits 0-7 = R, 8-15 = G, 16-23 = B, 24-31 = A.
 */
export function bgr555ToRgba(palette: Uint8Array): Uint32Array {
  if (palette.length < PALETTE_4BPP_SIZE_BYTES) {
    throw new RangeError(
      `bgr555ToRgba: palette length ${String(palette.length)} < 32`,
    );
  }
  const out = new Uint32Array(16);
  for (let i = 0; i < 16; i++) {
    const lo = palette[i * 2]!;
    const hi = palette[i * 2 + 1]!;
    const bgr = lo | (hi << 8);
    // BGR555: bits 0-4 R, 5-9 G, 10-14 B.
    const r5 = bgr & 0x1f;
    const g5 = (bgr >> 5) & 0x1f;
    const b5 = (bgr >> 10) & 0x1f;
    // Scale 5-bit → 8-bit with the standard (n << 3) | (n >> 2) trick
    // so 0x1F maps to 0xFF + 0 maps to 0.
    const r8 = (r5 << 3) | (r5 >> 2);
    const g8 = (g5 << 3) | (g5 >> 2);
    const b8 = (b5 << 3) | (b5 >> 2);
    if (i === TRANSPARENT_PALETTE_INDEX) {
      out[i] = 0; // fully transparent
    } else {
      out[i] = (0xff << 24) | (b8 << 16) | (g8 << 8) | r8;
    }
  }
  return out;
}

/** One metatile-layer-tile-attribute u16 decoded into its fields. */
export interface MetatileTileSpec {
  /** Tile index into the tileset's tile sheet (0..1023). */
  readonly tileIndex: number;
  /** Horizontal flip applied during composition. */
  readonly hflip: boolean;
  /** Vertical flip applied during composition. */
  readonly vflip: boolean;
  /** Palette number (0..15). */
  readonly paletteIndex: number;
}

/** Decode one 16-bit metatile attribute u16 into its fields. */
export function decodeMetatileTileAttribute(attr: number): MetatileTileSpec {
  return {
    tileIndex: attr & 0x03ff,
    hflip: (attr & 0x0400) !== 0,
    vflip: (attr & 0x0800) !== 0,
    paletteIndex: (attr >> 12) & 0x0f,
  };
}

/** Decode one full metatile (16 bytes = 4 tiles × 2 layers × 2 bytes
 *  each) at `bytes[offset..offset+16]` into its 8 MetatileTileSpec
 *  entries (layer 0 tiles 0-3, then layer 1 tiles 0-3). The tiles are
 *  arranged 2×2 in row-major order: top-left, top-right, bottom-left,
 *  bottom-right. */
export function decodeMetatile(
  bytes: Uint8Array,
  offset: number,
): {
  readonly layer0: ReadonlyArray<MetatileTileSpec>;
  readonly layer1: ReadonlyArray<MetatileTileSpec>;
} {
  if (offset < 0 || offset + 16 > bytes.length) {
    throw new RangeError(
      `decodeMetatile: offset ${String(offset)} + 16 exceeds buffer length ${String(bytes.length)}`,
    );
  }
  const layer0: MetatileTileSpec[] = [];
  const layer1: MetatileTileSpec[] = [];
  for (let i = 0; i < 4; i++) {
    const attr0 = bytes[offset + i * 2]! | (bytes[offset + i * 2 + 1]! << 8);
    layer0.push(decodeMetatileTileAttribute(attr0));
  }
  for (let i = 0; i < 4; i++) {
    const off = offset + 8 + i * 2;
    const attr1 = bytes[off]! | (bytes[off + 1]! << 8);
    layer1.push(decodeMetatileTileAttribute(attr1));
  }
  return { layer0: Object.freeze(layer0), layer1: Object.freeze(layer1) };
}

/** Apply optional hflip + vflip to a tile's 64 palette indices,
 *  returning a new flipped pixel array. */
function flipTilePixels(
  pixels: Uint8Array,
  hflip: boolean,
  vflip: boolean,
): Uint8Array {
  if (!hflip && !vflip) return pixels;
  const out = new Uint8Array(PIXELS_PER_TILE);
  for (let y = 0; y < 8; y++) {
    const srcY = vflip ? 7 - y : y;
    for (let x = 0; x < 8; x++) {
      const srcX = hflip ? 7 - x : x;
      out[y * 8 + x] = pixels[srcY * 8 + srcX]!;
    }
  }
  return out;
}

/**
 * Compose one 16×16 metatile from its layer specs + the decoded tile
 * sheet (an array of Uint8Array(64) palette-index tiles, one per tile
 * index) + the decoded palette set (an array of Uint32Array(16) RGBA
 * palettes). Returns a Uint32Array(256) of u32 RGBA in row-major order.
 *
 * Layer composition: layer 0 (bottom) drawn first; layer 1 (top)
 * composited per-pixel - where layer 1's palette index is 0 (transparent),
 * the layer 0 pixel shows through. Where layer 1 is opaque, it replaces
 * layer 0.
 *
 * If a tileIndex references a tile beyond the tile sheet's length OR
 * a paletteIndex beyond the palette set, that tile slot renders as
 * fully transparent (defensive - no crash on corrupt metatile attrs).
 */
export function composeMetatile(
  layer0: ReadonlyArray<MetatileTileSpec>,
  layer1: ReadonlyArray<MetatileTileSpec>,
  tileSheet: ReadonlyArray<Uint8Array>,
  palettes: ReadonlyArray<Uint32Array>,
): Uint32Array {
  const out = new Uint32Array(PIXELS_PER_METATILE);

  // Layer 0 - fill every pixel using the layer 0 tile/palette combo.
  // Even index-0 pixels are colored using layer 0's palette so the
  // composed metatile is fully opaque on its background.
  for (let q = 0; q < 4; q++) {
    const spec = layer0[q]!;
    const tilePixels = tileSheet[spec.tileIndex] ?? new Uint8Array(PIXELS_PER_TILE);
    const palette = palettes[spec.paletteIndex] ?? new Uint32Array(16);
    const flipped = flipTilePixels(tilePixels, spec.hflip, spec.vflip);
    const dx = (q % 2) * 8;
    const dy = Math.floor(q / 2) * 8;
    for (let py = 0; py < 8; py++) {
      for (let px = 0; px < 8; px++) {
        const palIdx = flipped[py * 8 + px]!;
        // For layer 0, render every pixel including index 0 - use the
        // matching color from palette (which DOES have an entry at 0
        // even though we returned it as 0/transparent in bgr555ToRgba;
        // for ground tiles like grass, the BG color at index 0 IS the
        // intended background).
        // To make ground tiles render with their real "transparent"
        // color, we re-encode index 0 by reading the palette bytes
        // directly (caller responsibility) OR use a separate
        // composeMetatileWithLayer0Background variant. For simplicity
        // and per pret convention, index 0 in layer 0 stays
        // transparent and the canvas BG color fills through.
        out[(dy + py) * 16 + (dx + px)] = palette[palIdx] ?? 0;
      }
    }
  }

  // Layer 1 - composite over layer 0 with transparency at palette index 0.
  for (let q = 0; q < 4; q++) {
    const spec = layer1[q]!;
    if (spec.tileIndex === 0 && spec.paletteIndex === 0) {
      // Empty layer-1 slot (common for ground-only metatiles); skip.
      continue;
    }
    const tilePixels = tileSheet[spec.tileIndex] ?? new Uint8Array(PIXELS_PER_TILE);
    const palette = palettes[spec.paletteIndex] ?? new Uint32Array(16);
    const flipped = flipTilePixels(tilePixels, spec.hflip, spec.vflip);
    const dx = (q % 2) * 8;
    const dy = Math.floor(q / 2) * 8;
    for (let py = 0; py < 8; py++) {
      for (let px = 0; px < 8; px++) {
        const palIdx = flipped[py * 8 + px]!;
        if (palIdx === TRANSPARENT_PALETTE_INDEX) continue;
        out[(dy + py) * 16 + (dx + px)] = palette[palIdx] ?? 0;
      }
    }
  }

  return out;
}
