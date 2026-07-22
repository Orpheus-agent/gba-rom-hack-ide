import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { FlagInspector } from './FlagInspector';
import { useUiPreferencesStore, type EntityRef } from '../state';
import type { Flag, ProjectManifest, Variable } from '@rom-editor/shared';

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

const sampleFlag: Flag = {
  id: 'FLAG_BADGE01_GET',
  name: 'FLAG_BADGE01_GET',
  engineValue: '0x820',
  scope: 'global',
  defaultValue: false,
  description: null,
};

const sampleVariable: Variable = {
  id: 'VAR_STARTER_CHOICE',
  name: 'VAR_STARTER_CHOICE',
  engineValue: '0x4001',
  scope: 'global',
  defaultValue: 0,
  description: 'Which starter the player picked',
};

const flagSelection: EntityRef = { kind: 'flag', id: 'FLAG_BADGE01_GET' };
const variableSelection: EntityRef = { kind: 'variable', id: 'VAR_STARTER_CHOICE' };

describe('FlagInspector (Phase P.3 sample)', () => {
  beforeEach(() => {
    useUiPreferencesStore.setState({ showInternalIds: false });
  });

  afterEach(() => cleanup());

  it('renders no-manifest state when project is not loaded', () => {
    render(<FlagInspector selection={flagSelection} manifest={null} sessionId={null} />);
    expect(screen.getByTestId('flag-inspector')).toBeInTheDocument();
    expect(screen.getByText(/Open a project to inspect/i)).toBeInTheDocument();
  });

  it('renders unknown-flag state when manifest has no matching entry', () => {
    const manifest = makeManifest({ flags: [], variables: [] });
    render(
      <FlagInspector selection={flagSelection} manifest={manifest} sessionId="s1" />,
    );
    expect(screen.getByTestId('flag-inspector')).toBeInTheDocument();
    expect(
      screen.getByText(/no flag or variable with that id is present/i),
    ).toBeInTheDocument();
  });

  it('renders flag metadata when the manifest has a match', () => {
    const manifest = makeManifest({ flags: [sampleFlag] });
    render(<FlagInspector selection={flagSelection} manifest={manifest} sessionId="s1" />);
    expect(screen.getByTestId('flag-inspector-name').textContent).toMatch(
      /FLAG_BADGE01_GET/,
    );
    // Phase Q.6.1 overhaul: flag defaults now render as human prose
    // ("Cleared (off at new game)") instead of the JS boolean, and
    // scope reads as plain English ("Persistent - saved to the save file").
    expect(screen.getByTestId('flag-inspector-default').textContent).toBe(
      'Cleared (off at new game)',
    );
    expect(screen.getByTestId('flag-inspector-scope').textContent).toMatch(
      /Persistent.*save file/,
    );
    // No description on this fixture → row not rendered.
    expect(screen.queryByTestId('flag-inspector-description')).not.toBeInTheDocument();
  });

  it('also handles variables (same component, kind switch in selection.kind)', () => {
    const manifest = makeManifest({ variables: [sampleVariable] });
    render(
      <FlagInspector
        selection={variableSelection}
        manifest={manifest}
        sessionId="s1"
      />,
    );
    expect(screen.getByTestId('flag-inspector-name').textContent).toMatch(
      /VAR_STARTER_CHOICE/,
    );
    expect(screen.getByTestId('flag-inspector-default').textContent).toBe('0');
    expect(screen.getByTestId('flag-inspector-description').textContent).toMatch(
      /Which starter/,
    );
  });

  it('renders the role-summary chips when the flag has cross-references', () => {
    // Build a manifest where FLAG_BADGE01_GET is set by one script step
    // and gates one NPC's visibility - exactly the kind of multi-role
    // flag the role-summary lands on.
    const manifest = makeManifest({
      flags: [sampleFlag],
      scriptSteps: [
        {
          id: 'oak_intro__5',
          kind: 'set_flag',
          // flagReferences.ts matches against the `flag` key (and a few
          // related ones - see FLAG_PARAM_KEYS).
          params: { flag: 'FLAG_BADGE01_GET' },
        },
      ] as never,
      objectEvents: [
        {
          id: 'rocket_grunt',
          name: 'Rocket grunt',
          mapId: 'binary_map_3_0',
          coord: { x: 5, y: 7 },
          elevation: 0,
          kind: 'trainer',
          graphicsId: 'gfx_5',
          movementType: null,
          scriptId: null,
          flagId: 'FLAG_BADGE01_GET',
          trainerType: null,
          metadata: {},
        },
      ] as never,
    });
    render(<FlagInspector selection={flagSelection} manifest={manifest} sessionId="s1" />);
    const chips = screen.getByTestId('flag-inspector-role-chips');
    expect(chips.textContent).toMatch(/set by 1 script step/);
    expect(chips.textContent).toMatch(/gates 1 NPC/);
  });

  it('renders an explicit "nothing touches this" headline for a dead flag', () => {
    const manifest = makeManifest({ flags: [sampleFlag] });
    render(<FlagInspector selection={flagSelection} manifest={manifest} sessionId="s1" />);
    expect(screen.getByTestId('flag-inspector-role').textContent).toMatch(
      /Nothing in the indexed project touches this flag/,
    );
    expect(screen.queryByTestId('flag-inspector-role-chips')).not.toBeInTheDocument();
  });

  it('hides developer details by default; toggle reveals raw id + engine value', () => {
    const manifest = makeManifest({ flags: [sampleFlag] });
    render(<FlagInspector selection={flagSelection} manifest={manifest} sessionId="s1" />);
    expect(screen.queryByTestId('flag-inspector-advanced')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('flag-inspector-advanced-toggle'));
    expect(screen.getByTestId('flag-inspector-advanced')).toBeInTheDocument();
    expect(screen.getByTestId('flag-inspector-advanced').textContent).toMatch(
      /FLAG_BADGE01_GET/,
    );
    expect(screen.getByTestId('flag-inspector-advanced').textContent).toMatch(
      /0x820/,
    );
    fireEvent.click(screen.getByTestId('flag-inspector-advanced-toggle'));
    expect(screen.queryByTestId('flag-inspector-advanced')).not.toBeInTheDocument();
  });
});
