/**
 * propose_seed_save_state - Phase 4.1E.
 *
 * Lets the agent persist a scene-boot recipe so the user can apply
 * it from the Live preview's SceneBootPicker. The agent uses this to
 * say, in chat: "I made you a 'Cosmog handoff' boot recipe - click
 * the deep link to load it." The user clicks the surfaced
 * `editor://scene-boot/<id>` link → SceneBootPicker pre-applies the
 * recipe.
 *
 * Validation rules:
 *   - Every flag in initialFlags must be in the manifest's flag list
 *     (we reject "I think this flag id exists" guesses).
 *   - Every var in initialVars must be in the manifest's var list.
 *   - startingMapId must resolve to a manifest.maps entry.
 *   - triggerScriptId, when present, must resolve to a manifest
 *     script entry.
 *
 * Side effects: writes a row to <projectRoot>/.editor/scene-boots/index.json
 * via the Phase 4.1B store (createSceneBoot). No ROM modifications.
 */

import { z } from 'zod';
import { readManifest } from '../../scan/manifest-io.js';
import { createSceneBoot, SceneBootError } from '../../scene-boot/store.js';
import type { ToolContext } from '../types.js';

export const PROPOSE_SEED_SAVE_STATE_TOOL_NAME = 'propose_seed_save_state';

export const PROPOSE_SEED_SAVE_STATE_DESCRIPTION =
  'Persist a scene-boot recipe (warp + flag/var seed + optional script\n' +
  'trigger) so the user can apply it from the in-editor live preview.\n' +
  'Returns a deep-link the agent can surface in chat.\n\n' +
  'Inputs:\n' +
  '  - `name`: display name (1-80 chars).\n' +
  '  - `startingMapId`: manifest map id where the player should appear.\n' +
  '  - `initialFlags`: optional list of flag ids to SET on boot.\n' +
  '  - `initialVars`: optional list of (varId, value) pairs to write.\n' +
  '  - `triggerScriptId`: optional script id to fire after the warp.\n' +
  '  - `notes`: optional free-form note explaining the recipe.\n\n' +
  'Every flag/var/script referenced must exist in the current manifest;\n' +
  'unknown ids are rejected with `unknown_flag` / `unknown_var` /\n' +
  '`unknown_map` / `unknown_script` errors.';

const u16 = z.number().int().min(0).max(0xffff);

export const proposeSeedSaveStateInputShape = {
  name: z.string().min(1).max(80),
  startingMapId: z.string().min(1),
  startingPosition: z
    .object({
      x: z.number().int().min(0).max(255),
      y: z.number().int().min(0).max(255),
      facing: z.enum(['down', 'up', 'left', 'right']),
    })
    .optional(),
  initialFlags: z.array(u16).max(256).optional(),
  initialVars: z
    .array(z.object({ varId: u16, value: u16 }))
    .max(256)
    .optional(),
  triggerScriptId: z.string().optional(),
  notes: z.string().max(500).optional(),
  skipIntro: z.boolean().optional(),
} as const;

export interface ProposeSeedSaveStateResult {
  readonly ok: boolean;
  readonly recipeId: string | null;
  readonly deepLink: string | null;
  /** Issues found during validation. Each is a human-readable line. */
  readonly issues: ReadonlyArray<string>;
  readonly message: string;
}

function fail(message: string, issues: string[] = []): ProposeSeedSaveStateResult {
  return { ok: false, recipeId: null, deepLink: null, issues, message };
}

/** Try to parse the `engineValue` field of a Flag or Variable manifest
 *  entry into a u16 number. Returns null when the field is an
 *  unresolved macro ("(TRAINER_FLAGS_START + 0x4)") or otherwise
 *  non-numeric. */
function parseEngineHexU16(value: string | null | undefined): number | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  // Strip surrounding parens for "(0x820)" style entries.
  const inner = trimmed.startsWith('(') && trimmed.endsWith(')')
    ? trimmed.slice(1, -1).trim()
    : trimmed;
  let n: number;
  if (inner.startsWith('0x') || inner.startsWith('0X')) {
    n = Number.parseInt(inner.slice(2), 16);
  } else if (/^[0-9]+$/.test(inner)) {
    n = Number.parseInt(inner, 10);
  } else {
    return null;
  }
  if (!Number.isFinite(n) || n < 0 || n > 0xffff) return null;
  return n;
}

export async function proposeSeedSaveState(
  ctx: ToolContext,
  args: {
    name: string;
    startingMapId: string;
    startingPosition?: { x: number; y: number; facing: 'down' | 'up' | 'left' | 'right' };
    initialFlags?: number[];
    initialVars?: { varId: number; value: number }[];
    triggerScriptId?: string;
    notes?: string;
    skipIntro?: boolean;
  },
): Promise<ProposeSeedSaveStateResult> {
  const manifest = await readManifest(ctx.projectRoot);
  if (!manifest) {
    return fail('No manifest. Run scan first.');
  }

  const issues: string[] = [];

  // Validate map id.
  if (!manifest.maps.find((m) => m.id === args.startingMapId)) {
    issues.push(`unknown_map: "${args.startingMapId}" is not in manifest.maps.`);
  }

  // Validate flag ids - manifest.flags has the canonical list. Each
  // Flag entity stores its numeric id as engineValue, a string like
  // "0x820". Some entries are unresolved macros ("(TRAINER_FLAGS_START
  // + 0x4)") that we can't parse to a number; those don't contribute
  // to the valid-id set, which is fine - the agent must surface them
  // by their resolved hex.
  const validFlagIds = new Set<number>();
  for (const f of manifest.flags ?? []) {
    const parsed = parseEngineHexU16(f.engineValue);
    if (parsed !== null) validFlagIds.add(parsed);
  }
  if (args.initialFlags) {
    for (const id of args.initialFlags) {
      if (!validFlagIds.has(id)) {
        issues.push(`unknown_flag: 0x${id.toString(16)} is not in manifest.flags.`);
      }
    }
  }

  // Validate var ids.
  const validVarIds = new Set<number>();
  for (const v of manifest.variables ?? []) {
    const parsed = parseEngineHexU16(v.engineValue);
    if (parsed !== null) validVarIds.add(parsed);
  }
  if (args.initialVars) {
    for (const seed of args.initialVars) {
      if (!validVarIds.has(seed.varId)) {
        issues.push(`unknown_var: 0x${seed.varId.toString(16)} is not in manifest.variables.`);
      }
    }
  }

  // Validate script id when present. Manifests record decoded scripts
  // under manifest.scriptSteps with ids like `<scriptId>__<index>`; the
  // "owning" id is the prefix.
  if (args.triggerScriptId) {
    const prefix = `${args.triggerScriptId}__`;
    const found = manifest.scriptSteps?.some((s) => s.id.startsWith(prefix));
    if (!found) {
      issues.push(`unknown_script: "${args.triggerScriptId}" is not in manifest.scriptSteps.`);
    }
  }

  if (issues.length > 0) {
    return fail(
      `Recipe rejected - ${String(issues.length)} validation issue(s). Fix the listed ids + retry.`,
      issues,
    );
  }

  // Persist via the Phase 4.1B store.
  try {
    const recipe = await createSceneBoot({
      projectRoot: ctx.projectRoot,
      name: args.name,
      notes: args.notes ?? null,
      startingMapId: args.startingMapId,
      ...(args.startingPosition !== undefined
        ? { startingPosition: args.startingPosition }
        : {}),
      ...(args.initialFlags !== undefined ? { initialFlags: args.initialFlags } : {}),
      ...(args.initialVars !== undefined ? { initialVars: args.initialVars } : {}),
      ...(args.triggerScriptId !== undefined
        ? { triggerScriptId: args.triggerScriptId }
        : {}),
      ...(args.skipIntro !== undefined ? { skipIntro: args.skipIntro } : {}),
    });
    const deepLink = `editor://scene-boot/${recipe.id}`;
    return {
      ok: true,
      recipeId: recipe.id,
      deepLink,
      issues: [],
      message:
        `Saved recipe "${recipe.name}" (id ${recipe.id}). ` +
        `Apply it from the Live preview's "Scenes" popover, or click ${deepLink} in chat.`,
    };
  } catch (e) {
    if (e instanceof SceneBootError) {
      return fail(`Store rejected: ${e.code} - ${e.message}`);
    }
    throw e;
  }
}
