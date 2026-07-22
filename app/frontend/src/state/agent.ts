import { create } from 'zustand';
import type {
  AgentBinaryDiscoveryStep,
  AgentPatchProposal,
  AgentTurnEvent,
  AgentWsServerMessage,
} from '@rom-editor/shared';
import { AgentStream, type AgentStreamState } from '../lib/agentStream';
import {
  applyAgentPatch,
  rejectAgentPatch,
  fetchAgentHealth,
  AgentPatchActionError,
} from '../api';
import { useProjectStore } from '../state';

const DEV_MODE_LS_KEY = 'agentDevMode.v1';

function readDevModeFromStorage(): boolean {
  if (typeof window === 'undefined' || !window.localStorage) return false;
  try {
    return window.localStorage.getItem(DEV_MODE_LS_KEY) === 'true';
  } catch {
    return false;
  }
}

function writeDevModeToStorage(next: boolean): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    if (next) window.localStorage.setItem(DEV_MODE_LS_KEY, 'true');
    else window.localStorage.removeItem(DEV_MODE_LS_KEY);
  } catch {
    /* ignore */
  }
}

export type AgentConnectionState = AgentStreamState;

export type AgentDisplayMessageKind =
  | 'user'
  | 'agent_text'
  | 'tool_call'
  | 'tool_result'
  | 'system'
  | 'error'
  | 'status'
  | 'patch_proposal';

export interface AgentDisplayMessage {
  readonly id: string;
  readonly kind: AgentDisplayMessageKind;
  readonly text: string;
  readonly meta?: Readonly<Record<string, string>>;
  readonly raw?: AgentTurnEvent;
  /** For kind='patch_proposal' messages: the id of the proposal in the
   *  store's `proposals` map. Component renders the proposal by looking
   *  it up at render time so applied/rejected status updates flow through. */
  readonly proposalId?: string;
}

export type PatchActionState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'in_flight' }
  | { readonly kind: 'error'; readonly message: string; readonly editIndex?: number; readonly filePath?: string };

/** Whether the `claude` CLI is reachable on the user's machine. The
 *  WebSocket connects regardless (so we can still receive patch_proposed
 *  frames if another client triggers them), but turn_start fails with
 *  `claude_cli_not_installed` when this is `false`. The AgentPanel
 *  surfaces a clear banner so the user isn't fooled by the green pip. */
export type ClaudeAvailability =
  | { readonly kind: 'unknown' }
  | { readonly kind: 'checking' }
  | { readonly kind: 'available'; readonly binaryPath: string }
  | {
      readonly kind: 'missing';
      /** Discovery trace returned by /api/agent/health - paths that
       *  were checked, in order, with their existence status. The
       *  banner renders this so the user can see exactly why
       *  discovery failed + which paths to fix. */
      readonly searchTrace: ReadonlyArray<AgentBinaryDiscoveryStep>;
    }
  | { readonly kind: 'check_failed'; readonly message: string };

export interface AgentStoreState {
  /** Live AgentStream - null when no project is connected. */
  readonly stream: AgentStream | null;
  /** Latest connection state from the AgentStream. */
  readonly connection: AgentConnectionState;
  /** Project id the stream is bound to. */
  readonly projectId: string | null;
  /** Projected display messages, append-only within a project session. */
  readonly messages: ReadonlyArray<AgentDisplayMessage>;
  /** True between turn_started and turn_done / turn_error. */
  readonly inFlight: boolean;
  /** Monotonic counter used to build stable message ids per stream event. */
  readonly eventCounter: number;
  /** Live patch proposals keyed by id. Status is mutated in place when
   *  WS frames `patch_applied` / `patch_rejected` arrive, and when the
   *  user's apply/reject HTTP call returns. */
  readonly proposals: ReadonlyMap<string, AgentPatchProposal>;
  /** Per-proposal action state - tracks in-flight HTTP requests and
   *  surfaces the most recent apply/reject error per proposal. */
  readonly patchActions: ReadonlyMap<string, PatchActionState>;
  /** Whether `claude` CLI is reachable. Probed via /api/agent/health on
   *  connect; `unknown` until the probe lands. */
  readonly claudeAvailability: ClaudeAvailability;
  /** AI-4.1 dev mode. When true, every turn_start carries devMode=true
   *  and the backend appends the dev-mode system-prompt addendum
   *  telling the agent it may edit the editor's own source via the
   *  built-in Edit/Write/Bash tools. Persisted to localStorage so the
   *  toggle survives reloads. Default false. */
  readonly devMode: boolean;

  connect: (projectId: string, opts?: { WebSocketCtor?: typeof WebSocket }) => void;
  disconnect: () => void;
  sendPrompt: (text: string) => void;
  abortTurn: () => void;
  resetSession: () => void;
  clearMessages: () => void;
  applyProposal: (proposalId: string) => Promise<void>;
  rejectProposal: (proposalId: string) => Promise<void>;
  refreshClaudeAvailability: () => Promise<void>;
  setDevMode: (next: boolean) => void;
}

export const useAgentStore = create<AgentStoreState>((set, get) => {
  function pushMessage(msg: AgentDisplayMessage): void {
    set((s) => ({ messages: [...s.messages, msg] }));
  }

  function handleServerMessage(msg: AgentWsServerMessage): void {
    switch (msg.kind) {
      case 'ready':
        // Connection state already promotes via onStateChange; no message.
        return;
      case 'turn_started':
        set({ inFlight: true });
        pushMessage({
          id: `started-${msg.turnIndex}`,
          kind: 'status',
          text: `Turn #${msg.turnIndex} started`,
        });
        return;
      case 'turn_event': {
        const idx = get().eventCounter;
        set({ eventCounter: idx + 1 });
        const projected = projectEvent(msg.event, idx);
        if (projected) pushMessage(projected);
        return;
      }
      case 'turn_done':
        set({ inFlight: false });
        if (msg.finalText) {
          pushMessage({
            id: `done-${msg.turnCount}`,
            kind: 'agent_text',
            text: msg.finalText,
          });
        }
        pushMessage({
          id: `done-meta-${msg.turnCount}`,
          kind: 'status',
          text: `Done in ${Math.round(msg.durationMs)}ms`,
        });
        return;
      case 'turn_error':
        set({ inFlight: false });
        pushMessage({
          id: `err-${Date.now()}`,
          kind: 'error',
          text: msg.message ?? msg.code,
          meta: msg.stderr ? { stderr: msg.stderr } : undefined,
        });
        return;
      case 'session_reset':
        // Server-confirmed reset. Clear local messages + proposals.
        set({
          messages: [],
          eventCounter: 0,
          proposals: new Map(),
          patchActions: new Map(),
        });
        pushMessage({
          id: `reset-${Date.now()}`,
          kind: 'status',
          text: `Session reset · new id ${msg.sessionId.slice(0, 8)}…`,
        });
        return;
      case 'pong':
        return;
      case 'patch_proposed': {
        const proposal = msg.proposal;
        const next = new Map(get().proposals);
        next.set(proposal.id, proposal);
        set({ proposals: next });
        pushMessage({
          id: `proposal-${proposal.id}`,
          kind: 'patch_proposal',
          text: proposal.description,
          proposalId: proposal.id,
        });
        return;
      }
      case 'patch_applied': {
        const existing = get().proposals.get(msg.proposalId);
        if (!existing) return;
        const next = new Map(get().proposals);
        next.set(msg.proposalId, {
          ...existing,
          status: 'applied',
          appliedAtUtc: existing.appliedAtUtc ?? new Date().toISOString(),
        });
        set({ proposals: next });
        return;
      }
      case 'patch_rejected': {
        const existing = get().proposals.get(msg.proposalId);
        if (!existing) return;
        const next = new Map(get().proposals);
        next.set(msg.proposalId, {
          ...existing,
          status: 'rejected',
          rejectedAtUtc: existing.rejectedAtUtc ?? new Date().toISOString(),
        });
        set({ proposals: next });
        return;
      }
    }
  }

  function setPatchAction(proposalId: string, state: PatchActionState): void {
    const next = new Map(get().patchActions);
    next.set(proposalId, state);
    set({ patchActions: next });
  }

  return {
    stream: null,
    connection: { kind: 'idle' },
    projectId: null,
    messages: [],
    inFlight: false,
    eventCounter: 0,
    proposals: new Map(),
    patchActions: new Map(),
    claudeAvailability: { kind: 'unknown' },
    devMode: readDevModeFromStorage(),

    connect(projectId, opts) {
      const cur = get();
      if (cur.stream && cur.projectId === projectId) {
        // Already connected to this project - no-op.
        return;
      }
      // Different project → close old stream and clear messages.
      if (cur.stream) {
        cur.stream.close();
      }
      const projectChanged = cur.projectId !== null && cur.projectId !== projectId;
      const stream = new AgentStream(
        projectId,
        {
          onStateChange: (state) => set({ connection: state }),
          onMessage: handleServerMessage,
        },
        opts,
      );
      set({
        stream,
        projectId,
        connection: { kind: 'idle' },
        inFlight: false,
        ...(projectChanged
          ? {
              messages: [],
              eventCounter: 0,
              proposals: new Map<string, AgentPatchProposal>(),
              patchActions: new Map<string, PatchActionState>(),
            }
          : {}),
      });
      stream.connect();
      // Probe claude availability - fire-and-forget; result lands in
      // the store regardless of WS state.
      void get().refreshClaudeAvailability();
    },

    setDevMode(next) {
      set({ devMode: next });
      writeDevModeToStorage(next);
    },

    async refreshClaudeAvailability() {
      set({ claudeAvailability: { kind: 'checking' } });
      try {
        const health = await fetchAgentHealth();
        if (health.claudeBinary && health.claudeBinary.length > 0) {
          set({ claudeAvailability: { kind: 'available', binaryPath: health.claudeBinary } });
        } else {
          set({
            claudeAvailability: {
              kind: 'missing',
              searchTrace: health.claudeBinarySearchTrace ?? [],
            },
          });
        }
      } catch (e) {
        set({
          claudeAvailability: {
            kind: 'check_failed',
            message: e instanceof Error ? e.message : String(e),
          },
        });
      }
    },

    disconnect() {
      const cur = get();
      if (cur.stream) cur.stream.close();
      set({ stream: null, projectId: null, connection: { kind: 'idle' }, inFlight: false });
    },

    sendPrompt(text) {
      const trimmed = text.trim();
      if (!trimmed) return;
      const cur = get();
      if (!cur.stream || cur.connection.kind !== 'open') return;
      // AI-4.1: include devMode flag so the backend can augment the
      // system prompt for this turn.
      cur.stream.send({ kind: 'turn_start', prompt: trimmed, devMode: cur.devMode });
      pushMessage({ id: `user-${Date.now()}`, kind: 'user', text: trimmed });
    },

    abortTurn() {
      get().stream?.send({ kind: 'turn_abort' });
    },

    resetSession() {
      get().stream?.send({ kind: 'session_reset' });
    },

    clearMessages() {
      set({ messages: [], eventCounter: 0 });
    },

    async applyProposal(proposalId) {
      setPatchAction(proposalId, { kind: 'in_flight' });
      try {
        const applied = await applyAgentPatch(proposalId);
        // The WS will also send patch_applied; pre-emptively update the
        // local state so the UI flips immediately on click.
        const next = new Map(get().proposals);
        next.set(applied.id, applied);
        set({ proposals: next });
        setPatchAction(proposalId, { kind: 'idle' });
        // Phase 2A-3 - trigger a re-scan so downstream propose-* tools
        // see the updated manifest. The session-1 transcript hit this
        // exact pitfall: propose_add_script_for_trainer ran immediately
        // after Apply, read a stale 1648-entry manifest, and couldn't
        // see the just-added ObjectEvent. Stale-while-revalidate in
        // state.ts:127-141 keeps the UI from flickering during the rescan.
        // Fire-and-forget - the rescan is a side effect on store state,
        // not something the apply flow needs to await.
        void useProjectStore.getState().scanCurrentProject();
      } catch (e) {
        if (e instanceof AgentPatchActionError) {
          setPatchAction(proposalId, {
            kind: 'error',
            message: e.message,
            editIndex: e.editIndex,
            filePath: e.filePath,
          });
        } else {
          setPatchAction(proposalId, {
            kind: 'error',
            message: e instanceof Error ? e.message : String(e),
          });
        }
      }
    },

    async rejectProposal(proposalId) {
      setPatchAction(proposalId, { kind: 'in_flight' });
      try {
        const rejected = await rejectAgentPatch(proposalId);
        const next = new Map(get().proposals);
        next.set(rejected.id, rejected);
        set({ proposals: next });
        setPatchAction(proposalId, { kind: 'idle' });
      } catch (e) {
        if (e instanceof AgentPatchActionError) {
          setPatchAction(proposalId, { kind: 'error', message: e.message });
        } else {
          setPatchAction(proposalId, {
            kind: 'error',
            message: e instanceof Error ? e.message : String(e),
          });
        }
      }
    },
  };
});

/** Project a raw stream-json event into a renderable AgentDisplayMessage,
 *  or null if the event shouldn't appear in the UI (e.g. the terminal
 *  `result` event - its text is surfaced via the `turn_done` message). */
export function projectEvent(event: AgentTurnEvent, idx: number): AgentDisplayMessage | null {
  const id = `evt-${idx}`;
  if (event.type === 'system') {
    const sub = typeof event.data.subtype === 'string' ? event.data.subtype : 'system';
    return { id, kind: 'system', text: `system: ${sub}`, raw: event };
  }
  if (event.type === 'assistant') {
    const message = event.data.message as { content?: unknown[] } | undefined;
    const blocks = Array.isArray(message?.content) ? message?.content ?? [] : [];
    const texts: string[] = [];
    const toolCalls: AgentDisplayMessage[] = [];
    for (const blk of blocks) {
      const b = blk as { type?: string; text?: string; name?: string; input?: unknown; id?: string };
      if (b.type === 'text' && typeof b.text === 'string') texts.push(b.text);
      if (b.type === 'tool_use' && typeof b.name === 'string') {
        toolCalls.push({
          id: `${id}-tu-${b.id ?? toolCalls.length}`,
          kind: 'tool_call',
          text: `→ ${b.name}`,
          meta: { input: JSON.stringify(b.input ?? {}) },
          raw: event,
        });
      }
    }
    if (texts.length > 0) return { id, kind: 'agent_text', text: texts.join('\n'), raw: event };
    if (toolCalls.length === 1) return toolCalls[0]!;
    if (toolCalls.length > 1) return { id, kind: 'tool_call', text: `→ ${toolCalls.length} tools`, meta: { count: String(toolCalls.length) }, raw: event };
    return null;
  }
  if (event.type === 'user') {
    const message = event.data.message as { content?: unknown[] } | undefined;
    const blocks = Array.isArray(message?.content) ? message?.content ?? [] : [];
    const results: string[] = [];
    for (const blk of blocks) {
      const b = blk as { type?: string; tool_use_id?: string; content?: unknown };
      if (b.type === 'tool_result') {
        const text = Array.isArray(b.content)
          ? (b.content as { type?: string; text?: string }[])
              .filter((c) => c.type === 'text' && typeof c.text === 'string')
              .map((c) => c.text!)
              .join('')
          : '';
        results.push(text.slice(0, 240));
      }
    }
    if (results.length === 0) return null;
    return { id, kind: 'tool_result', text: results.join('\n'), raw: event };
  }
  if (event.type === 'result') {
    return null;
  }
  if (event.type === 'raw_text') {
    const line = typeof event.data.line === 'string' ? event.data.line : '';
    return { id, kind: 'system', text: line, raw: event };
  }
  return { id, kind: 'system', text: `${event.type}`, raw: event };
}
