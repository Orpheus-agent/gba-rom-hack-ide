/**
 * Visual Script Editor - script-step metadata.
 *
 * The engine decodes Gen-3 script bytecode into semantic `ScriptStep`
 * entries with one of 13 `ScriptStepKind` values (dialogue, set_flag,
 * give_item, etc.). The visual scripter (Phase R / WP3) renders each
 * step as a card with a plain-English one-line summary, a category
 * colour, and an inline editor.
 *
 * This module owns:
 *   - the per-kind metadata (summary template + category + icon + colour)
 *   - the canonical Add Event category palette (modelled on GB Studio /
 *     RPG Maker MZ, narrowed to verbs Pokémon actually supports)
 *
 * It does NOT own:
 *   - the inline editor components (live in components/script/)
 *   - the propose-script-edit MCP tool (backend, WP3.4 deferred)
 *   - raw opcode → kind mapping (engine side, already done in the
 *     binary-ROM script decoder)
 *
 * Lookups go through `commandMetadata(kind)` for a single step, and
 * `commandsByCategory()` for the Add Event popover. Both are pure.
 */

import type { ProjectManifest, ScriptStep, ScriptStepKind } from '@rom-editor/shared';
import { resolveDisplayName } from './displayName';
import { resolveUniversalSymbol } from './symbols';

/** The 14 categories of "things a script can do" the user picks from
 *  in the Add Event popover. Mirrors GB Studio's category palette
 *  filtered for what Gen-3 Pokémon scripts actually express. */
export type ScriptCommandCategory =
  | 'text'
  | 'flow'
  | 'flags_vars'
  | 'party'
  | 'inventory'
  | 'battle'
  | 'movement'
  | 'npc'
  | 'camera'
  | 'screen'
  | 'audio'
  | 'scene'
  | 'system'
  | 'advanced';

interface CategoryMetadata {
  readonly id: ScriptCommandCategory;
  readonly label: string;
  readonly description: string;
  /** Colour for the left-border accent on every card in this category. */
  readonly color: string;
}

export const SCRIPT_COMMAND_CATEGORIES: ReadonlyArray<CategoryMetadata> = [
  { id: 'text', label: 'Text & Dialogue', description: 'Show dialogue, signs, choices', color: '#4a9eff' },
  { id: 'flow', label: 'Flow', description: 'If, loop, branch, jump', color: '#b46aff' },
  { id: 'flags_vars', label: 'Flags & Variables', description: 'Set / clear / check story state', color: '#50c878' },
  { id: 'party', label: 'Party', description: 'Give Pokémon, heal, teach moves', color: '#5dade2' },
  { id: 'inventory', label: 'Inventory', description: 'Give / take items, money', color: '#f0b429' },
  { id: 'battle', label: 'Battle', description: 'Trainer battles, wild encounters', color: '#a83d3d' },
  { id: 'movement', label: 'Movement', description: 'Move NPCs, warps, lock player', color: '#5dade2' },
  { id: 'npc', label: 'NPC', description: 'Show, hide, change sprite, change movement', color: '#94c45d' },
  { id: 'camera', label: 'Camera', description: 'Pan, lock, shake', color: '#7c8088' },
  { id: 'screen', label: 'Screen', description: 'Fade, weather, flash', color: '#7c8088' },
  { id: 'audio', label: 'Audio', description: 'Music, sound effects, fanfares', color: '#7c8088' },
  { id: 'scene', label: 'Scene', description: 'Open PC, shop, menu, game over', color: '#c98a3d' },
  { id: 'system', label: 'System', description: 'Set time of day, mart inventory, badges', color: '#c98a3d' },
  { id: 'advanced', label: 'Advanced', description: 'Engine-internal commands', color: '#7c8088' },
] as const;

const CATEGORY_BY_ID: Readonly<Record<ScriptCommandCategory, CategoryMetadata>> =
  Object.fromEntries(SCRIPT_COMMAND_CATEGORIES.map((c) => [c.id, c])) as Readonly<
    Record<ScriptCommandCategory, CategoryMetadata>
  >;

export interface ScriptCommandMetadata {
  /** Engine-decoded kind this metadata applies to. */
  readonly kind: ScriptStepKind;
  /** Category for grouping in the Add Event popover. */
  readonly category: ScriptCommandCategory;
  /** Short human verb shown on a card when params can't be summarized
   *  (fallback when summarize() returns null). */
  readonly defaultLabel: string;
  /** Emoji icon shown on the card. */
  readonly icon: string;
  /** Generates the one-line plain-English summary using the step's
   *  params + manifest lookups. Return null to fall back to defaultLabel. */
  readonly summarize: (step: ScriptStep, manifest: ProjectManifest) => string | null;
}

/** Helper: look up an entity reference id in the manifest and return
 *  its prettified display name. Falls back to the raw id if not found. */
function nameOf(manifest: ProjectManifest, id: string | undefined | null): string {
  if (!id) return ' - ';
  return resolveDisplayName(manifest, id).text;
}

/** Helper: param-getter (params is `Record<string, unknown>`). */
function strParam(step: ScriptStep, key: string): string | null {
  const v = step.params[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}
function numParam(step: ScriptStep, key: string): number | null {
  const v = step.params[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Phase 2B - pretty symbols for branch_on_var operators. Keep in sync
 *  with backend's BranchOperator + engine's BRANCH_OPERATOR_SYMBOLS. */
const OPERATOR_SYMBOLS: Readonly<Record<string, string>> = {
  less: '<',
  equal: '=',
  greater: '>',
  lessorequal: '≤',
  greaterorequal: '≥',
  notequal: '≠',
};

const REGISTRY: Readonly<Record<ScriptStepKind, ScriptCommandMetadata>> = {
  dialogue: {
    kind: 'dialogue',
    category: 'text',
    defaultLabel: 'Show dialogue',
    icon: '💬',
    summarize: (step) => {
      const text = strParam(step, 'dialogueText');
      if (!text) return 'Show dialogue';
      const preview = text.length > 60 ? `${text.slice(0, 57).trim()}…` : text;
      return `Show dialogue - "${preview}"`;
    },
  },
  set_flag: {
    kind: 'set_flag',
    category: 'flags_vars',
    defaultLabel: 'Mark story flag as done',
    icon: '🚩',
    summarize: (step, manifest) => {
      const flagId = strParam(step, 'flagId');
      const flagName = flagId ? nameOf(manifest, flagId) : null;
      return flagName ? `Mark "${flagName}" as done` : 'Mark a story flag as done';
    },
  },
  clear_flag: {
    kind: 'clear_flag',
    category: 'flags_vars',
    defaultLabel: 'Reset story flag',
    icon: '🏳️',
    summarize: (step, manifest) => {
      const flagId = strParam(step, 'flagId');
      const flagName = flagId ? nameOf(manifest, flagId) : null;
      return flagName ? `Reset "${flagName}"` : 'Reset a story flag';
    },
  },
  branch: {
    kind: 'branch',
    category: 'flow',
    defaultLabel: 'If condition…',
    icon: '🔀',
    summarize: (step, manifest) => {
      const condition = strParam(step, 'conditionExpression');
      if (condition) return `If ${prettifyCondition(condition, manifest)}…`;
      const flagId = strParam(step, 'flagId');
      if (flagId) {
        const flagName = nameOf(manifest, flagId);
        return `If "${flagName}" is set…`;
      }
      return 'If condition…';
    },
  },
  branch_on_var: {
    kind: 'branch_on_var',
    category: 'flow',
    defaultLabel: 'If story number…',
    icon: '🔀',
    summarize: (step, manifest) => {
      // Phase 2B - the load-bearing primitive for Resonance Alignment.
      // Renders as "If VAR_NAME <op> N → jump" with op shown as a glyph.
      const varId = numParam(step, 'varId');
      const value = numParam(step, 'value');
      const operator = strParam(step, 'operator');
      const symbol = operator
        ? OPERATOR_SYMBOLS[operator as keyof typeof OPERATOR_SYMBOLS] ?? operator
        : '?';
      const varName = varId !== null
        ? nameOf(manifest, `var_0x${varId.toString(16)}`)
        : null;
      if (varName && varName !== ' - ' && value !== null) {
        return `If ${varName} ${symbol} ${String(value)} - jump`;
      }
      if (varId !== null && value !== null) {
        return `If var 0x${varId.toString(16)} ${symbol} ${String(value)} - jump`;
      }
      return 'If story number…';
    },
  },
  give_item: {
    kind: 'give_item',
    category: 'inventory',
    defaultLabel: 'Give item',
    icon: '🎁',
    summarize: (step, manifest) => {
      const itemId = strParam(step, 'itemId');
      const quantity = numParam(step, 'quantity') ?? 1;
      if (!itemId) return 'Give an item';
      const itemName = nameOf(manifest, itemId);
      return quantity > 1
        ? `Give ${String(quantity)} × ${itemName}`
        : `Give ${itemName}`;
    },
  },
  start_battle: {
    kind: 'start_battle',
    category: 'battle',
    defaultLabel: 'Start trainer battle',
    icon: '⚔️',
    summarize: (step, manifest) => {
      const trainerId = strParam(step, 'trainerId');
      if (!trainerId) return 'Start a battle';
      const trainerName = nameOf(manifest, trainerId);
      return `Battle ${trainerName}`;
    },
  },
  play_sound: {
    kind: 'play_sound',
    category: 'audio',
    defaultLabel: 'Play sound effect',
    icon: '🔊',
    summarize: (step, manifest) => {
      const soundId = strParam(step, 'soundId');
      if (!soundId) return 'Play a sound';
      const name = nameOf(manifest, soundId);
      return `Play sound - ${name}`;
    },
  },
  move_npc: {
    kind: 'move_npc',
    category: 'movement',
    defaultLabel: 'Move NPC',
    icon: '🚶',
    summarize: (step, manifest) => {
      const objectId = strParam(step, 'objectId');
      const target = objectId ? nameOf(manifest, objectId) : 'NPC';
      const steps = numParam(step, 'stepCount');
      if (steps !== null) {
        return `${target} performs ${String(steps)}-step movement`;
      }
      return `${target} performs a movement sequence`;
    },
  },
  fade_scene: {
    kind: 'fade_scene',
    category: 'screen',
    defaultLabel: 'Fade screen',
    icon: '🌓',
    summarize: (step) => {
      const direction = strParam(step, 'direction');
      if (direction === 'in') return 'Fade in from black';
      if (direction === 'out') return 'Fade out to black';
      return 'Fade screen';
    },
  },
  warp_player: {
    kind: 'warp_player',
    category: 'movement',
    defaultLabel: 'Warp player',
    icon: '🚪',
    summarize: (step, manifest) => {
      const destMapId = strParam(step, 'destMapId');
      const x = numParam(step, 'destX');
      const y = numParam(step, 'destY');
      if (!destMapId) return 'Warp player';
      const mapName = nameOf(manifest, destMapId);
      if (x !== null && y !== null) {
        return `Warp player to ${mapName} (${String(x)}, ${String(y)})`;
      }
      return `Warp player to ${mapName}`;
    },
  },
  set_variable: {
    kind: 'set_variable',
    category: 'flags_vars',
    defaultLabel: 'Set story number',
    icon: '🔢',
    summarize: (step, manifest) => {
      const varId = strParam(step, 'varId');
      const value = numParam(step, 'value');
      if (!varId) return 'Set a story number';
      const varName = nameOf(manifest, varId);
      if (value !== null) return `Set "${varName}" to ${String(value)}`;
      return `Update "${varName}"`;
    },
  },
  randomize_branch: {
    kind: 'randomize_branch',
    category: 'flow',
    defaultLabel: 'Random choice',
    icon: '🎲',
    summarize: () => 'Pick a random branch',
  },
  raw: {
    kind: 'raw',
    category: 'advanced',
    defaultLabel: 'Engine command',
    icon: '⚙️',
    summarize: (step) => {
      const opcode = numParam(step, 'opcode');
      if (opcode === null) return 'Engine command (advanced)';
      // Look up the opcode in the universal script-command registry - 
      // turns "Engine command 0x6c" into "Show dialogue (engine-level)"
      // for opcodes we have plain-English names for.
      const entry = resolveUniversalSymbol('script_command', opcode);
      if (entry) return `Engine command - ${entry.name}`;
      return `Engine command (advanced)`;
    },
  },
};

/** Returns metadata for a given step kind. Always returns a record
 *  (the raw entry is a safe fallback for any unmapped kind). */
export function commandMetadata(kind: ScriptStepKind): ScriptCommandMetadata {
  return REGISTRY[kind] ?? REGISTRY.raw;
}

/** Returns the plain-English one-line summary for a step. Uses the
 *  per-kind summarize() function, falling back to the kind's
 *  defaultLabel. Never returns an empty string. */
export function summarizeStep(step: ScriptStep, manifest: ProjectManifest): string {
  const meta = commandMetadata(step.kind);
  const result = meta.summarize(step, manifest);
  if (result && result.length > 0) return result;
  return meta.defaultLabel;
}

/** Returns category metadata for a step (drives left-border colour,
 *  category label chip, etc.). */
export function categoryFor(kind: ScriptStepKind): CategoryMetadata {
  return CATEGORY_BY_ID[commandMetadata(kind).category];
}

/** Returns the registry grouped by category, in the canonical category
 *  order. Used by the AddEventPopover. */
export function commandsByCategory(): ReadonlyArray<{
  readonly category: CategoryMetadata;
  readonly commands: ReadonlyArray<ScriptCommandMetadata>;
}> {
  const grouped = new Map<ScriptCommandCategory, ScriptCommandMetadata[]>();
  for (const meta of Object.values(REGISTRY)) {
    const arr = grouped.get(meta.category) ?? [];
    arr.push(meta);
    grouped.set(meta.category, arr);
  }
  return SCRIPT_COMMAND_CATEGORIES.map((c) => ({
    category: c,
    commands: grouped.get(c.id) ?? [],
  })).filter((g) => g.commands.length > 0);
}

/** Prettify a raw condition string for display in a branch card. The
 *  engine emits expressions like "VAR_RESULT == 1" or "checkflag 0x828
 *  == true". This turns the hex constants into plain English. */
function prettifyCondition(expr: string, manifest: ProjectManifest): string {
  // Match: `flag(<id>)`, `var(<id>)`, `<id> == <val>`, etc.
  // Conservative: only swap obvious `flag_0xNNNN` / `var_0xNNNN` /
  // `checkflag <id>` patterns; leave the rest alone so we don't
  // mangle user-written expressions.
  return expr.replace(/\b(flag|var)_(0x[0-9a-fA-F]+|\d+)\b/g, (_, kind, id) => {
    const synth = `${kind}_${id}`;
    return nameOf(manifest, synth);
  });
}
