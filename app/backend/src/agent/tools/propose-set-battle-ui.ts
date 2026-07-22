/**
 * propose_set_battle_ui - Phase 3.35.
 *
 * Wraps propose_import_tileset (or propose_import_overworld_sprite,
 * for sprite-sheet UI elements) with battle-UI-specific defaults.
 * Same plan-then-execute pattern as propose_set_title_screen.
 */

import { z } from 'zod';
import type { ToolContext } from '../types.js';

export const PROPOSE_SET_BATTLE_UI_TOOL_NAME = 'propose_set_battle_ui';

export const PROPOSE_SET_BATTLE_UI_DESCRIPTION =
  'Plan a battle-UI element replacement (HP bar / status icons / menu\n' +
  'frame). Wraps propose_import_tileset with sensible defaults.\n\n' +
  'Inputs:\n' +
  '  - `component`: \'hp_bar\' | \'status_icon\' | \'menu_frame\'.\n' +
  '  - `pngPath`: path under .editor/assets/.\n\n' +
  'Returns a plan; the agent runs the import + then a follow-up\n' +
  'propose_patch to repoint the engine\'s battle-UI sprite pointer.';

export const proposeSetBattleUiInputShape = {
  component: z.enum(['hp_bar', 'status_icon', 'menu_frame']),
  pngPath: z.string().min(1),
} as const;

export interface ProposeSetBattleUiResult {
  readonly ok: boolean;
  readonly plan: ReadonlyArray<{ tool: string; args: Record<string, unknown>; purpose: string }>;
  readonly message: string;
}

export async function proposeSetBattleUi(
  _ctx: ToolContext,
  args: { component: 'hp_bar' | 'status_icon' | 'menu_frame'; pngPath: string },
): Promise<ProposeSetBattleUiResult> {
  const plan = [
    {
      tool: 'propose_import_tileset',
      args: {
        mode: 'png',
        pngPath: args.pngPath,
        compress: true,
        isSecondary: false,
      },
      purpose: `import battle UI ${args.component}`,
    },
    {
      tool: 'propose_patch',
      args: {
        description: `Wire battle UI ${args.component} pointers`,
        edits: [],
      },
      purpose: 'agent fills in pointerOffset + new target after import',
    },
  ];
  return {
    ok: true,
    plan: Object.freeze(plan as ReadonlyArray<{ tool: string; args: Record<string, unknown>; purpose: string }>),
    message: `Planned battle UI ${args.component} swap. Execute step 1 (import_tileset), then use the returned offsets to fill in the pointer rewrite.`,
  };
}
