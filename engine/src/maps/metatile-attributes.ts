/**
 * Gen-3 MetatileAttributes parser + encoder - Phase J.4.
 *
 * Each metatile in a Gen-3 tileset has a separate "attributes" word
 * stored at a parallel offset (the Tileset struct's slot10Ptr for
 * Emerald, slot14Ptr for FireRed/LeafGreen). The word packs the
 * metatile's behavior (tall grass, water, jump-direction, etc.),
 * terrain type, encounter eligibility, and layer-composition mode as
 * bitfields.
 *
 * Layouts (per pret/pokefirered + pret/pokeemerald
 * `include/global.fieldmap.h`):
 *
 *   FRLG - 4 bytes per metatile:
 *     bits  0..8  (9 bits) - behavior
 *     bits  9..13 (5 bits) - terrainType
 *     bits 14..23 (10 bits) - padding
 *     bits 24..26 (3 bits) - encounterType
 *     bits 27..28 (2 bits) - layerType
 *     bits 29..31 (3 bits) - padding
 *
 *   RSE - 2 bytes per metatile:
 *     bits  0..7  (8 bits) - behavior
 *     bits  8..11 (4 bits) - padding
 *     bits 12..13 (2 bits) - layerType
 *     bits 14..15 (2 bits) - padding
 *
 *   (RSE has no terrainType / encounterType fields; those were added
 *   in FRLG. Editors targeting an RSE tileset should hide those
 *   dropdowns.)
 *
 * Behavior values are documented in pret's `include/constants/
 * metatile_behaviors.h` (FRLG has ~80, Emerald ~110). We parse the raw
 * numeric value here and let consumers map it to a human label.
 */

export type MetatileAttributesFamily = 'frlg' | 'rse';

export interface MetatileAttributes {
  readonly behavior: number;
  readonly terrainType: number;
  readonly encounterType: number;
  readonly layerType: number;
}

/** Bytes per attribute word for each family. */
export function metatileAttributesStride(family: MetatileAttributesFamily): 2 | 4 {
  return family === 'frlg' ? 4 : 2;
}

/** Parse one MetatileAttributes entry at `offset`. */
export function parseMetatileAttributes(
  bytes: Uint8Array,
  offset: number,
  family: MetatileAttributesFamily,
): MetatileAttributes {
  if (family === 'frlg') {
    const word =
      ((bytes[offset] ?? 0) |
        ((bytes[offset + 1] ?? 0) << 8) |
        ((bytes[offset + 2] ?? 0) << 16) |
        ((bytes[offset + 3] ?? 0) << 24)) >>>
      0;
    return Object.freeze({
      behavior: word & 0x1ff,
      terrainType: (word >>> 9) & 0x1f,
      encounterType: (word >>> 24) & 0x07,
      layerType: (word >>> 29) & 0x03,
    });
  }
  // RSE
  const word = ((bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8)) >>> 0;
  return Object.freeze({
    behavior: word & 0xff,
    terrainType: 0,
    encounterType: 0,
    layerType: (word >>> 12) & 0x03,
  });
}

/** Encode an attribute set into the family's byte layout, preserving
 *  the padding/reserved bits from the existing word at `offset`. */
export function encodeMetatileAttributes(
  bytes: Uint8Array,
  offset: number,
  family: MetatileAttributesFamily,
  attrs: Partial<MetatileAttributes>,
): Uint8Array {
  const current = parseMetatileAttributes(bytes, offset, family);
  const merged: MetatileAttributes = {
    behavior: attrs.behavior ?? current.behavior,
    terrainType: attrs.terrainType ?? current.terrainType,
    encounterType: attrs.encounterType ?? current.encounterType,
    layerType: attrs.layerType ?? current.layerType,
  };
  if (family === 'frlg') {
    // Preserve the padding bits (9..13 are terrainType, 14..23 padding,
    // 24..26 encounterType, 27..28 layerType). Read original word, mask
    // out the editable fields, OR in the new values.
    const original =
      ((bytes[offset] ?? 0) |
        ((bytes[offset + 1] ?? 0) << 8) |
        ((bytes[offset + 2] ?? 0) << 16) |
        ((bytes[offset + 3] ?? 0) << 24)) >>>
      0;
    // Clear bits we control: 0..8, 9..13, 24..26, 27..28.
    const mask = ~(0x1ff | (0x1f << 9) | (0x07 << 24) | (0x03 << 29)) >>> 0;
    let word = (original & mask) >>> 0;
    word = (word | (merged.behavior & 0x1ff)) >>> 0;
    word = (word | ((merged.terrainType & 0x1f) << 9)) >>> 0;
    word = (word | ((merged.encounterType & 0x07) << 24)) >>> 0;
    word = (word | ((merged.layerType & 0x03) << 29)) >>> 0;
    const out = new Uint8Array(4);
    out[0] = word & 0xff;
    out[1] = (word >>> 8) & 0xff;
    out[2] = (word >>> 16) & 0xff;
    out[3] = (word >>> 24) & 0xff;
    return out;
  }
  // RSE
  const original = ((bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8)) >>> 0;
  const mask = ~(0xff | (0x03 << 12)) & 0xffff;
  let word = (original & mask) & 0xffff;
  word = (word | (merged.behavior & 0xff)) & 0xffff;
  word = (word | ((merged.layerType & 0x03) << 12)) & 0xffff;
  const out = new Uint8Array(2);
  out[0] = word & 0xff;
  out[1] = (word >>> 8) & 0xff;
  return out;
}
