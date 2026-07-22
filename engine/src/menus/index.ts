/**
 * `engine/src/menus/` - Gen-3 menu-system substrate.
 *
 * Phase UW-2 / Category 11. Iter 77 (UW-2-T11) ships the menu prompt
 * string scanner. Future iters can add per-menu-system decoders (start
 * menu layout, pause menu choice tables, bag pocket transitions, etc.).
 *
 * Engine root namespace surfaces this as
 * `import { menus } from '@rom-introspection/engine'` per the same
 * convention as `moves`, `items`, `abilities`, `saveData`, etc.
 */

export {
  MENU_PROMPT_STRINGS,
  MENU_PROMPT_MIN_MATCHES,
  scanMenuPromptStrings,
  type MenuPromptMatch,
} from './menu-strings.js';
