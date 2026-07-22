import { beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ProjectManifest, ScriptStep } from '@rom-editor/shared';
import { VisualScriptEditor } from './VisualScriptEditor';
import { useSelection, useViewStore } from '../../state';

function makeManifest(scriptSteps: ScriptStep[]): ProjectManifest {
  return {
    schemaVersion: 1,
    generatedAtUtc: '2026-05-25T00:00:00.000Z',
    projectRoot: '/tmp/test',
    identity: {
      kind: 'patch',
      confidence: 0.5,
      displayName: 'Bare ROM',
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
    scriptSteps,
    assets: [],
  };
}

function makeStep(id: string, over: Partial<ScriptStep>): ScriptStep {
  return {
    id,
    kind: 'raw',
    params: {},
    ...over,
  };
}

describe('VisualScriptEditor', () => {
  beforeEach(() => {
    cleanup();
    useSelection.setState({ current: null, history: [] });
  });

  it('renders the empty-state message when no steps exist', () => {
    const m = makeManifest([]);
    render(<VisualScriptEditor scriptId="script_oak" manifest={m} />);
    expect(screen.getByTestId('visual-script-empty')).toBeInTheDocument();
  });

  it('renders one card per step belonging to the scriptId, sorted numerically', () => {
    const m = makeManifest([
      makeStep('script_oak__10', { kind: 'set_flag', params: { flagId: 'binary_flag_2095' } }),
      makeStep('script_oak__2', { kind: 'dialogue', params: { dialogueText: 'Hello' } }),
      makeStep('script_oak__1', { kind: 'dialogue', params: { dialogueText: 'Welcome' } }),
      makeStep('other_script__1', { kind: 'dialogue', params: { dialogueText: 'Should not show' } }),
    ]);
    render(<VisualScriptEditor scriptId="script_oak" manifest={m} />);
    const cards = screen.getAllByTestId(/^visual-script-card-script_oak__\d+$/);
    expect(cards).toHaveLength(3);
    // Numeric sort: __1, __2, __10 (not lexicographic __1, __10, __2)
    expect(cards[0]!.getAttribute('data-testid')).toBe('visual-script-card-script_oak__1');
    expect(cards[1]!.getAttribute('data-testid')).toBe('visual-script-card-script_oak__2');
    expect(cards[2]!.getAttribute('data-testid')).toBe('visual-script-card-script_oak__10');
  });

  it('renders the plain-English summary for each card (no underscores, no hex)', () => {
    const m = makeManifest([
      makeStep('script_oak__1', {
        kind: 'dialogue',
        params: { dialogueText: 'Welcome to Pallet Town!' },
      }),
      makeStep('script_oak__2', {
        kind: 'set_flag',
        params: { flagId: 'binary_flag_2095' },
      }),
    ]);
    render(<VisualScriptEditor scriptId="script_oak" manifest={m} />);
    expect(screen.getByTestId('visual-script-card-summary-script_oak__1').textContent).toBe(
      'Show dialogue - "Welcome to Pallet Town!"',
    );
    expect(screen.getByTestId('visual-script-card-summary-script_oak__2').textContent).toBe(
      'Mark "Defeated Brock (Pewter)" as done',
    );
    // No raw kind enum strings leaking through
    const list = screen.getByTestId('visual-script-list');
    expect(list.textContent).not.toMatch(/set_flag/);
    expect(list.textContent).not.toMatch(/0x82F/i);
  });

  it('clicking a card selects the step → opens it in the inspector', () => {
    const m = makeManifest([
      makeStep('script_oak__1', { kind: 'dialogue', params: { dialogueText: 'Hi' } }),
    ]);
    render(<VisualScriptEditor scriptId="script_oak" manifest={m} />);
    fireEvent.click(screen.getByTestId('visual-script-card-button-script_oak__1'));
    const sel = useSelection.getState().current;
    expect(sel).toEqual({ kind: 'scriptStep', id: 'script_oak__1' });
  });

  it('highlights the currently-selected card', () => {
    const m = makeManifest([
      makeStep('script_oak__1', { kind: 'dialogue', params: { dialogueText: 'Hi' } }),
      makeStep('script_oak__2', { kind: 'set_flag', params: { flagId: 'binary_flag_2095' } }),
    ]);
    useSelection.getState().select({ kind: 'scriptStep', id: 'script_oak__2' });
    render(<VisualScriptEditor scriptId="script_oak" manifest={m} />);
    expect(screen.getByTestId('visual-script-card-script_oak__2').className).toMatch(
      /visual-script__card--selected/,
    );
    expect(screen.getByTestId('visual-script-card-script_oak__1').className).not.toMatch(
      /visual-script__card--selected/,
    );
  });

  it('shows the action count + engine-command sub-count in the header', () => {
    const m = makeManifest([
      makeStep('script_oak__1', { kind: 'dialogue', params: { dialogueText: 'Hi' } }),
      makeStep('script_oak__2', { kind: 'set_flag', params: { flagId: 'binary_flag_2095' } }),
      makeStep('script_oak__3', { kind: 'raw', params: { opcode: 0x80 } }),
    ]);
    render(<VisualScriptEditor scriptId="script_oak" manifest={m} />);
    expect(screen.getByTestId('visual-script-action-count').textContent).toBe('2 actions');
    expect(screen.getByTestId('visual-script-internal-count').textContent).toMatch(
      /1 engine command/,
    );
  });

  it('filter "Hide engine commands" hides raw-kind steps', () => {
    const m = makeManifest([
      makeStep('script_oak__1', { kind: 'dialogue', params: { dialogueText: 'Hi' } }),
      makeStep('script_oak__2', { kind: 'raw', params: { opcode: 0x80 } }),
    ]);
    render(<VisualScriptEditor scriptId="script_oak" manifest={m} />);
    fireEvent.change(screen.getByTestId('visual-script-filter'), {
      target: { value: 'meaningful' },
    });
    expect(screen.queryByTestId('visual-script-card-script_oak__2')).not.toBeInTheDocument();
    expect(screen.getByTestId('visual-script-card-script_oak__1')).toBeInTheDocument();
  });

  it('filter "Only text & dialogue" keeps only text-category cards', () => {
    const m = makeManifest([
      makeStep('script_oak__1', { kind: 'dialogue', params: { dialogueText: 'Hi' } }),
      makeStep('script_oak__2', { kind: 'set_flag', params: { flagId: 'binary_flag_2095' } }),
      makeStep('script_oak__3', { kind: 'start_battle', params: { trainerId: 'binary_trainer_1' } }),
    ]);
    render(<VisualScriptEditor scriptId="script_oak" manifest={m} />);
    fireEvent.change(screen.getByTestId('visual-script-filter'), {
      target: { value: 'text' },
    });
    expect(screen.getAllByTestId(/^visual-script-card-script_oak/)).toHaveLength(1);
    expect(screen.getByTestId('visual-script-card-script_oak__1')).toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // Phase 9G - "Boot from here" affordance
  // ---------------------------------------------------------------------------

  it('renders a Boot button on every card', () => {
    const m = makeManifest([
      makeStep('script_oak__1', { kind: 'dialogue', params: { dialogueText: 'Hi' } }),
      makeStep('script_oak__2', { kind: 'set_flag', params: { flagId: 'binary_flag_2095' } }),
    ]);
    render(<VisualScriptEditor scriptId="script_oak" manifest={m} />);
    expect(
      screen.getByTestId('visual-script-card-boot-script_oak__1'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('visual-script-card-boot-script_oak__2'),
    ).toBeInTheDocument();
  });

  it('Boot button populates the SceneBoot prefill with the owning map + suggested name', () => {
    const m = makeManifest([
      makeStep('script_oak__1', { kind: 'dialogue', params: { dialogueText: 'Hi' } }),
    ]);
    // Attach an objectEvent that references the script so the editor
    // can find the owning map. Use a spread because the field is
    // typed readonly.
    const mWithEvent = {
      ...m,
      objectEvents: [
        {
          id: 'binary_event_pallet_oak',
          mapId: 'binary_map_3_0',
          kind: 'objectEvent',
          coord: { x: 0, y: 0 },
          scriptId: 'script_oak',
          graphicsId: null,
          flagId: null,
          trainerType: null,
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ] as any,
    } as ProjectManifest;
    // Clear any previous prefill.
    useViewStore.setState({
      sceneBootPrefill: null,
      activeView: 'maps',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    render(<VisualScriptEditor scriptId="script_oak" manifest={mWithEvent} />);
    fireEvent.click(screen.getByTestId('visual-script-card-boot-script_oak__1'));
    const prefill = useViewStore.getState().sceneBootPrefill;
    expect(prefill).not.toBeNull();
    expect(prefill!.startingMapId).toBe('binary_map_3_0');
    expect(prefill!.suggestedName).toContain('script_oak');
    expect(prefill!.suggestedNotes).toContain('step #1');
    expect(useViewStore.getState().activeView).toBe('livePreview');
  });

  it('Boot button still works with empty owning map (user picks manually)', () => {
    const m = makeManifest([
      makeStep('script_oak__1', { kind: 'dialogue', params: { dialogueText: 'Hi' } }),
    ]);
    // No objectEvent references this script.
    useViewStore.setState({
      sceneBootPrefill: null,
      activeView: 'maps',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    render(<VisualScriptEditor scriptId="script_oak" manifest={m} />);
    fireEvent.click(screen.getByTestId('visual-script-card-boot-script_oak__1'));
    const prefill = useViewStore.getState().sceneBootPrefill;
    expect(prefill).not.toBeNull();
    expect(prefill!.startingMapId).toBe('');
    expect(prefill!.suggestedName).toContain('script_oak');
  });
});
