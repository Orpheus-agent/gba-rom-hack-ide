/**
 * propose_add_species - Phase 3.43.
 *
 * Orchestrator for adding a brand-new Pokémon species. Composes:
 *
 *   - propose_species_edit (existing) - base stats + types + abilities
 *     + egg group + catch rate + EVs + held items.
 *   - propose_pokedex_entry (Phase 3.42) - category name + height/
 *     weight + flavor text + sprite display params.
 *   - propose_import_pokemon_sprite (Phase 3.17) - front + back +
 *     shiny sprite + palette.
 *   - propose_edit_evolution (Phase 3.28) - evolution chain.
 *   - propose_set_cry (Phase 3.38, deferred) - when implemented.
 *
 * Like propose_author_scene, this tool returns a PLAN - a structured
 * list of tool invocations - rather than executing them directly.
 * The agent makes the sub-calls (each going through the per-proposal
 * review flow); then calls propose_batch_apply for transactional
 * all-or-nothing landing.
 *
 * This tool is HEAVIEST when DPE is installed (the user can place
 * brand-new species past CFRU's caps). On CFRU-only ROMs, it still
 * works for editing existing species' full data set.
 */

import { z } from 'zod';
import type { ToolContext } from '../types.js';

export const PROPOSE_ADD_SPECIES_TOOL_NAME = 'propose_add_species';

export const PROPOSE_ADD_SPECIES_DESCRIPTION =
  'Plan a full species addition: base stats + pokedex entry + sprite\n' +
  '+ evolutions. Returns a structured plan of tool invocations the\n' +
  'agent then executes + batch-applies.\n\n' +
  'Inputs:\n' +
  '  - `speciesId`: u16 - the slot to fill. On CFRU, max is 0x50D.\n' +
  '    On CFRU+DPE, range extends through Gen 9.\n' +
  '  - `name`: species name (10 chars max in the gSpeciesNames slot).\n' +
  '  - `baseStats`: HP/Atk/Def/SpA/SpD/Spe (each 1..255).\n' +
  '  - `types`: [type1, type2] - duplicate when single-typed.\n' +
  '  - `abilities`: [ability1, ability2] - 0 in slot 2 if single-ability.\n' +
  '  - `pokedex`: { categoryName, height, weight, description }.\n' +
  '  - `sprite`: { frontPngPath, backPngPath?, shinyPngPath? }.\n' +
  '  - `evolutions`: optional array of evolution entries.\n' +
  '  - `eggGroups`: [eggGroup1, eggGroup2].\n' +
  '  - `catchRate`: u8.\n' +
  '  - `growthRate`: u8 (0..5).\n\n' +
  'Returns a plan; execute via propose_batch_apply after each sub-\n' +
  'call lands.';

const u8 = z.number().int().min(0).max(0xff);
const u16 = z.number().int().min(0).max(0xffff);

export const proposeAddSpeciesInputShape = {
  speciesId: u16,
  name: z.string().min(1).max(10),
  baseStats: z.object({
    hp: z.number().int().min(1).max(255),
    attack: z.number().int().min(1).max(255),
    defense: z.number().int().min(1).max(255),
    spAttack: z.number().int().min(1).max(255),
    spDefense: z.number().int().min(1).max(255),
    speed: z.number().int().min(1).max(255),
  }),
  types: z.tuple([u8, u8]),
  abilities: z.tuple([u8, u8]),
  pokedex: z.object({
    categoryName: z.string().min(1).max(11),
    height: z.number().int().min(0).max(9999),
    weight: z.number().int().min(0).max(9999),
    description: z.string().min(1).max(2000),
  }),
  sprite: z.object({
    frontPngPath: z.string().min(1),
    backPngPath: z.string().optional(),
    shinyPngPath: z.string().optional(),
  }),
  evolutions: z
    .array(
      z.object({
        method: u16,
        param: u16,
        targetSpecies: u16,
      }),
    )
    .max(5)
    .optional(),
  eggGroups: z.tuple([u8, u8]).optional(),
  catchRate: u8.optional(),
  growthRate: u8.optional(),
} as const;

export interface PlannedSpeciesCall {
  readonly tool: string;
  readonly args: Record<string, unknown>;
  readonly purpose: string;
}

export interface ProposeAddSpeciesResult {
  readonly ok: boolean;
  readonly plan: ReadonlyArray<PlannedSpeciesCall>;
  readonly warnings: ReadonlyArray<string>;
  readonly message: string;
}

export async function proposeAddSpecies(
  _ctx: ToolContext,
  args: z.infer<typeof speciesArgsSchema>,
): Promise<ProposeAddSpeciesResult> {
  const plan: PlannedSpeciesCall[] = [];
  const warnings: string[] = [];

  if (args.speciesId > 0x50d) {
    warnings.push(
      `speciesId 0x${args.speciesId.toString(16)} exceeds CFRU\'s vanilla cap (0x50D). This requires a CFRU+DPE-bundled ROM (Phase 3.41). On a CFRU-only ROM the engine will refuse to load this slot.`,
    );
  }

  // 1) Base stats + types + abilities + name.
  plan.push({
    tool: 'propose_species_edit',
    args: {
      speciesId: args.speciesId,
      name: args.name,
      baseHP: args.baseStats.hp,
      baseAttack: args.baseStats.attack,
      baseDefense: args.baseStats.defense,
      baseSpeed: args.baseStats.speed,
      baseSpAttack: args.baseStats.spAttack,
      baseSpDefense: args.baseStats.spDefense,
      type1: args.types[0],
      type2: args.types[1],
      ability1: args.abilities[0],
      ability2: args.abilities[1],
      eggGroup1: args.eggGroups?.[0] ?? 15, // EGG_GROUP_UNDISCOVERED
      eggGroup2: args.eggGroups?.[1] ?? 15,
      catchRate: args.catchRate ?? 45,
      growthRate: args.growthRate ?? 1, // medium-fast
    },
    purpose: `species base data: ${args.name} (${args.baseStats.hp}/${args.baseStats.attack}/${args.baseStats.defense}/${args.baseStats.spAttack}/${args.baseStats.spDefense}/${args.baseStats.speed})`,
  });

  // 2) Pokédex entry + flavor text.
  plan.push({
    tool: 'propose_pokedex_entry',
    args: {
      speciesId: args.speciesId,
      categoryName: args.pokedex.categoryName,
      height: args.pokedex.height,
      weight: args.pokedex.weight,
      description: args.pokedex.description,
    },
    purpose: `Pokédex: ${args.pokedex.categoryName} Pokémon`,
  });

  // 3) Sprite import.
  plan.push({
    tool: 'propose_import_pokemon_sprite',
    args: {
      speciesId: args.speciesId,
      frontPngPath: args.sprite.frontPngPath,
      ...(args.sprite.backPngPath ? { backPngPath: args.sprite.backPngPath } : {}),
      ...(args.sprite.shinyPngPath ? { shinyPngPath: args.sprite.shinyPngPath } : {}),
    },
    purpose: `sprite: ${args.sprite.frontPngPath}`,
  });

  // 4) Evolutions (optional).
  if (args.evolutions && args.evolutions.length > 0) {
    plan.push({
      tool: 'propose_edit_evolution',
      args: { speciesId: args.speciesId, evolutions: args.evolutions },
      purpose: `evolutions: ${String(args.evolutions.length)} method(s)`,
    });
  }

  return {
    ok: true,
    plan: Object.freeze(plan),
    warnings: Object.freeze(warnings),
    message:
      `Planned ${String(plan.length)} sub-calls to add species ${String(args.speciesId)} (${args.name}). ` +
      `Execute each via the agent\'s normal flow, then propose_batch_apply for atomic landing.`,
  };
}

// Helper to expose the schema's inferred type for the function signature.
const speciesArgsSchema = z.object(proposeAddSpeciesInputShape);
