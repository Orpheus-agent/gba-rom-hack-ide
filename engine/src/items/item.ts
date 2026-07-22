/**
 * Gen-3 Item struct parser - Phase UW-2 / Category 4 substrate.
 *
 * Per pret/pokefirered + pret/pokeemerald `include/item.h`, every item
 * (bag/key/TM/HM/berry, vanilla 376 in FRLG, up to 1000+ in heavy hacks)
 * has a 44-byte entry in a flat `gItems` array indexed by item ID. Layout:
 *
 *   struct Item {
 *     u8  name[14];           // 0x00..0x0D - Gen-3 charset, 0xFF-terminated
 *     u16 itemId;             // 0x0E - MUST EQUAL record index
 *     u16 price;              // 0x10 - buy price (0..9999 vanilla)
 *     u8  holdEffect;         // 0x12 - HoldEffect enum (0..n)
 *     u8  holdEffectParam;    // 0x13 - qty/percent
 *     u32 descriptionPtr;     // 0x14..0x17 - ROM pointer (0x08000000..0x09FFFFFF) or 0
 *     u8  importance;         // 0x18 - KeyItem flag (0 or 1; vanilla=0 for most)
 *     u8  unk19;              // 0x19 - usually 0
 *     u8  pocket;             // 0x1A - POCKET_* enum (0..9 vanilla)
 *     u8  type;               // 0x1B - usage type byte
 *     u32 fieldUseFuncPtr;    // 0x1C..0x1F - ROM pointer or 0
 *     u32 battleUsage;        // 0x20..0x23 - bitmask
 *     u32 battleUseFuncPtr;   // 0x24..0x27 - ROM pointer or 0
 *     u8  secondaryId;        // 0x28 - TM/HM number for TM/HM items
 *     u8  padding[3];         // 0x29..0x2B - MUST be all zero
 *   };  // 44 bytes
 *
 * The strongest universal detection signal is the `itemId == record index`
 * invariant - every Gen-3 ROM stores items in `gItems` indexed by ID with
 * `gItems[i].itemId == i`. This is universal across vanilla AND every
 * known fork that expands the item list. A run of ≥100 consecutive
 * records each satisfying that invariant is essentially guaranteed real.
 *
 * Additional per-record validation:
 *   - pocket byte ≤ 9 (vanilla has 10 pockets; even heavy hacks rarely
 *     exceed this since the bag UI shows only ~10)
 *   - 3 padding bytes (0x29..0x2B) all zero
 *   - 3 pointer fields are either zero OR in the canonical GBA ROM
 *     mirror range 0x08000000..0x09FFFFFF
 *
 * PD 5: structural-only - no baked offsets; works on any Gen-3 cart
 * whose Item struct retains the published 44-byte layout.
 */

/** Size of one Gen-3 Item struct in bytes. */
export const ITEM_STRUCT_SIZE_BYTES = 44;

/** Length in bytes of the item-name field (offset 0x00..0x0D). */
export const ITEM_NAME_LENGTH_BYTES = 14;

/** Highest valid pocket byte (Gen-3 has 10 pockets: 0..9). */
export const ITEM_POCKET_MAX = 9;

/** Maximum nominal price stored as u16 LE (vanilla cap ~9999). */
export const ITEM_PRICE_MAX_NOMINAL = 9999;

/** Start of canonical GBA ROM mirror address space. */
export const GBA_ROM_BASE = 0x08000000;

/** End-exclusive of GBA ROM mirror (32 MiB max cart). */
export const GBA_ROM_END_EXCLUSIVE = 0x0a000000;

/** Field offsets within an Item struct (matching pret include/item.h). */
export const ITEM_OFFSET_NAME = 0x00;
export const ITEM_OFFSET_ITEM_ID = 0x0e;
export const ITEM_OFFSET_PRICE = 0x10;
export const ITEM_OFFSET_HOLD_EFFECT = 0x12;
export const ITEM_OFFSET_HOLD_EFFECT_PARAM = 0x13;
export const ITEM_OFFSET_DESCRIPTION_PTR = 0x14;
export const ITEM_OFFSET_IMPORTANCE = 0x18;
export const ITEM_OFFSET_UNK19 = 0x19;
export const ITEM_OFFSET_POCKET = 0x1a;
export const ITEM_OFFSET_TYPE = 0x1b;
export const ITEM_OFFSET_FIELD_USE_FUNC_PTR = 0x1c;
export const ITEM_OFFSET_BATTLE_USAGE = 0x20;
export const ITEM_OFFSET_BATTLE_USE_FUNC_PTR = 0x24;
export const ITEM_OFFSET_SECONDARY_ID = 0x28;
export const ITEM_OFFSET_PADDING = 0x29;

export interface Item {
  /** Raw 14-byte name field (Gen-3 charset bytes; not decoded by parser). */
  readonly nameBytes: Uint8Array;
  /** Item ID at offset 0x0E (u16 LE). MUST equal record index in the table. */
  readonly itemId: number;
  /** Buy price at offset 0x10 (u16 LE). */
  readonly price: number;
  /** Hold-effect enum at offset 0x12. */
  readonly holdEffect: number;
  /** Hold-effect parameter at offset 0x13. */
  readonly holdEffectParam: number;
  /** Description pointer at offset 0x14 (u32 LE; 0 or ROM-space). */
  readonly descriptionPtr: number;
  /** KeyItem flag at offset 0x18 (0 or 1). */
  readonly importance: number;
  /** Reserved byte at offset 0x19. */
  readonly unk19: number;
  /** Pocket enum at offset 0x1A (0..9 vanilla). */
  readonly pocket: number;
  /** Usage-type byte at offset 0x1B. */
  readonly type: number;
  /** Field-use-function pointer at offset 0x1C (u32 LE; 0 or ROM-space). */
  readonly fieldUseFuncPtr: number;
  /** Battle-usage bitmask at offset 0x20 (u32 LE). */
  readonly battleUsage: number;
  /** Battle-use-function pointer at offset 0x24 (u32 LE; 0 or ROM-space). */
  readonly battleUseFuncPtr: number;
  /** Secondary ID at offset 0x28 (TM/HM number for those items). */
  readonly secondaryId: number;
}

export type ItemParseFailure =
  | { readonly kind: 'out_of_bounds' }
  | { readonly kind: 'pocket_out_of_range' }
  | { readonly kind: 'padding_not_zero' }
  | { readonly kind: 'description_ptr_invalid' }
  | { readonly kind: 'field_use_func_ptr_invalid' }
  | { readonly kind: 'battle_use_func_ptr_invalid' };

export type ItemParseResult =
  | { readonly ok: true; readonly value: Item }
  | { readonly ok: false; readonly failure: ItemParseFailure };

function readU16LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function readU32LE(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset]! |
      (bytes[offset + 1]! << 8) |
      (bytes[offset + 2]! << 16) |
      (bytes[offset + 3]! << 24)) >>>
    0
  );
}

function isValidRomPointerOrZero(ptr: number): boolean {
  if (ptr === 0) return true;
  return ptr >= GBA_ROM_BASE && ptr < GBA_ROM_END_EXCLUSIVE;
}

/**
 * Parse a single 44-byte Item struct from `bytes` starting at `offset`.
 *
 * Returns `ok:true` with the populated Item interface if all structural
 * checks pass:
 *   - 44 bytes available from `offset`
 *   - pocket byte ≤ 9
 *   - 3 padding bytes (0x29..0x2B) all zero
 *   - 3 pointer fields (description / fieldUseFunc / battleUseFunc) are
 *     each zero OR in [0x08000000, 0x0A000000)
 *
 * Returns `ok:false` with a typed failure kind otherwise. Note: this
 * parser does NOT validate `itemId == record index` - that's the
 * scanner's job (the parser is per-record; the invariant is per-table).
 */
export function parseItem(bytes: Uint8Array, offset: number): ItemParseResult {
  if (offset < 0 || offset + ITEM_STRUCT_SIZE_BYTES > bytes.byteLength) {
    return { ok: false, failure: { kind: 'out_of_bounds' } };
  }

  const pocket = bytes[offset + ITEM_OFFSET_POCKET]!;
  if (pocket > ITEM_POCKET_MAX) {
    return { ok: false, failure: { kind: 'pocket_out_of_range' } };
  }

  const pad0 = bytes[offset + ITEM_OFFSET_PADDING + 0]!;
  const pad1 = bytes[offset + ITEM_OFFSET_PADDING + 1]!;
  const pad2 = bytes[offset + ITEM_OFFSET_PADDING + 2]!;
  if (pad0 !== 0 || pad1 !== 0 || pad2 !== 0) {
    return { ok: false, failure: { kind: 'padding_not_zero' } };
  }

  const descriptionPtr = readU32LE(bytes, offset + ITEM_OFFSET_DESCRIPTION_PTR);
  if (!isValidRomPointerOrZero(descriptionPtr)) {
    return { ok: false, failure: { kind: 'description_ptr_invalid' } };
  }
  const fieldUseFuncPtr = readU32LE(bytes, offset + ITEM_OFFSET_FIELD_USE_FUNC_PTR);
  if (!isValidRomPointerOrZero(fieldUseFuncPtr)) {
    return { ok: false, failure: { kind: 'field_use_func_ptr_invalid' } };
  }
  const battleUseFuncPtr = readU32LE(bytes, offset + ITEM_OFFSET_BATTLE_USE_FUNC_PTR);
  if (!isValidRomPointerOrZero(battleUseFuncPtr)) {
    return { ok: false, failure: { kind: 'battle_use_func_ptr_invalid' } };
  }

  return {
    ok: true,
    value: {
      nameBytes: bytes.slice(offset + ITEM_OFFSET_NAME, offset + ITEM_OFFSET_NAME + ITEM_NAME_LENGTH_BYTES),
      itemId: readU16LE(bytes, offset + ITEM_OFFSET_ITEM_ID),
      price: readU16LE(bytes, offset + ITEM_OFFSET_PRICE),
      holdEffect: bytes[offset + ITEM_OFFSET_HOLD_EFFECT]!,
      holdEffectParam: bytes[offset + ITEM_OFFSET_HOLD_EFFECT_PARAM]!,
      descriptionPtr,
      importance: bytes[offset + ITEM_OFFSET_IMPORTANCE]!,
      unk19: bytes[offset + ITEM_OFFSET_UNK19]!,
      pocket,
      type: bytes[offset + ITEM_OFFSET_TYPE]!,
      fieldUseFuncPtr,
      battleUsage: readU32LE(bytes, offset + ITEM_OFFSET_BATTLE_USAGE),
      battleUseFuncPtr,
      secondaryId: bytes[offset + ITEM_OFFSET_SECONDARY_ID]!,
    },
  };
}
