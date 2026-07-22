// Pure template registry for the Templates sidebar tab. Each template is a
// typed recipe that produces a partial-entity bundle the writer can stage to
// `.editor/staged-templates/` for later application to the source tree.
//
// Templates are intentionally minimal - they produce skeletons (id + name +
// the wired references), not finished content. The writer fills in dialogue
// text, sprites, etc. by hand or via the existing per-entity editors.

import type {
  DialogueNode,
  Flag,
  MapNode,
  ObjectEvent,
  ScriptStep,
  Trigger,
  Variable,
  Warp,
} from '@rom-editor/shared';

export type TemplateId =
  | 'town_skeleton'
  | 'boss_battle_intro'
  | 'gift_pokemon_event'
  | 'randomizer_toggle'
  | 'npc_with_dialogue';

export type TemplateCategory = 'map' | 'event' | 'mechanic' | 'character';

export interface TemplateParamDef {
  readonly key: string;
  readonly label: string;
  readonly required: boolean;
  readonly placeholder?: string;
  readonly defaultValue?: string;
}

export interface TemplateMaterialization {
  readonly summary: string;
  readonly entities: {
    readonly maps?: ReadonlyArray<Partial<MapNode>>;
    readonly objectEvents?: ReadonlyArray<Partial<ObjectEvent>>;
    readonly scriptSteps?: ReadonlyArray<Partial<ScriptStep>>;
    readonly dialogue?: ReadonlyArray<Partial<DialogueNode>>;
    readonly flags?: ReadonlyArray<Partial<Flag>>;
    readonly variables?: ReadonlyArray<Partial<Variable>>;
    readonly triggers?: ReadonlyArray<Partial<Trigger>>;
    readonly warps?: ReadonlyArray<Partial<Warp>>;
  };
}

export interface TemplateDefinition {
  readonly id: TemplateId;
  readonly label: string;
  readonly category: TemplateCategory;
  readonly description: string;
  readonly params: ReadonlyArray<TemplateParamDef>;
  readonly materialize: (params: Record<string, string>) => TemplateMaterialization;
}

export class TemplateError extends Error {
  constructor(
    public readonly code: 'unknown_template' | 'missing_required_param',
    message: string,
  ) {
    super(message);
    this.name = 'TemplateError';
  }
}

function req(params: Record<string, string>, key: string): string {
  const v = params[key];
  if (!v || v.trim().length === 0) {
    throw new TemplateError('missing_required_param', `Required template param '${key}' was empty`);
  }
  return v.trim();
}

const TEMPLATES: ReadonlyArray<TemplateDefinition> = [
  {
    id: 'town_skeleton',
    label: 'Town skeleton',
    category: 'map',
    description:
      'A 20×20 town MapNode with 3 NPC placeholder object events and 1 outbound warp slot. Fill in the warp destination, NPC graphics, and per-NPC scripts.',
    params: [
      { key: 'mapName', label: 'Map name', required: true, placeholder: 'NewTown' },
    ],
    materialize: (params) => {
      const mapName = req(params, 'mapName');
      return {
        summary: `Creates 1 map (${mapName}) + 3 NPC object events + 1 outbound warp slot.`,
        entities: {
          maps: [
            {
              id: mapName,
              name: mapName,
              group: 'town',
              dimensions: { width: 20, height: 20 },
              tilesetIds: [],
              warpIds: [`${mapName}_warp_0`],
              scriptIds: [],
              objectEventIds: [
                `${mapName}_obj_0`,
                `${mapName}_obj_1`,
                `${mapName}_obj_2`,
              ],
              encounterTableIds: [],
              musicId: null,
              metadata: {},
            },
          ],
          objectEvents: [0, 1, 2].map((i) => ({
            id: `${mapName}_obj_${i}`,
            name: `${mapName}_obj_${i}`,
            mapId: mapName,
            coord: { x: 5 + i * 4, y: 10 },
            elevation: 3,
            kind: 'npc' as const,
            graphicsId: null,
            movementType: 'NO_MOVEMENT',
            scriptId: null,
            flagId: null,
            trainerType: null,
            metadata: {},
          })),
          warps: [
            {
              id: `${mapName}_warp_0`,
              name: `${mapName}_warp_0`,
              fromMapId: mapName,
              fromCoord: { x: 10, y: 19 },
              toMapId: 'TODO_DESTINATION_MAP',
              toCoord: { x: 0, y: 0 },
            },
          ],
        },
      };
    },
  },
  {
    id: 'boss_battle_intro',
    label: 'Boss battle intro',
    category: 'event',
    description:
      'A trigger + 4-step script (msgbox → setvar → trainerbattle → setflag) + 2 dialogue stubs (pre-fight + post-fight). Wire the script label into the trigger.',
    params: [
      { key: 'bossLabel', label: 'Boss script label', required: true, placeholder: 'Boss_FirstGym' },
      { key: 'dialogueLabel', label: 'Dialogue label prefix', required: true, placeholder: 'Text_FirstGym' },
    ],
    materialize: (params) => {
      const bossLabel = req(params, 'bossLabel');
      const dialogueLabel = req(params, 'dialogueLabel');
      return {
        summary: `Creates 1 trigger + 4 script steps (${bossLabel}#0..#3) + 2 dialogue lines.`,
        entities: {
          triggers: [
            {
              id: `trigger_${bossLabel}`,
              name: `trigger_${bossLabel}`,
              kind: 'on_interact',
              mapId: null,
              coord: null,
              conditionExpression: null,
              scriptStepIds: [
                `${bossLabel}#0`,
                `${bossLabel}#1`,
                `${bossLabel}#2`,
                `${bossLabel}#3`,
              ],
            },
          ],
          scriptSteps: [
            { id: `${bossLabel}#0`, kind: 'dialogue', params: { macro: 'msgbox', args: [`${dialogueLabel}_PreFight`], text: `${dialogueLabel}_PreFight` } },
            { id: `${bossLabel}#1`, kind: 'set_variable', params: { macro: 'setvar', args: ['VAR_RESULT', '0'], variable: 'VAR_RESULT', value: '0' } },
            { id: `${bossLabel}#2`, kind: 'start_battle', params: { macro: 'trainerbattle_single', args: ['TODO_TRAINER_ID'], trainerId: 'TODO_TRAINER_ID' } },
            { id: `${bossLabel}#3`, kind: 'set_flag', params: { macro: 'setflag', args: [`FLAG_BEAT_${bossLabel.toUpperCase()}`], flag: `FLAG_BEAT_${bossLabel.toUpperCase()}` } },
          ],
          dialogue: [
            { id: `${dialogueLabel}_PreFight`, name: `${dialogueLabel}_PreFight`, speakerName: null, portraitAssetId: null, text: 'TODO: pre-fight bravado here.', choices: [] },
            { id: `${dialogueLabel}_PostFight`, name: `${dialogueLabel}_PostFight`, speakerName: null, portraitAssetId: null, text: 'TODO: post-fight reaction here.', choices: [] },
          ],
        },
      };
    },
  },
  {
    id: 'gift_pokemon_event',
    label: 'Gift Pokémon event',
    category: 'event',
    description:
      'An NPC object event + a 3-step script (msgbox → givemon → setflag) + a FLAG_RECEIVED_* flag that gates the NPC after the gift.',
    params: [
      { key: 'speciesId', label: 'Species id', required: true, placeholder: 'SPECIES_EEVEE' },
      { key: 'flagId', label: 'Received flag id', required: true, placeholder: 'FLAG_RECEIVED_EEVEE' },
    ],
    materialize: (params) => {
      const speciesId = req(params, 'speciesId');
      const flagId = req(params, 'flagId');
      const scriptLabel = `Gift_${speciesId}`;
      return {
        summary: `Creates 1 NPC + 3 script steps + 1 flag (${flagId}) for the ${speciesId} gift.`,
        entities: {
          objectEvents: [
            {
              id: `obj_gift_${speciesId.toLowerCase()}`,
              name: `obj_gift_${speciesId.toLowerCase()}`,
              mapId: 'TODO_MAP',
              coord: { x: 0, y: 0 },
              elevation: 3,
              kind: 'npc' as const,
              graphicsId: null,
              movementType: 'NO_MOVEMENT',
              scriptId: scriptLabel,
              flagId,
              trainerType: null,
              metadata: {},
            },
          ],
          scriptSteps: [
            { id: `${scriptLabel}#0`, kind: 'dialogue', params: { macro: 'msgbox', args: [`Text_${scriptLabel}_Offer`], text: `Text_${scriptLabel}_Offer` } },
            { id: `${scriptLabel}#1`, kind: 'give_item', params: { macro: 'givemon', args: [speciesId, '5'] } },
            { id: `${scriptLabel}#2`, kind: 'set_flag', params: { macro: 'setflag', args: [flagId], flag: flagId } },
          ],
          flags: [
            { id: flagId, name: flagId, scope: 'global', defaultValue: false, description: `Set after the player receives ${speciesId}.`, engineValue: 'TODO_ASSIGN' },
          ],
        },
      };
    },
  },
  {
    id: 'randomizer_toggle',
    label: 'Randomizer toggle',
    category: 'mechanic',
    description:
      'Two flags (FLAG_RANDOMIZER_ENABLED, FLAG_RANDOMIZER_SEEDED) + one variable (VAR_RANDOMIZER_SEED) so the build can read a player-chosen randomizer mode at runtime.',
    params: [],
    materialize: () => ({
      summary: 'Creates 2 flags + 1 variable for a randomizer mechanic.',
      entities: {
        flags: [
          { id: 'FLAG_RANDOMIZER_ENABLED', name: 'FLAG_RANDOMIZER_ENABLED', scope: 'global', defaultValue: false, description: 'Master randomizer toggle.', engineValue: 'TODO_ASSIGN' },
          { id: 'FLAG_RANDOMIZER_SEEDED', name: 'FLAG_RANDOMIZER_SEEDED', scope: 'global', defaultValue: false, description: 'Set after VAR_RANDOMIZER_SEED is initialized.', engineValue: 'TODO_ASSIGN' },
        ],
        variables: [
          { id: 'VAR_RANDOMIZER_SEED', name: 'VAR_RANDOMIZER_SEED', scope: 'global', defaultValue: 0, description: 'Seed for the randomizer RNG.', engineValue: 'TODO_ASSIGN' },
        ],
      },
    }),
  },
  {
    id: 'npc_with_dialogue',
    label: 'NPC with dialogue',
    category: 'character',
    description:
      'A single NPC object event + 2-step script (msgbox → return) + 1 dialogue line. The minimum building block for a "talk to me" character.',
    params: [
      { key: 'npcName', label: 'NPC name', required: true, placeholder: 'TownGreeter' },
      { key: 'dialogueText', label: 'Dialogue text', required: false, defaultValue: 'Hello, traveler!' },
    ],
    materialize: (params) => {
      const npcName = req(params, 'npcName');
      const dialogueText = params['dialogueText']?.trim() || 'Hello, traveler!';
      const scriptLabel = `${npcName}_Talk`;
      const dialogueLabel = `Text_${npcName}_Greeting`;
      return {
        summary: `Creates 1 NPC (${npcName}) + 2 script steps + 1 dialogue line.`,
        entities: {
          objectEvents: [
            {
              id: `obj_${npcName.toLowerCase()}`,
              name: `obj_${npcName.toLowerCase()}`,
              mapId: 'TODO_MAP',
              coord: { x: 0, y: 0 },
              elevation: 3,
              kind: 'npc' as const,
              graphicsId: null,
              movementType: 'NO_MOVEMENT',
              scriptId: scriptLabel,
              flagId: null,
              trainerType: null,
              metadata: {},
            },
          ],
          scriptSteps: [
            { id: `${scriptLabel}#0`, kind: 'dialogue', params: { macro: 'msgbox', args: [dialogueLabel], text: dialogueLabel } },
            { id: `${scriptLabel}#1`, kind: 'raw', params: { macro: 'return', args: [] } },
          ],
          dialogue: [
            { id: dialogueLabel, name: dialogueLabel, speakerName: npcName, portraitAssetId: null, text: dialogueText, choices: [] },
          ],
        },
      };
    },
  },
];

export function listTemplates(): ReadonlyArray<TemplateDefinition> {
  return TEMPLATES;
}

export function getTemplate(id: TemplateId): TemplateDefinition {
  const t = TEMPLATES.find((x) => x.id === id);
  if (!t) {
    throw new TemplateError('unknown_template', `No template with id '${id}'`);
  }
  return t;
}

export function materializeTemplate(
  id: TemplateId,
  params: Record<string, string>,
): TemplateMaterialization {
  const t = getTemplate(id);
  return t.materialize(params);
}
