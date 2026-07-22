/**
 * propose_author_scene - Phase 3.24.
 *
 * Compose-a-scene orchestrator. Reads a scene spec (either inline
 * via args.scene or by sceneId from the persisted story-spec.md),
 * resolves cast voice cards, generates dialogue, places NPCs, wires
 * scripts, and returns a STRUCTURED PLAN describing the sequence of
 * sub-tool calls the agent should make.
 *
 * Design note: the orchestrator deliberately does NOT call the
 * sub-tools directly. Instead it returns a structured "plan" - a
 * list of tool invocations with their args + dependency ordering.
 * The agent then makes those calls (each going through the user's
 * review flow). This keeps the user in control of every ROM edit,
 * preserves the per-proposal review UX, and lets the agent fall
 * back to manual composition if any step fails.
 *
 * The orchestrator also runs propose_check_story_coherence at the
 * end as a sanity check.
 */

import { z } from 'zod';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { ToolContext } from '../types.js';

export const PROPOSE_AUTHOR_SCENE_TOOL_NAME = 'propose_author_scene';

export const PROPOSE_AUTHOR_SCENE_DESCRIPTION =
  'Plan a complete scene as a sequence of tool calls: NPC placement,\n' +
  'script wiring, dialogue gen, cutscene composition. Returns a\n' +
  'structured plan; the agent executes the calls + the user reviews\n' +
  'each proposal as usual.\n\n' +
  'Inputs:\n' +
  '  - `sceneId`: scene id from the story spec (looked up in\n' +
  '    .editor/story-spec.md).\n' +
  '  - `targetMapId`: the map this scene plays on (must exist; create\n' +
  '    via propose_create_map first if missing).\n' +
  '  - `castMembers`: array of { characterId, npcId?, coord, gfxId,\n' +
  '    movementType }. The orchestrator looks up each character\'s\n' +
  '    voice card; missing cards are listed in `missingVoiceCards`.\n' +
  '  - `dialogues`: array of { characterId, beat, lines } - pre-\n' +
  '    drafted dialogue. If omitted, the plan includes\n' +
  '    propose_generate_dialogue calls for the agent to fill in.\n' +
  '  - `cutsceneBeats`: optional cutscene beat list (Phase 3.20). If\n' +
  '    present, the plan includes a propose_cutscene call.\n\n' +
  'The plan output is a JSON-friendly array of `{ tool, args }`\n' +
  'objects, executed in order via propose_batch_apply for\n' +
  'transactional semantics.';

const u8 = z.number().int().min(0).max(0xff);
const u16 = z.number().int().min(0).max(0xffff);

export const proposeAuthorSceneInputShape = {
  sceneId: z.string().min(1).max(60),
  targetMapId: z.string().min(1),
  castMembers: z
    .array(
      z.object({
        characterId: z.string().min(1).max(60),
        coord: z.object({ x: u8, y: u8 }),
        gfxId: u8,
        movementType: z.union([u8, z.string()]).optional(),
      }),
    )
    .min(0)
    .max(20),
  dialogues: z
    .array(
      z.object({
        characterId: z.string().min(1).max(60),
        beat: z.string().min(1).max(40),
        lines: z.array(z.string().min(1).max(500)).min(1).max(10),
      }),
    )
    .optional(),
  cutsceneBeats: z.array(z.unknown()).optional(), // pass-through to propose_cutscene
} as const;

export interface PlannedToolCall {
  readonly tool: string;
  readonly args: Record<string, unknown>;
  readonly purpose: string;
}

export interface ProposeAuthorSceneResult {
  readonly ok: boolean;
  readonly plan: ReadonlyArray<PlannedToolCall>;
  readonly missingVoiceCards: ReadonlyArray<string>;
  readonly warnings: ReadonlyArray<string>;
  readonly message: string;
}

async function voiceCardExists(projectRoot: string, characterId: string): Promise<boolean> {
  const file = path.join(projectRoot, '.editor', 'voices', `${characterId}.md`);
  try {
    await fsp.stat(file);
    return true;
  } catch {
    return false;
  }
}

export async function proposeAuthorScene(
  ctx: ToolContext,
  args: {
    sceneId: string;
    targetMapId: string;
    castMembers: Array<{
      characterId: string;
      coord: { x: number; y: number };
      gfxId: number;
      movementType?: number | string;
    }>;
    dialogues?: Array<{ characterId: string; beat: string; lines: string[] }>;
    cutsceneBeats?: unknown[];
  },
): Promise<ProposeAuthorSceneResult> {
  const plan: PlannedToolCall[] = [];
  const missingVoiceCards: string[] = [];
  const warnings: string[] = [];

  // Step 1: voice-card check for each cast member.
  for (const cm of args.castMembers) {
    const exists = await voiceCardExists(ctx.projectRoot, cm.characterId);
    if (!exists) missingVoiceCards.push(cm.characterId);
  }
  if (missingVoiceCards.length > 0) {
    warnings.push(
      `Missing voice cards for: ${missingVoiceCards.join(', ')}. ` +
      `Create them via propose_character_voice_card before authoring dialogue, or the dialogue gen will skip voice validation.`,
    );
  }

  // Step 2: NPC placement per cast member.
  // Coord conflict pre-check (within this scene).
  const coordKeys = new Set<string>();
  for (const cm of args.castMembers) {
    const key = `${String(cm.coord.x)},${String(cm.coord.y)}`;
    if (coordKeys.has(key)) {
      warnings.push(`Cast members at duplicate coord (${key}) - only one will be placed; pick distinct tiles.`);
    }
    coordKeys.add(key);
    plan.push({
      tool: 'propose_add_object_event',
      args: {
        mapId: args.targetMapId,
        x: cm.coord.x,
        y: cm.coord.y,
        graphicsId: cm.gfxId,
        movementType: cm.movementType ?? 'MOVEMENT_TYPE_FACE_DOWN',
      },
      purpose: `place ${cm.characterId} on ${args.targetMapId}`,
    });
  }

  // Step 3: dialogue generation per supplied dialogue spec.
  if (args.dialogues) {
    for (const d of args.dialogues) {
      plan.push({
        tool: 'propose_generate_dialogue',
        args: {
          characterId: d.characterId,
          sceneId: args.sceneId,
          beat: d.beat,
          contextSummary: `Scene ${args.sceneId} on ${args.targetMapId}`,
          lines: d.lines,
        },
        purpose: `cache + validate ${d.characterId}/${d.beat}`,
      });
    }
  } else {
    // No dialogues supplied - emit placeholders the agent fills in.
    for (const cm of args.castMembers) {
      plan.push({
        tool: 'propose_generate_dialogue',
        args: {
          characterId: cm.characterId,
          sceneId: args.sceneId,
          beat: 'greet',
          contextSummary: `Initial greeting in scene ${args.sceneId}`,
          lines: ['[agent fills these in]'],
        },
        purpose: `placeholder for ${cm.characterId}/greet`,
      });
    }
  }

  // Step 4: cutscene if supplied.
  if (args.cutsceneBeats && args.cutsceneBeats.length > 0) {
    plan.push({
      tool: 'propose_cutscene',
      args: { beats: args.cutsceneBeats, terminator: 'end' },
      purpose: `compose scene ${args.sceneId} bytecode`,
    });
  }

  // Step 5: final coherence check.
  plan.push({
    tool: 'propose_check_story_coherence',
    args: {},
    purpose: 'verify scene wiring matches story spec',
  });

  return {
    ok: true,
    plan: Object.freeze(plan),
    missingVoiceCards: Object.freeze(missingVoiceCards),
    warnings: Object.freeze(warnings),
    message:
      `Authored ${String(plan.length)}-step plan for scene "${args.sceneId}" on ${args.targetMapId}. ` +
      `${args.castMembers.length} NPCs + ${String(args.dialogues?.length ?? args.castMembers.length)} dialogues + ${args.cutsceneBeats ? 'cutscene' : 'no cutscene'} + coherence check. ` +
      `Execute via propose_batch_apply once the proposals exist.`,
  };
}
