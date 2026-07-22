import { describe, expect, it } from 'vitest';
import type { ProjectManifest, ScriptStep } from '@rom-editor/shared';
import { emptyManifest } from '@rom-editor/shared';
import { traceDialogueNarrative } from './dialogueTrace';

function step(id: string, kind: ScriptStep['kind'], params: Record<string, unknown>): ScriptStep {
  return { id, kind, params };
}

function withDialogue(
  base: ProjectManifest,
  ids: ReadonlyArray<{ id: string; text?: string; speakerName?: string | null }>,
): ProjectManifest {
  return {
    ...base,
    dialogue: ids.map((d) => ({
      id: d.id,
      name: d.id,
      speakerName: d.speakerName ?? null,
      portraitAssetId: null,
      text: d.text ?? `Text body for ${d.id}`,
      choices: [],
    })),
  };
}

describe('traceDialogueNarrative', () => {
  it('returns just the root node when the dialogue has no callers', () => {
    const base = emptyManifest('/tmp/x', '2026-05-16T00:00:00Z');
    const manifest = withDialogue(base, [{ id: 'Text_Orphan', text: 'Nobody calls me.' }]);
    const trace = traceDialogueNarrative(manifest, 'Text_Orphan');
    expect(trace.root.id).toBe('Text_Orphan');
    expect(trace.root.isRoot).toBe(true);
    expect(trace.nodes).toHaveLength(1);
    expect(trace.edges).toHaveLength(0);
    expect(trace.callers).toHaveLength(0);
    expect(trace.truncated).toBe(false);
  });

  it('traces forward from a single caller to the next msgbox as a "next" edge', () => {
    const base = emptyManifest('/tmp/x', '2026-05-16T00:00:00Z');
    const manifest = withDialogue(
      {
        ...base,
        scriptSteps: [
          step('LittlerootTown_Mom#0', 'dialogue', {
            macro: 'msgbox',
            args: ['LittlerootTown_Mom_Text_Hi', 'MSGBOX_NPC'],
            text: 'LittlerootTown_Mom_Text_Hi',
            msgboxType: 'MSGBOX_NPC',
          }),
          step('LittlerootTown_Mom#1', 'dialogue', {
            macro: 'msgbox',
            args: ['LittlerootTown_Mom_Text_Bye', 'MSGBOX_NPC'],
            text: 'LittlerootTown_Mom_Text_Bye',
            msgboxType: 'MSGBOX_NPC',
          }),
        ],
      },
      [
        { id: 'LittlerootTown_Mom_Text_Hi', text: 'Hello!' },
        { id: 'LittlerootTown_Mom_Text_Bye', text: 'Goodbye!' },
      ],
    );

    const trace = traceDialogueNarrative(manifest, 'LittlerootTown_Mom_Text_Hi');

    expect(trace.callers).toHaveLength(1);
    expect(trace.callers[0]?.scriptLabel).toBe('LittlerootTown_Mom');
    expect(trace.edges).toHaveLength(1);
    expect(trace.edges[0]?.kind).toBe('next');
    expect(trace.edges[0]?.fromId).toBe('LittlerootTown_Mom_Text_Hi');
    expect(trace.edges[0]?.toId).toBe('LittlerootTown_Mom_Text_Bye');
    expect(trace.edges[0]?.label).toBe('after');
    expect(trace.nodes.map((n) => n.id).sort()).toEqual([
      'LittlerootTown_Mom_Text_Bye',
      'LittlerootTown_Mom_Text_Hi',
    ]);
  });

  it('annotates setflag / setvar side-effects onto the next edge', () => {
    const base = emptyManifest('/tmp/x', '2026-05-16T00:00:00Z');
    const manifest = withDialogue(
      {
        ...base,
        scriptSteps: [
          step('S_Intro#0', 'dialogue', {
            macro: 'msgbox',
            args: ['Text_Intro_Greeting', 'MSGBOX_DEFAULT'],
            text: 'Text_Intro_Greeting',
          }),
          step('S_Intro#1', 'set_flag', {
            macro: 'setflag',
            args: ['FLAG_GREETED'],
            flag: 'FLAG_GREETED',
          }),
          step('S_Intro#2', 'set_variable', {
            macro: 'setvar',
            args: ['VAR_INTRO_STATE', '1'],
            variable: 'VAR_INTRO_STATE',
            value: '1',
          }),
          step('S_Intro#3', 'dialogue', {
            macro: 'msgbox',
            args: ['Text_Intro_Followup', 'MSGBOX_DEFAULT'],
            text: 'Text_Intro_Followup',
          }),
        ],
      },
      [
        { id: 'Text_Intro_Greeting' },
        { id: 'Text_Intro_Followup' },
      ],
    );

    const trace = traceDialogueNarrative(manifest, 'Text_Intro_Greeting');
    expect(trace.edges).toHaveLength(1);
    const edge = trace.edges[0]!;
    expect(edge.toId).toBe('Text_Intro_Followup');
    expect(edge.sideEffects).toEqual(['sets FLAG_GREETED', 'VAR_INTRO_STATE ← 1']);
  });

  it('emits a branch edge for goto_if_set with a conditional label', () => {
    const base = emptyManifest('/tmp/x', '2026-05-16T00:00:00Z');
    const manifest = withDialogue(
      {
        ...base,
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
          step('Route101_Pick#2', 'dialogue', {
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
      },
      [
        { id: 'Text_PickStarter' },
        { id: 'Text_GiveStarter' },
        { id: 'Text_AlreadyHave' },
      ],
    );

    const trace = traceDialogueNarrative(manifest, 'Text_PickStarter');
    expect(trace.edges).toHaveLength(2);
    // One branch edge to Text_AlreadyHave with the conditional label.
    const branchEdge = trace.edges.find((e) => e.toId === 'Text_AlreadyHave');
    expect(branchEdge).toBeDefined();
    expect(branchEdge?.kind).toBe('branch');
    expect(branchEdge?.label).toBe('if FLAG_HAS_STARTER set');
    // One fall-through edge to Text_GiveStarter.
    const fallEdge = trace.edges.find((e) => e.toId === 'Text_GiveStarter');
    expect(fallEdge).toBeDefined();
    expect(fallEdge?.kind).toBe('next');
  });

  it('uses compare + goto_if_eq context to build the branch label', () => {
    const base = emptyManifest('/tmp/x', '2026-05-16T00:00:00Z');
    const manifest = withDialogue(
      {
        ...base,
        scriptSteps: [
          step('Branch#0', 'dialogue', {
            macro: 'msgbox',
            args: ['Text_AskMode', 'MSGBOX_YESNO'],
            text: 'Text_AskMode',
          }),
          step('Branch#1', 'set_variable', {
            macro: 'compare',
            args: ['VAR_RESULT', '1'],
            left: 'VAR_RESULT',
            right: '1',
          }),
          step('Branch#2', 'branch', {
            macro: 'goto_if_eq',
            args: ['Branch_Yes'],
            label: 'Branch_Yes',
          }),
          step('Branch_Yes#0', 'dialogue', {
            macro: 'msgbox',
            args: ['Text_Yes', 'MSGBOX_DEFAULT'],
            text: 'Text_Yes',
          }),
        ],
      },
      [
        { id: 'Text_AskMode' },
        { id: 'Text_Yes' },
      ],
    );

    const trace = traceDialogueNarrative(manifest, 'Text_AskMode');
    const branchEdge = trace.edges.find((e) => e.toId === 'Text_Yes');
    expect(branchEdge).toBeDefined();
    expect(branchEdge?.label).toBe('if VAR_RESULT == 1');
  });

  it('marks the trace truncated when a caller exists beyond maxDepth', () => {
    const base = emptyManifest('/tmp/x', '2026-05-16T00:00:00Z');
    // Chain: A -> B -> C -> D (each via setvar+msgbox).
    const manifest = withDialogue(
      {
        ...base,
        scriptSteps: [
          step('Chain#0', 'dialogue', { macro: 'msgbox', args: ['A'], text: 'A' }),
          step('Chain#1', 'dialogue', { macro: 'msgbox', args: ['B'], text: 'B' }),
          step('Chain2#0', 'dialogue', { macro: 'msgbox', args: ['B'], text: 'B' }),
          step('Chain2#1', 'dialogue', { macro: 'msgbox', args: ['C'], text: 'C' }),
          step('Chain3#0', 'dialogue', { macro: 'msgbox', args: ['C'], text: 'C' }),
          step('Chain3#1', 'dialogue', { macro: 'msgbox', args: ['D'], text: 'D' }),
        ],
      },
      [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }],
    );

    const trace = traceDialogueNarrative(manifest, 'A', 1);
    // depth=1 means we expand A → B but stop at B (don't follow into C).
    expect(trace.nodes.map((n) => n.id).sort()).toEqual(['A', 'B']);
    expect(trace.edges.map((e) => e.toId)).toEqual(['B']);
    expect(trace.truncated).toBe(true);
  });

  it('surfaces caller metadata (script label + parent trigger) for the root', () => {
    const base = emptyManifest('/tmp/x', '2026-05-16T00:00:00Z');
    const manifest = withDialogue(
      {
        ...base,
        triggers: [
          {
            id: 'trigger_Route101_0',
            name: 'trigger_Route101_0',
            kind: 'on_enter',
            mapId: 'Route101',
            coord: { x: 12, y: 7 },
            conditionExpression: null,
            scriptStepIds: ['Route101_Intro#0', 'Route101_Intro#1'],
          },
        ],
        scriptSteps: [
          step('Route101_Intro#0', 'dialogue', {
            macro: 'msgbox',
            args: ['Text_Hi', 'MSGBOX_DEFAULT'],
            text: 'Text_Hi',
          }),
          step('Route101_Intro#1', 'set_flag', {
            macro: 'setflag',
            args: ['FLAG_INTRO_DONE'],
            flag: 'FLAG_INTRO_DONE',
          }),
        ],
      },
      [{ id: 'Text_Hi', speakerName: 'Narrator' }],
    );

    const trace = traceDialogueNarrative(manifest, 'Text_Hi');
    expect(trace.callers).toHaveLength(1);
    const caller = trace.callers[0]!;
    expect(caller.scriptStepId).toBe('Route101_Intro#0');
    expect(caller.scriptLabel).toBe('Route101_Intro');
    expect(caller.triggerId).toBe('trigger_Route101_0');
    expect(caller.triggerKind).toBe('on_enter');
    expect(caller.mapId).toBe('Route101');
  });
});
