// Design-lint engine - runs typed quality rules over the canonical manifest
// and produces severity-tagged findings. Reused from the existing per-entity
// reference lookups (FlagsView's findReferences, AssetsView's
// findAssetReferences) so the rules walk the manifest once with O(N) cost.
//
// Rules are deliberately conservative - every finding either points at a
// real broken reference (orphan dialogue, empty trigger) or at a genuine
// dead state (unused flag, orphan asset). False positives waste the writer's
// attention; we'd rather have fewer, more honest warnings.

import type { ProjectManifest } from '@rom-editor/shared';
import { findAssetReferences } from './assetReferences';

export type LintRuleId =
  | 'orphan_dialogue'
  | 'unused_flag'
  | 'orphan_asset'
  | 'empty_trigger'
  | 'decorative_object';

export type LintSeverity = 'warn' | 'info';

export interface LintFinding {
  readonly ruleId: LintRuleId;
  readonly severity: LintSeverity;
  readonly entityId: string;
  readonly entityKind:
    | 'dialogue'
    | 'flag'
    | 'asset'
    | 'trigger'
    | 'object_event';
  readonly message: string;
}

export interface LintReport {
  readonly findings: ReadonlyArray<LintFinding>;
  readonly countsBySeverity: Readonly<Record<LintSeverity, number>>;
  readonly countsByRule: Readonly<Partial<Record<LintRuleId, number>>>;
}

const RULE_LABELS: Readonly<Record<LintRuleId, string>> = {
  orphan_dialogue: 'Orphan dialogue',
  unused_flag: 'Unused flag',
  orphan_asset: 'Orphan asset',
  empty_trigger: 'Empty trigger',
  decorative_object: 'Decorative-or-broken object event',
};

export function lintRuleLabel(id: LintRuleId): string {
  return RULE_LABELS[id];
}

export function runDesignLint(manifest: ProjectManifest): LintReport {
  const findings: LintFinding[] = [];

  // Phase I.3.5 - binary-ROM projects lack the decomp-style msgbox →
  // dialogue-id linkage these rules expect. The script decoder emits
  // `dialogueText` (the decoded string) but never the original synthetic
  // dialogue id, so every binary `binary_text_*` dialogue node would
  // light up as orphan (yielding the 469-finding flood the user saw on
  // vanilla FireRed). Same story for assets + decorative-object events:
  // the cross-ref graph that decomp builds line-by-line in scripts.inc
  // doesn't exist when we ingest from raw bytes. Skip the noisy rules
  // for binary entities until the cross-ref pass linking decoded
  // msgbox-text → dialogue-id is in place.
  const isBinaryEntity = (id: string): boolean =>
    id.startsWith('binary_') || id.startsWith('script_0x') ||
    id.startsWith('gfx_') || id.startsWith('tileset_0x');

  // -- Orphan dialogue ------------------------------------------------------
  // A DialogueNode is orphan when (a) no ScriptStep's params.text equals its
  // id AND (b) no other DialogueNode's choices[*].nextDialogueId points to
  // it. We collect both lookup sets once.
  const calledByScriptIds = new Set<string>();
  for (const s of manifest.scriptSteps) {
    if (s.kind === 'dialogue' && typeof s.params['text'] === 'string') {
      calledByScriptIds.add(s.params['text'] as string);
    }
  }
  const linkedByDialogueIds = new Set<string>();
  for (const d of manifest.dialogue) {
    for (const c of d.choices) {
      if (c.nextDialogueId) linkedByDialogueIds.add(c.nextDialogueId);
    }
  }
  for (const d of manifest.dialogue) {
    if (isBinaryEntity(d.id)) continue; // Phase I.3.5 - see note above.
    if (!calledByScriptIds.has(d.id) && !linkedByDialogueIds.has(d.id)) {
      findings.push({
        ruleId: 'orphan_dialogue',
        severity: 'warn',
        entityId: d.id,
        entityKind: 'dialogue',
        message: `No script step references ${d.id} and no dialogue choice points to it. The player will never see this line.`,
      });
    }
  }

  // -- Unused flag ----------------------------------------------------------
  const flagsReferenced = new Set<string>();
  for (const o of manifest.objectEvents) {
    if (o.flagId) flagsReferenced.add(o.flagId);
  }
  for (const s of manifest.scriptSteps) {
    const f = s.params['flag'];
    if (typeof f === 'string') flagsReferenced.add(f);
    const cond = s.params['condition'];
    if (typeof cond === 'string') flagsReferenced.add(cond);
    // args[] fallback for flag-shaped identifiers that buildParams didn't break
    // out into a named param.
    const args = s.params['args'];
    if (Array.isArray(args)) {
      for (const a of args) {
        if (typeof a === 'string' && a.startsWith('FLAG_')) flagsReferenced.add(a);
      }
    }
  }
  for (const d of manifest.dialogue) {
    for (const c of d.choices) {
      for (const fid of c.setsFlagIds) flagsReferenced.add(fid);
    }
  }
  for (const f of manifest.flags) {
    if (isBinaryEntity(f.id)) continue;
    if (!flagsReferenced.has(f.id)) {
      findings.push({
        ruleId: 'unused_flag',
        severity: 'warn',
        entityId: f.id,
        entityKind: 'flag',
        message: `Flag ${f.id} (${f.engineValue}) is declared but nothing references it - dead state.`,
      });
    }
  }

  // -- Orphan asset ---------------------------------------------------------
  for (const a of manifest.assets) {
    if (isBinaryEntity(a.id)) continue;
    const refs = findAssetReferences(manifest, a.id);
    const total =
      refs.maps.length +
      refs.objectEvents.length +
      refs.dialogueNodes.length +
      refs.scriptSteps.length;
    if (total === 0) {
      findings.push({
        ruleId: 'orphan_asset',
        severity: 'warn',
        entityId: a.id,
        entityKind: 'asset',
        message: `Asset ${a.id} (${a.kind}) at ${a.relativePath} is not referenced by any map / event / dialogue / script.`,
      });
    }
  }

  // -- Empty trigger --------------------------------------------------------
  for (const t of manifest.triggers) {
    if (isBinaryEntity(t.id)) continue;
    if (t.scriptStepIds.length === 0) {
      findings.push({
        ruleId: 'empty_trigger',
        severity: 'warn',
        entityId: t.id,
        entityKind: 'trigger',
        message: `Trigger ${t.id} has no resolved script steps - it will fire and do nothing.`,
      });
    }
  }

  // -- Decorative-or-broken object event ------------------------------------
  for (const o of manifest.objectEvents) {
    if (isBinaryEntity(o.id)) continue;
    if (o.scriptId === null && o.flagId === null) {
      findings.push({
        ruleId: 'decorative_object',
        severity: 'info',
        entityId: o.id,
        entityKind: 'object_event',
        message: `Object event ${o.id} (${o.kind} on ${o.mapId}) has no script + no flag - purely decorative, or a missing wire.`,
      });
    }
  }

  // -- Counts ---------------------------------------------------------------
  const countsBySeverity: Record<LintSeverity, number> = { warn: 0, info: 0 };
  const countsByRule: Partial<Record<LintRuleId, number>> = {};
  for (const f of findings) {
    countsBySeverity[f.severity] += 1;
    countsByRule[f.ruleId] = (countsByRule[f.ruleId] ?? 0) + 1;
  }

  return { findings, countsBySeverity, countsByRule };
}
