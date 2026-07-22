/**
 * `engine/src/battle/` - battle-system data table parsers + scanners.
 *
 * Phase UW-2 / Category 4 substrate. Started iter 69 (UW-2-T3) with the
 * gTypeEffectiveness chart; later iters will add trainer-AI tables,
 * damage-formula constants, etc. Engine root namespace surfaces this as
 * `import { battle } from '@rom-introspection/engine'` per the same
 * convention as `moves`, `species`, etc.
 */

export {
  TYPE_MATCHUP_SIZE_BYTES,
  TYPE_CHART_TYPE_MAX,
  TYPE_CHART_FORESIGHT_SENTINEL,
  TYPE_CHART_ENDTABLE_SENTINEL,
  TYPE_CHART_EFFECTIVENESS_IMMUNE,
  TYPE_CHART_EFFECTIVENESS_NOT_VERY,
  TYPE_CHART_EFFECTIVENESS_NORMAL,
  TYPE_CHART_EFFECTIVENESS_SUPER,
  parseTypeMatchup,
  type TypeMatchupKind,
  type TypeMatchup,
  type TypeMatchupParseFailure,
  type TypeMatchupParseResult,
} from './type-chart.js';

export {
  TYPE_CHART_SCAN_MIN_TRIPLETS,
  scanTypeChart,
  type TypeChartTable,
  type TypeChartScanOptions,
} from './type-chart-scanner.js';

export {
  TYPE_NAME_SLOT_BYTES,
  TYPE_NAMES_MIN_VALID_SLOTS,
  TYPE_NAMES_READ_CAP,
  readTypeNamesAt,
  validateTypeNames,
  findTypeNamesTable,
} from './type-names.js';

// Phase 3.4 - damage simulator + win-rate estimator.
export {
  FAIRY_TYPE_ID,
  TYPE_MATRIX_SIZE,
  VANILLA_GEN3_TYPE_MATRIX,
  computeDamage,
  deriveGen3MoveSplit,
  prepareTypeMatrix,
  simulateBattle,
  type MoveSpec,
  type PokemonStatsSpec,
} from './damage.js';
