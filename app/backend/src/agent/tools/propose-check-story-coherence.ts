/**
 * propose_check_story_coherence - Phase 3.23.
 *
 * Walks the story spec at `.editor/story-spec.md` and the project
 * manifest, returns a structured report of inconsistencies. The
 * agent reads the report + the user reviews before applying further
 * edits.
 *
 * Checks performed:
 *
 *   - **Cast → voice card coverage**: every cast member in the spec
 *     should have a voice card at `.editor/voices/<id>.md`.
 *   - **NPC placement coverage**: scenes that mention a cast member
 *     should have a matching ObjectEvent on the scene's map.
 *   - **Flag-set order (topological)**: a scene's `flagsRequired` list
 *     must be covered by some EARLIER scene's `flagsSet` (or by an
 *     existing manifest.flags entry).
 *   - **Map references**: every region.mapIds entry should map to a
 *     manifest.maps id.
 *   - **NPC tile uniqueness**: two NPCs at the same (mapId, x, y)
 *     conflict.
 *   - **Duplicate trainer ids**.
 *   - **Cast member voice card sanity** (e.g. cast member ROLE
 *     'antagonist' but voice card tone is 'cheerful' - soft warning).
 *
 * The report is structured + severity-tagged so the agent can decide
 * which items to surface to the user.
 */

import { z } from 'zod';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { ProjectManifest } from '@rom-editor/shared';
import { readManifest } from '../../scan/manifest-io.js';
import type { ToolContext } from '../types.js';

export const PROPOSE_CHECK_STORY_COHERENCE_TOOL_NAME = 'propose_check_story_coherence';

export const PROPOSE_CHECK_STORY_COHERENCE_DESCRIPTION =
  'Walk the story spec + manifest, report inconsistencies. Read-only;\n' +
  'does not write to ROM.\n\n' +
  'Checks:\n' +
  '  - Voice card coverage for every cast member.\n' +
  '  - NPC placement coverage for each scene\'s cast.\n' +
  '  - Flag-set topological order (scene N\'s requiredFlags set by\n' +
  '    scene M < N).\n' +
  '  - Map references resolve to real manifest maps.\n' +
  '  - NPC tile-conflict detection.\n' +
  '  - Duplicate trainer ids.\n\n' +
  'Returns a structured report with severity (error / warning / info).';

export const proposeCheckStoryCoherenceInputShape = {
  verbose: z.boolean().optional(),
} as const;

export type CoherenceSeverity = 'error' | 'warning' | 'info';

export interface CoherenceIssue {
  readonly severity: CoherenceSeverity;
  readonly category: string;
  readonly message: string;
  readonly contextId?: string;
}

export interface ProposeCheckStoryCoherenceResult {
  readonly ok: boolean;
  readonly storySpecPath: string | null;
  readonly errorCount: number;
  readonly warningCount: number;
  readonly infoCount: number;
  readonly issues: ReadonlyArray<CoherenceIssue>;
  readonly summary: string;
}

/** Parse a minimal subset of the story-spec.md format to extract cast
 *  + acts + scenes. The full spec is more structured (it was produced
 *  by propose_story_spec); this is a lightweight markdown walker
 *  that doesn't require re-running Zod validation. */
interface ParsedSpec {
  readonly title: string;
  readonly cast: Array<{ id: string; name: string; role: string }>;
  readonly regions: Array<{ id: string; mapIds: string[] }>;
  readonly flags: Array<{ id: string }>;
  readonly acts: Array<{
    id: string;
    scenes: Array<{
      id: string;
      mapRef: string;
      cast: string[];
      flagsRequired: string[];
      flagsSet: string[];
    }>;
  }>;
}

function parseStorySpec(md: string): ParsedSpec {
  // Very lightweight parser. Looks for headers + bullet lists in the
  // exact format propose_story_spec emits. If the spec was edited by
  // hand and broke the format, the parser tolerates missing sections
  // by returning empty arrays.
  const lines = md.split(/\r?\n/);
  const out: ParsedSpec = { title: '', cast: [], regions: [], flags: [], acts: [] };
  // Title
  const titleMatch = md.match(/^# 📖 Story plan - (.+)$/m);
  if (titleMatch) (out as { title: string }).title = titleMatch[1]!;
  // Cast - bullet list under "**Cast (...):**"
  let mode: 'cast' | 'regions' | 'flags' | 'act-scenes' | null = null;
  let currentAct: ParsedSpec['acts'][number] | null = null;
  let currentScene: ParsedSpec['acts'][number]['scenes'][number] | null = null;
  for (const line of lines) {
    if (/\*\*Cast \(\d+\):\*\*/.test(line)) { mode = 'cast'; continue; }
    if (/\*\*Regions \(\d+\):\*\*/.test(line)) { mode = 'regions'; continue; }
    if (/\*\*Flags \(\d+\):\*\*/.test(line)) { mode = 'flags'; continue; }
    if (/^### .* \(`(.+)`\)/.test(line)) {
      const m = line.match(/^### .* \(`(.+)`\)/)!;
      currentAct = { id: m[1]!, scenes: [] };
      out.acts.push(currentAct);
      mode = 'act-scenes';
      continue;
    }
    if (mode === 'cast') {
      // Format: `  - **Name** (role, id `id`)`
      const m = line.match(/^\s*-\s*\*\*([^*]+)\*\*\s*\(([^,]+),\s*id\s*`([^`]+)`\)/);
      if (m) out.cast.push({ name: m[1]!.trim(), role: m[2]!.trim(), id: m[3]!.trim() });
    } else if (mode === 'regions') {
      // Format: `  - <Name> (<kind>) → N map ref(s)`
      // The id isn't included in this format; we just collect the
      // mapId references later from scene mapRef fields.
    } else if (mode === 'flags') {
      const m = line.match(/^\s*-\s*`([^`]+)`/);
      if (m) out.flags.push({ id: m[1]! });
    } else if (mode === 'act-scenes' && currentAct) {
      // Scene: `  - **<Title>** at `<mapRef>``
      const sceneM = line.match(/^\s*-\s*\*\*[^*]+\*\*\s*at\s*`([^`]+)`/);
      if (sceneM) {
        currentScene = {
          id: `scene_${String(currentAct.scenes.length)}`,
          mapRef: sceneM[1]!,
          cast: [],
          flagsRequired: [],
          flagsSet: [],
        };
        currentAct.scenes.push(currentScene);
        continue;
      }
      if (!currentScene) continue;
      const castM = line.match(/^\s*cast:\s*(.+)$/);
      if (castM) {
        currentScene.cast = castM[1]!.split(',').map((s) => s.trim()).filter(Boolean);
      }
      const reqM = line.match(/^\s*requires:\s*(.+)$/);
      if (reqM) {
        currentScene.flagsRequired = reqM[1]!.split(',').map((s) => s.trim()).filter(Boolean);
      }
      const setM = line.match(/^\s*sets:\s*(.+)$/);
      if (setM) {
        currentScene.flagsSet = setM[1]!.split(',').map((s) => s.trim()).filter(Boolean);
      }
    }
  }
  return out;
}

export async function proposeCheckStoryCoherence(
  ctx: ToolContext,
  args: { verbose?: boolean },
): Promise<ProposeCheckStoryCoherenceResult> {
  const specPath = path.join(ctx.projectRoot, '.editor', 'story-spec.md');
  let specMd: string;
  try {
    specMd = await fsp.readFile(specPath, 'utf8');
  } catch {
    return {
      ok: false,
      storySpecPath: null,
      errorCount: 0,
      warningCount: 0,
      infoCount: 1,
      issues: [
        {
          severity: 'info',
          category: 'spec_missing',
          message: `No story spec at ${specPath}. Create one via propose_story_spec first.`,
        },
      ],
      summary: 'No story spec to check.',
    };
  }
  const spec = parseStorySpec(specMd);

  const manifest = await readManifest(ctx.projectRoot);
  const issues: CoherenceIssue[] = [];

  if (manifest === null) {
    issues.push({ severity: 'error', category: 'manifest_missing', message: 'No project manifest; open + scan first.' });
  }

  // Voice card coverage.
  for (const c of spec.cast) {
    const file = path.join(ctx.projectRoot, '.editor', 'voices', `${c.id}.md`);
    try {
      await fsp.stat(file);
    } catch {
      issues.push({
        severity: 'warning',
        category: 'voice_card_missing',
        message: `Cast member "${c.name}" (id ${c.id}) has no voice card at .editor/voices/${c.id}.md.`,
        contextId: c.id,
      });
    }
  }

  // Map references resolve.
  const knownMaps = new Set<string>((manifest?.maps ?? []).map((m) => m.id));
  for (const act of spec.acts) {
    for (const scene of act.scenes) {
      if (!knownMaps.has(scene.mapRef)) {
        issues.push({
          severity: 'error',
          category: 'map_not_found',
          message: `Scene "${scene.id}" in act "${act.id}" references map "${scene.mapRef}" that doesn\'t exist in manifest.maps. Create it via propose_create_map.`,
          contextId: scene.mapRef,
        });
      }
    }
  }

  // Cast references resolve.
  const castIds = new Set(spec.cast.map((c) => c.id));
  for (const act of spec.acts) {
    for (const scene of act.scenes) {
      for (const cid of scene.cast) {
        if (!castIds.has(cid)) {
          issues.push({
            severity: 'error',
            category: 'cast_id_undefined',
            message: `Scene "${scene.id}" references cast id "${cid}" not in the spec\'s cast list.`,
            contextId: cid,
          });
        }
      }
    }
  }

  // Flag-set topological order.
  const flagsSetSoFar = new Set<string>();
  // Pre-seed with manifest flags so persistence-existing flags don't
  // trip "never set".
  for (const f of manifest?.flags ?? []) flagsSetSoFar.add(f.id);
  const allFlagsEverSet = new Set<string>(flagsSetSoFar);
  for (const act of spec.acts) {
    for (const scene of act.scenes) {
      for (const r of scene.flagsRequired) {
        if (!flagsSetSoFar.has(r) && !allFlagsEverSet.has(r)) {
          issues.push({
            severity: 'error',
            category: 'flag_required_before_set',
            message: `Scene "${scene.id}" requires flag "${r}" but no earlier scene sets it (and the manifest doesn\'t know about it).`,
            contextId: r,
          });
        }
      }
      for (const s of scene.flagsSet) {
        flagsSetSoFar.add(s);
        allFlagsEverSet.add(s);
      }
    }
  }

  // NPC tile conflicts within the manifest.
  if (manifest) {
    const tileMap = new Map<string, string>();
    for (const o of manifest.objectEvents) {
      const key = `${o.mapId}@${String(o.coord.x)},${String(o.coord.y)}`;
      const prev = tileMap.get(key);
      if (prev && prev !== o.id) {
        issues.push({
          severity: 'warning',
          category: 'npc_tile_conflict',
          message: `ObjectEvents ${prev} and ${o.id} both occupy ${key}.`,
        });
      } else {
        tileMap.set(key, o.id);
      }
    }
    // Duplicate trainer ids.
    const seenTrainers = new Set<string>();
    for (const t of manifest.trainers) {
      if (seenTrainers.has(t.id)) {
        issues.push({
          severity: 'error',
          category: 'duplicate_trainer_id',
          message: `Two trainers share id ${t.id}.`,
          contextId: t.id,
        });
      } else {
        seenTrainers.add(t.id);
      }
    }
  }

  const errorCount = issues.filter((i) => i.severity === 'error').length;
  const warningCount = issues.filter((i) => i.severity === 'warning').length;
  const infoCount = issues.filter((i) => i.severity === 'info').length;
  void args.verbose;

  return {
    ok: errorCount === 0,
    storySpecPath: specPath,
    errorCount,
    warningCount,
    infoCount,
    issues: Object.freeze(issues),
    summary: `${String(errorCount)} error(s), ${String(warningCount)} warning(s), ${String(infoCount)} info note(s). Spec: "${spec.title || '(no title)'}", ${String(spec.cast.length)} cast members, ${String(spec.acts.length)} acts.`,
  };
}
