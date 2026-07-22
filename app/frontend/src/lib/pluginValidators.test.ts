import { describe, expect, it } from 'vitest';
import {
  emptyManifest,
  type PluginManifest,
  type ProjectManifest,
  type ScriptStep,
} from '@rom-editor/shared';
import { runPluginValidators } from './pluginValidators';

function baseManifest(): ProjectManifest {
  const base = emptyManifest('/tmp/x', '2026-05-16T00:00:00Z');
  const step: ScriptStep = { id: 's0', kind: 'raw', params: { macro: 'noop', args: [] } };
  return {
    ...base,
    flags: [
      { id: 'FLAG_OK', name: 'FLAG_OK', scope: 'global', defaultValue: false, description: null, engineValue: '0x800' },
      { id: 'TEMP_BAD', name: 'TEMP_BAD', scope: 'global', defaultValue: false, description: null, engineValue: '0x801' },
      { id: 'TEMP_BAD_TWO', name: 'TEMP_BAD_TWO', scope: 'global', defaultValue: false, description: null, engineValue: '0x802' },
    ],
    trainers: [
      { id: 't1', name: 't1', mapId: 'm1', className: 'YOUNGSTER', party: [], aiFlags: [] },
      { id: 't2', name: 't2', mapId: 'm1', className: 'YOUNGSTER', party: [], aiFlags: [] },
    ],
    dialogue: [
      { id: 'd1', name: 'd1', speakerName: null, portraitAssetId: null, text: 'Hello!', choices: [] },
      { id: 'd2', name: 'd2', speakerName: null, portraitAssetId: null, text: 'TODO: rewrite this line', choices: [] },
    ],
    objectEvents: [
      { id: 'obj_ok', name: 'obj_ok', mapId: 'm1', coord: { x: 0, y: 0 }, elevation: 3, kind: 'npc', graphicsId: null, movementType: null, scriptId: null, flagId: 'FLAG_OK', trainerType: null, metadata: {} },
      { id: 'obj_bad', name: 'obj_bad', mapId: 'm1', coord: { x: 0, y: 0 }, elevation: 3, kind: 'npc', graphicsId: null, movementType: null, scriptId: null, flagId: 'FLAG_DOES_NOT_EXIST', trainerType: null, metadata: {} },
      { id: 'obj_null_flag', name: 'obj_null_flag', mapId: 'm1', coord: { x: 0, y: 0 }, elevation: 3, kind: 'npc', graphicsId: null, movementType: null, scriptId: null, flagId: null, trainerType: null, metadata: {} },
    ],
    scriptSteps: [step],
  };
}

function plugin(validators: PluginManifest['validators']): PluginManifest {
  return { id: 'p1', label: 'P1', version: '0.1', description: '', validators };
}

describe('runPluginValidators', () => {
  it('returns empty report when no plugins are registered', () => {
    const r = runPluginValidators(baseManifest(), []);
    expect(r.findings).toEqual([]);
    expect(r.countsByPlugin).toEqual({});
    expect(r.countsBySeverity).toEqual({ warn: 0, info: 0 });
  });

  it('entity_pattern: flags every entity whose id matches the regex', () => {
    const p = plugin([
      {
        ruleId: 'no_temp_flags',
        severity: 'warn',
        message: 'flag id starts with TEMP_',
        predicate: { kind: 'entity_pattern', entityKind: 'flag', idPattern: '^TEMP_' },
      },
    ]);
    const r = runPluginValidators(baseManifest(), [p]);
    expect(r.findings).toHaveLength(2);
    expect(r.findings.map((f) => f.entityId).sort()).toEqual(['TEMP_BAD', 'TEMP_BAD_TWO']);
    expect(r.countsByPlugin['p1']).toBe(2);
    expect(r.countsBySeverity['warn']).toBe(2);
  });

  it('entity_pattern: emits no findings when nothing matches', () => {
    const p = plugin([
      {
        ruleId: 'never',
        severity: 'info',
        message: 'never matches',
        predicate: { kind: 'entity_pattern', entityKind: 'flag', idPattern: '^XYZ_ABSENT_' },
      },
    ]);
    const r = runPluginValidators(baseManifest(), [p]);
    expect(r.findings).toEqual([]);
  });

  it('entity_count: flags when min/max bounds are violated', () => {
    const p = plugin([
      {
        ruleId: 'need_more_trainers',
        severity: 'warn',
        message: 'project should have ≥5 trainers',
        predicate: { kind: 'entity_count', entityKind: 'trainer', min: 5 },
      },
    ]);
    const r = runPluginValidators(baseManifest(), [p]);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]!.entityId).toBe('(count=2)');
  });

  it('entity_count with filter: counts only entities whose fieldPath equals value', () => {
    const p = plugin([
      {
        ruleId: 'too_many_youngsters',
        severity: 'info',
        message: 'cap on YOUNGSTER-class trainers',
        predicate: {
          kind: 'entity_count',
          entityKind: 'trainer',
          filter: { fieldPath: 'className', equals: 'YOUNGSTER' },
          max: 1,
        },
      },
    ]);
    // Both trainers in baseManifest are className=YOUNGSTER → count=2 > max=1 → 1 finding.
    const r = runPluginValidators(baseManifest(), [p]);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]!.entityId).toBe('(count=2)');
  });

  it('entity_reference_required: flags objects whose flagId points at a missing flag', () => {
    const p = plugin([
      {
        ruleId: 'objectEvent_flag_exists',
        severity: 'warn',
        message: 'objectEvent.flagId must reference a real flag',
        predicate: {
          kind: 'entity_reference_required',
          entityKind: 'objectEvent',
          referenceFieldPath: 'flagId',
          mustReferenceKind: 'flag',
        },
      },
    ]);
    const r = runPluginValidators(baseManifest(), [p]);
    // obj_bad → flagId 'FLAG_DOES_NOT_EXIST' (missing); obj_null_flag → null (missing).
    // obj_ok → flagId 'FLAG_OK' (present).
    expect(r.findings.map((f) => f.entityId).sort()).toEqual(['obj_bad', 'obj_null_flag']);
  });

  it('field_pattern with mustMatch=false: flags dialogue whose text contains TODO', () => {
    const p = plugin([
      {
        ruleId: 'no_todo_in_dialogue',
        severity: 'info',
        message: 'dialogue text contains TODO marker',
        predicate: {
          kind: 'field_pattern',
          entityKind: 'dialogue',
          fieldPath: 'text',
          pattern: 'TODO',
          mustMatch: false,
        },
      },
    ]);
    const r = runPluginValidators(baseManifest(), [p]);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]!.entityId).toBe('d2');
  });

  it('field_pattern with mustMatch=true: flags dialogue whose text does NOT match', () => {
    const p = plugin([
      {
        ruleId: 'dialogue_must_be_polite',
        severity: 'warn',
        message: 'dialogue should end with a greeting',
        predicate: {
          kind: 'field_pattern',
          entityKind: 'dialogue',
          fieldPath: 'text',
          pattern: '!',
          mustMatch: true,
        },
      },
    ]);
    const r = runPluginValidators(baseManifest(), [p]);
    // d1 has 'Hello!' (matches), d2 has no '!' (does NOT match → finding).
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]!.entityId).toBe('d2');
  });

  it('aggregates counts across multiple plugins and rules', () => {
    const r = runPluginValidators(baseManifest(), [
      plugin([
        {
          ruleId: 'a',
          severity: 'warn',
          message: 'temp flags',
          predicate: { kind: 'entity_pattern', entityKind: 'flag', idPattern: '^TEMP_' },
        },
      ]),
      {
        id: 'p2',
        label: 'P2',
        version: '0.1',
        description: '',
        validators: [
          {
            ruleId: 'b',
            severity: 'info',
            message: 'todo dialogue',
            predicate: { kind: 'field_pattern', entityKind: 'dialogue', fieldPath: 'text', pattern: 'TODO', mustMatch: false },
          },
        ],
      },
    ]);
    expect(r.countsByPlugin['p1']).toBe(2);
    expect(r.countsByPlugin['p2']).toBe(1);
    expect(r.countsBySeverity['warn']).toBe(2);
    expect(r.countsBySeverity['info']).toBe(1);
  });
});
