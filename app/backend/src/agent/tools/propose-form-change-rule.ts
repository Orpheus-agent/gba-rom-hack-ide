/**
 * propose_form_change_rule - Phase 2E Filing 1.
 *
 * Registers a "this species holds this item → it transforms into that
 * form" rule. The CFRU dispatcher `HoldItemFormChange()` in
 * `src/form_change.c` is the registry; each rule is a `{ speciesId,
 * heldItemId, targetSpeciesId }` triple.
 *
 * Implementation note (deliberately pragmatic):
 *
 *   The HoldItemFormChange function is a 200+ line C switch with lots
 *   of conditional defines and nested logic. Auto-injecting new cases
 *   would be fragile. Instead this tool:
 *
 *     1. Validates the rule (species/item ids exist; oneWay opt-in for
 *        non-bidirectional rules).
 *     2. Persists the rule to <projectRoot>/.editor/form-change-rules.json
 *        so the editor + agent share a single source of truth across
 *        sessions.
 *     3. Generates a paste-ready C snippet (case branches for both the
 *        base→target and target→base directions) the user pastes into
 *        the HoldItemFormChange switch.
 *     4. For one-way rules, also generates an entry the user pastes
 *        into sBannedBackupSpecies (so the target form doesn't revert
 *        on PC deposit).
 *
 *   When this becomes a frequent flow - say after the user has 5+
 *   rules - we can layer in auto-injection. For now the snippet path
 *   keeps complexity low and the user in full control of the source.
 */

import { z } from 'zod';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { ToolContext } from '../types.js';

export const PROPOSE_FORM_CHANGE_RULE_TOOL_NAME = 'propose_form_change_rule';

export const PROPOSE_FORM_CHANGE_RULE_DESCRIPTION =
  'Register a signature-item-driven form change. Example: Zacian + ' +
  'Rusted Sword → Crowned Sword. Used to wire dynamic-legendary ' +
  'transforms keyed off a held item.\n\n' +
  'Inputs:\n' +
  '  - `speciesId`: symbolic species constant of the BASE form ' +
  '(e.g. "SPECIES_ZACIAN").\n' +
  '  - `heldItemId`: symbolic item constant of the catalyst item ' +
  '(e.g. "ITEM_RUSTED_SWORD"). The CFRU engine reads ' +
  'ItemId_GetHoldEffect(item).\n' +
  '  - `targetSpeciesId`: symbolic species constant of the ' +
  'TRANSFORMED form (e.g. "SPECIES_ZACIAN_CROWNED").\n' +
  '  - `notes`: optional free-form note shown in the inspector.\n' +
  '  - `oneWay`: when true, the rule is permanent (no revert on item ' +
  'detach). Default false. One-way rules also require the target ' +
  'species to be in sBannedBackupSpecies so PC deposit doesn\'t ' +
  'revert - the tool surfaces the snippet for that.\n\n' +
  'Behaviour:\n' +
  '  1. Validates ids are non-empty + match SPECIES_/ITEM_ shape.\n' +
  '  2. Persists the rule to `<projectRoot>/.editor/form-change-rules.json` ' +
  '(appends if the file exists; replaces an existing rule with the ' +
  'same speciesId+heldItemId tuple).\n' +
  '  3. Returns a paste-ready C snippet for the user to add to ' +
  'HoldItemFormChange in CFRU\'s `src/form_change.c`. For one-way ' +
  'rules, also returns a snippet for sBannedBackupSpecies.\n' +
  '  4. Returns the next-step prompt: paste the snippet, re-run ' +
  '`scripts/build-cfru-bundle.mjs`, re-modernize a fresh ROM to see ' +
  'the new rule in-game.\n\n' +
  'The tool does NOT directly edit form_change.c - the function is a ' +
  '200+ line switch with many conditional defines, and auto-injecting ' +
  'cases would be fragile. Pasting one or two case branches is fast ' +
  'and keeps you in control of the C source.';

const symbolicId = z.string().min(1).max(80);

export const proposeFormChangeRuleInputShape = {
  speciesId: symbolicId,
  heldItemId: symbolicId,
  targetSpeciesId: symbolicId,
  notes: z.string().max(500).optional(),
  oneWay: z.boolean().optional(),
} as const;

export interface ProposeFormChangeRuleResult {
  readonly ok: boolean;
  readonly rule: {
    readonly id: string;
    readonly speciesId: string;
    readonly heldItemId: string;
    readonly targetSpeciesId: string;
    readonly oneWay: boolean;
    readonly notes: string | null;
  } | null;
  readonly persistedRulesPath: string | null;
  readonly totalRulesAfterApply: number;
  readonly cSnippet: string | null;
  readonly bannedBackupSnippet: string | null;
  readonly nextStep: string;
  readonly message: string;
}

interface StoredRule {
  readonly id: string;
  readonly speciesId: string;
  readonly heldItemId: string;
  readonly targetSpeciesId: string;
  readonly oneWay: boolean;
  readonly notes: string | null;
}

interface StoredRulesFile {
  readonly schemaVersion: 1;
  readonly rules: StoredRule[];
}

/** Validate a symbolic id looks like a CFRU constant (`SPECIES_*` /
 *  `ITEM_*`). Symbolic shape check is exported for tests. */
export function isLikelySpeciesId(id: string): boolean {
  return /^SPECIES_[A-Z0-9_]+$/.test(id);
}

export function isLikelyItemId(id: string): boolean {
  return /^ITEM_[A-Z0-9_]+$/.test(id);
}

/** Build the deterministic id for a rule from its key fields. Used as
 *  the dedup key in form-change-rules.json. */
export function buildRuleId(speciesId: string, heldItemId: string): string {
  return `form_change_${speciesId}_${heldItemId}`;
}

async function readStoredRules(filePath: string): Promise<StoredRule[]> {
  try {
    const raw = await fsp.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as StoredRulesFile;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      Array.isArray(parsed.rules)
    ) {
      return parsed.rules.filter((r) => typeof r?.id === 'string');
    }
  } catch {
    // File doesn't exist or isn't valid JSON. Treat as empty.
  }
  return [];
}

async function writeStoredRules(
  filePath: string,
  rules: ReadonlyArray<StoredRule>,
): Promise<void> {
  const file: StoredRulesFile = {
    schemaVersion: 1,
    rules: [...rules],
  };
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  // Atomic write: tmp + rename.
  const tmp = `${filePath}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(file, null, 2), 'utf8');
  await fsp.rename(tmp, filePath);
}

/** Build the paste-ready C snippet for HoldItemFormChange. Emits both
 *  the forward (species → target on attach) and reverse (target →
 *  species on detach) case branches; the reverse branch is omitted for
 *  one-way rules.
 *
 *  Exported for tests. */
export function buildCSnippet(rule: StoredRule, heldItemEffect: string): string {
  const reverseSection = rule.oneWay
    ? `\t\t// (one-way rule - no revert on detach)\n`
    : `\n\t\tcase ${rule.targetSpeciesId}:\n` +
      `\t\t\tif (itemEffect != ${heldItemEffect})\n` +
      `\t\t\t\ttargetSpecies = ${rule.speciesId};\n` +
      `\t\t\tbreak;\n`;
  return (
    `// Phase 2E form-change rule: ${rule.speciesId} + ${rule.heldItemId} ↔ ${rule.targetSpeciesId}\n` +
    `// Paste these case branches into HoldItemFormChange() in CFRU's src/form_change.c.\n` +
    `\t\tcase ${rule.speciesId}:\n` +
    `\t\t\tif (itemEffect == ${heldItemEffect})\n` +
    `\t\t\t\ttargetSpecies = ${rule.targetSpeciesId};\n` +
    `\t\t\tbreak;\n` +
    reverseSection
  );
}

/** Build the sBannedBackupSpecies entry for the target species. Only
 *  emitted for one-way rules; bidirectional rules naturally revert via
 *  the dispatcher and don't need the ban. */
export function buildBannedBackupSnippet(rule: StoredRule): string {
  return (
    `// Phase 2E: add this to sBannedBackupSpecies in CFRU's src/form_change.c\n` +
    `// so the one-way ${rule.targetSpeciesId} form doesn't revert on PC deposit.\n` +
    `\t${rule.targetSpeciesId},\n`
  );
}

/** Synthesize the "ItemId_GetHoldEffect" symbolic constant for a given
 *  item. CFRU uses ITEM_EFFECT_* constants that don't map 1:1 with
 *  ITEM_* names. Without scraping items.h's hold-effect table we
 *  approximate: replace the leading "ITEM_" with "ITEM_EFFECT_". The
 *  user can adjust the snippet before pasting. */
function inferItemEffectConstant(itemId: string): string {
  if (itemId.startsWith('ITEM_')) {
    return `ITEM_EFFECT_${itemId.slice('ITEM_'.length)}`;
  }
  return `ITEM_EFFECT_${itemId}`;
}

export async function proposeFormChangeRule(
  ctx: ToolContext,
  args: {
    speciesId: string;
    heldItemId: string;
    targetSpeciesId: string;
    notes?: string;
    oneWay?: boolean;
  },
): Promise<ProposeFormChangeRuleResult> {
  // ── 1. Validate symbolic ids ────────────────────────────────────
  if (!isLikelySpeciesId(args.speciesId)) {
    return failure(`speciesId "${args.speciesId}" doesn't match the SPECIES_<NAME> pattern. Pass a symbolic CFRU species constant (e.g. SPECIES_ZACIAN).`);
  }
  if (!isLikelySpeciesId(args.targetSpeciesId)) {
    return failure(`targetSpeciesId "${args.targetSpeciesId}" doesn't match the SPECIES_<NAME> pattern. Pass a symbolic CFRU species constant (e.g. SPECIES_ZACIAN_CROWNED).`);
  }
  if (!isLikelyItemId(args.heldItemId)) {
    return failure(`heldItemId "${args.heldItemId}" doesn't match the ITEM_<NAME> pattern. Pass a symbolic CFRU item constant (e.g. ITEM_RUSTED_SWORD).`);
  }
  if (args.speciesId === args.targetSpeciesId) {
    return failure(`speciesId and targetSpeciesId are the same (${args.speciesId}). A form-change rule needs DIFFERENT base + target species.`);
  }
  const oneWay = args.oneWay ?? false;

  // ── 2. Persist the rule ────────────────────────────────────────
  const id = buildRuleId(args.speciesId, args.heldItemId);
  const rule: StoredRule = {
    id,
    speciesId: args.speciesId,
    heldItemId: args.heldItemId,
    targetSpeciesId: args.targetSpeciesId,
    oneWay,
    notes: args.notes ?? null,
  };
  const rulesPath = path.join(ctx.projectRoot, '.editor', 'form-change-rules.json');
  let stored: StoredRule[] = [];
  try {
    stored = await readStoredRules(rulesPath);
  } catch {
    stored = [];
  }
  const existingIndex = stored.findIndex((r) => r.id === id);
  if (existingIndex >= 0) {
    stored.splice(existingIndex, 1, rule);
  } else {
    stored.push(rule);
  }
  let persistedRulesPath: string | null = null;
  try {
    await writeStoredRules(rulesPath, stored);
    persistedRulesPath = rulesPath;
  } catch (e) {
    return {
      ok: false,
      rule: null,
      persistedRulesPath: null,
      totalRulesAfterApply: 0,
      cSnippet: null,
      bannedBackupSnippet: null,
      nextStep: '',
      message: `Could not persist rules at ${rulesPath} - ${e instanceof Error ? e.message : String(e)}.`,
    };
  }

  // ── 3. Generate snippets ───────────────────────────────────────
  const itemEffectConstant = inferItemEffectConstant(args.heldItemId);
  const cSnippet = buildCSnippet(rule, itemEffectConstant);
  const bannedBackupSnippet = oneWay ? buildBannedBackupSnippet(rule) : null;

  // ── 4. Return ─────────────────────────────────────────────────
  return {
    ok: true,
    rule,
    persistedRulesPath,
    totalRulesAfterApply: stored.length,
    cSnippet,
    bannedBackupSnippet,
    nextStep:
      `1. Open ${path.normalize('C:\\path\\to\\Complete-Fire-Red-Upgrade-master\\Complete-Fire-Red-Upgrade-master\\src\\form_change.c')} and paste the C snippet above into the HoldItemFormChange switch.` +
      (oneWay ? ` 2. Also paste the sBannedBackupSpecies entry into the table at the top of the same file.` : '') +
      ` ${oneWay ? '3' : '2'}. Run \`node scripts/build-cfru-bundle.mjs --vanilla-rom <vanilla-rom-path>\`.` +
      ` ${oneWay ? '4' : '3'}. Re-modernize a fresh vanilla ROM to pick up the new bundled patch.`,
    message:
      `Registered ${oneWay ? 'one-way ' : ''}form-change rule ${args.speciesId} + ${args.heldItemId} → ${args.targetSpeciesId}. ` +
      `${String(stored.length)} rule${stored.length === 1 ? '' : 's'} on file at ${rulesPath}.`,
  };
}

function failure(message: string): ProposeFormChangeRuleResult {
  return {
    ok: false,
    rule: null,
    persistedRulesPath: null,
    totalRulesAfterApply: 0,
    cSnippet: null,
    bannedBackupSnippet: null,
    nextStep: '',
    message,
  };
}
