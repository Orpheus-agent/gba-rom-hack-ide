import { z } from 'zod';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { ToolContext } from '../types.js';

export const PROPOSE_STORY_SPEC_TOOL_NAME = 'propose_story_spec';

export const PROPOSE_STORY_SPEC_DESCRIPTION =
  'Capture a structured story plan BEFORE proposing any ROM patches. ' +
  'Use this for large multi-week initiatives like "make Unova with the ' +
  'story of Black & White 2" - the user reads the spec to confirm the ' +
  'narrative shape is right, THEN approves piece-by-piece implementation ' +
  'via the downstream propose_* tools (species, move, encounter, trainer, ' +
  'object event, etc.).\n\n' +
  'The schema models a story DAG:\n' +
  '  - acts: top-level narrative beats ("Plasma intro", "Gym tour",\n' +
  '    "N\'s Castle climax")\n' +
  '  - scenes within each act: a single map + cast + dialogue\n' +
  '  - flags: story-progress markers that gate scene transitions\n' +
  '  - cast: recurring named characters (rivals, gym leaders,\n' +
  '    antagonists)\n' +
  '  - regions: groupings of maps (cities, routes, dungeons) - points\n' +
  '    at existing mapIds when known, or labels for maps you plan to\n' +
  '    create.\n\n' +
  'The tool VALIDATES the spec\'s internal consistency (every scene\'s ' +
  'flagsRequired must be set by some EARLIER scene; every character ' +
  'referenced in a scene must appear in the cast; every map referenced ' +
  'must appear in some region). Inconsistencies are returned as a list ' +
  'of warnings - non-fatal; the spec still ships back so the agent can ' +
  'discuss them with the user.\n\n' +
  'After the tool returns:\n' +
  '  1. The agent presents the spec to the user (the `markdown` field is ' +
  'a ready-to-paste rendering).\n' +
  '  2. The user approves, edits, or rejects.\n' +
  '  3. On approval, the agent implements scene-by-scene using ' +
  'propose_object_event_edit / propose_trainer_party / propose_rename / ' +
  'etc.\n' +
  '  4. For capabilities the editor doesn\'t yet have (asset import, ' +
  'large map generation), the agent uses propose_editor_extension to ' +
  'ask for dev mode.\n\n' +
  'This tool is INTENTIONALLY read-only - it produces a plan, not a ' +
  'patch. The user is the final gate on whether implementation begins.';

const flagSchema = z.object({
  id: z.string().min(1).max(60),
  description: z.string().min(1).max(200),
});

const characterSchema = z.object({
  id: z.string().min(1).max(60),
  name: z.string().min(1).max(40),
  role: z.string().min(1).max(60), // "rival" | "gym_leader" | "antagonist" | "champion" | "supporting"
  notes: z.string().max(500).optional(),
});

const sceneSchema = z.object({
  id: z.string().min(1).max(60),
  title: z.string().min(1).max(120),
  mapRef: z.string().min(1).max(60), // points at a region.mapIds entry OR a placeholder label
  cast: z.array(z.string().min(1)).max(20), // character ids
  flagsRequired: z.array(z.string().min(1)).max(20).optional(),
  flagsSet: z.array(z.string().min(1)).max(20).optional(),
  dialogueSummary: z.string().min(1).max(800),
});

const actSchema = z.object({
  id: z.string().min(1).max(60),
  title: z.string().min(1).max(120),
  summary: z.string().min(1).max(500),
  scenes: z.array(sceneSchema).min(1).max(40),
});

const regionSchema = z.object({
  id: z.string().min(1).max(60),
  name: z.string().min(1).max(60),
  kind: z.enum(['town', 'city', 'route', 'cave', 'dungeon', 'interior', 'other']),
  mapIds: z.array(z.string().min(1)).max(40),
});

export const proposeStorySpecInputShape = {
  title: z.string().min(1).max(120),
  premise: z.string().min(10).max(2000),
  baseGameRef: z.string().min(1).max(120).optional(),
  cast: z.array(characterSchema).min(1).max(60),
  regions: z.array(regionSchema).min(1).max(40),
  flags: z.array(flagSchema).max(120),
  acts: z.array(actSchema).min(1).max(20),
} as const;

interface StorySpecArgs {
  title: string;
  premise: string;
  baseGameRef?: string;
  cast: Array<{ id: string; name: string; role: string; notes?: string }>;
  regions: Array<{ id: string; name: string; kind: string; mapIds: string[] }>;
  flags: Array<{ id: string; description: string }>;
  acts: Array<{
    id: string;
    title: string;
    summary: string;
    scenes: Array<{
      id: string;
      title: string;
      mapRef: string;
      cast: string[];
      flagsRequired?: string[];
      flagsSet?: string[];
      dialogueSummary: string;
    }>;
  }>;
}

export interface ProposeStorySpecResult {
  readonly title: string;
  readonly proposedAtUtc: string;
  readonly stats: {
    readonly acts: number;
    readonly scenes: number;
    readonly cast: number;
    readonly regions: number;
    readonly mapRefs: number;
    readonly flags: number;
  };
  readonly warnings: ReadonlyArray<string>;
  /** Markdown rendering the agent can paste into its reply so the
   *  user reads the whole spec in the AgentPanel. */
  readonly markdown: string;
  /** The full validated spec - the agent retains this in conversation
   *  context so it can iterate on subsequent turns. */
  readonly spec: StorySpecArgs;
  /** Phase 2C - absolute path of the persisted markdown copy. The tool
   *  writes the rendered spec to `<projectRoot>/.editor/story-spec.md`
   *  so the agent and user share a single source of truth across
   *  sessions. Null when persistence failed (e.g. read-only project
   *  root); the in-memory result is still returned. */
  readonly persistedMarkdownPath: string | null;
}

function validateSpec(spec: StorySpecArgs): string[] {
  const warnings: string[] = [];
  const characterIds = new Set(spec.cast.map((c) => c.id));
  const flagIds = new Set(spec.flags.map((f) => f.id));
  const allMapRefs = new Set<string>();
  for (const r of spec.regions) {
    for (const m of r.mapIds) allMapRefs.add(m);
  }

  let totalScenes = 0;
  const flagsSetBySomeScene = new Set<string>();

  for (const act of spec.acts) {
    for (const scene of act.scenes) {
      totalScenes++;
      // Cast references resolve to actual characters?
      for (const charId of scene.cast) {
        if (!characterIds.has(charId)) {
          warnings.push(
            `Scene ${act.id}/${scene.id} references unknown character "${charId}". Add to cast[] or fix the ref.`,
          );
        }
      }
      // mapRef resolves to a region's mapIds entry?
      if (!allMapRefs.has(scene.mapRef)) {
        warnings.push(
          `Scene ${act.id}/${scene.id} references map "${scene.mapRef}" that doesn't appear in any region. Add it to a region's mapIds.`,
        );
      }
      // flagsRequired exist?
      for (const fr of scene.flagsRequired ?? []) {
        if (!flagIds.has(fr)) {
          warnings.push(
            `Scene ${act.id}/${scene.id} requires unknown flag "${fr}". Add to flags[].`,
          );
        }
      }
      for (const fs of scene.flagsSet ?? []) {
        if (!flagIds.has(fs)) {
          warnings.push(
            `Scene ${act.id}/${scene.id} sets unknown flag "${fs}". Add to flags[].`,
          );
        }
        flagsSetBySomeScene.add(fs);
      }
    }
  }

  // Second pass: every required flag must be set by SOMETHING.
  for (const act of spec.acts) {
    for (const scene of act.scenes) {
      for (const fr of scene.flagsRequired ?? []) {
        if (!flagsSetBySomeScene.has(fr)) {
          warnings.push(
            `Flag "${fr}" is required by ${act.id}/${scene.id} but never set by any scene - that scene is unreachable.`,
          );
        }
      }
    }
  }

  void totalScenes;
  return warnings;
}

function renderMarkdown(spec: StorySpecArgs, warnings: string[]): string {
  const lines: string[] = [];
  lines.push(`# 📖 Story plan - ${spec.title}`);
  lines.push('');
  lines.push(`**Premise:** ${spec.premise}`);
  if (spec.baseGameRef) {
    lines.push('');
    lines.push(`**Base game ref:** ${spec.baseGameRef}`);
  }
  lines.push('');
  lines.push(`**Cast (${spec.cast.length}):**`);
  for (const c of spec.cast) {
    const notes = c.notes ? ` - ${c.notes}` : '';
    lines.push(`  - **${c.name}** (${c.role}, id \`${c.id}\`)${notes}`);
  }
  lines.push('');
  lines.push(`**Regions (${spec.regions.length}):**`);
  for (const r of spec.regions) {
    lines.push(`  - ${r.name} (${r.kind}) → ${r.mapIds.length} map ref${r.mapIds.length === 1 ? '' : 's'}`);
  }
  lines.push('');
  lines.push(`**Flags (${spec.flags.length}):**`);
  for (const f of spec.flags.slice(0, 8)) {
    lines.push(`  - \`${f.id}\`: ${f.description}`);
  }
  if (spec.flags.length > 8) lines.push(`  - …and ${spec.flags.length - 8} more`);
  lines.push('');
  lines.push(`**Acts (${spec.acts.length}):**`);
  for (const act of spec.acts) {
    lines.push(`### ${act.title} (\`${act.id}\`)`);
    lines.push(`*${act.summary}*`);
    lines.push('');
    for (const scene of act.scenes) {
      lines.push(`  - **${scene.title}** at \`${scene.mapRef}\``);
      if (scene.cast.length > 0) lines.push(`    cast: ${scene.cast.join(', ')}`);
      if (scene.flagsRequired && scene.flagsRequired.length > 0) {
        lines.push(`    requires: ${scene.flagsRequired.join(', ')}`);
      }
      if (scene.flagsSet && scene.flagsSet.length > 0) {
        lines.push(`    sets: ${scene.flagsSet.join(', ')}`);
      }
      lines.push(`    → ${scene.dialogueSummary}`);
    }
    lines.push('');
  }
  if (warnings.length > 0) {
    lines.push(`**⚠ ${warnings.length} consistency warning${warnings.length === 1 ? '' : 's'}:**`);
    for (const w of warnings.slice(0, 12)) lines.push(`  - ${w}`);
    if (warnings.length > 12) lines.push(`  - …and ${warnings.length - 12} more`);
    lines.push('');
  }
  lines.push('---');
  lines.push(
    '**Next:** Review the plan above. If it captures the story you want, ' +
      'reply "approved" and I\'ll begin implementing scene-by-scene. ' +
      'If you want changes, tell me what to revise and I\'ll re-propose. ' +
      'Implementation uses propose_object_event_edit / propose_trainer_party ' +
      '/ propose_rename / etc. - each scene becomes a small reviewable diff.',
  );
  return lines.join('\n');
}

/** Phase 2C - persist the rendered story spec to
 *  `<projectRoot>/.editor/story-spec.md`. The user and agent both read
 *  from this file across sessions so re-running propose_story_spec
 *  (e.g. mid-implementation, after adding new acts) leaves a single
 *  source of truth on disk. Best-effort: a persistence failure does
 *  not fail the tool - the in-memory result is still useful for the
 *  current turn. */
async function persistStorySpecMarkdown(
  projectRoot: string,
  markdown: string,
): Promise<string | null> {
  try {
    const editorDir = path.join(projectRoot, '.editor');
    await fsp.mkdir(editorDir, { recursive: true });
    const file = path.join(editorDir, 'story-spec.md');
    await fsp.writeFile(file, markdown, { encoding: 'utf8' });
    return file;
  } catch {
    return null;
  }
}

export async function proposeStorySpec(
  ctx: ToolContext,
  args: StorySpecArgs,
): Promise<ProposeStorySpecResult> {
  const warnings = validateSpec(args);
  const totalScenes = args.acts.reduce((sum, a) => sum + a.scenes.length, 0);
  const totalMapRefs = args.regions.reduce((sum, r) => sum + r.mapIds.length, 0);
  const markdown = renderMarkdown(args, warnings);
  const persistedMarkdownPath = await persistStorySpecMarkdown(
    ctx.projectRoot,
    markdown,
  );
  return {
    title: args.title,
    proposedAtUtc: new Date().toISOString(),
    stats: {
      acts: args.acts.length,
      scenes: totalScenes,
      cast: args.cast.length,
      regions: args.regions.length,
      mapRefs: totalMapRefs,
      flags: args.flags.length,
    },
    warnings: Object.freeze(warnings),
    markdown,
    spec: args,
    persistedMarkdownPath,
  };
}
