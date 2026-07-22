/**
 * propose_level_cap_table - Phase 2D Filing 2.
 *
 * Edits CFRU's `src/config.h` to change the per-badge obedience-level
 * table - the system that controls when traded (or, optionally, original)
 * Pokémon start disobeying the player. Used to convert FireRed's loose
 * difficulty curve into a Nuzlocke-style hard level cap per gym badge.
 *
 * The edit hits CFRU SOURCE, not the bundled BPS patch - so the change
 * lands in-game only after the user reruns `scripts/build-cfru-bundle.mjs`
 * to produce a fresh `cfru.bps` from updated sources, and modernizes (or
 * re-modernizes) the ROM.
 *
 * Why not propose-flow:
 *
 *   The CFRU source clone lives outside the project root (it's a sibling
 *   directory under the user's Downloads/). The editor's existing
 *   replace_in_file infrastructure rejects paths that escape the project
 *   root for security - so a propose-flow with binary_write_bytes against
 *   the ROM isn't applicable here, and we don't want to broaden
 *   replace_in_file's surface.
 *
 *   This tool is a DIRECT-APPLY pattern: the user invoking the tool IS
 *   their own approval gate. The tool reads the existing config.h,
 *   validates the format matches expected, atomically writes a new
 *   version, and records what changed. Undo is by restoring the
 *   `.pre-level-caps.bak` file the tool drops next to config.h.
 *
 * Constraints:
 *
 *   - Levels are 1..100. 0 is rejected (would make every Pokémon disobey
 *     including the starter; clearly a footgun).
 *   - Badges array must be non-decreasing (badge 2's cap >= badge 1's,
 *     etc.) - a decreasing curve is a footgun: earning a badge would
 *     LOWER the player's cap.
 *   - `base` must be <= `badges[0]` (earning the first badge can't
 *     decrease the cap either).
 *   - `cfruSourcePath` must be an absolute path that points at a directory
 *     containing `src/config.h` with the recognizable
 *     `BADGE_N_OBEDIENCE_LEVEL` defines. Otherwise the tool refuses.
 */

import { z } from 'zod';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { ToolContext } from '../types.js';

export const PROPOSE_LEVEL_CAP_TABLE_TOOL_NAME = 'propose_level_cap_table';

export const PROPOSE_LEVEL_CAP_TABLE_DESCRIPTION =
  'Set the per-badge obedience-level table in the user\'s CFRU source ' +
  'clone. Turns FireRed\'s loose XP curve into a Nuzlocke-style hard ' +
  'level cap that lifts as the player earns gym badges.\n\n' +
  'Mechanics: above BADGE_N_OBEDIENCE_LEVEL, the engine has traded mons ' +
  '(or all mons, if originalOtObedienceCheck=true) sometimes disobey - ' +
  'they skip turns, fall asleep, attack themselves, or use the wrong ' +
  'move. After the 8th badge (Earth) the engine removes the cap entirely.\n\n' +
  'Inputs:\n' +
  '  - `cfruSourcePath`: absolute path to the user\'s CFRU clone root ' +
  '(the dir containing `src/config.h`). Default points at ' +
  '`C:\\path\\to\\Complete-Fire-Red-Upgrade-master\\Complete-Fire-Red-Upgrade-master`.\n' +
  '  - `base`: level at which traded mons disobey BEFORE any badge ' +
  '(1..100; default vanilla = 10).\n' +
  '  - `badges`: 7-tuple of caps after badges 1..7 (1..100 each; must be ' +
  'non-decreasing; first entry must be >= `base`).\n' +
  '  - `originalOtObedienceCheck`: when true, the rule also applies to ' +
  'the player\'s own Pokémon (NOT just traded). Default false (vanilla).\n\n' +
  'Behaviour:\n' +
  '  1. Reads `<cfruSourcePath>/src/config.h`.\n' +
  '  2. Validates the obedience-block matches the expected shape (the ' +
  '8 defines + the optional commented-out OBEDIENCE_CHECK_FOR_PLAYER_ ' +
  'ORIGINAL_POKEMON toggle).\n' +
  '  3. Writes a backup at `<cfruSourcePath>/src/config.h.pre-level-caps.bak`.\n' +
  '  4. Atomically rewrites the obedience block with the new values.\n' +
  '  5. Returns the diff + a next-step prompt: rerun ' +
  '`scripts/build-cfru-bundle.mjs` then modernize a fresh ROM to see ' +
  'the change in-game.\n\n' +
  'Direct-apply: the user invoking this tool is the approval gate. To ' +
  'undo, restore `config.h.pre-level-caps.bak` over `config.h`.';

const DEFAULT_CFRU_SOURCE_PATH =
  'C:\\path\\to\\Complete-Fire-Red-Upgrade-master\\Complete-Fire-Red-Upgrade-master';

const levelInput = z.number().int().min(1).max(100);

export const proposeLevelCapTableInputShape = {
  cfruSourcePath: z.string().min(1).optional(),
  base: levelInput,
  badges: z.tuple([levelInput, levelInput, levelInput, levelInput, levelInput, levelInput, levelInput]),
  originalOtObedienceCheck: z.boolean().optional(),
} as const;

export interface ProposeLevelCapTableResult {
  readonly ok: boolean;
  readonly configFilePath: string | null;
  readonly backupFilePath: string | null;
  readonly previousValues: {
    readonly base: number;
    readonly badges: ReadonlyArray<number>;
    readonly originalOtObedienceCheck: boolean;
  } | null;
  readonly newValues: {
    readonly base: number;
    readonly badges: ReadonlyArray<number>;
    readonly originalOtObedienceCheck: boolean;
  } | null;
  readonly diffPreview: string | null;
  readonly nextStep: string;
  readonly message: string;
}

/** Parse the obedience-block from a config.h source. Looks for the
 *  eight `#define BADGE_N_OBEDIENCE_LEVEL N` lines plus the optional
 *  `OBEDIENCE_CHECK_FOR_PLAYER_ORIGINAL_POKEMON` toggle. Returns null
 *  when any of the expected lines is missing - we refuse to operate
 *  on an unrecognised config layout.
 *
 *  Exported for tests. */
export function parseObedienceBlock(source: string): {
  readonly base: number;
  readonly badges: ReadonlyArray<number>;
  readonly originalOtObedienceCheck: boolean;
} | null {
  const base = matchDefine(source, 'BASE_OBEDIENCE_LEVEL');
  if (base === null) return null;
  const badges: number[] = [];
  for (let i = 1; i <= 7; i++) {
    const v = matchDefine(source, `BADGE_${String(i)}_OBEDIENCE_LEVEL`);
    if (v === null) return null;
    badges.push(v);
  }
  // The OBEDIENCE_CHECK toggle is *commented out* by default. Detect:
  //   - commented (//#define …) → false
  //   - uncommented (#define …)  → true
  //   - absent                    → false (be tolerant; the toggle is
  //     a CFRU-defined macro the source may not yet have)
  const commented = /^\s*\/\/\s*#\s*define\s+OBEDIENCE_CHECK_FOR_PLAYER_ORIGINAL_POKEMON\b/m.test(source);
  const uncommented = /^\s*#\s*define\s+OBEDIENCE_CHECK_FOR_PLAYER_ORIGINAL_POKEMON\b/m.test(source);
  const originalOtObedienceCheck = !commented && uncommented;
  return {
    base,
    badges: Object.freeze(badges),
    originalOtObedienceCheck,
  };
}

function matchDefine(source: string, name: string): number | null {
  // Match `#define NAME    VALUE` with optional whitespace between
  // segments. Comment-only or in-line comments after the value are
  // skipped by capturing the integer literal explicitly.
  const re = new RegExp(`^\\s*#\\s*define\\s+${name}\\b\\s+(-?\\d+)`, 'm');
  const m = re.exec(source);
  if (!m) return null;
  const n = parseInt(m[1]!, 10);
  return Number.isFinite(n) ? n : null;
}

/** Replace the obedience-block defines in-place. Preserves the
 *  surrounding text (comments, section header, other defines). Each
 *  define is rewritten via a regex substitution that targets the
 *  matching `#define NAME ...` line. */
export function rewriteObedienceBlock(
  source: string,
  newValues: {
    readonly base: number;
    readonly badges: ReadonlyArray<number>;
    readonly originalOtObedienceCheck: boolean;
  },
): string {
  let out = source;
  out = replaceDefine(out, 'BASE_OBEDIENCE_LEVEL', newValues.base);
  for (let i = 0; i < 7; i++) {
    out = replaceDefine(out, `BADGE_${String(i + 1)}_OBEDIENCE_LEVEL`, newValues.badges[i]!);
  }
  // OBEDIENCE_CHECK toggle: emit either commented or uncommented form.
  const togglePattern = /^\s*(\/\/\s*)?#\s*define\s+OBEDIENCE_CHECK_FOR_PLAYER_ORIGINAL_POKEMON\b[^\n]*/m;
  if (togglePattern.test(out)) {
    const replacement = newValues.originalOtObedienceCheck
      ? '#define OBEDIENCE_CHECK_FOR_PLAYER_ORIGINAL_POKEMON //Uncommenting line line will open up the possibility that the Player\'s Pokemon can disobey them (not just traded mons)'
      : '//#define OBEDIENCE_CHECK_FOR_PLAYER_ORIGINAL_POKEMON //Uncommenting line line will open up the possibility that the Player\'s Pokemon can disobey them (not just traded mons)';
    out = out.replace(togglePattern, replacement);
  }
  // (When the toggle is absent we don't synthesize one - CFRU may have
  //  removed the macro in a fork the user is on; we don't speculatively
  //  inject text that might break their build.)
  return out;
}

function replaceDefine(source: string, name: string, value: number): string {
  const re = new RegExp(`^(\\s*#\\s*define\\s+${name}\\b\\s+)-?\\d+([^\\n]*)`, 'm');
  return source.replace(re, (_match, prefix: string, suffix: string) => {
    return `${prefix}${String(value)}${suffix}`;
  });
}

/** Render a unified-diff-style preview of the change for the agent's
 *  reply. Shows the obedience block only (not the whole file). */
function buildDiffPreview(
  prev: {
    readonly base: number;
    readonly badges: ReadonlyArray<number>;
    readonly originalOtObedienceCheck: boolean;
  },
  next: {
    readonly base: number;
    readonly badges: ReadonlyArray<number>;
    readonly originalOtObedienceCheck: boolean;
  },
): string {
  const lines: string[] = [];
  lines.push('Before        After');
  lines.push(`Base    ${pad(prev.base, 3)}    →    ${pad(next.base, 3)}`);
  for (let i = 0; i < 7; i++) {
    lines.push(
      `Badge ${String(i + 1)} ${pad(prev.badges[i]!, 3)}    →    ${pad(next.badges[i]!, 3)}`,
    );
  }
  lines.push(`Apply to player's own mons: ${prev.originalOtObedienceCheck ? 'yes' : 'no '}  →  ${next.originalOtObedienceCheck ? 'yes' : 'no'}`);
  return lines.join('\n');
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, ' ');
}

export async function proposeLevelCapTable(
  _ctx: ToolContext,
  args: {
    cfruSourcePath?: string;
    base: number;
    badges: readonly [number, number, number, number, number, number, number];
    originalOtObedienceCheck?: boolean;
  },
): Promise<ProposeLevelCapTableResult> {
  const cfruPath = args.cfruSourcePath ?? DEFAULT_CFRU_SOURCE_PATH;
  const configPath = path.join(cfruPath, 'src', 'config.h');

  const badges = args.badges;
  const base = args.base;

  // ── 1. Monotonicity guard ──────────────────────────────────────
  if (base > badges[0]!) {
    return failure(
      configPath,
      `base (${String(base)}) is higher than badges[0] (${String(badges[0])}). Earning the first badge would LOWER your level cap - that's almost certainly a typo. Set base ≤ badges[0].`,
    );
  }
  for (let i = 1; i < badges.length; i++) {
    if (badges[i]! < badges[i - 1]!) {
      return failure(
        configPath,
        `badges[${String(i)}] (${String(badges[i])}) is lower than badges[${String(i - 1)}] (${String(badges[i - 1])}). The level cap must not decrease as the player earns badges.`,
      );
    }
  }

  // ── 2. Read config.h ───────────────────────────────────────────
  let original: string;
  try {
    original = await fsp.readFile(configPath, 'utf8');
  } catch (e) {
    return failure(
      configPath,
      `Could not read CFRU config.h at ${configPath} - ${e instanceof Error ? e.message : String(e)}. Pass cfruSourcePath if your CFRU clone is elsewhere.`,
    );
  }

  // ── 3. Parse the existing obedience block ──────────────────────
  const prev = parseObedienceBlock(original);
  if (prev === null) {
    return failure(
      configPath,
      `Recognised the file at ${configPath} as a config.h but couldn't find the BASE_OBEDIENCE_LEVEL + BADGE_N_OBEDIENCE_LEVEL block. Either CFRU has been forked into a different layout, or the file isn't the one the tool expects. Manual edit required.`,
    );
  }

  // ── 4. Build the new content ───────────────────────────────────
  const next = {
    base,
    badges: Object.freeze([...badges] as number[]),
    originalOtObedienceCheck: args.originalOtObedienceCheck ?? false,
  };
  const newContent = rewriteObedienceBlock(original, next);
  if (newContent === original) {
    return {
      ok: true,
      configFilePath: configPath,
      backupFilePath: null,
      previousValues: prev,
      newValues: next,
      diffPreview: buildDiffPreview(prev, next),
      nextStep:
        'No changes - the file already has those values. To pick them up in-game, ' +
        'run `node scripts/build-cfru-bundle.mjs --vanilla-rom <vanilla-rom-path>` then ' +
        're-modernize your project ROM.',
      message: `Level caps already set to the requested values in ${configPath}.`,
    };
  }

  // ── 5. Backup + atomic write ──────────────────────────────────
  const backupPath = `${configPath}.pre-level-caps.bak`;
  try {
    await fsp.writeFile(backupPath, original, 'utf8');
  } catch (e) {
    return failure(
      configPath,
      `Could not write backup at ${backupPath} - ${e instanceof Error ? e.message : String(e)}. Aborting to keep the source intact.`,
    );
  }
  const tmpPath = `${configPath}.tmp`;
  try {
    await fsp.writeFile(tmpPath, newContent, 'utf8');
    await fsp.rename(tmpPath, configPath);
  } catch (e) {
    return failure(
      configPath,
      `Could not write ${configPath} - ${e instanceof Error ? e.message : String(e)}. Backup is preserved at ${backupPath}.`,
    );
  }

  // ── 6. Done ────────────────────────────────────────────────────
  return {
    ok: true,
    configFilePath: configPath,
    backupFilePath: backupPath,
    previousValues: prev,
    newValues: next,
    diffPreview: buildDiffPreview(prev, next),
    nextStep:
      `1. Rebuild the CFRU bundle: \`node scripts/build-cfru-bundle.mjs --vanilla-rom <vanilla-rom-path>\`. ` +
      `2. Re-modernize a fresh vanilla ROM to pick up the new bundled patch (or restore the backup at ${backupPath} and re-run the bundle script if you change your mind).`,
    message:
      `Level caps written to ${configPath}. ` +
      `Base ${String(prev.base)}→${String(next.base)}; ` +
      `Badges (${prev.badges.join(',')})→(${next.badges.join(',')}); ` +
      `Player-own check ${prev.originalOtObedienceCheck ? 'on' : 'off'}→${next.originalOtObedienceCheck ? 'on' : 'off'}. ` +
      `Rerun build-cfru-bundle.mjs to bake the new caps.`,
  };
}

function failure(configFilePath: string, message: string): ProposeLevelCapTableResult {
  return {
    ok: false,
    configFilePath,
    backupFilePath: null,
    previousValues: null,
    newValues: null,
    diffPreview: null,
    nextStep: '',
    message,
  };
}
