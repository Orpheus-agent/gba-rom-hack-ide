import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ObjectEventInspector } from './ObjectEventInspector';
import { WarpInspector } from './WarpInspector';
import { TriggerInspector } from './TriggerInspector';
import {
  useSelection,
  useUiPreferencesStore,
  type EntityRef,
} from '../state';
import type {
  ObjectEvent,
  ProjectManifest,
  ScriptStep,
  Trigger,
  Warp,
} from '@rom-editor/shared';

function makeManifest(overrides: Partial<ProjectManifest> = {}): ProjectManifest {
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

const brock: ObjectEvent = {
  id: 'obj_brock',
  name: 'Brock',
  mapId: 'MAP_PEWTER_GYM',
  coord: { x: 5, y: 8 },
  elevation: 3,
  kind: 'trainer',
  graphicsId: 'gfx_brock',
  movementType: 'still',
  scriptId: 'script_brock',
  flagId: 'FLAG_DEFEATED_BROCK',
  trainerType: 'gym_leader',
  metadata: {},
};

const warpAtoB: Warp = {
  id: 'warp_a_b',
  fromMapId: 'MAP_PALLET_TOWN',
  fromCoord: { x: 8, y: 5 },
  toMapId: 'MAP_OAK_LAB',
  toCoord: { x: 4, y: 7 },
} as Warp;

const warpBtoA: Warp = {
  id: 'warp_b_a',
  fromMapId: 'MAP_OAK_LAB',
  fromCoord: { x: 4, y: 7 },
  toMapId: 'MAP_PALLET_TOWN',
  toCoord: { x: 8, y: 5 },
} as Warp;

const introTrigger: Trigger = {
  id: 'trig_intro',
  name: 'Intro trigger',
  kind: 'on_enter',
  mapId: 'MAP_OAK_LAB',
  coord: { x: 4, y: 7 },
  conditionExpression: 'VAR_INTRO_STATE == 0',
  scriptStepIds: ['step_a', 'step_b'],
};

describe('ObjectEventInspector (Phase S.2)', () => {
  beforeEach(() => {
    useUiPreferencesStore.setState({ showInternalIds: false });
    useSelection.setState({ current: null, history: [] });
  });
  afterEach(() => cleanup());

  it('renders kind, name, map context, flag gate, and script', () => {
    const sel: EntityRef = { kind: 'objectEvent', id: 'obj_brock' };
    render(
      <ObjectEventInspector
        selection={sel}
        manifest={makeManifest({ objectEvents: [brock] })}
        sessionId="s1"
      />,
    );
    expect(screen.getByTestId('object-event-inspector-kind').textContent).toBe(
      'Trainer',
    );
    expect(screen.getByTestId('object-event-inspector-name').textContent).toMatch(
      /brock/i,
    );
    expect(screen.getByTestId('object-event-inspector-flag').textContent).toMatch(
      /FLAG_DEFEATED_BROCK/,
    );
    expect(screen.getByTestId('object-event-inspector-script')).toBeInTheDocument();
  });

  it('clicking the flag back-ref selects the flag', () => {
    const sel: EntityRef = { kind: 'objectEvent', id: 'obj_brock' };
    render(
      <ObjectEventInspector
        selection={sel}
        manifest={makeManifest({ objectEvents: [brock] })}
        sessionId="s1"
      />,
    );
    const flagBtn = screen
      .getAllByRole('button')
      .find((b) => b.textContent?.includes('FLAG_DEFEATED_BROCK'));
    fireEvent.click(flagBtn!);
    expect(useSelection.getState().current).toEqual({
      kind: 'flag',
      id: 'FLAG_DEFEATED_BROCK',
    });
  });
});

describe('WarpInspector (Phase S.3)', () => {
  beforeEach(() => {
    useSelection.setState({ current: null, history: [] });
    useUiPreferencesStore.setState({ showInternalIds: false });
  });
  afterEach(() => cleanup());

  it('renders from/to with coords + click-through', () => {
    const sel: EntityRef = { kind: 'warp', id: 'warp_a_b' };
    render(
      <WarpInspector
        selection={sel}
        manifest={makeManifest({ warps: [warpAtoB, warpBtoA] })}
        sessionId="s1"
      />,
    );
    expect(screen.getByTestId('warp-inspector-from').textContent).toMatch(
      /PALLET_TOWN/,
    );
    expect(screen.getByTestId('warp-inspector-to').textContent).toMatch(/OAK_LAB/);
    // Reverse warp detected.
    expect(screen.getByTestId('warp-inspector-reverse').textContent).toMatch(
      /Return path/,
    );
    expect(screen.getByTestId('warp-inspector-reverse').textContent).toMatch(/\(1\)/);
  });

  it('reports one-way when no reverse warp', () => {
    const sel: EntityRef = { kind: 'warp', id: 'warp_a_b' };
    render(
      <WarpInspector
        selection={sel}
        manifest={makeManifest({ warps: [warpAtoB] })}
        sessionId="s1"
      />,
    );
    expect(screen.getByTestId('warp-inspector-reverse').textContent).toMatch(
      /one-way passage/,
    );
  });

  it('clicking to-map selects the map', () => {
    const sel: EntityRef = { kind: 'warp', id: 'warp_a_b' };
    render(
      <WarpInspector
        selection={sel}
        manifest={makeManifest({ warps: [warpAtoB] })}
        sessionId="s1"
      />,
    );
    const toBtn = screen
      .getAllByRole('button')
      .find((b) => b.textContent?.includes('OAK_LAB'));
    fireEvent.click(toBtn!);
    expect(useSelection.getState().current).toEqual({
      kind: 'map',
      id: 'MAP_OAK_LAB',
    });
  });
});

describe('TriggerInspector (Phase S.8-lite)', () => {
  beforeEach(() => {
    useSelection.setState({ current: null, history: [] });
    useUiPreferencesStore.setState({ showInternalIds: false });
  });
  afterEach(() => cleanup());

  it('renders kind, condition, script steps', () => {
    const sel: EntityRef = { kind: 'trigger', id: 'trig_intro' };
    const stepA = { id: 'step_a', kind: 'dialogue', params: {} } as ScriptStep;
    const stepB = { id: 'step_b', kind: 'set_flag', params: {} } as ScriptStep;
    render(
      <TriggerInspector
        selection={sel}
        manifest={makeManifest({
          triggers: [introTrigger],
          scriptSteps: [stepA, stepB],
        })}
        sessionId="s1"
      />,
    );
    expect(screen.getByTestId('trigger-inspector-kind').textContent).toBe('On enter');
    expect(screen.getByTestId('trigger-inspector-condition').textContent).toMatch(
      /VAR_INTRO_STATE == 0/,
    );
    expect(screen.getByTestId('trigger-inspector-steps').textContent).toMatch(
      /Script chain/,
    );
    expect(screen.getByTestId('trigger-inspector-steps').textContent).toMatch(
      /dialogue|set_flag/,
    );
  });

  it('clicking a script step selects the step', () => {
    const sel: EntityRef = { kind: 'trigger', id: 'trig_intro' };
    const stepA = { id: 'step_a', kind: 'dialogue', params: {} } as ScriptStep;
    const stepB = { id: 'step_b', kind: 'set_flag', params: {} } as ScriptStep;
    render(
      <TriggerInspector
        selection={sel}
        manifest={makeManifest({
          triggers: [introTrigger],
          scriptSteps: [stepA, stepB],
        })}
        sessionId="s1"
      />,
    );
    const stepBtns = screen
      .getAllByRole('button')
      .filter((b) => b.textContent?.includes('dialogue'));
    fireEvent.click(stepBtns[0]!);
    expect(useSelection.getState().current?.kind).toBe('scriptStep');
    expect(useSelection.getState().current?.id).toBe('step_a');
  });
});
