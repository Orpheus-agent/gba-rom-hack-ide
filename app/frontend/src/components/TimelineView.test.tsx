import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ProjectOpenResponse } from '@rom-editor/shared';
import { TimelineView } from './TimelineView';
import { useProjectStore } from '../state';
import type { OpLogResponse } from '../api';

const sessionResponse: ProjectOpenResponse = {
  session: { id: 'sess-1', projectRoot: '/abs/path', openedAtUtc: '2026-05-16T00:00:00Z' },
  rootListing: { path: '', entries: [] },
  identity: {
    kind: 'decomp',
    confidence: 0.9,
    displayName: 'pokeemerald',
    baseGame: 'pokeemerald',
    fork: null,
    featureFlags: [],
    warnings: [],
    evidence: [],
  },
};

function loadedSession(): void {
  useProjectStore.setState({ load: { kind: 'loaded', data: sessionResponse } });
}

function logResponse(entries: OpLogResponse['entries'] = []): OpLogResponse {
  return {
    sessionId: 'sess-1',
    logPath: '/abs/path/.editor/op-log.jsonl',
    totalLines: entries.length,
    entries,
    parseErrors: [],
  };
}

describe('TimelineView', () => {
  beforeEach(() => {
    useProjectStore.setState({ load: { kind: 'empty' } });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('shows the idle state when no session is loaded', () => {
    render(<TimelineView />);
    expect(screen.getByTestId('timeline-status-idle')).toBeInTheDocument();
  });

  it('shows the empty state when the backend returns zero entries', async () => {
    loadedSession();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify(logResponse([])), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
    render(<TimelineView />);
    await waitFor(() => expect(screen.getByTestId('timeline-status-empty')).toBeInTheDocument());
  });

  it('renders entries grouped by date with op-kind chips', async () => {
    loadedSession();
    const r = logResponse([
      { entryId: 'a', atUtc: '2026-05-16T14:01:00Z', sessionId: 'sess-1', op: 'move_event', payload: {} },
      { entryId: 'b', atUtc: '2026-05-16T13:00:00Z', sessionId: 'sess-1', op: 'edit_dialogue', payload: {} },
      { entryId: 'c', atUtc: '2026-05-15T20:00:00Z', sessionId: 'sess-1', op: 'stage_template', payload: {} },
    ]);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify(r), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
    render(<TimelineView />);
    await waitFor(() => expect(screen.getByTestId('timeline-entry-a')).toBeInTheDocument());
    expect(screen.getByTestId('timeline-day-2026-05-16')).toBeInTheDocument();
    expect(screen.getByTestId('timeline-day-2026-05-15')).toBeInTheDocument();
    expect(screen.getByTestId('timeline-entry-a')).toHaveAttribute('data-op', 'move_event');
    expect(screen.getByTestId('timeline-entry-b')).toHaveAttribute('data-op', 'edit_dialogue');
    expect(screen.getByTestId('timeline-count')).toHaveTextContent('Showing 3 of 3 entries');
  });

  it('clicking show payload toggles a JSON dump of the payload', async () => {
    loadedSession();
    const r = logResponse([
      {
        entryId: 'a',
        atUtc: '2026-05-16T14:01:00Z',
        sessionId: 'sess-1',
        op: 'patch_mechanic_config',
        payload: { mechanicId: 'starter_selection', patch: { starters: ['X'] } },
      },
    ]);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify(r), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
    render(<TimelineView />);
    await waitFor(() => expect(screen.getByTestId('timeline-entry-a')).toBeInTheDocument());
    expect(screen.queryByTestId('timeline-entry-payload-a')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('timeline-entry-toggle-a'));
    const payload = screen.getByTestId('timeline-entry-payload-a');
    expect(payload).toBeInTheDocument();
    expect(payload).toHaveTextContent('starter_selection');
  });

  it('surfaces parse errors via the unparseable count badge', async () => {
    loadedSession();
    const r: OpLogResponse = {
      sessionId: 'sess-1',
      logPath: '/abs/path/.editor/op-log.jsonl',
      totalLines: 2,
      entries: [
        { entryId: 'a', atUtc: '2026-05-16T10:00:00Z', sessionId: 'sess-1', op: 'move_event', payload: {} },
      ],
      parseErrors: [
        { lineNumber: 2, raw: '{broken', message: 'Unexpected token' },
      ],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify(r), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
    render(<TimelineView />);
    await waitFor(() => expect(screen.getByTestId('timeline-parse-warn')).toBeInTheDocument());
    expect(screen.getByTestId('timeline-parse-warn')).toHaveTextContent('(1 unparseable)');
  });
});
