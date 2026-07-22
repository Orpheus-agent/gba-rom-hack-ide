/**
 * propose_test_scene - Phase 3.25.
 *
 * Read-only wrapper around the engine script step simulator
 * (Phase 3.5). Loads a script's decoded steps from the manifest,
 * runs them through `simulateScript` with the given initial state,
 * and surfaces assertions: which flags got set, which dialogues
 * showed, which battles started, etc.
 *
 * Used by the agent to verify a scene's logic without booting an
 * emulator. The simulator handles branch_on_var, set_variable,
 * dialogue, give_item, start_battle, warp_player; unknown opcodes
 * are logged but don't halt by default.
 */

import { z } from 'zod';
import type { ProjectManifest } from '@rom-editor/shared';
import { scripts as scriptsApi } from '@rom-introspection/engine';
import { readManifest } from '../../scan/manifest-io.js';
import type { ToolContext } from '../types.js';

export const PROPOSE_TEST_SCENE_TOOL_NAME = 'propose_test_scene';

export const PROPOSE_TEST_SCENE_DESCRIPTION =
  'Simulate a scripted scene without booting the emulator. The tool\n' +
  'walks the script\'s decoded steps via the engine step simulator and\n' +
  'returns a trace of state changes.\n\n' +
  'Inputs:\n' +
  '  - `scriptId`: the script entrypoint id (e.g. `script_0x1a3c5f`).\n' +
  '  - `initialFlags`: optional list of flag ids that start "on" in\n' +
  '    the simulated state.\n' +
  '  - `initialVars`: optional list of [varId, value] tuples.\n' +
  '  - `maxSteps`: optional cap (default = 2 × decoded step count).\n' +
  '  - `assertions`: optional checks - { flagsThatMustBeSet: [...],\n' +
  '    flagsThatMustNotBeSet: [...], dialogueMustInclude: [...],\n' +
  '    varsAfter: { [varId]: expectedValue } }.\n\n' +
  'Returns a structured trace + pass/fail per assertion. Read-only;\n' +
  'no ROM writes.';

const u16 = z.number().int().min(0).max(0xffff);

export const proposeTestSceneInputShape = {
  scriptId: z.string().min(1),
  initialFlags: z.array(u16).optional(),
  initialVars: z.array(z.tuple([u16, u16])).optional(),
  maxSteps: z.number().int().min(1).max(10000).optional(),
  assertions: z
    .object({
      flagsThatMustBeSet: z.array(u16).optional(),
      flagsThatMustNotBeSet: z.array(u16).optional(),
      dialogueMustInclude: z.array(z.string().min(1)).optional(),
      varsAfter: z.record(z.string(), u16).optional(),
    })
    .optional(),
} as const;

export interface AssertionResult {
  readonly description: string;
  readonly passed: boolean;
  readonly detail: string;
}

export interface ProposeTestSceneResult {
  readonly ok: boolean;
  readonly stepsSimulated: number;
  readonly stoppedReason: string;
  readonly flagsSet: ReadonlyArray<number>;
  readonly varsAfter: ReadonlyArray<readonly [number, number]>;
  readonly dialoguesShown: ReadonlyArray<string>;
  readonly battlesStarted: ReadonlyArray<number>;
  readonly assertionResults: ReadonlyArray<AssertionResult>;
  readonly allAssertionsPassed: boolean;
  readonly message: string;
}

function emptyResult(message: string): ProposeTestSceneResult {
  return {
    ok: false,
    stepsSimulated: 0,
    stoppedReason: 'invalid_offset',
    flagsSet: [],
    varsAfter: [],
    dialoguesShown: [],
    battlesStarted: [],
    assertionResults: [],
    allAssertionsPassed: false,
    message,
  };
}

/** Find a script's decoded steps in the manifest by walking
 *  manifest.scriptSteps for entries with id `<scriptId>__<index>`. */
function loadStepsFromManifest(
  manifest: ProjectManifest,
  scriptId: string,
): ReadonlyArray<scriptsApi.DecodedScriptStep> | null {
  const prefix = `${scriptId}__`;
  const matches = manifest.scriptSteps.filter((s) => s.id.startsWith(prefix));
  if (matches.length === 0) return null;
  // Sort by trailing index.
  matches.sort((a, b) => {
    const ai = parseInt(a.id.slice(prefix.length), 10);
    const bi = parseInt(b.id.slice(prefix.length), 10);
    return ai - bi;
  });
  return matches.map((m, i) => ({
    index: i,
    fileOffset: typeof m.params['fileOffset'] === 'number' ? (m.params['fileOffset'] as number) : 0,
    kind: m.kind,
    label: typeof m.params['label'] === 'string' ? (m.params['label'] as string) : '',
    params: m.params,
  }));
}

export async function proposeTestScene(
  ctx: ToolContext,
  args: {
    scriptId: string;
    initialFlags?: number[];
    initialVars?: Array<readonly [number, number]>;
    maxSteps?: number;
    assertions?: {
      flagsThatMustBeSet?: number[];
      flagsThatMustNotBeSet?: number[];
      dialogueMustInclude?: string[];
      varsAfter?: Record<string, number>;
    };
  },
): Promise<ProposeTestSceneResult> {
  const manifest = await readManifest(ctx.projectRoot);
  if (!manifest) return emptyResult('No manifest.');
  const steps = loadStepsFromManifest(manifest, args.scriptId);
  if (!steps) return emptyResult(`No decoded steps found for ${args.scriptId}. Use list_entities or read_decoded_script first.`);

  const result = scriptsApi.simulateScript(steps, {
    initial: {
      flags: args.initialFlags,
      vars: args.initialVars,
    },
    maxSteps: args.maxSteps,
  });

  const assertionResults: AssertionResult[] = [];
  if (args.assertions) {
    for (const fid of args.assertions.flagsThatMustBeSet ?? []) {
      const passed = result.state.flags.has(fid);
      assertionResults.push({
        description: `flag 0x${fid.toString(16)} must be set`,
        passed,
        detail: passed ? 'set' : 'not set',
      });
    }
    for (const fid of args.assertions.flagsThatMustNotBeSet ?? []) {
      const passed = !result.state.flags.has(fid);
      assertionResults.push({
        description: `flag 0x${fid.toString(16)} must NOT be set`,
        passed,
        detail: passed ? 'not set' : 'set',
      });
    }
    for (const needle of args.assertions.dialogueMustInclude ?? []) {
      const passed = result.state.dialoguesShown.some((d) => d.includes(needle));
      assertionResults.push({
        description: `dialogue must include "${needle.slice(0, 40)}"`,
        passed,
        detail: passed ? 'found' : 'not found',
      });
    }
    if (args.assertions.varsAfter) {
      for (const [vKey, expected] of Object.entries(args.assertions.varsAfter)) {
        const varId = vKey.startsWith('0x') ? parseInt(vKey.slice(2), 16) : parseInt(vKey, 10);
        const actual = result.state.vars.get(varId) ?? 0;
        const passed = actual === expected;
        assertionResults.push({
          description: `var 0x${varId.toString(16)} == ${String(expected)}`,
          passed,
          detail: `actual ${String(actual)}`,
        });
      }
    }
  }
  const allAssertionsPassed = assertionResults.every((a) => a.passed);

  return {
    ok: true,
    stepsSimulated: result.state.stepsVisited.length,
    stoppedReason: result.stoppedReason,
    flagsSet: Object.freeze([...result.state.flags]),
    varsAfter: Object.freeze([...result.state.vars.entries()] as Array<readonly [number, number]>),
    dialoguesShown: Object.freeze([...result.state.dialoguesShown]),
    battlesStarted: Object.freeze([...result.state.battlesStarted]),
    assertionResults: Object.freeze(assertionResults),
    allAssertionsPassed,
    message:
      `Simulated ${String(result.state.stepsVisited.length)} steps; stopped: ${result.stoppedReason}. ` +
      `${String(result.state.flags.size)} flags set, ${String(result.state.dialoguesShown.length)} dialogues shown, ` +
      `${String(result.state.battlesStarted.length)} battles. ` +
      (assertionResults.length > 0
        ? `${String(assertionResults.filter((a) => a.passed).length)}/${String(assertionResults.length)} assertions passed.`
        : 'No assertions checked.'),
  };
}
