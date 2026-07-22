import { beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { DialogueNode, ProjectManifest } from '@rom-editor/shared';
import { DialogueReviewPanel } from './DialogueReviewPanel';
import { useSelection } from '../../state';

function makeManifest(dialogue: DialogueNode[]): ProjectManifest {
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
    dialogue,
    flags: [],
    variables: [],
    encounterTables: [],
    trainers: [],
    scriptSteps: [],
    assets: [],
  };
}

function d(id: string, speaker: string | null, text: string): DialogueNode {
  return {
    id,
    name: id,
    speakerName: speaker,
    portraitAssetId: null,
    text,
    choices: [],
  };
}

describe('DialogueReviewPanel', () => {
  beforeEach(() => {
    cleanup();
    useSelection.setState({ current: null, history: [] });
  });

  it('renders the empty-state message when no dialogue exists', () => {
    const m = makeManifest([]);
    render(<DialogueReviewPanel manifest={m} />);
    expect(screen.getByTestId('dialogue-review-empty')).toBeInTheDocument();
  });

  it('renders one row per dialogue line', () => {
    const m = makeManifest([
      d('text_1', 'Oak', 'Welcome to the world of Pokémon!'),
      d('text_2', 'Mom', 'Brendan! Everyone\'s talking about Prof. Birch!'),
      d('text_3', null, 'Press the A Button to talk.'),
    ]);
    render(<DialogueReviewPanel manifest={m} />);
    expect(screen.getByTestId('dialogue-review-row-text_1')).toBeInTheDocument();
    expect(screen.getByTestId('dialogue-review-row-text_2')).toBeInTheDocument();
    expect(screen.getByTestId('dialogue-review-row-text_3')).toBeInTheDocument();
  });

  it('shows the running count of visible lines', () => {
    const m = makeManifest([
      d('text_1', 'Oak', 'A'),
      d('text_2', 'Oak', 'B'),
      d('text_3', 'Mom', 'C'),
    ]);
    render(<DialogueReviewPanel manifest={m} />);
    expect(screen.getByTestId('dialogue-review-count').textContent).toBe('Showing 3 of 3 lines');
  });

  it('clicking a row selects the dialogue node', () => {
    const m = makeManifest([d('text_1', 'Oak', 'Hi')]);
    render(<DialogueReviewPanel manifest={m} />);
    fireEvent.click(screen.getByTestId('dialogue-review-row-text_1'));
    expect(useSelection.getState().current).toEqual({ kind: 'dialogue', id: 'text_1' });
  });

  it('filters by text content', () => {
    const m = makeManifest([
      d('text_1', 'Oak', 'Welcome'),
      d('text_2', 'Mom', 'Brock is in Pewter City'),
      d('text_3', 'Brock', 'I am Brock'),
    ]);
    render(<DialogueReviewPanel manifest={m} />);
    fireEvent.change(screen.getByTestId('dialogue-review-filter'), {
      target: { value: 'brock' },
    });
    expect(screen.getByTestId('dialogue-review-row-text_2')).toBeInTheDocument();
    expect(screen.getByTestId('dialogue-review-row-text_3')).toBeInTheDocument();
    expect(screen.queryByTestId('dialogue-review-row-text_1')).not.toBeInTheDocument();
  });

  it('filters by speaker name', () => {
    const m = makeManifest([
      d('text_1', 'Oak', 'Welcome'),
      d('text_2', 'Mom', 'Hi sweetie'),
      d('text_3', 'Oak', 'You chose this Pokémon'),
    ]);
    render(<DialogueReviewPanel manifest={m} />);
    fireEvent.change(screen.getByTestId('dialogue-review-speaker-filter'), {
      target: { value: 'Oak' },
    });
    expect(screen.getByTestId('dialogue-review-row-text_1')).toBeInTheDocument();
    expect(screen.getByTestId('dialogue-review-row-text_3')).toBeInTheDocument();
    expect(screen.queryByTestId('dialogue-review-row-text_2')).not.toBeInTheDocument();
  });

  it('filters by id substring', () => {
    const m = makeManifest([
      d('LittlerootTown_Mom_Text_Hi', 'Mom', 'Hi'),
      d('LittlerootTown_Brendan_Text', 'Brendan', 'Yo'),
    ]);
    render(<DialogueReviewPanel manifest={m} />);
    fireEvent.change(screen.getByTestId('dialogue-review-filter'), {
      target: { value: 'mom' },
    });
    expect(
      screen.getByTestId('dialogue-review-row-LittlerootTown_Mom_Text_Hi'),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId('dialogue-review-row-LittlerootTown_Brendan_Text'),
    ).not.toBeInTheDocument();
  });

  it('shows "no match" message when filter has no hits', () => {
    const m = makeManifest([d('text_1', 'Oak', 'Hi')]);
    render(<DialogueReviewPanel manifest={m} />);
    fireEvent.change(screen.getByTestId('dialogue-review-filter'), {
      target: { value: 'something that does not exist' },
    });
    expect(screen.getByTestId('dialogue-review-no-match')).toBeInTheDocument();
  });

  it('sorts by length when the Length header is clicked', () => {
    const m = makeManifest([
      d('text_short', 'Oak', 'Hi'),
      d('text_long', 'Oak', 'A much much longer dialogue line'),
      d('text_mid', 'Oak', 'Medium length'),
    ]);
    render(<DialogueReviewPanel manifest={m} />);
    fireEvent.click(screen.getByTestId('dialogue-review-sort-length'));
    const rows = screen.getAllByTestId(/^dialogue-review-row-/);
    // Ascending: shortest first
    expect(rows[0]!.getAttribute('data-testid')).toBe('dialogue-review-row-text_short');
    expect(rows[rows.length - 1]!.getAttribute('data-testid')).toBe('dialogue-review-row-text_long');
    // Click again → descending: longest first
    fireEvent.click(screen.getByTestId('dialogue-review-sort-length'));
    const rows2 = screen.getAllByTestId(/^dialogue-review-row-/);
    expect(rows2[0]!.getAttribute('data-testid')).toBe('dialogue-review-row-text_long');
  });

  it('shows the currently-selected row highlighted', () => {
    const m = makeManifest([
      d('text_1', 'Oak', 'A'),
      d('text_2', 'Mom', 'B'),
    ]);
    useSelection.getState().select({ kind: 'dialogue', id: 'text_2' });
    render(<DialogueReviewPanel manifest={m} />);
    expect(screen.getByTestId('dialogue-review-row-text_2').className).toMatch(
      /dialogue-review__row--selected/,
    );
    expect(screen.getByTestId('dialogue-review-row-text_1').className).not.toMatch(
      /dialogue-review__row--selected/,
    );
  });

  it('unnamed speakers get bucketed into the (unnamed) filter option', () => {
    const m = makeManifest([
      d('text_1', 'Oak', 'Hi'),
      d('text_2', null, 'Untagged'),
      d('text_3', '', 'Empty speaker'),
    ]);
    render(<DialogueReviewPanel manifest={m} />);
    const speakerOptions = screen.getByTestId('dialogue-review-speaker-filter');
    expect(speakerOptions.textContent).toMatch(/\(unnamed speaker\) \(2\)/);
  });
});
