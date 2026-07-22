import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentStream, buildWsUrl, type AgentStreamState } from './agentStream';
import type { AgentWsServerMessage } from '@rom-editor/shared';

/** Most-recently-constructed mock so each test can drive its socket. */
let lastSocket: MockWebSocket | null = null;

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState: number = MockWebSocket.CONNECTING;
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
  fireMessage(server: AgentWsServerMessage): void {
    this.emit('message', { data: JSON.stringify(server) });
  }
  fireError(): void {
    this.emit('error', {});
  }
  fireClose(code = 1006, reason = ''): void {
    this.readyState = MockWebSocket.CLOSED;
    this.emit('close', { code, reason });
  }
  emit(type: string, ev: any): void {
    for (const l of this.listeners.get(type) ?? []) l(ev);
  }
}

const WS_CTOR = MockWebSocket as unknown as typeof WebSocket;

function makeStream(handlers?: Partial<{
  onMessage: (m: AgentWsServerMessage) => void;
  onStateChange: (s: AgentStreamState) => void;
}>): AgentStream {
  return new AgentStream(
    'p1',
    {
      onMessage: handlers?.onMessage ?? vi.fn(),
      onStateChange: handlers?.onStateChange,
    },
    { WebSocketCtor: WS_CTOR },
  );
}

describe('buildWsUrl', () => {
  it('encodes the projectId', () => {
    expect(buildWsUrl('abc/def 1')).toContain('projectId=abc%2Fdef%201');
  });
});

describe('AgentStream', () => {
  beforeEach(() => {
    lastSocket = null;
  });

  it('transitions idle → connecting on connect()', () => {
    const states: AgentStreamState[] = [];
    const stream = makeStream({ onStateChange: (s) => states.push(s) });
    expect(stream.getState()).toEqual({ kind: 'idle' });
    stream.connect();
    expect(states[0]).toEqual({ kind: 'connecting' });
  });

  it('promotes to open when the server sends ready', () => {
    const onMessage = vi.fn();
    const stream = makeStream({ onMessage });
    stream.connect();
    expect(lastSocket).not.toBeNull();
    lastSocket!.fireOpen();
    lastSocket!.fireMessage({ kind: 'ready', sessionId: 'sess-1', turnCount: 0 });
    const state = stream.getState();
    expect(state.kind).toBe('open');
    if (state.kind === 'open') {
      expect(state.sessionId).toBe('sess-1');
      expect(state.turnCount).toBe(0);
    }
    expect(onMessage).toHaveBeenCalledWith({ kind: 'ready', sessionId: 'sess-1', turnCount: 0 });
  });

  it('send() serializes the client message and writes to the socket', () => {
    const stream = makeStream();
    stream.connect();
    lastSocket!.fireOpen();
    stream.send({ kind: 'turn_start', prompt: 'hi' });
    expect(lastSocket!.sent).toEqual([JSON.stringify({ kind: 'turn_start', prompt: 'hi' })]);
  });

  it('send() is a no-op when the socket is not open', () => {
    const stream = makeStream();
    stream.connect();
    stream.send({ kind: 'ping' });
    expect(lastSocket!.sent).toEqual([]);
  });

  it('handleClose transitions to closed', () => {
    const states: AgentStreamState[] = [];
    const stream = makeStream({ onStateChange: (s) => states.push(s) });
    stream.connect();
    lastSocket!.fireOpen();
    lastSocket!.fireClose(1006, 'gone');
    expect(states.at(-1)).toEqual({ kind: 'closed', code: 1006, reason: 'gone' });
  });

  it('close() detaches listeners and closes the socket', () => {
    const stream = makeStream();
    stream.connect();
    lastSocket!.fireOpen();
    stream.close();
    expect(lastSocket!.readyState).toBe(MockWebSocket.CLOSED);
  });

  it('drops malformed server messages silently', () => {
    const onMessage = vi.fn();
    const stream = makeStream({ onMessage });
    stream.connect();
    lastSocket!.fireOpen();
    lastSocket!.emit('message', { data: 'not json {{' });
    expect(onMessage).not.toHaveBeenCalled();
  });
});
