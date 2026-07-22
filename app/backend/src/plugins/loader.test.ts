import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadProjectPlugins } from './loader.js';

const PLUGINS_DIR = '.editor/plugins';

describe('loadProjectPlugins', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(path.join(tmpdir(), 'rom-editor-plugins-'));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  function writePlugin(name: string, body: unknown): void {
    const dir = path.join(projectRoot, PLUGINS_DIR);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, name), JSON.stringify(body), 'utf-8');
  }

  it('returns empty arrays when the plugins directory does not exist', async () => {
    const r = await loadProjectPlugins(projectRoot);
    expect(r.plugins).toEqual([]);
    expect(r.parseErrors).toEqual([]);
    expect(r.pluginsDir).toBe(path.join(projectRoot, PLUGINS_DIR));
  });

  it('loads a single well-formed plugin manifest', async () => {
    writePlugin('first.json', {
      id: 'my.first',
      label: 'My First Plugin',
      version: '1.0.0',
      description: 'desc',
      validators: [
        {
          ruleId: 'rule_a',
          severity: 'warn',
          message: 'no trainers named TEST_*',
          predicate: {
            kind: 'entity_pattern',
            entityKind: 'trainer',
            idPattern: '^TEST_',
          },
        },
      ],
    });
    const r = await loadProjectPlugins(projectRoot);
    expect(r.parseErrors).toEqual([]);
    expect(r.plugins).toHaveLength(1);
    expect(r.plugins[0]!.id).toBe('my.first');
    expect(r.plugins[0]!.validators).toHaveLength(1);
    expect(r.plugins[0]!.validators![0]!.predicate.kind).toBe('entity_pattern');
  });

  it('reports invalid JSON as a parse error without dropping later valid plugins', async () => {
    const dir = path.join(projectRoot, PLUGINS_DIR);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'broken.json'), '{not json', 'utf-8');
    writePlugin('good.json', {
      id: 'good',
      label: 'Good',
      version: '0.1',
      description: '',
    });
    const r = await loadProjectPlugins(projectRoot);
    expect(r.parseErrors).toHaveLength(1);
    expect(r.parseErrors[0]!.code).toBe('invalid_json');
    expect(r.plugins).toHaveLength(1);
    expect(r.plugins[0]!.id).toBe('good');
  });

  it('reports invalid manifest shape as invalid_shape', async () => {
    writePlugin('bad.json', { id: 123, label: 'no string id' });
    const r = await loadProjectPlugins(projectRoot);
    expect(r.parseErrors).toHaveLength(1);
    expect(r.parseErrors[0]!.code).toBe('invalid_shape');
    expect(r.plugins).toEqual([]);
  });

  it('rejects a predicate with an invalid kind discriminator', async () => {
    writePlugin('bad_predicate.json', {
      id: 'bp',
      label: 'BP',
      version: '0.1',
      description: '',
      validators: [
        {
          ruleId: 'x',
          severity: 'warn',
          message: 'm',
          predicate: { kind: 'no_such_kind', entityKind: 'flag' },
        },
      ],
    });
    const r = await loadProjectPlugins(projectRoot);
    expect(r.parseErrors).toHaveLength(1);
    expect(r.parseErrors[0]!.code).toBe('invalid_shape');
    expect(r.parseErrors[0]!.message).toContain('predicate.kind');
  });

  it('rejects an invalid regex in entity_pattern', async () => {
    writePlugin('bad_regex.json', {
      id: 'br',
      label: 'BR',
      version: '0.1',
      description: '',
      validators: [
        {
          ruleId: 'x',
          severity: 'warn',
          message: 'm',
          predicate: { kind: 'entity_pattern', entityKind: 'map', idPattern: '[unclosed' },
        },
      ],
    });
    const r = await loadProjectPlugins(projectRoot);
    expect(r.parseErrors).toHaveLength(1);
    expect(r.parseErrors[0]!.message).toContain('regex');
  });

  it('reports duplicate plugin ids across files as duplicate_id', async () => {
    writePlugin('a.json', { id: 'same', label: 'A', version: '0.1', description: '' });
    writePlugin('b.json', { id: 'same', label: 'B', version: '0.1', description: '' });
    const r = await loadProjectPlugins(projectRoot);
    // First file wins; second is reported as a duplicate.
    expect(r.plugins).toHaveLength(1);
    expect(r.parseErrors).toHaveLength(1);
    expect(r.parseErrors[0]!.code).toBe('duplicate_id');
  });

  it('accepts all 4 predicate kinds + eventTypes + mapLayers + adapters in one manifest', async () => {
    writePlugin('full.json', {
      id: 'full',
      label: 'Full',
      version: '1.0',
      description: 'has everything',
      validators: [
        { ruleId: 'r1', severity: 'warn', message: 'm', predicate: { kind: 'entity_pattern', entityKind: 'flag', idPattern: '^X_' } },
        { ruleId: 'r2', severity: 'info', message: 'm', predicate: { kind: 'entity_count', entityKind: 'trainer', min: 5 } },
        { ruleId: 'r3', severity: 'warn', message: 'm', predicate: { kind: 'entity_reference_required', entityKind: 'objectEvent', referenceFieldPath: 'flagId', mustReferenceKind: 'flag' } },
        { ruleId: 'r4', severity: 'info', message: 'm', predicate: { kind: 'field_pattern', entityKind: 'dialogue', fieldPath: 'text', pattern: 'TODO', mustMatch: false } },
      ],
      eventTypes: [{ macroName: 'custom_warp', kindAlias: 'raw', description: 'project-specific warp shortcut' }],
      mapLayers: [{ layerId: 'flag_state', label: 'Flag state', source: 'flag_state', color: '#abc' }],
      adapters: [{ adapterId: 'export_csv', direction: 'export', label: 'CSV Export', description: 'flag table → csv' }],
    });
    const r = await loadProjectPlugins(projectRoot);
    expect(r.parseErrors).toEqual([]);
    const p = r.plugins[0]!;
    expect(p.validators).toHaveLength(4);
    expect(p.eventTypes).toHaveLength(1);
    expect(p.mapLayers).toHaveLength(1);
    expect(p.adapters).toHaveLength(1);
  });

  it('rejects duplicate ruleIds within a single plugin', async () => {
    writePlugin('dupes.json', {
      id: 'd',
      label: 'D',
      version: '0.1',
      description: '',
      validators: [
        { ruleId: 'same_id', severity: 'warn', message: 'a', predicate: { kind: 'entity_pattern', entityKind: 'flag', idPattern: 'a' } },
        { ruleId: 'same_id', severity: 'warn', message: 'b', predicate: { kind: 'entity_pattern', entityKind: 'flag', idPattern: 'b' } },
      ],
    });
    const r = await loadProjectPlugins(projectRoot);
    expect(r.plugins).toEqual([]);
    expect(r.parseErrors).toHaveLength(1);
    expect(r.parseErrors[0]!.message).toContain('duplicated');
  });
});
