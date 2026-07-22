/**
 * `engine/src/items/` - items-system data table parser + scanner.
 *
 * Phase UW-2 / Category 4 substrate. Iter 70 (UW-2-T4): adds the 44-byte
 * gItems struct parser and the table scanner anchored on the universal
 * `itemId == record index` invariant. Engine root namespace surfaces this
 * as `import { items } from '@rom-introspection/engine'` per the same
 * convention as `moves`, `battle`, `species`, etc.
 */

export {
  ITEM_STRUCT_SIZE_BYTES,
  ITEM_NAME_LENGTH_BYTES,
  ITEM_POCKET_MAX,
  ITEM_PRICE_MAX_NOMINAL,
  GBA_ROM_BASE,
  GBA_ROM_END_EXCLUSIVE,
  ITEM_OFFSET_NAME,
  ITEM_OFFSET_ITEM_ID,
  ITEM_OFFSET_PRICE,
  ITEM_OFFSET_HOLD_EFFECT,
  ITEM_OFFSET_HOLD_EFFECT_PARAM,
  ITEM_OFFSET_DESCRIPTION_PTR,
  ITEM_OFFSET_IMPORTANCE,
  ITEM_OFFSET_UNK19,
  ITEM_OFFSET_POCKET,
  ITEM_OFFSET_TYPE,
  ITEM_OFFSET_FIELD_USE_FUNC_PTR,
  ITEM_OFFSET_BATTLE_USAGE,
  ITEM_OFFSET_BATTLE_USE_FUNC_PTR,
  ITEM_OFFSET_SECONDARY_ID,
  ITEM_OFFSET_PADDING,
  parseItem,
  type Item,
  type ItemParseFailure,
  type ItemParseResult,
} from './item.js';

export {
  ITEMS_SCAN_MIN_RECORDS,
  scanItemsTable,
  type ItemsTable,
  type ItemsScanOptions,
} from './item-scanner.js';
