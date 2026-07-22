import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ProjectManifest, ScriptStep } from '@rom-editor/shared';
import { emptyManifest } from '@rom-editor/shared';
import { MechanicsView } from './MechanicsView';

function step(id: string, kind: ScriptStep['kind'] = 'raw'): ScriptStep {
  return { id, kind, params: { macro: 'noop', args: [] } };
}

function makeManifest(): ProjectManifest {
  const base = emptyManifest('/tmp/x', '2026-05-16T00:00:00Z');
  return {
    ...base,
    flags: [
      { id: 'FLAG_DIFFICULTY_HARD', name: 'FLAG_DIFFICULTY_HARD', scope: 'global', defaultValue: false, description: null, engineValue: '0x801' },
      { id: 'FLAG_NUZLOCKE', name: 'FLAG_NUZLOCKE', scope: 'global', defaultValue: false, description: null, engineValue: '0x802' },
      { id: 'FLAG_RECEIVED_TREECKO', name: 'FLAG_RECEIVED_TREECKO', scope: 'global', defaultValue: false, description: null, engineValue: '0x900' },
      { id: 'FLAG_RECEIVED_TORCHIC', name: 'FLAG_RECEIVED_TORCHIC', scope: 'global', defaultValue: false, description: null, engineValue: '0x901' },
    ],
    variables: [
      { id: 'VAR_RANDOMIZER_SEED', name: 'VAR_RANDOMIZER_SEED', scope: 'global', defaultValue: 0, description: null, engineValue: '0x4001' },
    ],
    scriptSteps: [
      step('Birch_StarterChoice_Treecko#0', 'dialogue'),
      step('LittlerootTown_BirchsLab_EventScript_Pick#0'),
    ],
  };
}

describe('MechanicsView', () => {
  afterEach(() => cleanup());

  it('renders four mechanic items always (vanilla detectors included)', () => {
    render(<MechanicsView manifest={emptyManifest('/tmp/x', '2026-05-16T00:00:00Z')} />);
    expect(screen.getByTestId('mechanics-item-starter_selection')).toBeInTheDocument();
    expect(screen.getByTestId('mechanics-item-difficulty_system')).toBeInTheDocument();
    expect(screen.getByTestId('mechanics-item-evolution_flags')).toBeInTheDocument();
    expect(screen.getByTestId('mechanics-item-encounter_variants')).toBeInTheDocument();
  });

  it('tags each item with its severity for stable testing', () => {
    render(<MechanicsView manifest={makeManifest()} />);
    expect(screen.getByTestId('mechanics-item-starter_selection')).toHaveAttribute(
      'data-severity',
      'detected',
    );
    // 2 difficulty flags + 1 variable = 3 → at the detected threshold.
    expect(screen.getByTestId('mechanics-item-difficulty_system')).toHaveAttribute(
      'data-severity',
      'detected',
    );
    // 2 evolution flags is < 5 threshold → partial.
    expect(screen.getByTestId('mechanics-item-evolution_flags')).toHaveAttribute(
      'data-severity',
      'partial',
    );
    expect(screen.getByTestId('mechanics-item-encounter_variants')).toHaveAttribute(
      'data-severity',
      'vanilla',
    );
  });

  it('auto-selects the first detected mechanic and shows its detail', () => {
    render(<MechanicsView manifest={makeManifest()} />);
    expect(screen.getByTestId('mechanic-detail')).toBeInTheDocument();
    // First detected mechanic is starter_selection by registration order.
    expect(screen.getByTestId('mechanic-detail-severity')).toHaveTextContent('detected');
    expect(screen.getByTestId('mechanic-detail-present')).toHaveTextContent('Present');
  });

  it('switches detail pane when a different mechanic item is clicked', () => {
    render(<MechanicsView manifest={makeManifest()} />);
    fireEvent.click(screen.getByTestId('mechanics-item-evolution_flags'));
    expect(screen.getByTestId('mechanic-detail-severity')).toHaveTextContent('partial');
    // Signature should include the evolution flags
    expect(screen.getByTestId('mechanic-detail')).toHaveTextContent('FLAG_RECEIVED_TREECKO');
  });

  it('falls back to the first item when nothing is detected (all vanilla)', () => {
    render(<MechanicsView manifest={emptyManifest('/tmp/x', '2026-05-16T00:00:00Z')} />);
    expect(screen.getByTestId('mechanic-detail-severity')).toHaveTextContent('vanilla');
    expect(screen.getByTestId('mechanic-detail-present')).toHaveTextContent(/Vanilla/);
  });

  it('mounts the MechanicConfigEditor in the detail pane with a field for the active mechanic', () => {
    render(<MechanicsView manifest={makeManifest()} />);
    expect(screen.getByTestId('mechanic-config-editor')).toBeInTheDocument();
    // starter_selection is auto-selected (first detected); its field is starters.
    expect(screen.getByTestId('mc-field-starter_selection-starters')).toBeInTheDocument();
  });

  it('disables add/remove controls until config loads (no session in test harness)', () => {
    render(<MechanicsView manifest={makeManifest()} />);
    const input = screen.getByTestId('mc-input-starter_selection-starters') as HTMLInputElement;
    const addBtn = screen.getByTestId('mc-add-starter_selection-starters') as HTMLButtonElement;
    // configLoaded starts false because there's no project session in the test
    // harness; controls are disabled until config persists.
    expect(input.disabled).toBe(true);
    expect(addBtn.disabled).toBe(true);
  });

  it('renders a different config field when switching to another mechanic', () => {
    render(<MechanicsView manifest={makeManifest()} />);
    fireEvent.click(screen.getByTestId('mechanics-item-encounter_variants'));
    expect(screen.getByTestId('mc-field-encounter_variants-enabledTypes')).toBeInTheDocument();
    expect(screen.queryByTestId('mc-field-starter_selection-starters')).not.toBeInTheDocument();
  });
});
