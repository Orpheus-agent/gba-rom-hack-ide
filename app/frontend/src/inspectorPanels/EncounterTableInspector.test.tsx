import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { EncounterTable, ProjectManifest } from '@rom-editor/shared';
import { EncounterTableInspector } from './EncounterTableInspector';
import { useSelection, useProjectStore, type EntityRef } from '../state';

// WP-C1 - covers the rate-edit / ↑↓ reorder / bulk-replace UI surfaces
// added so users can change encounter tables beyond per-slot species.

const { editEncounterTableMock } = vi.hoisted(() => ({
  editEncounterTableMock: vi.fn(async () => ({
    encounterTableId: 'x',
    op: 'setRate' as const,
    editsApplied: 1,
    description: 'ok',
  })),
}));

vi.mock('../api', async () => {
  return {
    editBinaryRomEncounterSlot: vi.fn(async () => ({ ok: true })),
    editBinaryRomEncounterTable: editEncounterTableMock,
    ProjectApiError: class ProjectApiError extends Error {
      readonly code: string;
      constructor(code: string, message: string) {
        super(message);
        this.code = code;
      }
    },
  };
});

function makeTable(over: Partial<EncounterTable> = {}): EncounterTable {
  return {
    id: 'binary_encounter_2_0_land',
    name: 'Route 1 grass',
    mapId: 'map_2_0',
    type: 'grass',
    encounterRate: 25,
    slots: [
      { speciesId: 'species_16', minLevel: 5, maxLevel: 7, weight: 1, fileOffset: 0x300 },
      { speciesId: 'species_19', minLevel: 6, maxLevel: 8, weight: 1, fileOffset: 0x304 },
      { speciesId: 'species_129', minLevel: 10, maxLevel: 12, weight: 1, fileOffset: 0x308 },
    ],
    infoFileOffset: 0x200,
    slotsFileOffset: 0x300,
    ...over,
  };
}

function makeManifest(tables: EncounterTable[]): ProjectManifest {
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
    encounterTables: tables,
    trainers: [],
    scriptSteps: [],
    assets: [],
  } as ProjectManifest;
}

function selRef(id: string): EntityRef {
  return { kind: 'encounterTable', id };
}

describe('EncounterTableInspector - WP-C1 surfaces', () => {
  beforeEach(() => {
    cleanup();
    editEncounterTableMock.mockClear();
    useSelection.setState({ current: null, history: [] });
    useProjectStore.setState({
      scanCurrentProject: vi.fn(async () => {}),
    } as never);
  });

  afterEach(() => cleanup());

  it('renders rate display with edit button when sessionId + infoFileOffset present', () => {
    const t = makeTable();
    render(
      <EncounterTableInspector
        selection={selRef(t.id)}
        manifest={makeManifest([t])}
        sessionId="s1"
      />,
    );
    expect(screen.getByTestId('encounter-table-inspector-rate').textContent).toMatch(
      /25%/,
    );
    expect(
      screen.getByTestId('encounter-table-inspector-rate-edit'),
    ).toBeInTheDocument();
  });

  it('hides rate edit button when no sessionId (read-only mode)', () => {
    const t = makeTable();
    render(
      <EncounterTableInspector
        selection={selRef(t.id)}
        manifest={makeManifest([t])}
        sessionId={null}
      />,
    );
    expect(
      screen.queryByTestId('encounter-table-inspector-rate-edit'),
    ).not.toBeInTheDocument();
  });

  it('hides rate edit button when infoFileOffset missing (older manifest)', () => {
    const t = makeTable();
    const { infoFileOffset: _omit, ...stripped } = t;
    void _omit;
    render(
      <EncounterTableInspector
        selection={selRef(t.id)}
        manifest={makeManifest([stripped as EncounterTable])}
        sessionId="s1"
      />,
    );
    expect(
      screen.queryByTestId('encounter-table-inspector-rate-edit'),
    ).not.toBeInTheDocument();
  });

  it('opens the inline rate editor + calls API with setRate op', async () => {
    const t = makeTable();
    render(
      <EncounterTableInspector
        selection={selRef(t.id)}
        manifest={makeManifest([t])}
        sessionId="s1"
      />,
    );
    fireEvent.click(screen.getByTestId('encounter-table-inspector-rate-edit'));
    const input = screen.getByTestId(
      'encounter-table-inspector-rate-input',
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '75' } });
    fireEvent.click(screen.getByTestId('encounter-table-inspector-rate-save'));
    // Save is async; wait one microtask tick.
    await Promise.resolve();
    await Promise.resolve();
    expect(editEncounterTableMock).toHaveBeenCalledWith('s1', {
      encounterTableId: t.id,
      op: 'setRate',
      encounterRate: 75,
    });
  });

  it('renders ↑/↓ reorder buttons next to each slot when slotsFileOffset present', () => {
    const t = makeTable();
    render(
      <EncounterTableInspector
        selection={selRef(t.id)}
        manifest={makeManifest([t])}
        sessionId="s1"
      />,
    );
    // 3 slots → 3 ↑ + 3 ↓ buttons
    expect(screen.getByTestId('encounter-slot-up-btn-0')).toBeInTheDocument();
    expect(screen.getByTestId('encounter-slot-down-btn-0')).toBeInTheDocument();
    expect(screen.getByTestId('encounter-slot-up-btn-2')).toBeInTheDocument();
    expect(screen.getByTestId('encounter-slot-down-btn-2')).toBeInTheDocument();
    // First slot's ↑ is disabled, last slot's ↓ is disabled.
    expect((screen.getByTestId('encounter-slot-up-btn-0') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('encounter-slot-down-btn-2') as HTMLButtonElement).disabled).toBe(true);
  });

  it('clicking ↓ on slot 0 calls API with a swap permutation', async () => {
    const t = makeTable();
    render(
      <EncounterTableInspector
        selection={selRef(t.id)}
        manifest={makeManifest([t])}
        sessionId="s1"
      />,
    );
    fireEvent.click(screen.getByTestId('encounter-slot-down-btn-0'));
    await Promise.resolve();
    await Promise.resolve();
    expect(editEncounterTableMock).toHaveBeenCalledWith('s1', {
      encounterTableId: t.id,
      op: 'reorder',
      slotOrder: [1, 0, 2],
    });
  });

  it('clicking ↑ on slot 2 calls API with a swap permutation', async () => {
    const t = makeTable();
    render(
      <EncounterTableInspector
        selection={selRef(t.id)}
        manifest={makeManifest([t])}
        sessionId="s1"
      />,
    );
    fireEvent.click(screen.getByTestId('encounter-slot-up-btn-2'));
    await Promise.resolve();
    await Promise.resolve();
    expect(editEncounterTableMock).toHaveBeenCalledWith('s1', {
      encounterTableId: t.id,
      op: 'reorder',
      slotOrder: [0, 2, 1],
    });
  });

  it('renders bulk-replace section with open button', () => {
    const t = makeTable();
    render(
      <EncounterTableInspector
        selection={selRef(t.id)}
        manifest={makeManifest([t])}
        sessionId="s1"
      />,
    );
    expect(screen.getByTestId('encounter-table-inspector-bulk')).toBeInTheDocument();
    expect(
      screen.getByTestId('encounter-table-inspector-bulk-open'),
    ).toBeInTheDocument();
  });

  it('bulk-replace flow opens form + calls API with bulkReplaceSpecies op', async () => {
    const t = makeTable();
    render(
      <EncounterTableInspector
        selection={selRef(t.id)}
        manifest={makeManifest([t])}
        sessionId="s1"
      />,
    );
    fireEvent.click(screen.getByTestId('encounter-table-inspector-bulk-open'));
    // Bulk form open - species defaults to slot 0's species (16). Save with default.
    fireEvent.click(screen.getByTestId('encounter-table-inspector-bulk-save'));
    await Promise.resolve();
    await Promise.resolve();
    expect(editEncounterTableMock).toHaveBeenCalledWith('s1', {
      encounterTableId: t.id,
      op: 'bulkReplaceSpecies',
      speciesId: 16,
    });
  });

  it('hides bulk + reorder UI when slotsFileOffset missing', () => {
    const t = makeTable();
    const { slotsFileOffset: _omit, ...stripped } = t;
    void _omit;
    render(
      <EncounterTableInspector
        selection={selRef(t.id)}
        manifest={makeManifest([stripped as EncounterTable])}
        sessionId="s1"
      />,
    );
    expect(screen.queryByTestId('encounter-table-inspector-bulk')).not.toBeInTheDocument();
    expect(screen.queryByTestId('encounter-slot-up-btn-0')).not.toBeInTheDocument();
    expect(screen.queryByTestId('encounter-slot-down-btn-0')).not.toBeInTheDocument();
  });
});
