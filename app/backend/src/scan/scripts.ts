import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { EntityId, ScriptStep, ScriptStepKind } from '@rom-editor/shared';

// Pokemerald-class script macros → canonical step kinds. New mappings added
// here automatically take effect; unknown macros fall back to 'raw' so no
// script line is ever silently dropped.
const MACRO_TO_KIND: ReadonlyMap<string, ScriptStepKind> = new Map([
  ['msgbox', 'dialogue'],
  ['message', 'dialogue'],
  ['setflag', 'set_flag'],
  ['clearflag', 'clear_flag'],
  ['goto', 'branch'],
  ['goto_if', 'branch'],
  ['goto_if_set', 'branch'],
  ['goto_if_unset', 'branch'],
  ['goto_if_eq', 'branch'],
  ['goto_if_ne', 'branch'],
  ['call', 'branch'],
  ['call_if', 'branch'],
  ['call_if_set', 'branch'],
  ['call_if_unset', 'branch'],
  ['return', 'branch'],
  ['giveitem', 'give_item'],
  ['giveitem_std', 'give_item'],
  ['additem', 'give_item'],
  ['trainerbattle', 'start_battle'],
  ['trainerbattle_single', 'start_battle'],
  ['trainerbattle_double', 'start_battle'],
  ['trainerbattle_rematch', 'start_battle'],
  ['battle_setup_for_trainer', 'start_battle'],
  ['playse', 'play_sound'],
  ['playbgm', 'play_sound'],
  ['playfanfare', 'play_sound'],
  ['waitse', 'play_sound'],
  ['applymovement', 'move_npc'],
  ['applymovement_at', 'move_npc'],
  ['waitmovement', 'move_npc'],
  ['fadescreen', 'fade_scene'],
  ['fadescreenfast', 'fade_scene'],
  ['fadescreenspeed', 'fade_scene'],
  ['warp', 'warp_player'],
  ['warpsilent', 'warp_player'],
  ['warphole', 'warp_player'],
  ['warpwalk', 'warp_player'],
  ['warpteleport', 'warp_player'],
  ['setvar', 'set_variable'],
  ['addvar', 'set_variable'],
  ['subvar', 'set_variable'],
  ['copyvar', 'set_variable'],
  ['compare', 'set_variable'],
  ['random', 'randomize_branch'],
]);

function macroToKind(macro: string): ScriptStepKind {
  return MACRO_TO_KIND.get(macro) ?? 'raw';
}

function stripLineComment(line: string): string {
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"' && line[i - 1] !== '\\') inString = !inString;
    if (inString) continue;
    if (c === '@') return line.slice(0, i).trim();
    if (c === '/' && line[i + 1] === '/') return line.slice(0, i).trim();
  }
  return line.trim();
}

const LABEL_LINE = /^([A-Za-z_][A-Za-z0-9_]*)::?\s*$/;
const MACRO_LINE = /^([A-Za-z_][A-Za-z0-9_]*)(?:\s+(.*))?$/;

function splitArgs(argStr: string): string[] {
  // Pokemerald script arg lists are comma-separated, sometimes with quoted
  // strings (rare). Simple split is sufficient for the macros we care about;
  // a tokenizer can replace this if richer cases appear.
  if (!argStr) return [];
  const parts: string[] = [];
  let current = '';
  let inString = false;
  let parenDepth = 0;
  for (let i = 0; i < argStr.length; i++) {
    const c = argStr[i];
    if (c === '"' && argStr[i - 1] !== '\\') inString = !inString;
    if (!inString) {
      if (c === '(') parenDepth++;
      else if (c === ')') parenDepth--;
    }
    if (c === ',' && !inString && parenDepth === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += c;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function buildParams(macro: string, args: ReadonlyArray<string>): Readonly<Record<string, unknown>> {
  const params: Record<string, unknown> = { macro, args };
  switch (macro) {
    case 'msgbox':
    case 'message':
      if (args[0]) params['text'] = args[0];
      if (args[1]) params['msgboxType'] = args[1];
      break;
    case 'setflag':
    case 'clearflag':
      if (args[0]) params['flag'] = args[0];
      break;
    case 'setvar':
    case 'addvar':
    case 'subvar':
      if (args[0]) params['variable'] = args[0];
      if (args[1]) params['value'] = args[1];
      break;
    case 'copyvar':
      if (args[0]) params['dest'] = args[0];
      if (args[1]) params['source'] = args[1];
      break;
    case 'compare':
      if (args[0]) params['left'] = args[0];
      if (args[1]) params['right'] = args[1];
      break;
    case 'goto':
    case 'call':
      if (args[0]) params['label'] = args[0];
      break;
    case 'goto_if_set':
    case 'goto_if_unset':
    case 'call_if_set':
    case 'call_if_unset':
      if (args[0]) params['flag'] = args[0];
      if (args[1]) params['label'] = args[1];
      break;
    case 'goto_if_eq':
    case 'goto_if_ne':
      if (args[0]) params['value'] = args[0];
      if (args[1]) params['label'] = args[1];
      break;
    case 'goto_if':
    case 'call_if':
      if (args[0]) params['condition'] = args[0];
      if (args[1]) params['label'] = args[1];
      break;
    case 'giveitem':
    case 'giveitem_std':
    case 'additem':
      if (args[0]) params['item'] = args[0];
      if (args[1]) params['count'] = args[1];
      break;
    case 'applymovement':
    case 'applymovement_at':
    case 'waitmovement':
      if (args[0]) params['objectId'] = args[0];
      if (args[1]) params['movementId'] = args[1];
      break;
    case 'playse':
    case 'playbgm':
    case 'playfanfare':
    case 'waitse':
      if (args[0]) params['soundId'] = args[0];
      break;
    case 'warp':
    case 'warpsilent':
    case 'warphole':
    case 'warpwalk':
    case 'warpteleport':
      if (args[0]) params['mapId'] = args[0];
      if (args[1]) params['warpId'] = args[1];
      break;
    case 'fadescreen':
    case 'fadescreenfast':
    case 'fadescreenspeed':
      if (args[0]) params['fadeType'] = args[0];
      break;
    case 'random':
      if (args[0]) params['max'] = args[0];
      break;
    case 'trainerbattle':
    case 'trainerbattle_single':
    case 'trainerbattle_double':
    case 'trainerbattle_rematch':
    case 'battle_setup_for_trainer':
      if (args[0]) params['trainerId'] = args[0];
      break;
  }
  return params;
}

export interface ParsedScripts {
  readonly steps: ReadonlyArray<ScriptStep>;
  readonly labelToStepIds: ReadonlyMap<string, ReadonlyArray<EntityId>>;
}

export function parseScriptSource(source: string): ParsedScripts {
  const lines = source.split(/\r?\n/);
  const steps: ScriptStep[] = [];
  const labelToStepIds = new Map<string, EntityId[]>();
  let currentLabel: string | null = null;
  let stepIndex = 0;

  for (const rawLine of lines) {
    const cleaned = stripLineComment(rawLine);
    if (!cleaned) continue;
    if (cleaned.startsWith('.')) continue; // assembler directives (.string, .byte, etc.)
    const labelMatch = LABEL_LINE.exec(cleaned);
    if (labelMatch && labelMatch[1]) {
      currentLabel = labelMatch[1];
      stepIndex = 0;
      if (!labelToStepIds.has(currentLabel)) labelToStepIds.set(currentLabel, []);
      continue;
    }
    if (!currentLabel) continue;
    const macroMatch = MACRO_LINE.exec(cleaned);
    if (!macroMatch || !macroMatch[1]) continue;
    const macro = macroMatch[1];
    const args = splitArgs(macroMatch[2] ?? '');
    // Step ids use the `<label>__<index>` convention shared with the binary
    // decoder (binary-rom-registry.ts) and the frontend VisualScriptEditor /
    // ScriptStepsList prefix match. The `__` separator never appears in real
    // decomp symbol names (the linker requires single-underscore identifiers),
    // so it is an unambiguous synthetic delimiter.
    const id = `${currentLabel}__${stepIndex}`;
    steps.push({
      id,
      kind: macroToKind(macro),
      params: buildParams(macro, args),
    });
    labelToStepIds.get(currentLabel)!.push(id);
    stepIndex++;
  }
  return { steps, labelToStepIds };
}

async function tryReadFile(p: string): Promise<string | null> {
  try {
    return await fsp.readFile(p, 'utf8');
  } catch {
    return null;
  }
}

export interface ScriptsResult {
  readonly steps: ReadonlyArray<ScriptStep>;
  readonly labelToStepIds: ReadonlyMap<string, ReadonlyArray<EntityId>>;
  readonly warnings: ReadonlyArray<string>;
}

function labelOf(stepId: string): string {
  const cut = stepId.lastIndexOf('__');
  return cut === -1 ? stepId : stepId.slice(0, cut);
}

export async function parseScripts(projectRoot: string): Promise<ScriptsResult> {
  const allSteps: ScriptStep[] = [];
  const merged = new Map<string, EntityId[]>();
  const warnings: string[] = [];
  // Decomp symbols are globally unique (the linker forbids duplicates), so a
  // label parsed from one file must never be re-ingested from another - that
  // would mint duplicate step ids. `seen` enforces first-wins across sources;
  // maps are scanned first so map-local scripts take precedence.
  const seen = new Set<string>();

  const ingest = (src: string): void => {
    const parsed = parseScriptSource(src);
    const dup = new Set<string>();
    for (const label of parsed.labelToStepIds.keys()) {
      if (seen.has(label)) dup.add(label);
      else seen.add(label);
    }
    for (const s of parsed.steps) {
      if (!dup.has(labelOf(s.id))) allSteps.push(s);
    }
    for (const [label, ids] of parsed.labelToStepIds) {
      if (dup.has(label)) continue;
      merged.set(label, [...(merged.get(label) ?? []), ...ids]);
    }
  };

  // 1) Per-map scripts: data/maps/<Map>/scripts.inc (object-event + trigger
  //    scripts, prefixed by map name).
  const mapsDir = path.join(projectRoot, 'data', 'maps');
  try {
    const dirents = await fsp.readdir(mapsDir, { withFileTypes: true });
    for (const d of dirents) {
      if (!d.isDirectory()) continue;
      const src = await tryReadFile(path.join(mapsDir, d.name, 'scripts.inc'));
      if (src) ingest(src);
    }
  } catch {
    // data/maps absent - already warned by the map scanner.
  }

  // 2) Central shared scripts: data/scripts/*.inc (Pokémon Center nurse, PC,
  //    item balls, trainer rematch logic, gym leaders, etc.). Maps reference
  //    these by label, so without parsing them clicking such an NPC showed
  //    "No decoded steps". event_scripts.s only `.include`s these files
  //    (directive lines are skipped by the parser), so each label is parsed
  //    exactly once here.
  const scriptsDir = path.join(projectRoot, 'data', 'scripts');
  try {
    const ents = await fsp.readdir(scriptsDir, { withFileTypes: true });
    for (const d of ents) {
      if (!d.isFile() || !d.name.endsWith('.inc')) continue;
      const src = await tryReadFile(path.join(scriptsDir, d.name));
      if (src) ingest(src);
    }
  } catch {
    // no data/scripts - fine, older layouts inline everything.
  }

  // 3) Global dispatch script files (their own top-level labels).
  for (const c of [
    path.join(projectRoot, 'data', 'event_scripts.s'),
    path.join(projectRoot, 'data', 'scripts', 'event_scripts.s'),
  ]) {
    const src = await tryReadFile(c);
    if (src) ingest(src);
  }

  allSteps.sort((a, b) => a.id.localeCompare(b.id));
  return { steps: allSteps, labelToStepIds: merged, warnings };
}
