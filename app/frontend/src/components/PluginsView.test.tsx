import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, fireEvent } from '@testing-library/react';
import type { PluginsResponse, ProjectManifest, ProjectOpenResponse } from '@rom-editor/shared';
import { emptyManifest } from '@rom-editor/shared';
import { PluginsView } from './PluginsView';
import { useProjectStore } from '../state';

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

function makeManifest(): ProjectManifest {
  const m = emptyManifest('/abs/path', '2026-05-16T00:00:00Z');
  return {
    ...m,
    flags: [
      { id: 'TEMP_X', name: 'TEMP_X', scope: 'global', defaultValue: false, description: null, engineValue: '0x900' },
      { id: 'FLAG_OK', name: 'FLAG_OK', scope: 'global', defaultValue: false, description: null, engineValue: '0x901' },
    ],
  };
}

function pluginsResponse(): PluginsResponse {
  return {
    projectRoot: '/abs/path',
    pluginsDir: '/abs/path/.editor/plugins',
    plugins: [
      {
        id: 'rule_pack',
        label: 'Rule Pack',
        version: '0.1.0',
        description: 'project-specific design rules',
        validators: [
          {
            ruleId: 'no_temp_flags',
            severity: 'warn',
            message: 'flag id starts with TEMP_',
            predicate: { kind: 'entity_pattern', entityKind: 'flag', idPattern: '^TEMP_' },
          },
        ],
      },
      {
        id: 'event_pack',
        label: 'Event Pack',
        version: '1.0.0',
        description: '',
        eventTypes: [
          { macroName: 'custom_warp', kindAlias: 'raw', description: 'project shortcut' },
        ],
        adapters: [
          { adapterId: 'export_csv', direction: 'export', label: 'CSV Export', description: 'flags → csv' },
        ],
      },
    ],
    parseErrors: [
      { filePath: '/abs/path/.editor/plugins/broken.json', code: 'invalid_json', message: 'Unexpected token' },
    ],
  };
}

describe('PluginsView', () => {
  beforeEach(() => {
    useProjectStore.setState({ load: { kind: 'empty' } });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('shows the idle state when no project session is loaded', () => {
    render(<PluginsView manifest={makeManifest()} />);
    expect(screen.getByTestId('plugins-view-idle')).toBeInTheDocument();
    expect(screen.getByTestId('plugin-detail-empty')).toBeInTheDocument();
  });

  it('loads + lists plugins, auto-selects the first, and shows validators section', async () => {
    loadedSession();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify(pluginsResponse()), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );

    render(<PluginsView manifest={makeManifest()} />);
    // Both plugins rendered in the rail.
    await waitFor(() => expect(screen.getByTestId('plugins-item-rule_pack')).toBeInTheDocument());
    expect(screen.getByTestId('plugins-item-event_pack')).toBeInTheDocument();
    // rule_pack auto-selected (first in list); validators section visible.
    expect(screen.getByTestId('plugin-detail-validators')).toBeInTheDocument();
    expect(screen.getByTestId('plugin-validator-no_temp_flags')).toHaveAttribute('data-severity', 'warn');
  });

  it('renders parse errors in the rail with their code', async () => {
    loadedSession();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify(pluginsResponse()), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );

    render(<PluginsView manifest={makeManifest()} />);
    await waitFor(() => expect(screen.getByTestId('plugins-view-parse-errors')).toBeInTheDocument());
    expect(screen.getByTestId('plugin-parse-error-0')).toHaveTextContent('invalid_json');
  });

  it('switching to event_pack shows event-types + adapters sections instead of validators', async () => {
    loadedSession();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify(pluginsResponse()), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );

    render(<PluginsView manifest={makeManifest()} />);
    await waitFor(() => expect(screen.getByTestId('plugins-item-event_pack')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('plugins-item-event_pack'));
    expect(screen.getByTestId('plugin-detail-event-types')).toBeInTheDocument();
    expect(screen.getByTestId('plugin-detail-adapters')).toBeInTheDocument();
    expect(screen.queryByTestId('plugin-detail-validators')).not.toBeInTheDocument();
  });

  it('surfaces evaluated plugin findings inline under their declaring rule', async () => {
    loadedSession();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify(pluginsResponse()), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );

    render(<PluginsView manifest={makeManifest()} />);
    // TEMP_X matches the no_temp_flags pattern.
    await waitFor(() =>
      expect(
        screen.getByTestId('plugin-finding-no_temp_flags-TEMP_X'),
      ).toBeInTheDocument(),
    );
    // 1 finding for the no_temp_flags rule.
    expect(screen.getByTestId('plugin-detail-finding-count')).toHaveTextContent('1 finding');
  });

  it('shows the empty state when the backend returns zero plugins and zero errors', async () => {
    loadedSession();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              projectRoot: '/abs/path',
              pluginsDir: '/abs/path/.editor/plugins',
              plugins: [],
              parseErrors: [],
            } satisfies PluginsResponse),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      ),
    );
    render(<PluginsView manifest={makeManifest()} />);
    await waitFor(() => expect(screen.getByTestId('plugins-view-empty')).toBeInTheDocument());
  });
});
