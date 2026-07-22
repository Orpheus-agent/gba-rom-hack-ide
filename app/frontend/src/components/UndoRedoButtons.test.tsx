import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ProjectOpenResponse } from '@rom-editor/shared';
import { UndoRedoButtons } from './UndoRedoButtons';
import { useProjectStore } from '../state';

const sessionResponse: ProjectOpenResponse = {
  session: { id: 'sess-aaa', projectRoot: '/abs/path', openedAtUtc: '2026-05-16T00:00:00Z' },
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

function stubUndoState(state: {
  canUndo: boolean;
  canRedo: boolean;
  nextUndoOp?: string | null;
  nextRedoOp?: string | null;
}): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            sessionId: 'sess-aaa',
            canUndo: state.canUndo,
            canRedo: state.canRedo,
            nextUndoTargetId: state.canUndo ? 'a' : null,
            nextUndoOp: state.nextUndoOp ?? (state.canUndo ? 'move_event' : null),
            nextRedoTargetId: state.canRedo ? 'b' : null,
            nextRedoOp: state.nextRedoOp ?? (state.canRedo ? 'edit_dialogue' : null),
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    ),
  );
}

describe('UndoRedoButtons', () => {
  beforeEach(() => {
    useProjectStore.setState({ load: { kind: 'empty' }, scan: { kind: 'idle' } });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders 2 buttons disabled when no session is loaded', () => {
    render(<UndoRedoButtons />);
    expect((screen.getByTestId('undo-btn') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('redo-btn') as HTMLButtonElement).disabled).toBe(true);
  });

  it('enables Undo when the backend reports canUndo=true', async () => {
    useProjectStore.setState({ load: { kind: 'loaded', data: sessionResponse } });
    stubUndoState({ canUndo: true, canRedo: false });
    render(<UndoRedoButtons />);
    await waitFor(() => {
      expect((screen.getByTestId('undo-btn') as HTMLButtonElement).disabled).toBe(false);
    });
    expect((screen.getByTestId('redo-btn') as HTMLButtonElement).disabled).toBe(true);
  });

  it('enables both buttons when canUndo + canRedo are true', async () => {
    useProjectStore.setState({ load: { kind: 'loaded', data: sessionResponse } });
    stubUndoState({ canUndo: true, canRedo: true });
    render(<UndoRedoButtons />);
    await waitFor(() => {
      expect((screen.getByTestId('undo-btn') as HTMLButtonElement).disabled).toBe(false);
      expect((screen.getByTestId('redo-btn') as HTMLButtonElement).disabled).toBe(false);
    });
  });

  it('the undo button title surfaces the next undoable op', async () => {
    useProjectStore.setState({ load: { kind: 'loaded', data: sessionResponse } });
    stubUndoState({ canUndo: true, canRedo: false, nextUndoOp: 'edit_dialogue' });
    render(<UndoRedoButtons />);
    await waitFor(() => {
      expect(screen.getByTestId('undo-btn')).toHaveAttribute('title', expect.stringContaining('Edit dialogue'));
    });
  });

  it('clicking Undo fires a POST to /undo and triggers a project rescan', async () => {
    useProjectStore.setState({ load: { kind: 'loaded', data: sessionResponse } });
    const callLog: Array<{ url: string; method: string }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        callLog.push({ url, method: init?.method ?? 'GET' });
        if (url.endsWith('/undo-state')) {
          return new Response(
            JSON.stringify({
              sessionId: 'sess-aaa',
              canUndo: true,
              canRedo: false,
              nextUndoTargetId: 'a',
              nextUndoOp: 'move_event',
              nextRedoTargetId: null,
              nextRedoOp: null,
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (url.endsWith('/undo')) {
          return new Response(
            JSON.stringify({ undoEntryId: 'u1', reversedOp: 'move_event', sessionId: 'sess-aaa' }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        // scan endpoint
        return new Response(
          JSON.stringify({
            sessionId: 'sess-aaa',
            manifestPath: '/abs/path/.editor/manifest.json',
            scannerName: 'T',
            scanDurationMs: 1,
            warnings: [],
            manifest: {
              schemaVersion: 1,
              generatedAtUtc: '2026-05-16T00:00:00Z',
              projectRoot: '/abs/path',
              identity: sessionResponse.identity,
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
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );

    render(<UndoRedoButtons />);
    await waitFor(() => {
      expect((screen.getByTestId('undo-btn') as HTMLButtonElement).disabled).toBe(false);
    });
    fireEvent.click(screen.getByTestId('undo-btn'));
    await waitFor(() => {
      expect(callLog.some((c) => c.url.endsWith('/undo') && c.method === 'POST')).toBe(true);
    });
    await waitFor(() => {
      expect(callLog.some((c) => c.url.endsWith('/scan') && c.method === 'POST')).toBe(true);
    });
  });
});
