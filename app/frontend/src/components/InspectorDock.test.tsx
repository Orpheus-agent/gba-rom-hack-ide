import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { InspectorDock } from './InspectorDock';
import { useProjectStore, useSelection } from '../state';
import { useAnnotationsStore } from '../lib/annotations';

describe('InspectorDock (Phase P.2)', () => {
  beforeEach(() => {
    useSelection.setState({ current: null, history: [] });
    useProjectStore.setState({ load: { kind: 'empty' }, scan: { kind: 'idle' } });
  });

  afterEach(() => cleanup());

  it('renders the empty-state hint when nothing is selected', () => {
    render(<InspectorDock />);
    expect(screen.getByTestId('inspector-dock')).toBeInTheDocument();
    expect(screen.getByText(/Nothing selected/i)).toBeInTheDocument();
    expect(
      screen.getByText(/Click an NPC, warp, Pokémon, trainer, tile, flag, item/i),
    ).toBeInTheDocument();
  });

  it('renders recent history surface in the empty state when history is non-empty', () => {
    // Selecting flag → then move populates history with [flag] (only
    // PRIOR selections enter history when a new one displaces them).
    // Clearing leaves current=null but keeps history.
    useSelection.getState().select({ kind: 'flag', id: 'FLAG_X' });
    useSelection.getState().select({ kind: 'move', id: 'MOVE_TACKLE' });
    useSelection.getState().clear();
    render(<InspectorDock />);
    expect(screen.getByTestId('inspector-dock-recent')).toBeInTheDocument();
    // history[0] is the flag (the first selection that got displaced).
    expect(screen.getByTestId('inspector-dock-recent-0').textContent).toMatch(/flag/);
  });

  it('renders a back button when a selection has history', () => {
    useSelection.getState().select({ kind: 'flag', id: 'FLAG_X' });
    useSelection.getState().select({ kind: 'move', id: 'MOVE_TACKLE' });
    render(<InspectorDock />);
    expect(screen.getByTestId('inspector-dock-back-btn')).toBeInTheDocument();
  });

  it('back button re-selects the previous entity', () => {
    useSelection.getState().select({ kind: 'flag', id: 'FLAG_X' });
    useSelection.getState().select({ kind: 'move', id: 'MOVE_TACKLE' });
    render(<InspectorDock />);
    fireEvent.click(screen.getByTestId('inspector-dock-back-btn'));
    expect(useSelection.getState().current).toEqual({
      kind: 'flag',
      id: 'FLAG_X',
    });
  });

  it('renders the selected entity kind + id when a selection is set', () => {
    useSelection
      .getState()
      .select({ kind: 'species', id: 'SPECIES_BULBASAUR' });
    render(<InspectorDock />);
    expect(screen.getByTestId('inspector-dock')).toHaveAttribute(
      'data-selection-kind',
      'species',
    );
    expect(screen.getByTestId('inspector-dock')).toHaveAttribute(
      'data-selection-id',
      'SPECIES_BULBASAUR',
    );
    expect(screen.getByTestId('inspector-dock-kind').textContent).toMatch(/Pokémon/);
    expect(screen.getByTestId('inspector-dock-title').textContent).toMatch(/SPECIES_BULBASAUR/);
  });

  it('surfaces the mapContext when set', () => {
    useSelection
      .getState()
      .select({
        kind: 'objectEvent',
        id: 'obj_brock',
        mapContext: 'MAP_PEWTER_CITY_GYM',
      });
    render(<InspectorDock />);
    expect(screen.getByTestId('inspector-dock-mapContext').textContent).toMatch(
      /in MAP_PEWTER_CITY_GYM/,
    );
  });

  it('omits the mapContext line for global entities (no mapContext set)', () => {
    useSelection.getState().select({ kind: 'flag', id: 'FLAG_BADGE01_GET' });
    render(<InspectorDock />);
    expect(screen.queryByTestId('inspector-dock-mapContext')).not.toBeInTheDocument();
  });

  it('renders a friendly placeholder body for entity kinds without a registered editor', () => {
    useSelection.getState().select({ kind: 'trainer', id: 'TRAINER_BROCK' });
    // Force render path: ensure no inspector is registered for trainer
    // in this test by selecting a kind that doesn't have one - actually
    // trainer IS registered, so test for that. Pick a kind we have no
    // panel for.
    cleanup();
    useSelection.getState().select({ kind: 'sign', id: 'sign_42' });
    render(<InspectorDock />);
    // Phase Q.6.1 overhaul: replaced the engine-jargon placeholder
    // ("Phase S registers...") with copy that points the user at the
    // always-available rename + note affordances so a "no detail editor"
    // state is still useful.
    expect(screen.getByTestId('inspector-dock-placeholder').textContent).toMatch(/Sign/);
    expect(screen.getByTestId('inspector-dock-placeholder').textContent).toMatch(
      /rename it|attach a description/i,
    );
  });

  describe('Phase Q.6.1 description / notes affordance', () => {
    beforeEach(() => {
      useAnnotationsStore.setState({ projectKey: '_default', map: {} });
      if (typeof window !== 'undefined') {
        try {
          window.localStorage.removeItem('rom-editor.annotations._default');
        } catch {
          // ignore
        }
      }
    });

    it('shows an "Add a note" button when no description exists', () => {
      useSelection.getState().select({ kind: 'sign', id: 'sign_42' });
      render(<InspectorDock />);
      expect(screen.getByTestId('inspector-dock-description-empty')).toBeInTheDocument();
    });

    it('expands into a textarea when clicked, saves to annotations, and shows it back', () => {
      useSelection.getState().select({ kind: 'flag', id: 'FLAG_X' });
      render(<InspectorDock />);
      fireEvent.click(screen.getByTestId('inspector-dock-description-empty'));
      const textarea = screen.getByTestId(
        'inspector-dock-description-input',
      ) as HTMLTextAreaElement;
      fireEvent.change(textarea, {
        target: { value: 'Fires when the player defeats Brock.' },
      });
      fireEvent.click(screen.getByTestId('inspector-dock-description-save'));
      // The annotations store now carries the prose.
      expect(
        useAnnotationsStore.getState().getFullAnnotation('flag', 'FLAG_X')?.description,
      ).toBe('Fires when the player defeats Brock.');
      // The display state replaces the empty button with the saved text.
      expect(screen.getByTestId('inspector-dock-description-text').textContent).toBe(
        'Fires when the player defeats Brock.',
      );
    });

    it('Ctrl+Enter saves the note inside the textarea', () => {
      useSelection.getState().select({ kind: 'flag', id: 'FLAG_X' });
      render(<InspectorDock />);
      fireEvent.click(screen.getByTestId('inspector-dock-description-empty'));
      const textarea = screen.getByTestId(
        'inspector-dock-description-input',
      ) as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: 'A quick note' } });
      fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });
      expect(
        useAnnotationsStore.getState().getFullAnnotation('flag', 'FLAG_X')?.description,
      ).toBe('A quick note');
    });

    it('Esc cancels without saving', () => {
      useSelection.getState().select({ kind: 'flag', id: 'FLAG_X' });
      render(<InspectorDock />);
      fireEvent.click(screen.getByTestId('inspector-dock-description-empty'));
      const textarea = screen.getByTestId(
        'inspector-dock-description-input',
      ) as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: 'Should not save' } });
      fireEvent.keyDown(textarea, { key: 'Escape' });
      expect(
        useAnnotationsStore.getState().getFullAnnotation('flag', 'FLAG_X'),
      ).toBeNull();
    });

    it('the description survives the user renaming the entity', () => {
      useAnnotationsStore
        .getState()
        .setAnnotationDescription('flag', 'FLAG_X', 'Brock-defeat flag.');
      useSelection.getState().select({ kind: 'flag', id: 'FLAG_X' });
      render(<InspectorDock />);
      // Rename through the header
      fireEvent.click(screen.getByTestId('inspector-dock-rename-btn'));
      const input = screen.getByTestId(
        'inspector-dock-rename-input',
      ) as HTMLInputElement;
      fireEvent.change(input, { target: { value: 'Brock down' } });
      fireEvent.click(screen.getByTestId('inspector-dock-rename-save'));
      // Both fields are now set on the annotation.
      expect(
        useAnnotationsStore.getState().getFullAnnotation('flag', 'FLAG_X'),
      ).toEqual({ name: 'Brock down', description: 'Brock-defeat flag.' });
    });
  });

  describe('Phase Q.6 rename UI', () => {
    beforeEach(() => {
      // Reset annotations between tests
      useAnnotationsStore.setState({
        projectKey: '_default',
        map: {},
      });
      if (typeof window !== 'undefined') {
        try {
          window.localStorage.removeItem('rom-editor.annotations._default');
        } catch {
          // ignore
        }
      }
    });

    it('rename button is present in the header', () => {
      useSelection.getState().select({ kind: 'flag', id: 'FLAG_X' });
      render(<InspectorDock />);
      expect(screen.getByTestId('inspector-dock-rename-btn')).toBeInTheDocument();
    });

    it('clicking rename reveals the input', () => {
      useSelection.getState().select({ kind: 'flag', id: 'FLAG_X' });
      render(<InspectorDock />);
      fireEvent.click(screen.getByTestId('inspector-dock-rename-btn'));
      expect(screen.getByTestId('inspector-dock-rename-input')).toBeInTheDocument();
    });

    it('saving a custom name persists it via useAnnotationsStore', () => {
      useSelection.getState().select({ kind: 'flag', id: 'FLAG_X' });
      render(<InspectorDock />);
      fireEvent.click(screen.getByTestId('inspector-dock-rename-btn'));
      const input = screen.getByTestId(
        'inspector-dock-rename-input',
      ) as HTMLInputElement;
      fireEvent.change(input, { target: { value: 'My Custom Flag' } });
      fireEvent.click(screen.getByTestId('inspector-dock-rename-save'));
      expect(useAnnotationsStore.getState().getAnnotation('flag', 'FLAG_X')).toBe(
        'My Custom Flag',
      );
      // After save, the title now shows the custom name + "custom" tag.
      expect(screen.getByTestId('inspector-dock-title').textContent).toMatch(
        /My Custom Flag/,
      );
      expect(screen.getByTestId('inspector-dock-custom-tag')).toBeInTheDocument();
    });

    it('Enter saves; Esc cancels without saving', () => {
      useSelection.getState().select({ kind: 'flag', id: 'FLAG_X' });
      render(<InspectorDock />);
      fireEvent.click(screen.getByTestId('inspector-dock-rename-btn'));
      const input = screen.getByTestId(
        'inspector-dock-rename-input',
      ) as HTMLInputElement;
      fireEvent.change(input, { target: { value: 'Enter saved' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(useAnnotationsStore.getState().getAnnotation('flag', 'FLAG_X')).toBe(
        'Enter saved',
      );

      // Esc cancels
      fireEvent.click(screen.getByTestId('inspector-dock-rename-btn'));
      const input2 = screen.getByTestId(
        'inspector-dock-rename-input',
      ) as HTMLInputElement;
      fireEvent.change(input2, { target: { value: 'Should not save' } });
      fireEvent.keyDown(input2, { key: 'Escape' });
      expect(useAnnotationsStore.getState().getAnnotation('flag', 'FLAG_X')).toBe(
        'Enter saved',
      );
    });

    it('reset button removes a previously-set custom name', () => {
      useAnnotationsStore.getState().setAnnotation('flag', 'FLAG_X', 'Custom');
      useSelection.getState().select({ kind: 'flag', id: 'FLAG_X' });
      render(<InspectorDock />);
      fireEvent.click(screen.getByTestId('inspector-dock-rename-btn'));
      fireEvent.click(screen.getByTestId('inspector-dock-rename-reset'));
      expect(
        useAnnotationsStore.getState().getAnnotation('flag', 'FLAG_X'),
      ).toBeNull();
    });
  });
});
