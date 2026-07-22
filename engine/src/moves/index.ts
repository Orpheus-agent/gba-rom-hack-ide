export {
  BATTLE_MOVE_ACCURACY_MAX,
  BATTLE_MOVE_EFFECT_CHANCE_MAX,
  BATTLE_MOVE_POWER_MAX,
  BATTLE_MOVE_PP_MAX,
  BATTLE_MOVE_PRIORITY_MAX,
  BATTLE_MOVE_PRIORITY_MIN,
  BATTLE_MOVE_STRUCT_SIZE_BYTES,
  BATTLE_MOVE_TYPE_MAX,
  parseBattleMove,
  type BattleMove,
  type BattleMoveParseFailure,
  type BattleMoveParseResult,
} from './move.js';

export {
  BATTLE_MOVES_SCAN_MAX_RECORDS,
  BATTLE_MOVES_SCAN_MIN_POPULATED,
  BATTLE_MOVES_SCAN_MIN_RECORDS,
  scanBattleMovesTable,
  type BattleMovesTable,
  type ScanBattleMovesOptions,
} from './move-scanner.js';

export {
  MOVE_NAME_SLOT_BYTES,
  MOVE_NAMES_MIN_VALID_SLOTS,
  MOVE_NAMES_READ_CAP,
  MOVE_PLACEHOLDER_BYTE,
  readMoveNamesAt,
  validateMoveNames,
  findMoveNamesTable,
} from './move-names.js';
