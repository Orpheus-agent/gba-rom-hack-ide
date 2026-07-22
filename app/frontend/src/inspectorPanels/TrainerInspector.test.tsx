import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TrainerInspector } from './TrainerInspector';
import {
  useSelection,
  useUiPreferencesStore,
  type EntityRef,
} from '../state';
import type { ProjectManifest, Trainer } from '@rom-editor/shared';

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

const brock: Trainer = {
  id: 'TRAINER_BROCK',
  name: 'BROCK',
  className: 'GYM LEADER',
  party: [
    {
      speciesId: 'species_74',
      level: 12,
      moveIds: ['move_88', 'move_111'],
      heldItemId: null,
    },
    {
      speciesId: 'species_95',
      level: 14,
      moveIds: ['move_88', 'move_106', 'move_1'],
      heldItemId: 'item_55',
    },
  ],
  aiFlags: ['BASIC', 'CHECK_BAD_MOVE'],
  mapId: 'MAP_PEWTER_CITY_GYM',
  metadata: { partyOffset: '0x23eba8', partyFlags: 'Moves' },
} as Trainer;

describe('TrainerInspector (Phase S.7)', () => {
  beforeEach(() => {
    useUiPreferencesStore.setState({ showInternalIds: false });
    useSelection.setState({ current: null, history: [] });
  });
  afterEach(() => cleanup());

  it('renders no-manifest state', () => {
    const sel: EntityRef = { kind: 'trainer', id: 'TRAINER_BROCK' };
    render(<TrainerInspector selection={sel} manifest={null} sessionId={null} />);
    expect(screen.getByText(/Open a project to inspect/i)).toBeInTheDocument();
  });

  it('renders unknown trainer when manifest lacks the id', () => {
    const sel: EntityRef = { kind: 'trainer', id: 'TRAINER_GHOST' };
    render(<TrainerInspector selection={sel} manifest={makeManifest()} sessionId="s1" />);
    expect(screen.getByText(/no trainer with that id is present/i)).toBeInTheDocument();
  });

  it('renders class + party + AI flags + map link', () => {
    const sel: EntityRef = { kind: 'trainer', id: 'TRAINER_BROCK' };
    render(
      <TrainerInspector
        selection={sel}
        manifest={makeManifest({ trainers: [brock] })}
        sessionId="s1"
      />,
    );
    expect(screen.getByTestId('trainer-inspector-class').textContent).toBe('GYM LEADER');
    expect(screen.getByTestId('trainer-inspector-party').textContent).toMatch(/Lv 12/);
    expect(screen.getByTestId('trainer-inspector-party').textContent).toMatch(/Lv 14/);
    expect(screen.getByTestId('trainer-inspector-ai').textContent).toMatch(/BASIC/);
    expect(screen.getByTestId('trainer-inspector-ai').textContent).toMatch(
      /CHECK_BAD_MOVE/,
    );
  });

  it('clicking a party species button selects the species', () => {
    const sel: EntityRef = { kind: 'trainer', id: 'TRAINER_BROCK' };
    render(
      <TrainerInspector
        selection={sel}
        manifest={makeManifest({ trainers: [brock] })}
        sessionId="s1"
      />,
    );
    const speciesBtns = screen
      .getAllByRole('button')
      .filter((b) => b.textContent?.includes('Lv 12'));
    expect(speciesBtns.length).toBeGreaterThan(0);
    fireEvent.click(speciesBtns[0]!);
    expect(useSelection.getState().current).toEqual({
      kind: 'species',
      id: 'species_74',
    });
  });

  it('clicking a move chip selects the move', () => {
    const sel: EntityRef = { kind: 'trainer', id: 'TRAINER_BROCK' };
    render(
      <TrainerInspector
        selection={sel}
        manifest={makeManifest({ trainers: [brock] })}
        sessionId="s1"
      />,
    );
    // Find a move chip - move_88, move_111, etc. resolve through
    // displayName, so the text content shows the resolved label like
    // "Move @ 0x..." or "Move #N". We click whichever has #88.
    const allButtons = screen.getAllByRole('button');
    const moveChips = allButtons.filter((b) =>
      /move_88|#88/i.test(b.textContent ?? ''),
    );
    expect(moveChips.length).toBeGreaterThan(0);
    fireEvent.click(moveChips[0]!);
    expect(useSelection.getState().current?.kind).toBe('move');
    expect(useSelection.getState().current?.id).toBe('move_88');
  });

  it('clicking the map link selects the map', () => {
    const sel: EntityRef = { kind: 'trainer', id: 'TRAINER_BROCK' };
    render(
      <TrainerInspector
        selection={sel}
        manifest={makeManifest({ trainers: [brock] })}
        sessionId="s1"
      />,
    );
    const mapBtn = screen
      .getAllByRole('button')
      .find((b) => b.textContent?.includes('PEWTER'));
    expect(mapBtn).toBeTruthy();
    fireEvent.click(mapBtn!);
    expect(useSelection.getState().current?.kind).toBe('map');
    expect(useSelection.getState().current?.id).toBe('MAP_PEWTER_CITY_GYM');
  });

  it('clicking held item selects the item', () => {
    const sel: EntityRef = { kind: 'trainer', id: 'TRAINER_BROCK' };
    render(
      <TrainerInspector
        selection={sel}
        manifest={makeManifest({ trainers: [brock] })}
        sessionId="s1"
      />,
    );
    const itemBtn = screen
      .getAllByRole('button')
      .find((b) => b.textContent?.includes('item_55') ||
        /item.*55/i.test(b.textContent ?? '') ||
        /Item #55/.test(b.textContent ?? ''));
    expect(itemBtn).toBeTruthy();
    fireEvent.click(itemBtn!);
    expect(useSelection.getState().current?.kind).toBe('item');
    expect(useSelection.getState().current?.id).toBe('item_55');
  });

  it('developer-details disclosure shows metadata', () => {
    const sel: EntityRef = { kind: 'trainer', id: 'TRAINER_BROCK' };
    render(
      <TrainerInspector
        selection={sel}
        manifest={makeManifest({ trainers: [brock] })}
        sessionId="s1"
      />,
    );
    fireEvent.click(screen.getByTestId('trainer-inspector-advanced-toggle'));
    expect(screen.getByTestId('trainer-inspector-advanced').textContent).toMatch(
      /0x23eba8/,
    );
    expect(screen.getByTestId('trainer-inspector-advanced').textContent).toMatch(
      /Moves/,
    );
  });
});
