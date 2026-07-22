/**
 * Gen-3 menu-system string scanner - Phase UW-2 / Category 11 substrate
 * (iter 77 / UW-2-T11).
 *
 * Gen-3 Pokémon games define their main-menu, pause-menu, and submenu
 * prompts as `_("STRING")` literals in pret source - these expand to
 * Gen-3-encoded byte arrays embedded in `.rodata`. Scanning ROM for the
 * encoded form of these strings is a strong universal signal that the
 * ROM contains the Gen-3 menu engine.
 *
 * The strings chosen here are:
 *   - LONG enough to avoid coincidental matches in random byte regions
 *     (4+ bytes after Gen-3 encoding; "BAG" and "YES"/"NO" excluded
 *     because they're only 3 bytes and would false-positive too
 *     frequently)
 *   - UNIVERSAL across vanilla FRLG / Emerald / RS / LG main + pause
 *     menus
 *   - DISTINCTIVE - text patterns unlikely to appear in non-menu data
 *     (item names, dialogue, etc.)
 *
 * Per PD 5: no version-specific assumptions; works on every Gen-3
 * Pokémon ROM that retains pret's menu prompt text (every known FRLG /
 * Emerald / RS derivative including CFRU + Unbound + RR - even when
 * hacks rename SOME prompts they typically keep most).
 *
 * Per PD 12: returns ALL matched prompt strings with their offsets so
 * the editor/inspector can surface the full inventory.
 */

import { encodeString } from '../text/codec.js';

/**
 * Canonical Gen-3 menu prompt strings. Each entry's text is encoded via
 * the engine's text codec at scanner-init time; the resulting byte
 * sequence is searched in the ROM.
 *
 * Order matters slightly: the FIRST entry that matches is treated as
 * the "primary" prompt in the detector report. Order by descending
 * universality.
 */
export const MENU_PROMPT_STRINGS: ReadonlyArray<string> = Object.freeze([
  'CONTINUE',   // 8 bytes - main menu after a save exists
  'NEW GAME',   // 8 bytes - main menu always
  'OPTION',     // 6 bytes - main menu always
  'PLAYER',     // 6 bytes - pause menu / trainer card
  'EXIT',       // 4 bytes - submenu always
  'SETTING',    // 7 bytes - settings sub (longer-distinctive variant)
  'BUTTON',     // 6 bytes - options screen ("BUTTON MODE")
  'BATTLE',     // 6 bytes - appears in many menus
  'FRAME',      // 5 bytes - options ("FRAME ...")
  'SOUND',      // 5 bytes - options
]);

/** Minimum number of distinct prompt strings that must be found in the
 *  ROM to consider the menu system detected. Set to 3 because vanilla
 *  ROMs typically match all 10, and even shrunk hacks (which remove
 *  features) usually keep CONTINUE + NEW GAME + OPTION at minimum. */
export const MENU_PROMPT_MIN_MATCHES = 3;

/** Cartridge-header skip - none of these strings would appear there. */
const CARTRIDGE_HEADER_END = 0xc0;

export interface MenuPromptMatch {
  /** The literal prompt string (one of MENU_PROMPT_STRINGS). */
  readonly text: string;
  /** Absolute byte offset of the FIRST occurrence of this string. */
  readonly firstOffset: number;
  /** Total count of occurrences in the ROM (≥1). */
  readonly occurrenceCount: number;
}

/**
 * Scan `romBytes` for each canonical menu prompt string. Returns an
 * array of matches ordered the same as MENU_PROMPT_STRINGS, with one
 * entry per string FOUND (strings with zero occurrences are omitted).
 *
 * Empty array if none are found.
 */
export function scanMenuPromptStrings(romBytes: Uint8Array): ReadonlyArray<MenuPromptMatch> {
  const search = Buffer.isBuffer(romBytes) ? romBytes : Buffer.from(romBytes);
  const matches: MenuPromptMatch[] = [];
  for (const text of MENU_PROMPT_STRINGS) {
    const needle = Buffer.from(encodeString(text));
    let firstOffset = -1;
    let count = 0;
    let from = CARTRIDGE_HEADER_END;
    while (from < romBytes.length) {
      const found = search.indexOf(needle, from);
      if (found < 0) break;
      if (firstOffset < 0) firstOffset = found;
      count++;
      from = found + 1;
    }
    if (count > 0) {
      matches.push({ text, firstOffset, occurrenceCount: count });
    }
  }
  return matches;
}
