import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ProjectManifest, ScriptStep, Trigger } from '@rom-editor/shared';
import { emptyManifest } from '@rom-editor/shared';
import { EventsView } from './EventsView';

function makeManifest(): ProjectManifest {
  const base = emptyManifest('/tmp/example', '2026-05-16T00:00:00Z');
  const triggers: Trigger[] = [
    {
      id: 'MAP_LITTLEROOT_TOWN_bg_0',
      name: 'LittlerootTown_Sign',
      kind: 'on_interact',
      mapId: 'MAP_LITTLEROOT_TOWN',
      coord: { x: 4, y: 5 },
      conditionExpression: null,
      scriptStepIds: [
        'LittlerootTown_Sign#0',
        'LittlerootTown_Sign#1',
        'LittlerootTown_Sign#2',
      ],
    },
    {
      id: 'MAP_LITTLEROOT_TOWN_coord_0',
      name: 'LittlerootTown_Intro',
      kind: 'on_enter',
      mapId: 'MAP_LITTLEROOT_TOWN',
      coord: { x: 10, y: 10 },
      conditionExpression: 'VAR_INTRO_STATE == 1',
      scriptStepIds: ['LittlerootTown_Intro#0'],
    },
  ];
  const scriptSteps: ScriptStep[] = [
    {
      id: 'LittlerootTown_Sign#0',
      kind: 'raw',
      params: { macro: 'lock', args: [] },
    },
    {
      id: 'LittlerootTown_Sign#1',
      kind: 'dialogue',
      params: { macro: 'msgbox', args: ['SignText', 'MSGBOX_SIGN'], text: 'SignText' },
    },
    {
      id: 'LittlerootTown_Sign#2',
      kind: 'raw',
      params: { macro: 'release', args: [] },
    },
    {
      id: 'LittlerootTown_Intro#0',
      kind: 'set_flag',
      params: { macro: 'setflag', args: ['FLAG_INTRO_SEEN'], flag: 'FLAG_INTRO_SEEN' },
    },
  ];
  return { ...base, triggers, scriptSteps };
}

describe('EventsView', () => {
  afterEach(() => cleanup());

  it('renders the empty-state when no triggers are in the manifest', () => {
    const base = emptyManifest('/tmp/example', '2026-05-16T00:00:00Z');
    render(<EventsView manifest={base} />);
    expect(screen.getByTestId('events-view-empty')).toBeInTheDocument();
  });

  it('lists each trigger grouped by mapId in the left rail', () => {
    render(<EventsView manifest={makeManifest()} />);
    expect(screen.getByText(/MAP_LITTLEROOT_TOWN/)).toBeInTheDocument();
    expect(screen.getByTestId('events-view-trigger-MAP_LITTLEROOT_TOWN_bg_0')).toBeInTheDocument();
    expect(
      screen.getByTestId('events-view-trigger-MAP_LITTLEROOT_TOWN_coord_0'),
    ).toBeInTheDocument();
  });

  it('shows a placeholder until a trigger is selected', () => {
    render(<EventsView manifest={makeManifest()} />);
    expect(screen.getByTestId('events-view-no-selection')).toBeInTheDocument();
  });

  it('renders the event graph with one node per script step when a trigger is selected', () => {
    render(<EventsView manifest={makeManifest()} />);
    fireEvent.click(screen.getByTestId('events-view-trigger-MAP_LITTLEROOT_TOWN_bg_0'));
    expect(screen.getByTestId('event-graph')).toBeInTheDocument();
    expect(screen.getByTestId('event-node-LittlerootTown_Sign#0')).toBeInTheDocument();
    expect(screen.getByTestId('event-node-LittlerootTown_Sign#1')).toBeInTheDocument();
    expect(screen.getByTestId('event-node-LittlerootTown_Sign#2')).toBeInTheDocument();
  });

  it('shows the trigger inspector before a step is selected', () => {
    render(<EventsView manifest={makeManifest()} />);
    fireEvent.click(screen.getByTestId('events-view-trigger-MAP_LITTLEROOT_TOWN_coord_0'));
    const inspector = screen.getByTestId('events-view-inspector');
    expect(inspector.textContent).toMatch(/on_enter/);
    expect(inspector.textContent).toMatch(/VAR_INTRO_STATE == 1/);
  });

  it('shows the step inspector after clicking a node', () => {
    render(<EventsView manifest={makeManifest()} />);
    fireEvent.click(screen.getByTestId('events-view-trigger-MAP_LITTLEROOT_TOWN_bg_0'));
    fireEvent.click(screen.getByTestId('event-node-LittlerootTown_Sign#1'));
    const stepInspector = screen.getByTestId('events-view-step-inspector');
    expect(stepInspector.textContent).toMatch(/dialogue/i);
    expect(stepInspector.textContent).toMatch(/msgbox/);
    expect(stepInspector.textContent).toMatch(/SignText/);
  });

  it('renders the EventGraph empty state when trigger has no resolved steps', () => {
    const m = makeManifest();
    const orphan: Trigger = {
      id: 'MAP_X_bg_0',
      name: 'OrphanScript',
      kind: 'on_interact',
      mapId: 'MAP_X',
      coord: { x: 0, y: 0 },
      conditionExpression: null,
      scriptStepIds: [],
    };
    render(<EventsView manifest={{ ...m, triggers: [...m.triggers, orphan] }} />);
    fireEvent.click(screen.getByTestId('events-view-trigger-MAP_X_bg_0'));
    expect(screen.getByTestId('event-graph-empty')).toBeInTheDocument();
  });
});
