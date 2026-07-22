import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AgentPanel } from './AgentPanel';
import { useProjectStore } from '../state';
import { useAgentStore } from '../state/agent';

/** Capture the most recently constructed mock socket so tests can drive it. */
let lastSocket: MockWebSocket | null = null;

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = MockWebSocket.CONNECTING;
  url: string;
  sent: string[] = [];
  private readonly listeners = new Map<string, Array<(ev: any) => void>>();

  constructor(url: string) {
    this.url = url;
    lastSocket = this;
  }

  addEventListener(type: string, fn: (ev: any) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type)!.push(fn);
  }
  removeEventListener(type: string, fn: (ev: any) => void): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((l) => l !== fn));
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.emit('close', { code: 1000, reason: '' });
  }

  fireOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.emit('open', {});
  }
  fireMessage(server: unknown): void {
    this.emit('message', { data: JSON.stringify(server) });
  }
  private emit(type: string, ev: unknown): void {
    for (const l of this.listeners.get(type) ?? []) l(ev as never);
  }
}

function loadFakeProject(sessionId = 'proj-1'): void {
  useProjectStore.setState({
    load: {
      kind: 'loaded',
      data: {
        session: { id: sessionId, projectRoot: '/x', openedAtUtc: new Date().toISOString() },
        identity: {
          kind: 'decomp',
          confidence: 0.9,
          displayName: 'pokefirered',
          baseGame: 'firered',
          fork: null,
          featureFlags: [],
          warnings: [],
          evidence: [],
        },
      },
    },
  } as never);
}

function unloadProject(): void {
  useProjectStore.setState({ load: { kind: 'empty' } });
}

function resetAgentStore(): void {
  useAgentStore.getState().disconnect();
  useAgentStore.setState({
    stream: null,
    connection: { kind: 'idle' },
    projectId: null,
    messages: [],
    inFlight: false,
    eventCounter: 0,
  });
}

describe('AgentPanel', () => {
  let originalWs: typeof globalThis.WebSocket;

  beforeEach(() => {
    originalWs = globalThis.WebSocket;
    (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket =
      MockWebSocket as unknown as typeof WebSocket;
    (MockWebSocket as unknown as { OPEN: number }).OPEN = 1;
    lastSocket = null;
    resetAgentStore();
  });

  afterEach(() => {
    cleanup();
    resetAgentStore();
    unloadProject();
    (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = originalWs;
  });

  it('shows the "load a project" empty state when no project is loaded', () => {
    unloadProject();
    render(<AgentPanel />);
    expect(screen.getByTestId('agent-panel')).toBeInTheDocument();
    expect(screen.getByText(/Load a project to start a conversation/i)).toBeInTheDocument();
    expect(screen.getByTestId('agent-panel-input')).toBeDisabled();
  });

  it('connects to the WS when a project is loaded and reports ready state', () => {
    loadFakeProject('proj-42');
    render(<AgentPanel />);
    expect(lastSocket).not.toBeNull();
    expect(lastSocket!.url).toContain('projectId=proj-42');
    expect(screen.getByTestId('agent-panel-status')).toHaveTextContent(/connecting/i);
    act(() => {
      lastSocket!.fireOpen();
      lastSocket!.fireMessage({ kind: 'ready', sessionId: 'sess-abc12345', turnCount: 0 });
    });
    expect(screen.getByTestId('agent-panel-status')).toHaveTextContent(/connected/i);
    expect(screen.getByTestId('agent-panel-input')).not.toBeDisabled();
  });

  it('sends a turn_start frame on submit and renders the user prompt', () => {
    loadFakeProject();
    render(<AgentPanel />);
    act(() => {
      lastSocket!.fireOpen();
      lastSocket!.fireMessage({ kind: 'ready', sessionId: 'sess-1', turnCount: 0 });
    });
    const input = screen.getByTestId('agent-panel-input') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'how many maps?' } });
    fireEvent.click(screen.getByTestId('agent-panel-send'));
    const sent = lastSocket!.sent.map((s) => JSON.parse(s));
    // AI-4.1: turn_start frames now carry a devMode flag (defaults
    // to false; localStorage-persisted setDevMode promotes it).
    expect(sent).toContainEqual({ kind: 'turn_start', prompt: 'how many maps?', devMode: false });
    expect(screen.getByText('how many maps?')).toBeInTheDocument();
  });

  it('renders the final agent text from turn_done', async () => {
    loadFakeProject();
    render(<AgentPanel />);
    act(() => {
      lastSocket!.fireOpen();
      lastSocket!.fireMessage({ kind: 'ready', sessionId: 'sess-1', turnCount: 0 });
      lastSocket!.fireMessage({ kind: 'turn_started', sessionId: 'sess-1', turnIndex: 1 });
      lastSocket!.fireMessage({
        kind: 'turn_done',
        sessionId: 'sess-1',
        finalText: '246 maps in this project.',
        durationMs: 1500,
        turnCount: 1,
      });
    });
    await waitFor(() => expect(screen.getByText('246 maps in this project.')).toBeInTheDocument());
    expect(screen.getByText(/Done in 1500ms/)).toBeInTheDocument();
  });

  it('renders turn_error with the message', async () => {
    loadFakeProject();
    render(<AgentPanel />);
    act(() => {
      lastSocket!.fireOpen();
      lastSocket!.fireMessage({ kind: 'ready', sessionId: 'sess-1', turnCount: 0 });
      lastSocket!.fireMessage({
        kind: 'turn_error',
        code: 'claude_cli_not_installed',
        message: 'Could not locate claude.',
      });
    });
    await waitFor(() => expect(screen.getByText('Could not locate claude.')).toBeInTheDocument());
  });

  it('renders a patch_proposal card with Apply and Reject buttons', () => {
    loadFakeProject();
    render(<AgentPanel />);
    act(() => {
      lastSocket!.fireOpen();
      lastSocket!.fireMessage({ kind: 'ready', sessionId: 'sess-1', turnCount: 0 });
      lastSocket!.fireMessage({
        kind: 'patch_proposed',
        proposal: {
          id: 'patch_rt1',
          projectId: 'proj-1',
          description: 'rename Route 1 to Lane 17',
          edits: [
            { kind: 'replace_in_file', filePath: 'data/region.h', before: 'Route 1', after: 'Lane 17' },
          ],
          status: 'pending',
          createdAtUtc: '2026-05-22T00:00:00.000Z',
        },
      });
    });
    expect(screen.getByTestId('agent-panel-patch-title')).toHaveTextContent('rename Route 1 to Lane 17');
    expect(screen.getByTestId('agent-panel-patch-status')).toHaveTextContent('pending');
    expect(screen.getByTestId('agent-panel-patch-apply')).toBeEnabled();
    expect(screen.getByTestId('agent-panel-patch-reject')).toBeEnabled();
  });

  it('flips a patch card to applied when patch_applied arrives', () => {
    loadFakeProject();
    render(<AgentPanel />);
    act(() => {
      lastSocket!.fireOpen();
      lastSocket!.fireMessage({ kind: 'ready', sessionId: 'sess-1', turnCount: 0 });
      lastSocket!.fireMessage({
        kind: 'patch_proposed',
        proposal: {
          id: 'patch_app',
          projectId: 'proj-1',
          description: 'd',
          edits: [{ kind: 'replace_in_file', filePath: 'a.h', before: 'x', after: 'y' }],
          status: 'pending',
          createdAtUtc: '2026-05-22T00:00:00.000Z',
        },
      });
      lastSocket!.fireMessage({ kind: 'patch_applied', proposalId: 'patch_app' });
    });
    expect(screen.getByTestId('agent-panel-patch-status')).toHaveTextContent('applied');
    expect(screen.getByTestId('agent-panel-patch-apply')).toBeDisabled();
    expect(screen.getByTestId('agent-panel-patch-reject')).toBeDisabled();
    expect(screen.getByTestId('agent-panel-patch-patch_app')).toHaveAttribute('data-status', 'applied');
  });

  it('flips a patch card to rejected when patch_rejected arrives', () => {
    loadFakeProject();
    render(<AgentPanel />);
    act(() => {
      lastSocket!.fireOpen();
      lastSocket!.fireMessage({ kind: 'ready', sessionId: 'sess-1', turnCount: 0 });
      lastSocket!.fireMessage({
        kind: 'patch_proposed',
        proposal: {
          id: 'patch_rej',
          projectId: 'proj-1',
          description: 'd',
          edits: [{ kind: 'replace_in_file', filePath: 'a.h', before: 'x', after: 'y' }],
          status: 'pending',
          createdAtUtc: '2026-05-22T00:00:00.000Z',
        },
      });
      lastSocket!.fireMessage({ kind: 'patch_rejected', proposalId: 'patch_rej' });
    });
    expect(screen.getByTestId('agent-panel-patch-status')).toHaveTextContent('rejected');
  });

  it('focuses the input on the agent:focus-input custom event', () => {
    loadFakeProject();
    render(<AgentPanel />);
    act(() => {
      lastSocket!.fireOpen();
      lastSocket!.fireMessage({ kind: 'ready', sessionId: 'sess-1', turnCount: 0 });
    });
    const input = screen.getByTestId('agent-panel-input') as HTMLTextAreaElement;
    expect(document.activeElement).not.toBe(input);
    act(() => {
      window.dispatchEvent(new CustomEvent('agent:focus-input'));
    });
    expect(document.activeElement).toBe(input);
  });
});
