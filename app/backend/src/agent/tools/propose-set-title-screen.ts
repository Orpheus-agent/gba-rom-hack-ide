/**
 * propose_set_title_screen - Phase 3.33.
 *
 * Composes propose_import_tileset with a PNG that represents the
 * title-screen logo/background. The tool itself doesn't introduce
 * new engine surface; it returns a structured plan that wraps the
 * existing tileset-import tool with title-screen-specific defaults.
 *
 * The user wires the resulting tileset offsets into the title-screen
 * graphics pointers (varies by family; pret/pokefirered exposes
 * them as `sFRLGBackground`/`sFRLGTitleLogo` constants). The plan
 * surfaces the pointer slots the agent should rewrite via
 * propose_patch.
 */

import { z } from 'zod';
import type { ToolContext } from '../types.js';

export const PROPOSE_SET_TITLE_SCREEN_TOOL_NAME = 'propose_set_title_screen';

export const PROPOSE_SET_TITLE_SCREEN_DESCRIPTION =
  'Plan a title-screen graphic replacement. Wraps propose_import_tileset\n' +
  'with title-screen-specific defaults (compressed; secondary=false).\n\n' +
  'Inputs:\n' +
  '  - `pngPath`: path under .editor/assets/ - must be 240×160 or a\n' +
  '    smaller logo image (multiple of 8 in each dim).\n' +
  '  - `target`: \'logo\' | \'background\' - which title-screen layer\n' +
  '    this image targets.\n\n' +
  'Returns a plan describing the propose_import_tileset call to make,\n' +
  'plus a follow-up propose_patch suggestion for wiring the resulting\n' +
  'tileset offsets into the title-screen pointer slots.';

export const proposeSetTitleScreenInputShape = {
  pngPath: z.string().min(1),
  target: z.enum(['logo', 'background']),
} as const;

export interface ProposeSetTitleScreenResult {
  readonly ok: boolean;
  readonly plan: ReadonlyArray<{ tool: string; args: Record<string, unknown>; purpose: string }>;
  readonly message: string;
}

export async function proposeSetTitleScreen(
  _ctx: ToolContext,
  args: { pngPath: string; target: 'logo' | 'background' },
): Promise<ProposeSetTitleScreenResult> {
  const plan = [
    {
      tool: 'propose_import_tileset',
      args: {
        mode: 'png',
        pngPath: args.pngPath,
        compress: true,
        isSecondary: false,
      },
      purpose: `import title-screen ${args.target} tileset`,
    },
    {
      tool: 'propose_patch',
      args: {
        description: `Wire title-screen ${args.target} pointers`,
        edits: [
          {
            kind: 'binary_rewrite_pointer',
            note: `Repoint the title-screen ${args.target} pointer to the new tileset (offsets from the previous step). Find the pointer offset in CFRU/pret docs; typical FRLG slots live near offset 0x040EE4 (logo) and 0x040E50 (background).`,
          },
        ],
      },
      purpose: 'agent fills in pointerOffset + new target via binary_rewrite_pointer',
    },
  ];
  return {
    ok: true,
    plan: Object.freeze(plan as ReadonlyArray<{ tool: string; args: Record<string, unknown>; purpose: string }>),
    message: `Planned title-screen ${args.target} swap. Execute step 1 (import_tileset), then use the returned tilesOffset/paletteOffset to fill in the pointer rewrite in step 2.`,
  };
}
