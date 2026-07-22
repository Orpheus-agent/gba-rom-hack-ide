/**
 * `engine/src/abilities/` - ability-system data table parsers + scanners.
 *
 * Phase UW-2 / Category 4 substrate. Iter 71 (UW-2-T5) adds the
 * gAbilityNames signature scanner; later iters may add ability description
 * pointers, hidden-ability table, ability effect handlers, etc. Engine
 * root namespace surfaces this as `import { abilities } from '@rom-
 * introspection/engine'` per the same convention as `moves`, `items`,
 * `battle`, `species`, etc.
 */

export {
  ABILITY_NAME_SLOT_BYTES,
  ABILITY_NAMES_MIN_VALID_SLOTS,
  ABILITY_NAMES_READ_CAP,
  ABILITY_PLACEHOLDER_BYTE,
  readAbilityNamesAt,
  validateAbilityNames,
  findAbilityNamesTable,
} from './ability-names.js';
