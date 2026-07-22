import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ItemInspector } from './ItemInspector';
import { HealLocationInspector } from './HealLocationInspector';
import {
  useSelection,
  useUiPreferencesStore,
  type EntityRef,
} from '../state';
import type {
  HealLocationEntry,
  ItemEntry,
  ProjectManifest,
  RegionMapSectionEntry,
  Trainer,
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

const masterBall: ItemEntry = {
  id: 'ITEM_MASTER_BALL',
  itemIndex: 1,
  name: 'MASTER BALL',
  sourceTableOffset: 0,
  price: 0,
  importance: 1,
  pocket: 2,
};

const oranBerry: ItemEntry = {
  id: 'ITEM_ORAN_BERRY',
  itemIndex: 139,
  name: 'ORAN BERRY',
  sourceTableOffset: 0,
  price: 20,
  importance: 0,
  pocket: 4,
};

describe('ItemInspector (Phase S.9)', () => {
  beforeEach(() => {
    useUiPreferencesStore.setState({ showInternalIds: false });
    useSelection.setState({ current: null, history: [] });
  });
  afterEach(() => cleanup());

  it('renders item name + price + pocket + importance', () => {
    const sel: EntityRef = { kind: 'item', id: 'ITEM_MASTER_BALL' };
    render(
      <ItemInspector
        selection={sel}
        manifest={makeManifest({ items: [masterBall] })}
        sessionId="s1"
      />,
    );
    expect(screen.getByTestId('item-inspector-name').textContent).toBe('MASTER BALL');
    expect(screen.getByTestId('item-inspector-price').textContent).toMatch(/0/);
    expect(screen.getByTestId('item-inspector-pocket').textContent).toBe('Poké Balls');
    expect(screen.getByTestId('item-inspector-importance').textContent).toBe(
      'Key item',
    );
  });

  it('resolves synthetic item_N id', () => {
    const sel: EntityRef = { kind: 'item', id: 'item_139' };
    render(
      <ItemInspector
        selection={sel}
        manifest={makeManifest({ items: [masterBall, oranBerry] })}
        sessionId="s1"
      />,
    );
    expect(screen.getByTestId('item-inspector-name').textContent).toBe('ORAN BERRY');
    expect(screen.getByTestId('item-inspector-pocket').textContent).toBe('Berries');
  });

  it('shows trainer holders back-ref', () => {
    const trainerWithOran: Trainer = {
      id: 'TRAINER_X',
      name: 'YOUNGSTER JOEY',
      className: 'YOUNGSTER',
      party: [
        {
          speciesId: 'species_25',
          level: 10,
          moveIds: [],
          heldItemId: 'ITEM_ORAN_BERRY',
        },
      ],
      aiFlags: [],
      mapId: null,
    } as Trainer;
    const sel: EntityRef = { kind: 'item', id: 'ITEM_ORAN_BERRY' };
    render(
      <ItemInspector
        selection={sel}
        manifest={makeManifest({ items: [oranBerry], trainers: [trainerWithOran] })}
        sessionId="s1"
      />,
    );
    expect(screen.getByTestId('item-inspector-holders').textContent).toMatch(
      /TRAINER_X/,
    );
  });

  it('renders an Edit button when sessionId is present', () => {
    const sel: EntityRef = { kind: 'item', id: 'ITEM_MASTER_BALL' };
    render(
      <ItemInspector
        selection={sel}
        manifest={makeManifest({ items: [masterBall] })}
        sessionId="s1"
      />,
    );
    expect(screen.getByTestId('item-inspector-edit-btn')).toBeInTheDocument();
  });

  it('hides the Edit button when sessionId is null', () => {
    const sel: EntityRef = { kind: 'item', id: 'ITEM_MASTER_BALL' };
    render(
      <ItemInspector
        selection={sel}
        manifest={makeManifest({ items: [masterBall] })}
        sessionId={null}
      />,
    );
    expect(screen.queryByTestId('item-inspector-edit-btn')).not.toBeInTheDocument();
  });

  it('Edit reveals form with current price + importance', () => {
    const sel: EntityRef = { kind: 'item', id: 'ITEM_ORAN_BERRY' };
    render(
      <ItemInspector
        selection={sel}
        manifest={makeManifest({ items: [oranBerry] })}
        sessionId="s1"
      />,
    );
    fireEvent.click(screen.getByTestId('item-inspector-edit-btn'));
    const priceInput = screen.getByTestId(
      'item-inspector-edit-price',
    ) as HTMLInputElement;
    expect(priceInput.value).toBe('20');
    const impSel = screen.getByTestId(
      'item-inspector-edit-importance',
    ) as HTMLSelectElement;
    expect(impSel.value).toBe('0');
  });

  it('Cancel closes the form', () => {
    const sel: EntityRef = { kind: 'item', id: 'ITEM_ORAN_BERRY' };
    render(
      <ItemInspector
        selection={sel}
        manifest={makeManifest({ items: [oranBerry] })}
        sessionId="s1"
      />,
    );
    fireEvent.click(screen.getByTestId('item-inspector-edit-btn'));
    expect(screen.getByTestId('item-inspector-edit-form')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('item-inspector-cancel-btn'));
    expect(screen.queryByTestId('item-inspector-edit-form')).not.toBeInTheDocument();
  });

  it('clicking a holder selects the trainer', () => {
    const trainerWithOran: Trainer = {
      id: 'TRAINER_X',
      name: 'YOUNGSTER JOEY',
      className: 'YOUNGSTER',
      party: [
        {
          speciesId: 'species_25',
          level: 10,
          moveIds: [],
          heldItemId: 'ITEM_ORAN_BERRY',
        },
      ],
      aiFlags: [],
      mapId: null,
    } as Trainer;
    const sel: EntityRef = { kind: 'item', id: 'ITEM_ORAN_BERRY' };
    render(
      <ItemInspector
        selection={sel}
        manifest={makeManifest({ items: [oranBerry], trainers: [trainerWithOran] })}
        sessionId="s1"
      />,
    );
    const holderBtn = screen
      .getAllByRole('button')
      .find((b) => b.textContent?.includes('TRAINER_X'));
    fireEvent.click(holderBtn!);
    expect(useSelection.getState().current).toEqual({
      kind: 'trainer',
      id: 'TRAINER_X',
    });
  });
});

describe('HealLocationInspector (Phase S.13)', () => {
  beforeEach(() => {
    useSelection.setState({ current: null, history: [] });
    useUiPreferencesStore.setState({ showInternalIds: false });
  });
  afterEach(() => cleanup());

  it('renders slot + coords + dest map link', () => {
    const heal: HealLocationEntry = {
      id: 'spawn_0',
      slotIndex: 0,
      group: 0,
      mapNum: 12,
      x: 5,
      y: 8,
      destMapId: 'binary_map_0_12',
      sourceFileOffset: 0x1234,
    };
    const sel: EntityRef = { kind: 'healLocation', id: 'spawn_0' };
    render(
      <HealLocationInspector
        selection={sel}
        manifest={makeManifest({ healLocations: [heal] })}
        sessionId="s1"
      />,
    );
    expect(screen.getByTestId('heal-location-inspector-name').textContent).toBe(
      'Heal location #1',
    );
    expect(screen.getByTestId('heal-location-inspector-coords').textContent).toMatch(
      /x=5,\s*y=8/,
    );
    expect(screen.getByTestId('heal-location-inspector-dest').textContent).toMatch(
      /binary_map|map/,
    );
  });

  it('clicking the dest map button selects the map', () => {
    const heal: HealLocationEntry = {
      id: 'spawn_0',
      slotIndex: 0,
      group: 0,
      mapNum: 12,
      x: 5,
      y: 8,
      destMapId: 'binary_map_0_12',
      sourceFileOffset: 0x1234,
    };
    const sel: EntityRef = { kind: 'healLocation', id: 'spawn_0' };
    render(
      <HealLocationInspector
        selection={sel}
        manifest={makeManifest({ healLocations: [heal] })}
        sessionId="s1"
      />,
    );
    const mapBtn = screen
      .getAllByRole('button')
      .find((b) => b.textContent?.match(/map/i));
    fireEvent.click(mapBtn!);
    expect(useSelection.getState().current).toEqual({
      kind: 'map',
      id: 'binary_map_0_12',
    });
  });
});

