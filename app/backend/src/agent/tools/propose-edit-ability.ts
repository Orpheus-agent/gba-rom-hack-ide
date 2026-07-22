/**
 * propose_edit_ability - Phase 3.31.
 *
 * Direct-apply CFRU source edit (mirrors propose_level_cap_table from
 * 2D and propose_form_change_rule from 2E). Generates a paste-ready
 * C snippet for an ability effect, persists the rule to
 * .editor/ability-effects.json, and instructs the user to rebuild
 * the CFRU bundle.
 *
 * CFRU's ability effects live in `src/Battle_AI/AI_Master.c` +
 * `src/ability_battle_effects.c`. The exact dispatcher varies; this
 * tool produces a snippet for the agent + user to paste into the
 * appropriate handler.
 */

import { z } from 'zod';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { ToolContext } from '../types.js';

export const PROPOSE_EDIT_ABILITY_TOOL_NAME = 'propose_edit_ability';

export const PROPOSE_EDIT_ABILITY_DESCRIPTION =
  'Plan a new or modified ability effect. The tool generates a paste-\n' +
  'ready C snippet for CFRU source + persists the rule to\n' +
  '.editor/ability-effects.json. Direct-apply pattern (no ROM byte\n' +
  'writes).\n\n' +
  'Inputs:\n' +
  '  - `abilityId`: u16 - the ABILITY_* index.\n' +
  '  - `abilityName`: display name (≤30 chars).\n' +
  '  - `description`: in-game description (≤80 chars Gen-3 charset).\n' +
  '  - `effectSnippet`: C code implementing the ability effect (free-\n' +
  '    form; pasted verbatim into CFRU\'s ability handler).\n' +
  '  - `notes`: optional design notes for the rules file.\n\n' +
  'Next steps after this tool returns:\n' +
  '  1. Paste effectSnippet into the appropriate CFRU handler\n' +
  '     (typically src/ability_battle_effects.c or src/abilities.c).\n' +
  '  2. Add the ability name + description to gAbilityNames /\n' +
  '     gAbilityDescriptions.\n' +
  '  3. Re-run scripts/build-cfru-bundle.mjs.\n' +
  '  4. Re-modernize the project ROM.';

const u16 = z.number().int().min(0).max(0xffff);

export const proposeEditAbilityInputShape = {
  abilityId: u16,
  abilityName: z.string().min(1).max(30),
  description: z.string().min(1).max(80),
  effectSnippet: z.string().min(1).max(4000),
  notes: z.string().max(500).optional(),
} as const;

export interface ProposeEditAbilityResult {
  readonly ok: boolean;
  readonly abilityId: number;
  readonly persistedPath: string | null;
  readonly cSnippet: string;
  readonly nextStep: string;
  readonly message: string;
}

interface StoredAbility {
  readonly id: string;
  readonly abilityId: number;
  readonly abilityName: string;
  readonly description: string;
  readonly effectSnippet: string;
  readonly notes: string | null;
}

interface StoredAbilityFile {
  readonly schemaVersion: 1;
  readonly abilities: StoredAbility[];
}

export async function proposeEditAbility(
  ctx: ToolContext,
  args: {
    abilityId: number;
    abilityName: string;
    description: string;
    effectSnippet: string;
    notes?: string;
  },
): Promise<ProposeEditAbilityResult> {
  // Persist.
  const filePath = path.join(ctx.projectRoot, '.editor', 'ability-effects.json');
  let stored: StoredAbility[] = [];
  try {
    const raw = await fsp.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as StoredAbilityFile;
    if (parsed.schemaVersion === 1 && Array.isArray(parsed.abilities)) {
      stored = parsed.abilities;
    }
  } catch {
    /* fresh file */
  }
  const id = `ability_${String(args.abilityId)}`;
  const entry: StoredAbility = {
    id,
    abilityId: args.abilityId,
    abilityName: args.abilityName,
    description: args.description,
    effectSnippet: args.effectSnippet,
    notes: args.notes ?? null,
  };
  const existing = stored.findIndex((a) => a.id === id);
  if (existing >= 0) stored.splice(existing, 1, entry);
  else stored.push(entry);
  let persistedPath: string | null = null;
  try {
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(
      filePath,
      JSON.stringify({ schemaVersion: 1, abilities: stored }, null, 2),
      'utf8',
    );
    persistedPath = filePath;
  } catch {
    /* best-effort */
  }

  // Build the paste-ready snippet.
  const cSnippet =
    `// Phase 3.31 ability rule: ${args.abilityName} (id ${String(args.abilityId)})\n` +
    `// Description: ${args.description}\n` +
    `// Paste this case into the appropriate ability handler in\n` +
    `// CFRU's src/ability_battle_effects.c or src/abilities.c.\n` +
    `case ABILITY_${args.abilityName.toUpperCase().replace(/\s+/g, '_')}:\n` +
    `${args.effectSnippet.split('\n').map((l) => `    ${l}`).join('\n')}\n` +
    `    break;\n`;

  const nextStep =
    `1. Paste the C snippet into CFRU source (handler dispatch in src/ability_battle_effects.c). ` +
    `2. Add ABILITY_${args.abilityName.toUpperCase().replace(/\s+/g, '_')} to include/constants/abilities.h. ` +
    `3. Add the display name to gAbilityNames + description to gAbilityDescriptions. ` +
    `4. Run \`node scripts/build-cfru-bundle.mjs --vanilla-rom <vanilla-rom-path>\`. ` +
    `5. Re-modernize a fresh ROM.`;

  return {
    ok: true,
    abilityId: args.abilityId,
    persistedPath,
    cSnippet,
    nextStep,
    message: `Registered ability rule ${args.abilityName} (id ${String(args.abilityId)}). ${String(stored.length)} ability rule(s) on file.`,
  };
}
