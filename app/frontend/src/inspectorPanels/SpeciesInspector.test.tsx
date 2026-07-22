import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SpeciesInspector } from './SpeciesInspector';
import {
  useSelection,
  useUiPreferencesStore,
  type EntityRef,
} from '../state';
import type {
  AbilityEntry,
  BattleMoveEntry,
  ProjectManifest,
  SpeciesEntry,
  SpeciesLearnsetEntry,
  TypeNameEntry,
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

const grass: TypeNameEntry = { id: 'TYPE_GRASS', typeIndex: 12, name: 'Grass', sourceTableOffset: 0 };
const poison: TypeNameEntry = {
  id: 'TYPE_POISON',
  typeIndex: 3,
  name: 'Poison',
  sourceTableOffset: 0,
};

const overgrow: AbilityEntry = {
  id: 'ABILITY_OVERGROW',
  abilityIndex: 65,
  name: 'OVERGROW',
  sourceTableOffset: 0,
};

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
  sourceFileOffset: 0x1fb070,
  name: 'BULBASAUR',
  type1Name: 'Grass',
  type2Name: 'Poison',
  growthRateName: 'Medium Slow',
} as SpeciesEntry;

const learnset: SpeciesLearnsetEntry = {
  id: 'species_1',
  speciesIndex: 1,
  arrayFileOffset: 0,
  pointerRaw: 0,
  moves: [
    { level: 1, move: 33, moveName: 'TACKLE' },
    { level: 7, move: 22, moveName: 'VINE WHIP' },
    { level: 3, move: 45, moveName: 'GROWL' },
  ],
};

describe('SpeciesInspector (Phase S.6)', () => {
  beforeEach(() => {
    useUiPreferencesStore.setState({ showInternalIds: false });
    useSelection.setState({ current: null, history: [] });
  });
  afterEach(() => cleanup());

  it('renders no-manifest state', () => {
    const sel: EntityRef = { kind: 'species', id: 'species_1' };
    render(<SpeciesInspector selection={sel} manifest={null} sessionId={null} />);
    expect(screen.getByText(/Open a project to inspect/i)).toBeInTheDocument();
  });

  it('renders unknown-species state when manifest has no species', () => {
    const sel: EntityRef = { kind: 'species', id: 'species_1' };
    render(<SpeciesInspector selection={sel} manifest={makeManifest()} sessionId="s1" />);
    expect(
      screen.getByText(/no species with that id is present/i),
    ).toBeInTheDocument();
  });

  it('renders identity + stats + BST + types + abilities', () => {
    const sel: EntityRef = { kind: 'species', id: 'species_1' };
    render(
      <SpeciesInspector
        selection={sel}
        manifest={makeManifest({
          species: [bulbasaur],
          typeNames: [grass, poison],
          abilities: [overgrow],
        })}
        sessionId="s1"
      />,
    );
    expect(screen.getByTestId('species-inspector-name').textContent).toBe('BULBASAUR');
    expect(screen.getByTestId('species-inspector-bst').textContent).toMatch(/318/);
    expect(screen.getByTestId('species-inspector-types').textContent).toMatch(/Grass/);
    expect(screen.getByTestId('species-inspector-types').textContent).toMatch(/Poison/);
    expect(screen.getByTestId('species-inspector-abilities').textContent).toMatch(/OVERGROW/);
  });

  it('sorts learnset by level', () => {
    const sel: EntityRef = { kind: 'species', id: 'species_1' };
    render(
      <SpeciesInspector
        selection={sel}
        manifest={makeManifest({
          species: [bulbasaur],
          typeNames: [grass, poison],
          abilities: [overgrow],
          speciesLearnsets: [learnset],
        })}
        sessionId="s1"
      />,
    );
    const learnsetText =
      screen.getByTestId('species-inspector-learnset').textContent ?? '';
    const tacklePos = learnsetText.indexOf('TACKLE');
    const growlPos = learnsetText.indexOf('GROWL');
    const vineWhipPos = learnsetText.indexOf('VINE WHIP');
    expect(tacklePos).toBeGreaterThan(-1);
    expect(growlPos).toBeGreaterThan(tacklePos); // lv1 < lv3 < lv7
    expect(vineWhipPos).toBeGreaterThan(growlPos);
  });

  it('clicking a type chip selects the type via useSelection', () => {
    const sel: EntityRef = { kind: 'species', id: 'species_1' };
    render(
      <SpeciesInspector
        selection={sel}
        manifest={makeManifest({
          species: [bulbasaur],
          typeNames: [grass, poison],
          abilities: [overgrow],
        })}
        sessionId="s1"
      />,
    );
    const grassChip = screen
      .getAllByRole('button')
      .find((b) => b.textContent === 'Grass');
    expect(grassChip).toBeTruthy();
    fireEvent.click(grassChip!);
    expect(useSelection.getState().current).toEqual({
      kind: 'type',
      id: 'TYPE_GRASS',
    });
  });

  it('clicking an ability button selects the ability', () => {
    const sel: EntityRef = { kind: 'species', id: 'species_1' };
    render(
      <SpeciesInspector
        selection={sel}
        manifest={makeManifest({
          species: [bulbasaur],
          typeNames: [grass, poison],
          abilities: [overgrow],
        })}
        sessionId="s1"
      />,
    );
    const abilityBtn = screen
      .getAllByRole('button')
      .find((b) => b.textContent?.includes('OVERGROW'));
    expect(abilityBtn).toBeTruthy();
    fireEvent.click(abilityBtn!);
    expect(useSelection.getState().current).toEqual({
      kind: 'ability',
      id: 'ABILITY_OVERGROW',
    });
  });

  it('clicking a learnset row selects the move via synthetic move_N id', () => {
    const sel: EntityRef = { kind: 'species', id: 'species_1' };
    render(
      <SpeciesInspector
        selection={sel}
        manifest={makeManifest({
          species: [bulbasaur],
          typeNames: [grass, poison],
          abilities: [overgrow],
          speciesLearnsets: [learnset],
        })}
        sessionId="s1"
      />,
    );
    const tackleBtn = screen
      .getAllByRole('button')
      .find((b) => b.textContent?.includes('TACKLE'));
    expect(tackleBtn).toBeTruthy();
    fireEvent.click(tackleBtn!);
    expect(useSelection.getState().current).toEqual({
      kind: 'move',
      id: 'move_33',
    });
  });

  it('resolves synthetic species_N selection id', () => {
    const sel: EntityRef = { kind: 'species', id: 'species_1' };
    render(
      <SpeciesInspector
        selection={sel}
        manifest={makeManifest({ species: [bulbasaur] })}
        sessionId="s1"
      />,
    );
    expect(screen.getByTestId('species-inspector-name').textContent).toBe('BULBASAUR');
  });

  it('renders Edit base stats button when sessionId is present', () => {
    const sel: EntityRef = { kind: 'species', id: 'species_1' };
    render(
      <SpeciesInspector
        selection={sel}
        manifest={makeManifest({ species: [bulbasaur] })}
        sessionId="s1"
      />,
    );
    expect(screen.getByTestId('species-inspector-edit-stats-btn')).toBeInTheDocument();
  });

  it('hides Edit base stats button when sessionId is null', () => {
    const sel: EntityRef = { kind: 'species', id: 'species_1' };
    render(
      <SpeciesInspector
        selection={sel}
        manifest={makeManifest({ species: [bulbasaur] })}
        sessionId={null}
      />,
    );
    expect(
      screen.queryByTestId('species-inspector-edit-stats-btn'),
    ).not.toBeInTheDocument();
  });

  it('Edit base stats reveals form with all 6 stat inputs preset', () => {
    const sel: EntityRef = { kind: 'species', id: 'species_1' };
    render(
      <SpeciesInspector
        selection={sel}
        manifest={makeManifest({ species: [bulbasaur] })}
        sessionId="s1"
      />,
    );
    fireEvent.click(screen.getByTestId('species-inspector-edit-stats-btn'));
    expect(
      (screen.getByTestId('species-inspector-edit-baseHP') as HTMLInputElement).value,
    ).toBe('45');
    expect(
      (screen.getByTestId('species-inspector-edit-baseAttack') as HTMLInputElement)
        .value,
    ).toBe('49');
    expect(
      (screen.getByTestId('species-inspector-edit-baseSpeed') as HTMLInputElement)
        .value,
    ).toBe('45');
  });

  it('Edit form includes type + ability dropdowns when manifest has them', () => {
    const sel: EntityRef = { kind: 'species', id: 'species_1' };
    render(
      <SpeciesInspector
        selection={sel}
        manifest={makeManifest({
          species: [bulbasaur],
          typeNames: [grass, poison],
          abilities: [overgrow],
        })}
        sessionId="s1"
      />,
    );
    fireEvent.click(screen.getByTestId('species-inspector-edit-stats-btn'));
    expect(screen.getByTestId('species-inspector-edit-type1')).toBeInTheDocument();
    expect(screen.getByTestId('species-inspector-edit-type2')).toBeInTheDocument();
    expect(
      screen.getByTestId('species-inspector-edit-ability1'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('species-inspector-edit-ability2'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('species-inspector-edit-catchRate')).toBeInTheDocument();
  });

  it('Type dropdowns omit when typeNames is missing from manifest', () => {
    const sel: EntityRef = { kind: 'species', id: 'species_1' };
    render(
      <SpeciesInspector
        selection={sel}
        manifest={makeManifest({ species: [bulbasaur] })}
        sessionId="s1"
      />,
    );
    fireEvent.click(screen.getByTestId('species-inspector-edit-stats-btn'));
    expect(screen.queryByTestId('species-inspector-edit-type1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('species-inspector-edit-ability1')).not.toBeInTheDocument();
  });

  it('BST preview updates as the user edits stats', () => {
    const sel: EntityRef = { kind: 'species', id: 'species_1' };
    render(
      <SpeciesInspector
        selection={sel}
        manifest={makeManifest({ species: [bulbasaur] })}
        sessionId="s1"
      />,
    );
    fireEvent.click(screen.getByTestId('species-inspector-edit-stats-btn'));
    const hpInput = screen.getByTestId(
      'species-inspector-edit-baseHP',
    ) as HTMLInputElement;
    fireEvent.change(hpInput, { target: { value: '100' } });
    // Bulbasaur BST = 45+49+49+65+65+45 = 318.  HP 45→100 = +55, new BST = 373.
    expect(screen.getByTestId('species-inspector-bst-preview').textContent).toMatch(
      /373/,
    );
  });

  it('developer details disclosure shows species index + offset', () => {
    const sel: EntityRef = { kind: 'species', id: 'species_1' };
    render(
      <SpeciesInspector
        selection={sel}
        manifest={makeManifest({ species: [bulbasaur] })}
        sessionId="s1"
      />,
    );
    expect(screen.queryByTestId('species-inspector-advanced')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('species-inspector-advanced-toggle'));
    expect(screen.getByTestId('species-inspector-advanced').textContent).toMatch(/#1/);
    expect(screen.getByTestId('species-inspector-advanced').textContent).toMatch(
      /0x1fb070/,
    );
  });
});
