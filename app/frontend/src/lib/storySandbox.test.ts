import { describe, expect, it } from 'vitest';
import type { ProjectManifest, ScriptStep } from '@rom-editor/shared';
import { emptyManifest } from '@rom-editor/shared';
import { traceDialogueNarrative } from './dialogueTrace';
import {
  applySideEffect,
  availableNextOptions,
  createSession,
  diffFromDefaults,
  evaluateCondition,
  follow,
  initialSandboxState,
  resetSession,
} from './storySandbox';

function step(id: string, kind: ScriptStep['kind'], params: Record<string, unknown>): ScriptStep {
  return { id, kind, params };
}

function buildBranchingManifest(): ProjectManifest {
  const base = emptyManifest('/tmp/x', '2026-05-16T00:00:00Z');
  return {
    ...base,
    flags: [
      {
        id: 'FLAG_HAS_STARTER',
        name: 'FLAG_HAS_STARTER',
        scope: 'global',
        defaultValue: false,
        description: null,
        engineValue: '0x807',
      },
      {
        id: 'FLAG_GREETED',
        name: 'FLAG_GREETED',
        scope: 'global',
        defaultValue: false,
        description: null,
        engineValue: '0x808',
      },
    ],
    variables: [
      {
        id: 'VAR_INTRO_STATE',
        name: 'VAR_INTRO_STATE',
        scope: 'global',
        defaultValue: 0,
        description: null,
        engineValue: '0x4001',
      },
    ],
    dialogue: [
      { id: 'Text_PickStarter', name: 'Text_PickStarter', speakerName: null, portraitAssetId: null, text: 'Pick one!', choices: [] },
      { id: 'Text_GiveStarter', name: 'Text_GiveStarter', speakerName: null, portraitAssetId: null, text: 'Here you go!', choices: [] },
      { id: 'Text_AlreadyHave', name: 'Text_AlreadyHave', speakerName: null, portraitAssetId: null, text: 'You already have one.', choices: [] },
    ],
    scriptSteps: [
      step('Route101_Pick#0', 'dialogue', {
        macro: 'msgbox',
        args: ['Text_PickStarter', 'MSGBOX_YESNO'],
        text: 'Text_PickStarter',
      }),
      step('Route101_Pick#1', 'branch', {
        macro: 'goto_if_set',
        args: ['FLAG_HAS_STARTER', 'Route101_AlreadyPicked'],
        flag: 'FLAG_HAS_STARTER',
        label: 'Route101_AlreadyPicked',
      }),
      step('Route101_Pick#2', 'set_flag', {
        macro: 'setflag',
        args: ['FLAG_HAS_STARTER'],
        flag: 'FLAG_HAS_STARTER',
      }),
      step('Route101_Pick#3', 'set_variable', {
        macro: 'setvar',
        args: ['VAR_INTRO_STATE', '1'],
        variable: 'VAR_INTRO_STATE',
        value: '1',
      }),
      step('Route101_Pick#4', 'dialogue', {
        macro: 'msgbox',
        args: ['Text_GiveStarter', 'MSGBOX_DEFAULT'],
        text: 'Text_GiveStarter',
      }),
      step('Route101_AlreadyPicked#0', 'dialogue', {
        macro: 'msgbox',
        args: ['Text_AlreadyHave', 'MSGBOX_DEFAULT'],
        text: 'Text_AlreadyHave',
      }),
    ],
  };
}

describe('storySandbox.initialSandboxState', () => {
  it('seeds the state map from manifest defaults', () => {
    const m = buildBranchingManifest();
    const s = initialSandboxState(m);
    expect(s.flags.get('FLAG_HAS_STARTER')).toBe(false);
    expect(s.flags.get('FLAG_GREETED')).toBe(false);
    expect(s.variables.get('VAR_INTRO_STATE')).toBe(0);
  });
});

describe('storySandbox.evaluateCondition', () => {
  it('handles every structured condition kind', () => {
    const m = buildBranchingManifest();
    const s0 = initialSandboxState(m);
    expect(evaluateCondition({ kind: 'always' }, s0)).toBe('true');
    expect(evaluateCondition({ kind: 'flag_set', flagId: 'FLAG_HAS_STARTER' }, s0)).toBe('false');
    expect(evaluateCondition({ kind: 'flag_unset', flagId: 'FLAG_HAS_STARTER' }, s0)).toBe('true');
    expect(evaluateCondition({ kind: 'var_eq', variableId: 'VAR_INTRO_STATE', value: '0' }, s0)).toBe('true');
    expect(evaluateCondition({ kind: 'var_ne', variableId: 'VAR_INTRO_STATE', value: '1' }, s0)).toBe('true');
    expect(evaluateCondition({ kind: 'expression', raw: 'special_thing' }, s0)).toBe('unknown');
    expect(evaluateCondition({ kind: 'unknown', raw: 'mystery' }, s0)).toBe('unknown');

    const s1 = applySideEffect(s0, { kind: 'set_flag', flagId: 'FLAG_HAS_STARTER' });
    expect(evaluateCondition({ kind: 'flag_set', flagId: 'FLAG_HAS_STARTER' }, s1)).toBe('true');
    expect(evaluateCondition({ kind: 'flag_unset', flagId: 'FLAG_HAS_STARTER' }, s1)).toBe('false');
  });
});

describe('storySandbox.applySideEffect', () => {
  it('mutates flags / variables according to op kind', () => {
    const m = buildBranchingManifest();
    let s = initialSandboxState(m);
    s = applySideEffect(s, { kind: 'set_flag', flagId: 'FLAG_GREETED' });
    expect(s.flags.get('FLAG_GREETED')).toBe(true);
    s = applySideEffect(s, { kind: 'clear_flag', flagId: 'FLAG_GREETED' });
    expect(s.flags.get('FLAG_GREETED')).toBe(false);
    s = applySideEffect(s, { kind: 'set_var', variableId: 'VAR_INTRO_STATE', value: '5' });
    expect(s.variables.get('VAR_INTRO_STATE')).toBe(5);
    s = applySideEffect(s, { kind: 'add_var', variableId: 'VAR_INTRO_STATE', value: '2' });
    expect(s.variables.get('VAR_INTRO_STATE')).toBe(7);
    s = applySideEffect(s, { kind: 'sub_var', variableId: 'VAR_INTRO_STATE', value: '3' });
    expect(s.variables.get('VAR_INTRO_STATE')).toBe(4);
  });

  it('returns a new state object (immutability)', () => {
    const m = buildBranchingManifest();
    const s0 = initialSandboxState(m);
    const s1 = applySideEffect(s0, { kind: 'set_flag', flagId: 'FLAG_HAS_STARTER' });
    expect(s1).not.toBe(s0);
    expect(s0.flags.get('FLAG_HAS_STARTER')).toBe(false);
    expect(s1.flags.get('FLAG_HAS_STARTER')).toBe(true);
  });
});

describe('storySandbox.availableNextOptions', () => {
  it('returns the outgoing edges from the current node with condition results evaluated against state', () => {
    const m = buildBranchingManifest();
    const trace = traceDialogueNarrative(m, 'Text_PickStarter');
    const s0 = initialSandboxState(m);
    const options = availableNextOptions(trace, 'Text_PickStarter', s0);

    // From Text_PickStarter we expect two edges: one branch to Text_AlreadyHave (false in default state)
    // and one fall-through to Text_GiveStarter (always true).
    expect(options).toHaveLength(2);
    const branch = options.find((o) => o.edge.toId === 'Text_AlreadyHave');
    expect(branch?.result).toBe('false');
    const fall = options.find((o) => o.edge.toId === 'Text_GiveStarter');
    expect(fall?.result).toBe('true');

    // After setting FLAG_HAS_STARTER, the branch flips to true.
    const s1 = applySideEffect(s0, { kind: 'set_flag', flagId: 'FLAG_HAS_STARTER' });
    const optionsAfter = availableNextOptions(trace, 'Text_PickStarter', s1);
    const branch2 = optionsAfter.find((o) => o.edge.toId === 'Text_AlreadyHave');
    expect(branch2?.result).toBe('true');
  });
});

describe('storySandbox.follow', () => {
  it('moves the pointer, applies side-effects, and appends a history record', () => {
    const m = buildBranchingManifest();
    const trace = traceDialogueNarrative(m, 'Text_PickStarter');
    const session0 = createSession(m, 'Text_PickStarter');
    const options0 = availableNextOptions(trace, 'Text_PickStarter', session0.state);
    const fall = options0.find((o) => o.edge.toId === 'Text_GiveStarter')!;
    const session1 = follow(session0, fall.edge);

    expect(session1.currentDialogueId).toBe('Text_GiveStarter');
    // Side-effects on the edge: setflag FLAG_HAS_STARTER + setvar VAR_INTRO_STATE = 1.
    expect(session1.state.flags.get('FLAG_HAS_STARTER')).toBe(true);
    expect(session1.state.variables.get('VAR_INTRO_STATE')).toBe(1);
    expect(session1.history).toHaveLength(1);
    expect(session1.history[0]?.fromDialogueId).toBe('Text_PickStarter');
    expect(session1.history[0]?.toDialogueId).toBe('Text_GiveStarter');
  });
});

describe('storySandbox.resetSession', () => {
  it('restores the start pointer + default state and clears history', () => {
    const m = buildBranchingManifest();
    const trace = traceDialogueNarrative(m, 'Text_PickStarter');
    let session = createSession(m, 'Text_PickStarter');
    const fall = availableNextOptions(trace, 'Text_PickStarter', session.state).find(
      (o) => o.edge.toId === 'Text_GiveStarter',
    )!;
    session = follow(session, fall.edge);
    expect(session.history).toHaveLength(1);
    expect(session.state.flags.get('FLAG_HAS_STARTER')).toBe(true);

    const reset = resetSession(session, m);
    expect(reset.currentDialogueId).toBe('Text_PickStarter');
    expect(reset.history).toHaveLength(0);
    expect(reset.state.flags.get('FLAG_HAS_STARTER')).toBe(false);
    expect(reset.state.variables.get('VAR_INTRO_STATE')).toBe(0);
  });
});

describe('storySandbox.diffFromDefaults', () => {
  it('reports only the flags/variables that diverge from the manifest defaults', () => {
    const m = buildBranchingManifest();
    let s = initialSandboxState(m);
    expect(diffFromDefaults(m, s).flags).toEqual([]);
    expect(diffFromDefaults(m, s).variables).toEqual([]);

    s = applySideEffect(s, { kind: 'set_flag', flagId: 'FLAG_GREETED' });
    s = applySideEffect(s, { kind: 'set_var', variableId: 'VAR_INTRO_STATE', value: '7' });
    const d = diffFromDefaults(m, s);
    expect(d.flags).toEqual([{ id: 'FLAG_GREETED', value: true, defaultValue: false }]);
    expect(d.variables).toEqual([{ id: 'VAR_INTRO_STATE', value: 7, defaultValue: 0 }]);
  });
});
