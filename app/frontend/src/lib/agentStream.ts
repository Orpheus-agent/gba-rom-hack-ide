import type {
  AgentWsClientMessage,
  AgentWsServerMessage,
} from '@rom-editor/shared';

/**
 * Browser-side WebSocket client for /api/agent/ws.
 *
 * Wraps the native WebSocket with:
 *   - typed send (only AgentWsClientMessage allowed in)
 *   - typed receive (parsed AgentWsServerMessage handed to onMessage)
 *   - lifecycle states the React component renders directly
 *
 * Phase AI-0.5a - keep this small. Reconnection / backoff / queueing
 * across reconnects can come in AI-0.5b once the Zustand store lands.
 */

export type AgentStreamState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'connecting' }
  | { readonly kind: 'open'; readonly sessionId: string; readonly turnCount: number }
  | { readonly kind: 'closed'; readonly code: number; readonly reason: string }
  | { readonly kind: 'error'; readonly message: string };

export interface AgentStreamHandlers {
  readonly onMessage: (msg: AgentWsServerMessage) => void;
  readonly onStateChange?: (state: AgentStreamState) => void;
}

export class AgentStream {
  private ws: WebSocket | null = null;
  private state: AgentStreamState = { kind: 'idle' };
  private readonly projectId: string;
  private readonly handlers: AgentStreamHandlers;
  /** Test seam: injected WebSocket constructor (defaults to global). */
  private readonly WebSocketCtor: typeof WebSocket;

  constructor(
    projectId: string,
    handlers: AgentStreamHandlers,
    deps: { WebSocketCtor?: typeof WebSocket } = {},
  ) {
    this.projectId = projectId;
    this.handlers = handlers;
    this.WebSocketCtor = deps.WebSocketCtor ?? WebSocket;
  }

  getState(): AgentStreamState {
    return this.state;
  }

  connect(): void {
    if (this.ws) return;
    this.setState({ kind: 'connecting' });
    const url = buildWsUrl(this.projectId);
    let ws: WebSocket;
    try {
      ws = new this.WebSocketCtor(url);
    } catch (err) {
      this.setState({
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    this.ws = ws;
    ws.addEventListener('open', this.handleOpen);
    ws.addEventListener('message', this.handleMessage);
    ws.addEventListener('close', this.handleClose);
    ws.addEventListener('error', this.handleError);
  }

  send(msg: AgentWsClientMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(msg));
  }

  close(): void {
    if (!this.ws) return;
    const ws = this.ws;
    this.ws = null;
    ws.removeEventListener('open', this.handleOpen);
    ws.removeEventListener('message', this.handleMessage);
    ws.removeEventListener('close', this.handleClose);
    ws.removeEventListener('error', this.handleError);
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      try {
        ws.close();
      } catch {
        // best-effort
      }
    }
  }

  private setState(next: AgentStreamState): void {
    this.state = next;
    this.handlers.onStateChange?.(next);
  }

  private readonly handleOpen = (): void => {
    // The 'open' state isn't final yet - we wait for the server's
    // `ready` message which includes sessionId + turnCount. Until
    // then we stay in 'connecting'. handleMessage promotes us.
  };

  private readonly handleMessage = (ev: MessageEvent): void => {
    let parsed: AgentWsServerMessage;
    try {
      parsed = JSON.parse(typeof ev.data === 'string' ? ev.data : '') as AgentWsServerMessage;
    } catch {
      return; // malformed server messages are dropped silently
    }
    if (parsed.kind === 'ready') {
      this.setState({
        kind: 'open',
        sessionId: parsed.sessionId,
        turnCount: parsed.turnCount,
      });
    }
    this.handlers.onMessage(parsed);
  };

  private readonly handleClose = (ev: CloseEvent): void => {
    this.ws = null;
    this.setState({ kind: 'closed', code: ev.code, reason: ev.reason });
  };

  private readonly handleError = (): void => {
    this.setState({
      kind: 'error',
      message: 'WebSocket connection error',
    });
  };
}

export function buildWsUrl(projectId: string): string {
  if (typeof window === 'undefined') {
    // Server-side rendering / test fallback.
    return `ws://127.0.0.1:5173/api/agent/ws?projectId=${encodeURIComponent(projectId)}`;
  }
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/api/agent/ws?projectId=${encodeURIComponent(projectId)}`;
}
