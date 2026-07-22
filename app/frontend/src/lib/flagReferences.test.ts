import { describe, expect, it } from 'vitest';
import {
  buildTriggerByStepIdMap,
  computeFlagReferences,
  totalFlagReferences,
} from './flagReferences';
import type {
  DialogueNode,
  ObjectEvent,
  ProjectManifest,
  ScriptStep,
  Trigger,
} from '@rom-editor/shared';

function manifest(overrides: Partial<ProjectManifest> = {}): ProjectManifest {
  return {
    schemaVersion: 1,
    generatedAtUtc: '2026-05-18T00:00:00Z',
    projectRoot: '/abs/test',
    identity: {
      kind: 'decomp',
      confidence: 1,
      displayName: 'test',
      baseGame: null,
      fork: null,
      featureFlags: [],
      warnings: [],
      evidence: [],
    },
    buildProfile: null,
    maps: [],
    warps: [],
    triggers: [],
    objectEvents: [],
    dialogue: [],
    flags: [],
    variables: [],
    encounterTables: [],
    trainers: [],
    scriptSteps: [],
    assets: [],
    ...overrides,
  } as ProjectManifest;
}

const flagId = 'FLAG_BADGE01_GET';

describe('computeFlagReferences (Phase Q.2)', () => {
  it('returns empty refs for an isolated flag', () => {
    const refs = computeFlagReferences(manifest(), 'flag', flagId);
    expect(refs.objectEvents).toEqual([]);
    expect(refs.scriptSteps).toEqual([]);
    expect(refs.triggers).toEqual([]);
    expect(refs.dialogueChoices).toEqual([]);
    expect(totalFlagReferences(refs)).toBe(0);
  });

  it('surfaces object events gated by the flag', () => {
    const obj: ObjectEvent = {
      id: 'obj_brock',
      mapId: 'MAP_PEWTER_GYM',
      kind: 'npc',
      coord: { x: 5, y: 8 },
      graphicsId: 'gfx_brock',
      movementType: 'still',
      flagId,
      trainerType: null,
      visionRange: 0,
      scriptId: 'script_brock',
    } as unknown as ObjectEvent;
    const refs = computeFlagReferences(manifest({ objectEvents: [obj] }), 'flag', flagId);
    expect(refs.objectEvents).toHaveLength(1);
    expect(refs.objectEvents[0]?.id).toBe('obj_brock');
  });

  it('surfaces script steps that reference the flag in any param key', () => {
    const stepA: ScriptStep = {
      id: 'step_a',
      kind: 'set_flag',
      params: { flag: flagId },
    } as ScriptStep;
    const stepB: ScriptStep = {
      id: 'step_b',
      kind: 'branch',
      params: { condition: flagId, args: [flagId, '1'] },
    } as ScriptStep;
    const stepC: ScriptStep = {
      id: 'step_c',
      kind: 'set_flag',
      params: { flag: 'FLAG_OTHER' },
    } as ScriptStep;
    const refs = computeFlagReferences(
      manifest({ scriptSteps: [stepA, stepB, stepC] }),
      'flag',
      flagId,
    );
    expect(refs.scriptSteps.map((s) => s.id)).toEqual(['step_a', 'step_b']);
  });

  it('deduplicates the trigger list when a trigger touches the flag in multiple steps', () => {
    const stepA: ScriptStep = {
      id: 'step_a',
      kind: 'set_flag',
      params: { flag: flagId },
    } as ScriptStep;
    const stepB: ScriptStep = {
      id: 'step_b',
      kind: 'branch',
      params: { condition: flagId },
    } as ScriptStep;
    const trigger: Trigger = {
      id: 'trig_intro',
      mapId: 'MAP_OAK_LAB',
      kind: 'on_enter',
      coord: { x: 0, y: 0 },
      scriptStepIds: ['step_a', 'step_b'],
    } as unknown as Trigger;
    const refs = computeFlagReferences(
      manifest({ scriptSteps: [stepA, stepB], triggers: [trigger] }),
      'flag',
      flagId,
    );
    expect(refs.scriptSteps).toHaveLength(2);
    expect(refs.triggers).toHaveLength(1);
    expect(refs.triggers[0]?.id).toBe('trig_intro');
  });

  it('surfaces dialogue choices that set the flag', () => {
    const node: DialogueNode = {
      id: 'dlg_starter',
      speakerId: null,
      body: 'Pick a starter',
      choices: [
        { label: 'Bulbasaur', setsFlagIds: [flagId], nextDialogueId: null },
        { label: 'Charmander', setsFlagIds: [], nextDialogueId: null },
      ],
    } as unknown as DialogueNode;
    const refs = computeFlagReferences(manifest({ dialogue: [node] }), 'flag', flagId);
    expect(refs.dialogueChoices).toHaveLength(1);
    expect(refs.dialogueChoices[0]?.choiceLabel).toBe('Bulbasaur');
  });

  it('variable kind does NOT pick up object event visibility (flag-only)', () => {
    const obj: ObjectEvent = {
      id: 'obj_x',
      mapId: 'MAP_A',
      kind: 'npc',
      coord: { x: 0, y: 0 },
      graphicsId: 'gfx',
      movementType: 'still',
      flagId: 'VAR_FOO', // not a real shape, but proves the filter
      trainerType: null,
      visionRange: 0,
      scriptId: 's',
    } as unknown as ObjectEvent;
    const refs = computeFlagReferences(
      manifest({ objectEvents: [obj] }),
      'variable',
      'VAR_FOO',
    );
    expect(refs.objectEvents).toEqual([]);
  });

  it('variable kind matches variable-shaped param keys (variable, dest, source, left, right)', () => {
    const steps: ScriptStep[] = [
      { id: 's1', kind: 'setvar', params: { variable: 'VAR_FOO', value: '1' } },
      { id: 's2', kind: 'addvar', params: { dest: 'VAR_FOO', source: 'VAR_BAR' } },
      { id: 's3', kind: 'compare', params: { left: 'VAR_FOO', right: '0' } },
      { id: 's4', kind: 'noop', params: { other: 'VAR_FOO' } },
    ] as unknown as ScriptStep[];
    const refs = computeFlagReferences(
      manifest({ scriptSteps: steps }),
      'variable',
      'VAR_FOO',
    );
    expect(refs.scriptSteps.map((s) => s.id)).toEqual(['s1', 's2', 's3']);
  });

  it('reuses a precomputed trigger index when passed', () => {
    const idx = buildTriggerByStepIdMap(manifest());
    expect(idx.size).toBe(0);
    const refs = computeFlagReferences(manifest(), 'flag', flagId, idx);
    expect(refs.triggers).toEqual([]);
  });
});

describe('totalFlagReferences', () => {
  it('sums all four reference categories', () => {
    const refs = {
      objectEvents: [{}, {}] as unknown as ObjectEvent[],
      scriptSteps: [{}] as unknown as ScriptStep[],
      triggers: [{}, {}, {}] as unknown as Trigger[],
      dialogueChoices: [{}, {}] as unknown as Array<{
        node: DialogueNode;
        choiceLabel: string;
      }>,
    };
    expect(totalFlagReferences(refs)).toBe(8);
  });
});
