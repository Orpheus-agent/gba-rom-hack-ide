import { z } from 'zod';
import { readManifest } from '../../scan/manifest-io.js';
import type { ToolContext, WorkspaceSummary } from '../types.js';

export const GET_WORKSPACE_SUMMARY_TOOL_NAME = 'get_workspace_summary';

export const GET_WORKSPACE_SUMMARY_DESCRIPTION =
  'Top-level snapshot of the currently open ROM project - its identity ' +
  '(game family / hack fork) and the counts of every major editable entity ' +
  '(maps, NPCs, dialogue lines, flags, trainers, …). Call this first when ' +
  'orienting to a new project; the counts tell you what queries are worth making.';

export const getWorkspaceSummaryInputShape = {} as const;

export async function getWorkspaceSummary(ctx: ToolContext): Promise<WorkspaceSummary> {
  const manifest = await readManifest(ctx.projectRoot);
  if (!manifest) {
    return {
      available: false,
      projectRoot: ctx.projectRoot,
      reason: 'manifest_not_found',
      message:
        'No scanned workspace manifest at ' +
        `${ctx.projectRoot}/.editor/manifest.json. The user may need to open ` +
        'and scan a project before this tool returns data.',
    };
  }

  return {
    available: true,
    projectRoot: ctx.projectRoot,
    generatedAtUtc: manifest.generatedAtUtc,
    identity: {
      kind: manifest.identity.kind,
      displayName: manifest.identity.displayName,
      baseGame: manifest.identity.baseGame,
      fork: manifest.identity.fork,
      confidence: manifest.identity.confidence,
    },
    counts: {
      maps: manifest.maps.length,
      warps: manifest.warps.length,
      triggers: manifest.triggers.length,
      objectEvents: manifest.objectEvents.length,
      dialogue: manifest.dialogue.length,
      flags: manifest.flags.length,
      variables: manifest.variables.length,
      encounterTables: manifest.encounterTables.length,
      trainers: manifest.trainers.length,
      scriptSteps: manifest.scriptSteps.length,
      assets: manifest.assets.length,
    },
  };
}

export const getWorkspaceSummaryOutputShape = {
  available: z.boolean(),
  projectRoot: z.string(),
  reason: z.string().optional(),
  message: z.string().optional(),
  generatedAtUtc: z.string().optional(),
  identity: z
    .object({
      kind: z.string(),
      displayName: z.string(),
      baseGame: z.string().nullable(),
      fork: z.string().nullable(),
      confidence: z.number(),
    })
    .optional(),
  counts: z
    .object({
      maps: z.number(),
      warps: z.number(),
      triggers: z.number(),
      objectEvents: z.number(),
      dialogue: z.number(),
      flags: z.number(),
      variables: z.number(),
      encounterTables: z.number(),
      trainers: z.number(),
      scriptSteps: z.number(),
      assets: z.number(),
    })
    .optional(),
} as const;
