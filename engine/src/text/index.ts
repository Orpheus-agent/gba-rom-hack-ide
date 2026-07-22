export {
  STRING_TERMINATOR,
  decodeByte,
  decodeString,
  encodeString,
} from './codec.js';

export {
  TEXT_POINTER_TABLE_ANCHOR_CONFIRMATION_ENTRIES,
  TEXT_POINTER_TABLE_MAX_ENTRIES_PER_TABLE,
  TEXT_POINTER_TABLE_MAX_TABLES_PER_SCAN,
  TEXT_POINTER_TABLE_MAX_TEXT_LEN,
  TEXT_POINTER_TABLE_MIN_PRINTABLE_CHARS,
  TEXT_POINTER_TABLE_MIN_VALID_ENTRIES,
  findTextPointerTables,
  type TextPointerTable,
} from './text-pointer-tables.js';

export {
  classifyTextTable,
  type TextTableClassification,
  type TextTableKind,
} from './text-table-classifier.js';
