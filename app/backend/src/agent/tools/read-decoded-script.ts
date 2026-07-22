import { z } from 'zod';
import type { ProjectManifest, ScriptStep } from '@rom-editor/shared';
import { readManifest } from '../../scan/manifest-io.js';
import type {
  ReadDecodedScriptResult,
  ReadDecodedScriptStep,
  ReadDecodedScriptUnavailable,
  ToolContext,
} from '../types.js';

export const READ_DECODED_SCRIPT_TOOL_NAME = 'read_decoded_script';

export const READ_DECODED_SCRIPT_DESCRIPTION =
  'Return the semantic, decoded steps of a script - never raw bytecode or hex. ' +
  'Accepts either an exact ScriptStep id (returns one step), a decomp script head ' +
  'like "PalletTown_OaksLab_EventScript_1" (returns the chain `<head>#N` in order), ' +
  'or a binary-ROM script id like "script_0x16582f" (returns `<id>__N` in order). ' +
  'Step kinds map to gameplay vocabulary: dialogue, set_flag, give_item, start_battle, ' +
  'warp_player, etc. Use this whenever the user asks what an NPC says or does.';

export const readDecodedScriptInputShape = {
  scriptId: z.string().min(1),
  maxSteps: z.number().int().positive().max(256).optional(),
} as const;

const DEFAULT_MAX_STEPS = 64;

export async function readDecodedScript(
  ctx: ToolContext,
  args: { scriptId: string; maxSteps?: number },
): Promise<ReadDecodedScriptResult | ReadDecodedScriptUnavailable> {
  const manifest = await readManifest(ctx.projectRoot);
  if (!manifest) {
    return {
      available: false,
      scriptId: args.scriptId,
      reason: 'manifest_not_found',
      message: `No manifest at ${ctx.projectRoot}/.editor/manifest.json.`,
    };
  }

  const maxSteps = args.maxSteps ?? DEFAULT_MAX_STEPS;

  // Try exact match first.
  const exact = manifest.scriptSteps.find((s) => s.id === args.scriptId);
  if (exact) {
    return {
      available: true,
      scriptId: args.scriptId,
      matchMode: 'exact',
      steps: [stepToOutput(exact)],
      truncated: false,
    };
  }

  // Try chain match by id convention. Two encoding flavors:
  //   decomp:     <head>#0, <head>#1, ...
  //   binary-rom: <head>__0, <head>__1, ...
  const chain = collectChain(manifest, args.scriptId);
  if (chain.length > 0) {
    const limited = chain.slice(0, maxSteps);
    return {
      available: true,
      scriptId: args.scriptId,
      matchMode: chain.length === 1 ? 'prefix' : 'chain',
      steps: limited.map(stepToOutput),
      truncated: chain.length > maxSteps,
    };
  }

  return {
    available: false,
    scriptId: args.scriptId,
    reason: 'script_not_found',
    message:
      `No ScriptStep matches '${args.scriptId}' (tried exact, '<id>#N' chain, ` +
      `and '<id>__N' chain). Use find_references_to or list_entities to discover valid ids.`,
  };
}

function stepToOutput(s: ScriptStep): ReadDecodedScriptStep {
  const { label, ...rest } = s.params as { label?: unknown; [k: string]: unknown };
  return {
    id: s.id,
    kind: s.kind,
    label: typeof label === 'string' ? label : null,
    params: rest,
  };
}

function collectChain(m: ProjectManifest, head: string): ScriptStep[] {
  const matchSeparator = (s: ScriptStep): { sep: '#' | '__'; n: number } | null => {
    if (s.id.startsWith(`${head}#`)) {
      const tail = s.id.slice(head.length + 1);
      const n = Number.parseInt(tail, 10);
      return Number.isFinite(n) ? { sep: '#', n } : null;
    }
    if (s.id.startsWith(`${head}__`)) {
      const tail = s.id.slice(head.length + 2);
      const n = Number.parseInt(tail, 10);
      return Number.isFinite(n) ? { sep: '__', n } : null;
    }
    return null;
  };

  const candidates: { step: ScriptStep; idx: number }[] = [];
  for (const s of m.scriptSteps) {
    const match = matchSeparator(s);
    if (match) candidates.push({ step: s, idx: match.n });
  }
  candidates.sort((a, b) => a.idx - b.idx);
  return candidates.map((c) => c.step);
}
