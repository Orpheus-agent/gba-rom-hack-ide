import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  CommandPalette,
  useCommandPaletteShortcut,
  useCommandPaletteStore,
} from './CommandPalette';
import {
  useProjectStore,
  useSelection,
} from '../state';
import type {
  ProjectManifest,
  ScanResponse,
  SpeciesEntry,
  Trainer,
} from '@rom-editor/shared';

function makeScan(overrides: Partial<ProjectManifest> = {}): ScanResponse {
  const manifest: ProjectManifest = {
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
  return {
    sessionId: 'test',
    manifestPath: '/abs/test/.editor/manifest.json',
    scannerName: 'Test',
    scanDurationMs: 1,
    warnings: [],
    manifest,
  };
}

const bulbasaur: SpeciesEntry = {
  id: 'species_1',
  speciesIndex: 1,
  baseHP: 45,
  baseAttack: 49,
  baseDefense: 49,
  baseSpeed: 45,
  baseSpAttack: 65,
  baseSpDefense: 65,
  type1: 12,
  type2: 3,
  catchRate: 45,
  expYield: 64,
  item1: 0,
  item2: 0,
  genderRatio: 31,
  eggCycles: 20,
  friendship: 70,
  growthRate: 3,
  eggGroup1: 1,
  eggGroup2: 7,
  ability1: 65,
  ability2: 65,
  safariZoneFleeRate: 0,
  sourceFileOffset: 0,
  name: 'BULBASAUR',
} as SpeciesEntry;

const brock: Trainer = {
  id: 'TRAINER_BROCK',
  name: 'BROCK',
  className: 'GYM LEADER',
  party: [{ speciesId: 'species_74', level: 12, moveIds: [], heldItemId: null }],
  aiFlags: [],
  mapId: 'MAP_PEWTER_GYM',
} as Trainer;

describe('CommandPalette (Phase X.1)', () => {
  beforeEach(() => {
    useCommandPaletteStore.setState({ open: true });
    useSelection.setState({ current: null, history: [] });
    useProjectStore.setState({
      load: { kind: 'empty' },
      scan: { kind: 'loaded', data: makeScan({ species: [bulbasaur], trainers: [brock] }) },
    });
  });
  afterEach(() => {
    cleanup();
    useCommandPaletteStore.setState({ open: false });
  });

  it('does not render when closed', () => {
    useCommandPaletteStore.setState({ open: false });
    render(<CommandPalette />);
    expect(screen.queryByTestId('command-palette')).not.toBeInTheDocument();
  });

  it('renders the palette + indexed count when open with no query', () => {
    render(<CommandPalette />);
    expect(screen.getByTestId('command-palette')).toBeInTheDocument();
    expect(screen.getByTestId('command-palette-results').textContent).toMatch(
      /entities indexed/,
    );
  });

  it('typing a query surfaces ranked results', () => {
    render(<CommandPalette />);
    const input = screen.getByTestId(
      'command-palette-input',
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'BULBASAUR' } });
    expect(screen.getByTestId('command-palette-row-0').textContent).toMatch(
      /BULBASAUR/,
    );
  });

  it('Enter on a result fires useSelection.select', () => {
    render(<CommandPalette />);
    const input = screen.getByTestId(
      'command-palette-input',
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'BULBASAUR' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(useSelection.getState().current).toEqual({
      kind: 'species',
      id: 'species_1',
      mapContext: undefined,
    });
    expect(useCommandPaletteStore.getState().open).toBe(false);
  });

  it('arrow keys move the active row', () => {
    render(<CommandPalette />);
    const input = screen.getByTestId(
      'command-palette-input',
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'a' } });
    // Two rows expected (BULBASAUR matches 'a' in name, TRAINER_BROCK matches via leader/'a'-tag).
    const rows = screen.queryAllByTestId(/^command-palette-row-\d+$/);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]?.classList.contains('command-palette__row--active')).toBe(true);
    if (rows.length > 1) {
      fireEvent.keyDown(input, { key: 'ArrowDown' });
      expect(rows[1]?.classList.contains('command-palette__row--active')).toBe(true);
    }
  });

  it('Esc closes the palette without selecting', () => {
    render(<CommandPalette />);
    const input = screen.getByTestId(
      'command-palette-input',
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'BULBASAUR' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(useCommandPaletteStore.getState().open).toBe(false);
    expect(useSelection.getState().current).toBeNull();
  });

  it('clicking a row selects + closes', () => {
    render(<CommandPalette />);
    const input = screen.getByTestId(
      'command-palette-input',
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'brock' } });
    fireEvent.click(screen.getByTestId('command-palette-row-0'));
    expect(useSelection.getState().current?.kind).toBe('trainer');
    expect(useSelection.getState().current?.id).toBe('TRAINER_BROCK');
    expect(useCommandPaletteStore.getState().open).toBe(false);
  });

  it('shows "no matches" for a query with no results', () => {
    render(<CommandPalette />);
    const input = screen.getByTestId(
      'command-palette-input',
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'nonexistent-xyz' } });
    expect(screen.getByTestId('command-palette-results').textContent).toMatch(
      /No matches/,
    );
  });
});

describe('useCommandPaletteShortcut (Phase X.1)', () => {
  it('Ctrl+K toggles the palette open/closed', () => {
    function TestHarness() {
      useCommandPaletteShortcut();
      return null;
    }
    useCommandPaletteStore.setState({ open: false });
    render(<TestHarness />);
    expect(useCommandPaletteStore.getState().open).toBe(false);
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    expect(useCommandPaletteStore.getState().open).toBe(true);
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    expect(useCommandPaletteStore.getState().open).toBe(false);
  });
});
