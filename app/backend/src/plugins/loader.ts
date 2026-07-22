import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type {
  AdapterExtension,
  EventTypeExtension,
  MapLayerExtension,
  PluginManifest,
  PluginParseError,
  PluginsResponse,
  ProjectEntityKind,
  ValidatorExtension,
  ValidatorPredicate,
} from '@rom-editor/shared';

const PLUGINS_DIR = '.editor/plugins';

const VALID_ENTITY_KINDS: ReadonlySet<ProjectEntityKind> = new Set([
  'map',
  'warp',
  'trigger',
  'objectEvent',
  'flag',
  'variable',
  'encounterTable',
  'trainer',
  'dialogue',
  'asset',
  'scriptStep',
]);

const VALID_SEVERITIES = new Set(['warn', 'info']);
const VALID_DIRECTIONS = new Set(['import', 'export']);
const VALID_PREDICATE_KINDS = new Set([
  'entity_pattern',
  'entity_count',
  'entity_reference_required',
  'field_pattern',
]);

function isString(v: unknown): v is string {
  return typeof v === 'string';
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function validatePredicate(p: unknown): ValidatorPredicate {
  if (!isPlainObject(p)) throw new Error('predicate must be an object');
  const kind = p['kind'];
  if (!isString(kind) || !VALID_PREDICATE_KINDS.has(kind)) {
    throw new Error(`predicate.kind must be one of ${[...VALID_PREDICATE_KINDS].join('|')}`);
  }
  const entityKind = p['entityKind'];
  if (!isString(entityKind) || !VALID_ENTITY_KINDS.has(entityKind as ProjectEntityKind)) {
    throw new Error(`predicate.entityKind must be a valid ProjectEntityKind`);
  }
  switch (kind) {
    case 'entity_pattern': {
      if (!isNonEmptyString(p['idPattern'])) throw new Error('entity_pattern.idPattern required');
      try {
        new RegExp(p['idPattern'] as string);
      } catch {
        throw new Error(`entity_pattern.idPattern is not a valid regex`);
      }
      return { kind, entityKind: entityKind as ProjectEntityKind, idPattern: p['idPattern'] as string };
    }
    case 'entity_count': {
      const out: ValidatorPredicate = {
        kind,
        entityKind: entityKind as ProjectEntityKind,
        ...(p['min'] !== undefined ? { min: Number(p['min']) } : {}),
        ...(p['max'] !== undefined ? { max: Number(p['max']) } : {}),
      };
      const filter = p['filter'];
      if (filter !== undefined) {
        if (!isPlainObject(filter) || !isNonEmptyString(filter['fieldPath'])) {
          throw new Error('entity_count.filter requires fieldPath');
        }
        const eq = filter['equals'];
        if (!(typeof eq === 'string' || typeof eq === 'number' || typeof eq === 'boolean')) {
          throw new Error('entity_count.filter.equals must be string|number|boolean');
        }
        return { ...out, filter: { fieldPath: filter['fieldPath'] as string, equals: eq } };
      }
      if (out['min'] === undefined && out['max'] === undefined) {
        throw new Error('entity_count requires min or max');
      }
      return out;
    }
    case 'entity_reference_required': {
      if (!isNonEmptyString(p['referenceFieldPath'])) {
        throw new Error('entity_reference_required.referenceFieldPath required');
      }
      const mustRef = p['mustReferenceKind'];
      if (!isString(mustRef) || !VALID_ENTITY_KINDS.has(mustRef as ProjectEntityKind)) {
        throw new Error('entity_reference_required.mustReferenceKind must be a valid ProjectEntityKind');
      }
      return {
        kind,
        entityKind: entityKind as ProjectEntityKind,
        referenceFieldPath: p['referenceFieldPath'] as string,
        mustReferenceKind: mustRef as ProjectEntityKind,
      };
    }
    case 'field_pattern': {
      if (!isNonEmptyString(p['fieldPath'])) throw new Error('field_pattern.fieldPath required');
      if (!isNonEmptyString(p['pattern'])) throw new Error('field_pattern.pattern required');
      try {
        new RegExp(p['pattern'] as string);
      } catch {
        throw new Error('field_pattern.pattern is not a valid regex');
      }
      if (typeof p['mustMatch'] !== 'boolean') {
        throw new Error('field_pattern.mustMatch must be boolean');
      }
      return {
        kind,
        entityKind: entityKind as ProjectEntityKind,
        fieldPath: p['fieldPath'] as string,
        pattern: p['pattern'] as string,
        mustMatch: p['mustMatch'] as boolean,
      };
    }
    default:
      throw new Error(`unhandled predicate kind ${String(kind)}`);
  }
}

function validateValidator(v: unknown, index: number): ValidatorExtension {
  if (!isPlainObject(v)) throw new Error(`validators[${index}] must be an object`);
  if (!isNonEmptyString(v['ruleId'])) throw new Error(`validators[${index}].ruleId required`);
  if (!isString(v['severity']) || !VALID_SEVERITIES.has(v['severity'])) {
    throw new Error(`validators[${index}].severity must be 'warn' or 'info'`);
  }
  if (!isNonEmptyString(v['message'])) throw new Error(`validators[${index}].message required`);
  try {
    const predicate = validatePredicate(v['predicate']);
    return {
      ruleId: v['ruleId'] as string,
      severity: v['severity'] as 'warn' | 'info',
      message: v['message'] as string,
      predicate,
    };
  } catch (e) {
    throw new Error(`validators[${index}]: ${(e as Error).message}`);
  }
}

function validateEventType(v: unknown, index: number): EventTypeExtension {
  if (!isPlainObject(v)) throw new Error(`eventTypes[${index}] must be an object`);
  if (!isNonEmptyString(v['macroName'])) throw new Error(`eventTypes[${index}].macroName required`);
  if (!isNonEmptyString(v['kindAlias'])) throw new Error(`eventTypes[${index}].kindAlias required`);
  if (!isString(v['description'])) throw new Error(`eventTypes[${index}].description required`);
  return {
    macroName: v['macroName'] as string,
    kindAlias: v['kindAlias'] as string,
    description: v['description'] as string,
  };
}

function validateMapLayer(v: unknown, index: number): MapLayerExtension {
  if (!isPlainObject(v)) throw new Error(`mapLayers[${index}] must be an object`);
  if (!isNonEmptyString(v['layerId'])) throw new Error(`mapLayers[${index}].layerId required`);
  if (!isNonEmptyString(v['label'])) throw new Error(`mapLayers[${index}].label required`);
  if (!isNonEmptyString(v['source'])) throw new Error(`mapLayers[${index}].source required`);
  if (!isNonEmptyString(v['color'])) throw new Error(`mapLayers[${index}].color required`);
  return {
    layerId: v['layerId'] as string,
    label: v['label'] as string,
    source: v['source'] as string,
    color: v['color'] as string,
  };
}

function validateAdapter(v: unknown, index: number): AdapterExtension {
  if (!isPlainObject(v)) throw new Error(`adapters[${index}] must be an object`);
  if (!isNonEmptyString(v['adapterId'])) throw new Error(`adapters[${index}].adapterId required`);
  if (!isString(v['direction']) || !VALID_DIRECTIONS.has(v['direction'])) {
    throw new Error(`adapters[${index}].direction must be 'import' or 'export'`);
  }
  if (!isNonEmptyString(v['label'])) throw new Error(`adapters[${index}].label required`);
  if (!isString(v['description'])) throw new Error(`adapters[${index}].description required`);
  return {
    adapterId: v['adapterId'] as string,
    direction: v['direction'] as 'import' | 'export',
    label: v['label'] as string,
    description: v['description'] as string,
  };
}

function validateManifest(raw: unknown): PluginManifest {
  if (!isPlainObject(raw)) throw new Error('manifest root must be an object');
  if (!isNonEmptyString(raw['id'])) throw new Error('manifest.id required');
  if (!/^[a-zA-Z0-9_.-]+$/.test(raw['id'] as string)) {
    throw new Error('manifest.id must match [a-zA-Z0-9_.-]+');
  }
  if (!isNonEmptyString(raw['label'])) throw new Error('manifest.label required');
  if (!isNonEmptyString(raw['version'])) throw new Error('manifest.version required');
  if (!isString(raw['description'])) throw new Error('manifest.description required');

  const validators: ValidatorExtension[] = [];
  if (raw['validators'] !== undefined) {
    if (!Array.isArray(raw['validators'])) throw new Error('manifest.validators must be an array');
    const seenRuleIds = new Set<string>();
    (raw['validators'] as unknown[]).forEach((v, i) => {
      const ext = validateValidator(v, i);
      if (seenRuleIds.has(ext.ruleId)) {
        throw new Error(`validators[${i}].ruleId '${ext.ruleId}' is duplicated within this plugin`);
      }
      seenRuleIds.add(ext.ruleId);
      validators.push(ext);
    });
  }

  const eventTypes: EventTypeExtension[] = [];
  if (raw['eventTypes'] !== undefined) {
    if (!Array.isArray(raw['eventTypes'])) throw new Error('manifest.eventTypes must be an array');
    (raw['eventTypes'] as unknown[]).forEach((v, i) => eventTypes.push(validateEventType(v, i)));
  }

  const mapLayers: MapLayerExtension[] = [];
  if (raw['mapLayers'] !== undefined) {
    if (!Array.isArray(raw['mapLayers'])) throw new Error('manifest.mapLayers must be an array');
    (raw['mapLayers'] as unknown[]).forEach((v, i) => mapLayers.push(validateMapLayer(v, i)));
  }

  const adapters: AdapterExtension[] = [];
  if (raw['adapters'] !== undefined) {
    if (!Array.isArray(raw['adapters'])) throw new Error('manifest.adapters must be an array');
    (raw['adapters'] as unknown[]).forEach((v, i) => adapters.push(validateAdapter(v, i)));
  }

  return {
    id: raw['id'] as string,
    label: raw['label'] as string,
    version: raw['version'] as string,
    description: raw['description'] as string,
    ...(validators.length > 0 ? { validators } : {}),
    ...(eventTypes.length > 0 ? { eventTypes } : {}),
    ...(mapLayers.length > 0 ? { mapLayers } : {}),
    ...(adapters.length > 0 ? { adapters } : {}),
  };
}

export async function loadProjectPlugins(projectRoot: string): Promise<PluginsResponse> {
  const pluginsDir = path.join(projectRoot, PLUGINS_DIR);

  let files: string[] = [];
  try {
    const entries = await fsp.readdir(pluginsDir, { withFileTypes: true });
    files = entries
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.json'))
      .map((e) => path.join(pluginsDir, e.name))
      .sort();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return { projectRoot, pluginsDir, plugins: [], parseErrors: [] };
    }
    throw e;
  }

  const plugins: PluginManifest[] = [];
  const parseErrors: PluginParseError[] = [];
  const seenIds = new Set<string>();

  for (const filePath of files) {
    let text: string;
    try {
      text = await fsp.readFile(filePath, 'utf-8');
    } catch (e) {
      parseErrors.push({
        filePath,
        code: 'invalid_json',
        message: `read failed: ${(e as Error).message}`,
      });
      continue;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (e) {
      parseErrors.push({
        filePath,
        code: 'invalid_json',
        message: (e as Error).message,
      });
      continue;
    }
    let manifest: PluginManifest;
    try {
      manifest = validateManifest(raw);
    } catch (e) {
      parseErrors.push({
        filePath,
        code: 'invalid_shape',
        message: (e as Error).message,
      });
      continue;
    }
    if (seenIds.has(manifest.id)) {
      parseErrors.push({
        filePath,
        code: 'duplicate_id',
        message: `Another plugin in this directory already uses id '${manifest.id}'`,
      });
      continue;
    }
    seenIds.add(manifest.id);
    plugins.push(manifest);
  }

  return { projectRoot, pluginsDir, plugins, parseErrors };
}
