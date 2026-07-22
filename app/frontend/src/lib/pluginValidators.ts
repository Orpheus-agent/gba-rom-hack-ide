// Plugin validator runtime. Evaluates the declarative ValidatorPredicates
// from each loaded PluginManifest against the canonical ProjectManifest and
// produces typed PluginFindings. The output shape intentionally mirrors the
// built-in LintFinding shape (severity, entityKind, entityId, message) so the
// LintView can render them in the same grouped UI alongside the built-in
// rules, with a "from plugin X" badge for provenance.

import type {
  PluginManifest,
  ProjectEntityKind,
  ProjectManifest,
  ValidatorExtension,
  ValidatorPredicate,
} from '@rom-editor/shared';

export type PluginFindingSeverity = 'warn' | 'info';

export interface PluginFinding {
  readonly pluginId: string;
  readonly ruleId: string;
  readonly severity: PluginFindingSeverity;
  readonly entityKind: ProjectEntityKind;
  readonly entityId: string;
  readonly message: string;
}

export interface PluginFindingReport {
  readonly findings: ReadonlyArray<PluginFinding>;
  readonly countsByPlugin: Readonly<Record<string, number>>;
  readonly countsBySeverity: Readonly<Record<PluginFindingSeverity, number>>;
}

interface EntityRef {
  readonly id: string;
  readonly raw: Record<string, unknown>;
}

function listEntities(
  manifest: ProjectManifest,
  kind: ProjectEntityKind,
): ReadonlyArray<EntityRef> {
  switch (kind) {
    case 'map':
      return manifest.maps.map((m) => ({ id: m.id, raw: m as unknown as Record<string, unknown> }));
    case 'warp':
      return manifest.warps.map((m) => ({ id: m.id, raw: m as unknown as Record<string, unknown> }));
    case 'trigger':
      return manifest.triggers.map((m) => ({ id: m.id, raw: m as unknown as Record<string, unknown> }));
    case 'objectEvent':
      return manifest.objectEvents.map((m) => ({ id: m.id, raw: m as unknown as Record<string, unknown> }));
    case 'flag':
      return manifest.flags.map((m) => ({ id: m.id, raw: m as unknown as Record<string, unknown> }));
    case 'variable':
      return manifest.variables.map((m) => ({ id: m.id, raw: m as unknown as Record<string, unknown> }));
    case 'encounterTable':
      return manifest.encounterTables.map((m) => ({ id: m.id, raw: m as unknown as Record<string, unknown> }));
    case 'trainer':
      return manifest.trainers.map((m) => ({ id: m.id, raw: m as unknown as Record<string, unknown> }));
    case 'dialogue':
      return manifest.dialogue.map((m) => ({ id: m.id, raw: m as unknown as Record<string, unknown> }));
    case 'asset':
      return manifest.assets.map((m) => ({ id: m.id, raw: m as unknown as Record<string, unknown> }));
    case 'scriptStep':
      return manifest.scriptSteps.map((m) => ({ id: m.id, raw: m as unknown as Record<string, unknown> }));
  }
}

function entityIdSet(manifest: ProjectManifest, kind: ProjectEntityKind): Set<string> {
  return new Set(listEntities(manifest, kind).map((e) => e.id));
}

// fieldPath walks dot-separated nested properties on a JSON-shaped object,
// returning the leaf value or undefined if any segment is missing. Used by
// entity_count.filter, entity_reference_required.referenceFieldPath, and
// field_pattern.fieldPath to express e.g. 'params.flag' or 'coord.x'.
function getFieldByPath(raw: Record<string, unknown>, fieldPath: string): unknown {
  const parts = fieldPath.split('.');
  let cur: unknown = raw;
  for (const part of parts) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function evalPredicate(
  manifest: ProjectManifest,
  predicate: ValidatorPredicate,
  ext: ValidatorExtension,
  pluginId: string,
): PluginFinding[] {
  const out: PluginFinding[] = [];
  switch (predicate.kind) {
    case 'entity_pattern': {
      let regex: RegExp;
      try {
        regex = new RegExp(predicate.idPattern);
      } catch {
        return out;
      }
      for (const e of listEntities(manifest, predicate.entityKind)) {
        if (regex.test(e.id)) {
          out.push({
            pluginId,
            ruleId: ext.ruleId,
            severity: ext.severity,
            entityKind: predicate.entityKind,
            entityId: e.id,
            message: ext.message,
          });
        }
      }
      return out;
    }
    case 'entity_count': {
      const all = listEntities(manifest, predicate.entityKind);
      let matched = all;
      if (predicate.filter) {
        const { fieldPath, equals } = predicate.filter;
        matched = all.filter((e) => getFieldByPath(e.raw, fieldPath) === equals);
      }
      const n = matched.length;
      const tooFew = predicate.min !== undefined && n < predicate.min;
      const tooMany = predicate.max !== undefined && n > predicate.max;
      if (tooFew || tooMany) {
        out.push({
          pluginId,
          ruleId: ext.ruleId,
          severity: ext.severity,
          entityKind: predicate.entityKind,
          // For aggregate findings we surface the rule id as the "entity"
          // since the finding is about the group, not an individual.
          entityId: `(count=${n})`,
          message: ext.message,
        });
      }
      return out;
    }
    case 'entity_reference_required': {
      const targetIds = entityIdSet(manifest, predicate.mustReferenceKind);
      for (const e of listEntities(manifest, predicate.entityKind)) {
        const ref = getFieldByPath(e.raw, predicate.referenceFieldPath);
        if (typeof ref !== 'string' || ref.length === 0) {
          // Field absent / null / empty → finding (the reference is missing).
          out.push({
            pluginId,
            ruleId: ext.ruleId,
            severity: ext.severity,
            entityKind: predicate.entityKind,
            entityId: e.id,
            message: ext.message,
          });
          continue;
        }
        if (!targetIds.has(ref)) {
          out.push({
            pluginId,
            ruleId: ext.ruleId,
            severity: ext.severity,
            entityKind: predicate.entityKind,
            entityId: e.id,
            message: ext.message,
          });
        }
      }
      return out;
    }
    case 'field_pattern': {
      let regex: RegExp;
      try {
        regex = new RegExp(predicate.pattern);
      } catch {
        return out;
      }
      for (const e of listEntities(manifest, predicate.entityKind)) {
        const value = getFieldByPath(e.raw, predicate.fieldPath);
        const text = value === null || value === undefined ? '' : String(value);
        const matches = regex.test(text);
        if (matches !== predicate.mustMatch) {
          out.push({
            pluginId,
            ruleId: ext.ruleId,
            severity: ext.severity,
            entityKind: predicate.entityKind,
            entityId: e.id,
            message: ext.message,
          });
        }
      }
      return out;
    }
  }
}

export function runPluginValidators(
  manifest: ProjectManifest,
  plugins: ReadonlyArray<PluginManifest>,
): PluginFindingReport {
  const findings: PluginFinding[] = [];
  const countsByPlugin: Record<string, number> = {};
  const countsBySeverity: Record<PluginFindingSeverity, number> = { warn: 0, info: 0 };

  for (const plugin of plugins) {
    if (!plugin.validators) continue;
    for (const ext of plugin.validators) {
      const ruleFindings = evalPredicate(manifest, ext.predicate, ext, plugin.id);
      for (const f of ruleFindings) {
        findings.push(f);
        countsByPlugin[plugin.id] = (countsByPlugin[plugin.id] ?? 0) + 1;
        countsBySeverity[f.severity] = (countsBySeverity[f.severity] ?? 0) + 1;
      }
    }
  }

  return { findings, countsByPlugin, countsBySeverity };
}
