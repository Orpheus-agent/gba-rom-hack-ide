/**
 * Phase 4.1B - Scene-boot orchestrator.
 *
 * Given a SceneBootRecipe, drive the running emulator to a state
 * where:
 *
 *   1. The game is at the in-game overworld (SaveBlock pointers
 *      have been initialized - see savedataResolver.getSaveBlockBase).
 *   2. Every flag in `initialFlags` is SET.
 *   3. Every (varId, value) pair in `initialVars` has been written.
 *
 * The orchestrator works with the existing EmulatorMemory bridge
 * (savestate-patch under the hood). It does NOT:
 *
 *   - Warp the player to a specific map. The SaveBlock1 layout for
 *     CFRU's expanded player struct isn't reverse-engineered yet
 *     (the existing savedataLayout.ts only covers firered-vanilla
 *     and emerald-vanilla). The recipe's `startingMapId` is recorded
 *     for documentation + future expansion; today the orchestrator
 *     just surfaces guidance ("warp to <map> via the F9 debug menu
 *     before applying").
 *   - Trigger a script. Same reason - the engine's
 *     gPendingScriptOffset slot lives at a different EWRAM offset
 *     in CFRU than in vanilla. Recorded but not applied yet.
 *
 * What it DOES do is the load-bearing piece for the user's story
 * cadence: pre-seeding flags + vars so a scene branches correctly
 * the moment the user re-enters it.
 */

import type {
  SceneBootRecipe,
  SceneBootVarSeed,
} from '@rom-editor/shared';
import { EmulatorMemory, type EmulatorMemoryHost } from './emulatorMemory';
import { setFlag, setVar } from './savedataResolver';
import type { SupportedFamily } from './savedataLayout';

/** Outcome of a scene-boot application. */
export interface SceneBootApplyResult {
  /** Whether every flag in the recipe was written. */
  readonly flagsSet: number;
  /** Whether every var in the recipe was written. */
  readonly varsSet: number;
  /** Notes the orchestrator surfaces to the user - e.g. "the recipe
   *  records a startingMapId but warp isn't applied yet; warp manually
   *  via F9 if needed." */
  readonly guidance: ReadonlyArray<string>;
  /** Non-fatal errors encountered while applying individual flags/vars.
   *  The orchestrator continues past these. */
  readonly warnings: ReadonlyArray<string>;
}

/** Configuration for applying a recipe. */
export interface ApplySceneBootOptions {
  readonly recipe: SceneBootRecipe;
  readonly host: EmulatorMemoryHost & {
    readonly pauseGame?: () => void;
    readonly resumeGame?: () => void;
  };
  /** Which save-data family layout to use. Falls back to
   *  'firered-vanilla' for any unrecognized family (CFRU and
   *  derivatives use the same SaveBlock pointers as vanilla FRLG,
   *  so this works for the common case). */
  readonly family: SupportedFamily | string;
  /** Optional logger for the orchestrator's progress trace. Useful
   *  for surfacing "applied flag 0x820" lines in a status panel. */
  readonly onStep?: (message: string) => void;
}

/** Drive the running emulator to the recipe's pre-seeded state.
 *  Resolves to a structured result describing what was applied. */
export async function applySceneBoot(opts: ApplySceneBootOptions): Promise<SceneBootApplyResult> {
  const family: SupportedFamily =
    opts.family === 'firered-vanilla' || opts.family === 'emerald-vanilla'
      ? opts.family
      : 'firered-vanilla';
  const mem = new EmulatorMemory(opts.host);
  const warnings: string[] = [];
  const guidance: string[] = [];

  // Pause emulation while we patch - the savestate-patch path already
  // pauses internally per write, but a single outer pause keeps the
  // game from advancing frames between writes.
  if (typeof opts.host.pauseGame === 'function') opts.host.pauseGame();
  try {
    let flagsSet = 0;
    for (const flagId of opts.recipe.initialFlags) {
      try {
        await setFlag(mem, family, flagId, true);
        flagsSet += 1;
        opts.onStep?.(`set FLAG 0x${flagId.toString(16)}`);
      } catch (e) {
        warnings.push(
          `Couldn't set flag 0x${flagId.toString(16)}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    let varsSet = 0;
    for (const seed of opts.recipe.initialVars) {
      try {
        await setVar(mem, family, seed.varId, seed.value);
        varsSet += 1;
        opts.onStep?.(
          `set VAR 0x${seed.varId.toString(16)} = ${String(seed.value)}`,
        );
      } catch (e) {
        warnings.push(
          `Couldn't set var 0x${seed.varId.toString(16)}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    if (opts.recipe.startingPosition !== null) {
      guidance.push(
        `Recipe records starting position (${String(opts.recipe.startingPosition.x)}, ${String(opts.recipe.startingPosition.y)}) facing ${opts.recipe.startingPosition.facing} on map ${opts.recipe.startingMapId}. The orchestrator does not yet warp the player. Use the F9 debug menu or in-game Fly to move first.`,
      );
    } else {
      guidance.push(
        `Recipe targets map ${opts.recipe.startingMapId}. The orchestrator does not yet warp the player. Use the F9 debug menu or in-game Fly to move first.`,
      );
    }
    if (opts.recipe.triggerScriptId !== null) {
      guidance.push(
        `Recipe wants to trigger script ${opts.recipe.triggerScriptId} on boot. Script-trigger-on-boot isn't wired yet; interact with the relevant NPC after the warp instead.`,
      );
    }

    return { flagsSet, varsSet, guidance, warnings };
  } finally {
    if (typeof opts.host.resumeGame === 'function') opts.host.resumeGame();
  }
}

/** Helper exposed for tests: render a one-line summary of an applied recipe. */
export function summarizeSceneBootResult(
  recipe: SceneBootRecipe,
  result: SceneBootApplyResult,
): string {
  const parts: string[] = [];
  parts.push(`Applied "${recipe.name}"`);
  if (result.flagsSet > 0) {
    parts.push(`${String(result.flagsSet)}/${String(recipe.initialFlags.length)} flags set`);
  }
  if (result.varsSet > 0) {
    parts.push(`${String(result.varsSet)}/${String(recipe.initialVars.length)} vars set`);
  }
  if (result.warnings.length > 0) {
    parts.push(`${String(result.warnings.length)} warnings`);
  }
  return parts.join(' · ');
}

/** Helper: produce a stable string key for a var seed (used in
 *  picker UIs to dedupe list entries). */
export function varSeedKey(seed: SceneBootVarSeed): string {
  return `${seed.varId.toString(16)}=${String(seed.value)}`;
}
