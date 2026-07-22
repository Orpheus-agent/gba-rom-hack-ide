import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { TypeInspector } from './TypeInspector';
import { useUiPreferencesStore, type EntityRef } from '../state';
import type {
  ProjectManifest,
  TypeMatchupEntry,
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

const fire: TypeNameEntry = { id: 'TYPE_FIRE', typeIndex: 10, name: 'Fire', sourceTableOffset: 0 };
const grass: TypeNameEntry = { id: 'TYPE_GRASS', typeIndex: 12, name: 'Grass', sourceTableOffset: 0 };
const water: TypeNameEntry = { id: 'TYPE_WATER', typeIndex: 11, name: 'Water', sourceTableOffset: 0 };

const matchups: TypeMatchupEntry[] = [
  // Fire is super-effective against Grass (2x = 20)
  {
    id: 'tm_fire_grass',
    attackerType: 10,
    defenderType: 12,
    effectiveness: 20,
    sourceTableOffset: 0,
  },
  // Fire is resisted by Water (0.5x = 5)
  {
    id: 'tm_fire_water',
    attackerType: 10,
    defenderType: 11,
    effectiveness: 5,
    sourceTableOffset: 0,
  },
];

describe('TypeInspector (Phase S.12)', () => {
  beforeEach(() => {
    useUiPreferencesStore.setState({ showInternalIds: false });
  });
  afterEach(() => cleanup());

  it('renders empty when no manifest', () => {
    const sel: EntityRef = { kind: 'type', id: 'TYPE_FIRE' };
    render(<TypeInspector selection={sel} manifest={null} sessionId={null} />);
    expect(screen.getByText(/Open a project to inspect/i)).toBeInTheDocument();
  });

  it('renders unknown when manifest lacks typeNames', () => {
    const sel: EntityRef = { kind: 'type', id: 'TYPE_FIRE' };
    render(<TypeInspector selection={sel} manifest={makeManifest()} sessionId="s1" />);
    expect(screen.getByText(/no type with that id is present/i)).toBeInTheDocument();
  });

  it('renders type name and effectiveness as attacker', () => {
    const sel: EntityRef = { kind: 'type', id: 'TYPE_FIRE' };
    render(
      <TypeInspector
        selection={sel}
        manifest={makeManifest({
          typeNames: [fire, grass, water],
          typeMatchups: matchups,
        })}
        sessionId="s1"
      />,
    );
    expect(screen.getByTestId('type-inspector-name').textContent).toBe('Fire');
    expect(screen.getByTestId('type-inspector-as-attacker').textContent).toMatch(
      /Super-effective vs/,
    );
    expect(screen.getByTestId('type-inspector-as-attacker').textContent).toMatch(/Grass/);
    expect(screen.getByTestId('type-inspector-as-attacker').textContent).toMatch(
      /Resisted by/,
    );
    expect(screen.getByTestId('type-inspector-as-attacker').textContent).toMatch(/Water/);
  });

  it('renders type as defender (Grass weak to Fire)', () => {
    const sel: EntityRef = { kind: 'type', id: 'TYPE_GRASS' };
    render(
      <TypeInspector
        selection={sel}
        manifest={makeManifest({
          typeNames: [fire, grass, water],
          typeMatchups: matchups,
        })}
        sessionId="s1"
      />,
    );
    expect(screen.getByTestId('type-inspector-as-defender').textContent).toMatch(/Weak to/);
    expect(screen.getByTestId('type-inspector-as-defender').textContent).toMatch(/Fire/);
  });

  it('resolves synthetic type_N selection id', () => {
    const sel: EntityRef = { kind: 'type', id: 'type_12' };
    render(
      <TypeInspector
        selection={sel}
        manifest={makeManifest({ typeNames: [fire, grass] })}
        sessionId="s1"
      />,
    );
    expect(screen.getByTestId('type-inspector-name').textContent).toBe('Grass');
  });
});
