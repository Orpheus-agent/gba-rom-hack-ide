import { describe, expect, it } from 'vitest';
import type { ProjectManifest, ScriptStep } from '@rom-editor/shared';
import { emptyManifest } from '@rom-editor/shared';
import {
  armBreakpoint,
  clearHits,
  disarmBreakpoint,
  emptyBreakpointState,
  evaluateBreakpoints,
  recordHits,
} from './previewBreakpoints';

function step(id: string, kind: ScriptStep['kind'], params: Record<string, unknown>): ScriptStep {
  return { id, kind, params };
}

function makeManifest(): ProjectManifest {
  const base = emptyManifest('/tmp/x', '2026-05-16T00:00:00Z');
  return {
    ...base,
    objectEvents: [
      {
        id: 'obj_mom',
        name: 'obj_mom',
        mapId: 'LittlerootTown',
        coord: { x: 5, y: 4 },
        elevation: 3,
        kind: 'npc',
        graphicsId: 'OBJ_EVENT_GFX_MOM',
        movementType: 'WANDER_AROUND',
        scriptId: 'LittlerootTown_Mom',
        flagId: 'FLAG_HIDE_MOM',
        trainerType: null,
        metadata: {},
      },
    ],
    warps: [
      {
        id: 'warp_to_route101',
        name: 'warp_to_route101',
        fromMapId: 'LittlerootTown',
        fromCoord: { x: 8, y: 9 },
        toMapId: 'Route101',
        toCoord: { x: 0, y: 8 },
      },
    ],
    triggers: [
      {
        id: 'trig_intro',
        name: 'trig_intro',
        kind: 'on_enter',
        mapId: 'LittlerootTown',
        coord: { x: 10, y: 10 },
        conditionExpression: 'FLAG_INTRO_DONE',
        scriptStepIds: ['LittlerootTown_Intro#0'],
      },
    ],
    scriptSteps: [
      step('LittlerootTown_Mom#0', 'dialogue', {
        macro: 'msgbox',
        args: ['Text_MomHi', 'MSGBOX_NPC'],
        text: 'Text_MomHi',
      }),
      step('LittlerootTown_Intro#0', 'set_flag', {
        macro: 'setflag',
        args: ['FLAG_INTRO_DONE'],
        flag: 'FLAG_INTRO_DONE',
      }),
    ],
  };
}

describe('previewBreakpoints.evaluateBreakpoints', () => {
  it('returns empty when no breakpoints are armed', () => {
    const r = evaluateBreakpoints(emptyBreakpointState(), makeManifest(), 'LittlerootTown', { x: 0, y: 0 });
    expect(r).toEqual([]);
  });

  it('matches a warp_taken breakpoint when player is on the warp fromCoord', () => {
    const s = armBreakpoint(emptyBreakpointState(), { id: 'bp1', kind: 'warp_taken', entityId: null });
    const r = evaluateBreakpoints(s, makeManifest(), 'LittlerootTown', { x: 8, y: 9 });
    expect(r).toHaveLength(1);
    expect(r[0]?.kind).toBe('warp_taken');
    expect(r[0]?.entityId).toBe('warp_to_route101');
    expect(r[0]?.reason).toContain('Route101');
  });

  it('does not match a warp_taken breakpoint elsewhere on the map', () => {
    const s = armBreakpoint(emptyBreakpointState(), { id: 'bp1', kind: 'warp_taken', entityId: null });
    const r = evaluateBreakpoints(s, makeManifest(), 'LittlerootTown', { x: 0, y: 0 });
    expect(r).toEqual([]);
  });

  it('matches an object_event_step and annotates the flag gating', () => {
    const s = armBreakpoint(emptyBreakpointState(), { id: 'bp1', kind: 'object_event_step', entityId: null });
    const r = evaluateBreakpoints(s, makeManifest(), 'LittlerootTown', { x: 5, y: 4 });
    expect(r).toHaveLength(1);
    expect(r[0]?.reason).toContain('gated by FLAG_HIDE_MOM');
  });

  it('matches a trigger_fire breakpoint at the trigger coord with condition reported', () => {
    const s = armBreakpoint(emptyBreakpointState(), { id: 'bp1', kind: 'trigger_fire', entityId: null });
    const r = evaluateBreakpoints(s, makeManifest(), 'LittlerootTown', { x: 10, y: 10 });
    expect(r).toHaveLength(1);
    expect(r[0]?.reason).toContain('if FLAG_INTRO_DONE');
  });

  it('matches a dialogue_show breakpoint by walking the object event scriptId to its first msgbox', () => {
    const s = armBreakpoint(emptyBreakpointState(), { id: 'bp1', kind: 'dialogue_show', entityId: null });
    const r = evaluateBreakpoints(s, makeManifest(), 'LittlerootTown', { x: 5, y: 4 });
    expect(r).toHaveLength(1);
    expect(r[0]?.entityId).toBe('Text_MomHi');
    expect(r[0]?.reason).toContain('Text_MomHi');
    expect(r[0]?.reason).toContain('obj_mom');
  });

  it('honors entityId filter - non-matching entity id does not fire', () => {
    const s = armBreakpoint(emptyBreakpointState(), {
      id: 'bp1',
      kind: 'warp_taken',
      entityId: 'warp_DIFFERENT',
    });
    const r = evaluateBreakpoints(s, makeManifest(), 'LittlerootTown', { x: 8, y: 9 });
    expect(r).toEqual([]);
  });
});

describe('previewBreakpoints state ops', () => {
  it('armBreakpoint appends a new breakpoint and recordHits stamps it with a sequence', () => {
    let s = emptyBreakpointState();
    s = armBreakpoint(s, { id: 'bp1', kind: 'warp_taken', entityId: null });
    expect(s.breakpoints).toHaveLength(1);

    const matches = evaluateBreakpoints(s, makeManifest(), 'LittlerootTown', { x: 8, y: 9 });
    s = recordHits(s, matches);
    expect(s.hits).toHaveLength(1);
    expect(s.hits[0]?.sequence).toBe(0);
    expect(s.nextSequence).toBe(1);

    // Another hit increments
    const matches2 = evaluateBreakpoints(s, makeManifest(), 'LittlerootTown', { x: 8, y: 9 });
    s = recordHits(s, matches2);
    expect(s.hits).toHaveLength(2);
    // Most-recent first
    expect(s.hits[0]?.sequence).toBe(1);
    expect(s.hits[1]?.sequence).toBe(0);
  });

  it('disarmBreakpoint removes the breakpoint by id; clearHits empties history', () => {
    let s = armBreakpoint(emptyBreakpointState(), { id: 'bp1', kind: 'warp_taken', entityId: null });
    s = recordHits(s, evaluateBreakpoints(s, makeManifest(), 'LittlerootTown', { x: 8, y: 9 }));
    expect(s.hits).toHaveLength(1);

    s = clearHits(s);
    expect(s.hits).toEqual([]);
    expect(s.breakpoints).toHaveLength(1);

    s = disarmBreakpoint(s, 'bp1');
    expect(s.breakpoints).toEqual([]);
  });
});
