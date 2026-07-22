import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { ProjectOpenResponse, ScanResponse } from '@rom-editor/shared';
import { emptyManifest } from '@rom-editor/shared';
import { StatusBar } from './StatusBar';
import { useProjectStore } from '../state';

function projectResponse(): ProjectOpenResponse {
  return {
    session: { id: 'sess-aaa', projectRoot: '/abs/path', openedAtUtc: '2026-05-16T00:00:00Z' },
    rootListing: { path: '', entries: [] },
    identity: {
      kind: 'decomp',
      confidence: 0.92,
      displayName: 'pokeemerald',
      baseGame: 'pokeemerald',
      fork: null,
      featureFlags: [],
      warnings: [],
      evidence: [],
    },
  };
}

function scanResponseWithCounts(): ScanResponse {
  const m = emptyManifest('/abs/path', '2026-05-16T00:00:00Z');
  return {
    sessionId: 'sess-aaa',
    manifestPath: '/abs/path/.editor/manifest.json',
    scannerName: 'TestScanner',
    scanDurationMs: 1,
    warnings: [],
    manifest: {
      ...m,
      flags: [
        { id: 'F1', name: 'F1', scope: 'global', defaultValue: false, description: null, engineValue: '0x900' },
        { id: 'F2', name: 'F2', scope: 'global', defaultValue: false, description: null, engineValue: '0x901' },
      ],
    },
  };
}

describe('StatusBar', () => {
  beforeEach(() => {
    useProjectStore.setState({ load: { kind: 'empty' }, scan: { kind: 'idle' } });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders 3 cells with backend connecting state and no-project text', () => {
    render(<StatusBar backendStatus={{ state: 'connecting' }} />);
    expect(screen.getByTestId('status-cell-backend')).toHaveTextContent('Backend: connecting…');
    expect(screen.getByTestId('status-cell-project')).toHaveTextContent('No project open');
    expect(screen.getByTestId('status-cell-last-op')).toHaveTextContent('No edits yet');
  });

  it('shows backend disconnected state with red dot', () => {
    render(<StatusBar backendStatus={{ state: 'disconnected', error: 'ECONNREFUSED' }} />);
    expect(screen.getByTestId('status-cell-backend')).toHaveTextContent('Backend: unreachable');
  });

  it('shows project + scan summary with entity count when scan has loaded', () => {
    useProjectStore.setState({
      load: { kind: 'loaded', data: projectResponse() },
      scan: { kind: 'loaded', data: scanResponseWithCounts() },
    });
    // Stub fetch so the lazy op-log fetch returns an empty list (no edits).
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              sessionId: 'sess-aaa',
              logPath: '/abs/path/.editor/op-log.jsonl',
              totalLines: 0,
              entries: [],
              parseErrors: [],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      ),
    );
    render(<StatusBar backendStatus={{ state: 'connected', service: 'rom-editor-backend', version: '0.0.0' }} />);
    expect(screen.getByTestId('status-cell-backend')).toHaveTextContent('rom-editor-backend');
    expect(screen.getByTestId('status-cell-project')).toHaveTextContent('pokeemerald - 2 entities');
  });

  it('shows scan-failed text when the scan errored', () => {
    useProjectStore.setState({
      load: { kind: 'loaded', data: projectResponse() },
      scan: { kind: 'error', code: 'scan_failed', message: 'parse error' },
    });
    render(<StatusBar backendStatus={{ state: 'connected', service: 's', version: '1' }} />);
    expect(screen.getByTestId('status-cell-project')).toHaveTextContent('scan failed');
  });

  it('shows the most-recent op-log entry in the last-edit cell when one exists', async () => {
    useProjectStore.setState({
      load: { kind: 'loaded', data: projectResponse() },
      scan: { kind: 'loaded', data: scanResponseWithCounts() },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              sessionId: 'sess-aaa',
              logPath: '/abs/path/.editor/op-log.jsonl',
              totalLines: 1,
              entries: [
                {
                  entryId: 'e1',
                  atUtc: new Date(Date.now() - 30_000).toISOString(),
                  sessionId: 'sess-aaa',
                  op: 'stage_template',
                  payload: { templateId: 'town_skeleton' },
                },
              ],
              parseErrors: [],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      ),
    );
    render(<StatusBar backendStatus={{ state: 'connected', service: 's', version: '1' }} />);
    // Wait a tick for the lazy fetch to resolve + re-render.
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByTestId('status-cell-last-op').textContent).toMatch(/Stage template/);
  });
});
