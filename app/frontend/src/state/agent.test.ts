import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { projectEvent, useAgentStore } from './agent';
import type { AgentTurnEvent } from '@rom-editor/shared';

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
  emit(type: string, ev: unknown): void {
    for (const l of this.listeners.get(type) ?? []) l(ev as never);
  }
}

const WS_CTOR = MockWebSocket as unknown as typeof WebSocket;

function reset(): void {
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

describe('useAgentStore', () => {
  beforeEach(() => {
    lastSocket = null;
    reset();
  });
  afterEach(() => reset());

  it('connect() spawns a stream and transitions to connecting', () => {
    useAgentStore.getState().connect('proj-1', { WebSocketCtor: WS_CTOR });
    expect(lastSocket).not.toBeNull();
    expect(useAgentStore.getState().projectId).toBe('proj-1');
    expect(useAgentStore.getState().connection.kind).toBe('connecting');
  });

  it('promotes to open and records sessionId from ready', () => {
    useAgentStore.getState().connect('proj-1', { WebSocketCtor: WS_CTOR });
    lastSocket!.fireOpen();
    lastSocket!.fireMessage({ kind: 'ready', sessionId: 'sess-abc', turnCount: 3 });
    const c = useAgentStore.getState().connection;
    expect(c.kind).toBe('open');
    if (c.kind === 'open') {
      expect(c.sessionId).toBe('sess-abc');
      expect(c.turnCount).toBe(3);
    }
  });

  it('sendPrompt is a no-op when not connected', () => {
    useAgentStore.getState().sendPrompt('hi');
    expect(useAgentStore.getState().messages).toHaveLength(0);
  });

  it('sendPrompt pushes a user message and sends turn_start when open', () => {
    useAgentStore.getState().connect('p', { WebSocketCtor: WS_CTOR });
    lastSocket!.fireOpen();
    lastSocket!.fireMessage({ kind: 'ready', sessionId: 's', turnCount: 0 });
    useAgentStore.getState().sendPrompt('  hello  ');
    // The payload also carries the devMode flag (so the backend can augment
    // the system prompt for this turn); this assertion is about the trim.
    expect(lastSocket!.sent.map((s) => JSON.parse(s))).toContainEqual(
      expect.objectContaining({ kind: 'turn_start', prompt: 'hello' }),
    );
    expect(useAgentStore.getState().messages.map((m) => m.text)).toContain('hello');
  });

  it('turn lifecycle updates inFlight and appends final text', () => {
    useAgentStore.getState().connect('p', { WebSocketCtor: WS_CTOR });
    lastSocket!.fireOpen();
    lastSocket!.fireMessage({ kind: 'ready', sessionId: 's', turnCount: 0 });
    lastSocket!.fireMessage({ kind: 'turn_started', sessionId: 's', turnIndex: 1 });
    expect(useAgentStore.getState().inFlight).toBe(true);
    lastSocket!.fireMessage({
      kind: 'turn_done',
      sessionId: 's',
      finalText: 'all done',
      durationMs: 42,
      turnCount: 1,
    });
    expect(useAgentStore.getState().inFlight).toBe(false);
    const last = useAgentStore.getState().messages.at(-1);
    expect(last?.text).toContain('Done in 42ms');
    expect(useAgentStore.getState().messages.some((m) => m.text === 'all done')).toBe(true);
  });

  it('connect() to a different projectId resets messages', () => {
    useAgentStore.getState().connect('p1', { WebSocketCtor: WS_CTOR });
    lastSocket!.fireOpen();
    lastSocket!.fireMessage({ kind: 'ready', sessionId: 's', turnCount: 0 });
    useAgentStore.getState().sendPrompt('hi');
    expect(useAgentStore.getState().messages.length).toBeGreaterThan(0);
    useAgentStore.getState().connect('p2', { WebSocketCtor: WS_CTOR });
    expect(useAgentStore.getState().messages).toHaveLength(0);
    expect(useAgentStore.getState().projectId).toBe('p2');
  });

  it('abortTurn sends turn_abort frame', () => {
    useAgentStore.getState().connect('p', { WebSocketCtor: WS_CTOR });
    lastSocket!.fireOpen();
    lastSocket!.fireMessage({ kind: 'ready', sessionId: 's', turnCount: 0 });
    useAgentStore.getState().abortTurn();
    expect(lastSocket!.sent.map((s) => JSON.parse(s))).toContainEqual({ kind: 'turn_abort' });
  });

  it('disconnect closes the stream', () => {
    useAgentStore.getState().connect('p', { WebSocketCtor: WS_CTOR });
    lastSocket!.fireOpen();
    useAgentStore.getState().disconnect();
    expect(lastSocket!.readyState).toBe(MockWebSocket.CLOSED);
    expect(useAgentStore.getState().stream).toBeNull();
    expect(useAgentStore.getState().projectId).toBeNull();
  });

  it('patch_proposed adds a proposal + a patch_proposal message', () => {
    useAgentStore.getState().connect('p', { WebSocketCtor: WS_CTOR });
    lastSocket!.fireOpen();
    lastSocket!.fireMessage({ kind: 'ready', sessionId: 's', turnCount: 0 });
    const proposal = {
      id: 'patch_abc',
      projectId: 'p',
      description: 'rename Route 1 to Lane 17',
      edits: [{ kind: 'replace_in_file' as const, filePath: 'a.h', before: 'Route 1', after: 'Lane 17' }],
      status: 'pending' as const,
      createdAtUtc: '2026-05-22T00:00:00.000Z',
    };
    lastSocket!.fireMessage({ kind: 'patch_proposed', proposal });
    expect(useAgentStore.getState().proposals.get('patch_abc')?.description).toBe('rename Route 1 to Lane 17');
    const lastMsg = useAgentStore.getState().messages.at(-1);
    expect(lastMsg?.kind).toBe('patch_proposal');
    expect(lastMsg?.proposalId).toBe('patch_abc');
  });

  it('patch_applied flips the proposal status to applied', () => {
    useAgentStore.getState().connect('p', { WebSocketCtor: WS_CTOR });
    lastSocket!.fireOpen();
    lastSocket!.fireMessage({ kind: 'ready', sessionId: 's', turnCount: 0 });
    lastSocket!.fireMessage({
      kind: 'patch_proposed',
      proposal: {
        id: 'p1',
        projectId: 'p',
        description: 'd',
        edits: [{ kind: 'replace_in_file' as const, filePath: 'a.h', before: 'x', after: 'y' }],
        status: 'pending' as const,
        createdAtUtc: '2026-05-22T00:00:00.000Z',
      },
    });
    lastSocket!.fireMessage({ kind: 'patch_applied', proposalId: 'p1' });
    const p = useAgentStore.getState().proposals.get('p1');
    expect(p?.status).toBe('applied');
    expect(p?.appliedAtUtc).toBeDefined();
  });

  it('patch_rejected flips the proposal status to rejected', () => {
    useAgentStore.getState().connect('p', { WebSocketCtor: WS_CTOR });
    lastSocket!.fireOpen();
    lastSocket!.fireMessage({ kind: 'ready', sessionId: 's', turnCount: 0 });
    lastSocket!.fireMessage({
      kind: 'patch_proposed',
      proposal: {
        id: 'p1',
        projectId: 'p',
        description: 'd',
        edits: [{ kind: 'replace_in_file' as const, filePath: 'a.h', before: 'x', after: 'y' }],
        status: 'pending' as const,
        createdAtUtc: '2026-05-22T00:00:00.000Z',
      },
    });
    lastSocket!.fireMessage({ kind: 'patch_rejected', proposalId: 'p1' });
    const p = useAgentStore.getState().proposals.get('p1');
    expect(p?.status).toBe('rejected');
    expect(p?.rejectedAtUtc).toBeDefined();
  });

  // Phase 2A-3 - applyProposal triggers scanCurrentProject so downstream
  // propose tools see the fresh manifest. The session-1 transcript hit
  // the stale-manifest bug: propose_add_script_for_trainer ran right
  // after Apply, read the pre-apply manifest (1648 entries instead of
  // 1649), and couldn't see the just-added ObjectEvent.
  it('applyProposal fires a manifest re-scan on success', async () => {
    // Spy on the project store's scanCurrentProject by replacing it
    // via setState. The applyProposal flow calls
    // useProjectStore.getState().scanCurrentProject() in fire-and-forget.
    const { useProjectStore } = await import('../state');
    const scanSpy = vi.fn().mockResolvedValue(undefined);
    useProjectStore.setState({ scanCurrentProject: scanSpy });

    // Mock applyAgentPatch via the api module.
    const api = await import('../api');
    const applySpy = vi.spyOn(api, 'applyAgentPatch').mockResolvedValue({
      id: 'p1',
      projectId: 'p',
      description: 'test',
      edits: [{ kind: 'replace_in_file', filePath: 'a.h', before: 'x', after: 'y' }],
      status: 'applied',
      createdAtUtc: '2026-05-22T00:00:00.000Z',
      appliedAtUtc: '2026-05-22T00:00:01.000Z',
    });

    // Seed a pending proposal so applyProposal has something to mutate.
    const store = useAgentStore.getState();
    useAgentStore.setState({
      proposals: new Map([
        [
          'p1',
          {
            id: 'p1',
            projectId: 'p',
            description: 'test',
            edits: [
              { kind: 'replace_in_file' as const, filePath: 'a.h', before: 'x', after: 'y' },
            ],
            status: 'pending' as const,
            createdAtUtc: '2026-05-22T00:00:00.000Z',
          },
        ],
      ]),
    });

    await store.applyProposal('p1');

    expect(applySpy).toHaveBeenCalledWith('p1');
    expect(scanSpy).toHaveBeenCalledTimes(1);
  });
});

describe('projectEvent', () => {
  const make = (event: AgentTurnEvent) => projectEvent(event, 0);

  it('extracts assistant text content', () => {
    const m = make({ type: 'assistant', data: { message: { content: [{ type: 'text', text: 'hi' }] } } });
    expect(m?.kind).toBe('agent_text');
    expect(m?.text).toBe('hi');
  });

  it('renders a single tool_use as a tool_call message', () => {
    const m = make({
      type: 'assistant',
      data: { message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'read_map', input: { mapId: 'pallet_town' } }] } },
    });
    expect(m?.kind).toBe('tool_call');
    expect(m?.text).toContain('read_map');
  });

  it('coalesces multiple tool_use blocks into a summary line', () => {
    const m = make({
      type: 'assistant',
      data: {
        message: {
          content: [
            { type: 'tool_use', id: 't1', name: 'read_map', input: {} },
            { type: 'tool_use', id: 't2', name: 'list_entities', input: {} },
          ],
        },
      },
    });
    expect(m?.kind).toBe('tool_call');
    expect(m?.text).toContain('2 tools');
  });

  it('extracts tool_result text from user message', () => {
    const m = make({
      type: 'user',
      data: {
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'result text' }] },
          ],
        },
      },
    });
    expect(m?.kind).toBe('tool_result');
    expect(m?.text).toBe('result text');
  });

  it('returns null for terminal result events', () => {
    expect(make({ type: 'result', data: { result: 'final' } })).toBeNull();
  });

  it('preserves raw_text lines as system messages', () => {
    const m = make({ type: 'raw_text', data: { line: 'deprecation warning' } });
    expect(m?.kind).toBe('system');
    expect(m?.text).toBe('deprecation warning');
  });
});
