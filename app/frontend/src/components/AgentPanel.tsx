import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAgentStore, type AgentDisplayMessage, type PatchActionState } from '../state/agent';
import { useProjectStore } from '../state';
import type { AgentPatchEdit, AgentPatchProposal } from '@rom-editor/shared';
import './AgentPanel.css';

interface PatchProposalCardProps {
  readonly proposal: AgentPatchProposal;
  readonly action: PatchActionState;
  readonly onApply: () => void;
  readonly onReject: () => void;
}

/** Truncate a hex byte string for compact display in the diff card. */
function truncHex(hex: string, maxBytes = 12): string {
  const totalBytes = Math.ceil(hex.length / 2);
  if (totalBytes <= maxBytes) return hex;
  return `${hex.slice(0, maxBytes * 2)}… (${totalBytes} bytes)`;
}

interface EditSummary {
  readonly path: string;
  readonly before: string;
  readonly after: string;
}

function summarizeEdit(edit: AgentPatchEdit): EditSummary {
  switch (edit.kind) {
    case 'replace_in_file':
      return { path: edit.filePath, before: edit.before, after: edit.after };
    case 'binary_replace_text':
      return {
        path: `ROM @ 0x${edit.textOffset.toString(16)}`,
        before: edit.before,
        after: edit.after,
      };
    case 'binary_write_text': {
      const isFreeSpace = edit.before === '';
      return {
        path: `ROM @ 0x${edit.offset.toString(16)}${isFreeSpace ? ' (free-space write)' : ''}`,
        before: edit.before,
        after: edit.after,
      };
    }
    case 'binary_rewrite_pointer':
      return {
        path: `Pointer @ 0x${edit.pointerOffset.toString(16)}`,
        before: `→ 0x${edit.beforeTargetOffset.toString(16)}`,
        after: `→ 0x${edit.afterTargetOffset.toString(16)}`,
      };
    case 'binary_write_bytes': {
      const isFreeSpace = edit.beforeBytes === '';
      return {
        path: `ROM bytes @ 0x${edit.offset.toString(16)}${isFreeSpace ? ' (free-space write)' : ''}`,
        before: isFreeSpace ? '(fill bytes)' : truncHex(edit.beforeBytes),
        after: truncHex(edit.afterBytes),
      };
    }
  }
}

/** File / ROM-target group for the meta line - counts unique paths
 *  for source edits and treats every binary edit as touching the ROM. */
function distinctTargets(edits: ReadonlyArray<AgentPatchEdit>): number {
  const seen = new Set<string>();
  for (const e of edits) {
    if (e.kind === 'replace_in_file') seen.add(e.filePath);
    else seen.add('rom.gba');
  }
  return seen.size;
}

function PatchProposalCard({ proposal, action, onApply, onReject }: PatchProposalCardProps) {
  const editCount = proposal.edits.length;
  const fileCount = distinctTargets(proposal.edits);
  const isPending = proposal.status === 'pending';
  const isInFlight = action.kind === 'in_flight';
  return (
    <div className="agent-panel__patch-card" data-testid="agent-panel-patch-card">
      <header className="agent-panel__patch-header">
        <span className="agent-panel__patch-icon" aria-hidden>📝</span>
        <span className="agent-panel__patch-title" data-testid="agent-panel-patch-title">
          {proposal.description}
        </span>
        <span
          className={`agent-panel__patch-status agent-panel__patch-status--${proposal.status}`}
          data-testid="agent-panel-patch-status"
        >
          {proposal.status}
        </span>
      </header>
      <div className="agent-panel__patch-meta">
        {editCount} edit{editCount === 1 ? '' : 's'} across {fileCount} target{fileCount === 1 ? '' : 's'}
      </div>
      <details className="agent-panel__patch-edits">
        <summary>view edits</summary>
        <ul className="agent-panel__patch-edit-list">
          {proposal.edits.map((edit, i) => {
            const summary = summarizeEdit(edit);
            return (
              <li key={i} className="agent-panel__patch-edit">
                <span className="agent-panel__patch-edit-path">{summary.path}</span>
                {edit.note && <span className="agent-panel__patch-edit-note"> · {edit.note}</span>}
                <div className="agent-panel__patch-edit-diff">
                  <pre className="agent-panel__patch-edit-before">- {summary.before}</pre>
                  <pre className="agent-panel__patch-edit-after">+ {summary.after}</pre>
                </div>
              </li>
            );
          })}
        </ul>
      </details>
      {action.kind === 'error' && (
        <div className="agent-panel__patch-error" data-testid="agent-panel-patch-error">
          {action.message}
          {action.filePath !== undefined && (
            <span className="agent-panel__patch-error-file"> · {action.filePath}</span>
          )}
        </div>
      )}
      <div className="agent-panel__patch-actions">
        <button
          type="button"
          className="agent-panel__btn agent-panel__btn--primary"
          onClick={onApply}
          disabled={!isPending || isInFlight}
          data-testid="agent-panel-patch-apply"
        >
          {isInFlight ? 'Applying…' : 'Apply'}
        </button>
        <button
          type="button"
          className="agent-panel__btn agent-panel__btn--ghost"
          onClick={onReject}
          disabled={!isPending || isInFlight}
          data-testid="agent-panel-patch-reject"
        >
          Reject
        </button>
      </div>
    </div>
  );
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  if (target.isContentEditable) return true;
  return false;
}

export function AgentPanel() {
  const projectId = useProjectStore((s) =>
    s.load.kind === 'loaded' ? s.load.data.session.id : null,
  );

  const connection = useAgentStore((s) => s.connection);
  const messages = useAgentStore((s) => s.messages);
  const inFlight = useAgentStore((s) => s.inFlight);
  const proposals = useAgentStore((s) => s.proposals);
  const patchActions = useAgentStore((s) => s.patchActions);
  const claudeAvailability = useAgentStore((s) => s.claudeAvailability);
  const devMode = useAgentStore((s) => s.devMode);
  const connect = useAgentStore((s) => s.connect);
  const disconnect = useAgentStore((s) => s.disconnect);
  const sendPrompt = useAgentStore((s) => s.sendPrompt);
  const abortTurn = useAgentStore((s) => s.abortTurn);
  const resetSession = useAgentStore((s) => s.resetSession);
  const applyProposal = useAgentStore((s) => s.applyProposal);
  const rejectProposal = useAgentStore((s) => s.rejectProposal);
  const setDevMode = useAgentStore((s) => s.setDevMode);

  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const messageListRef = useRef<HTMLOListElement | null>(null);

  // Manage the WebSocket lifecycle. Now that the panel is always mounted
  // as the right rail, connect whenever a project is loaded; disconnect
  // only on project close.
  useEffect(() => {
    if (!projectId) {
      disconnect();
      return;
    }
    connect(projectId);
  }, [projectId, connect, disconnect]);

  // Auto-scroll to bottom when new messages arrive.
  useEffect(() => {
    const list = messageListRef.current;
    if (!list) return;
    list.scrollTop = list.scrollHeight;
  }, [messages]);

  // Ctrl+Shift+A (or ⌘+Shift+A) focuses the input. Skipped when typing
  // elsewhere so it doesn't fight code editors / dialogue fields.
  // Also listens for an explicit `agent:focus-input` custom event, which
  // is what the titlebar Agent button dispatches.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const accel = e.ctrlKey || e.metaKey;
      if (!accel || !e.shiftKey || e.key.toLowerCase() !== 'a' || e.repeat) return;
      if (isTypingTarget(e.target)) return;
      e.preventDefault();
      inputRef.current?.focus();
    }
    function onFocusEvent(): void {
      inputRef.current?.focus();
    }
    window.addEventListener('keydown', onKey);
    window.addEventListener('agent:focus-input', onFocusEvent);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('agent:focus-input', onFocusEvent);
    };
  }, []);

  const onSubmit = useCallback(() => {
    sendPrompt(draft);
    setDraft('');
  }, [draft, sendPrompt]);

  const statusLine = useMemo(() => {
    if (!projectId) return 'No project open';
    if (connection.kind === 'open' && claudeAvailability.kind === 'missing') {
      // The WS is established but turn-start would fail. Surface that
      // upfront so the green pip + "0 turns" doesn't mislead.
      return 'connected · agent unavailable (claude CLI missing)';
    }
    switch (connection.kind) {
      case 'idle': return 'idle';
      case 'connecting': return 'connecting…';
      case 'open': return `connected · session ${connection.sessionId.slice(0, 8)}… · ${connection.turnCount} turn${connection.turnCount === 1 ? '' : 's'}`;
      case 'closed': return `closed (${connection.code})${connection.reason ? `: ${connection.reason}` : ''}`;
      case 'error': return `error: ${connection.message}`;
    }
  }, [projectId, connection, claudeAvailability]);

  const claudeReady =
    claudeAvailability.kind === 'available' || claudeAvailability.kind === 'unknown';
  // While we don't yet know whether claude is installed we still allow
  // typing - the user might be a first-time launcher and the probe is
  // in flight. We only HARD-disable Send when we KNOW it's missing.
  const canSend =
    connection.kind === 'open' &&
    !inFlight &&
    draft.trim().length > 0 &&
    claudeAvailability.kind !== 'missing';

  return (
    <aside className="agent-panel" role="complementary" aria-label="Agent" data-testid="agent-panel">
      <header className="agent-panel__header">
        <div className="agent-panel__title">
          <span aria-hidden>💬</span>
          <span>Agent</span>
        </div>
        <div className="agent-panel__header-actions">
          <button
            type="button"
            className={`agent-panel__btn agent-panel__btn--ghost${devMode ? ' agent-panel__btn--dev-active' : ''}`}
            onClick={() => setDevMode(!devMode)}
            title={
              devMode
                ? 'Dev mode ON - agent can edit the editor\'s own source via Edit/Write/Bash. Click to disable.'
                : 'Dev mode OFF - agent only edits ROM data. Click to enable editor self-extension.'
            }
            data-testid="agent-panel-dev-mode-toggle"
            data-active={devMode ? 'true' : 'false'}
          >
            {devMode ? 'DEV ●' : 'DEV ○'}
          </button>
          <button
            type="button"
            className="agent-panel__btn agent-panel__btn--ghost"
            onClick={resetSession}
            disabled={connection.kind !== 'open' || inFlight}
            title="Start a fresh agent session (forgets prior turns)"
          >
            Reset
          </button>
        </div>
      </header>
      <div className="agent-panel__status" data-testid="agent-panel-status">
        {statusLine}
      </div>
      {claudeAvailability.kind === 'missing' && (
        <div
          className="agent-panel__banner agent-panel__banner--warn"
          role="status"
          data-testid="agent-panel-claude-missing"
        >
          <strong>Claude Code CLI not found.</strong>
          <p>
            The agent panel connects to the backend, but turn-start requires
            the local <code>claude</code> binary. Install{' '}
            <a href="https://docs.claude.com/claude-code" target="_blank" rel="noreferrer">
              Claude Code
            </a>{' '}
            (or set <code>CLAUDE_CLI_PATH</code> to its absolute path), then
            restart the backend.
          </p>
          {claudeAvailability.searchTrace.length > 0 && (
            <details className="agent-panel__banner-details">
              <summary>
                {claudeAvailability.searchTrace.length} path
                {claudeAvailability.searchTrace.length === 1 ? '' : 's'} checked
 - show me where it looked
              </summary>
              <ul className="agent-panel__banner-trace">
                {claudeAvailability.searchTrace.map((step, i) => (
                  <li
                    key={i}
                    className={
                      step.exists
                        ? 'agent-panel__banner-trace-step agent-panel__banner-trace-step--exists'
                        : 'agent-panel__banner-trace-step'
                    }
                    data-testid={`agent-panel-trace-step-${i}`}
                  >
                    <span className="agent-panel__banner-trace-source">{step.source}</span>
                    <code className="agent-panel__banner-trace-path">{step.path}</code>
                    {step.note && (
                      <span className="agent-panel__banner-trace-note"> · {step.note}</span>
                    )}
                  </li>
                ))}
              </ul>
              <p className="agent-panel__banner-hint">
                If Claude Code is installed somewhere else, set{' '}
                <code>CLAUDE_CLI_PATH</code> to its absolute path in PowerShell:
                <br />
                <code>
                  [Environment]::SetEnvironmentVariable("CLAUDE_CLI_PATH", "C:\path\to\claude.exe",
                  "User")
                </code>
                <br />
                then close + reopen the backend's terminal and re-run{' '}
                <code>npm run dev</code>.
              </p>
            </details>
          )}
          <button
            type="button"
            className="agent-panel__btn agent-panel__btn--ghost"
            onClick={() => void useAgentStore.getState().refreshClaudeAvailability()}
            data-testid="agent-panel-claude-recheck"
          >
            Recheck
          </button>
        </div>
      )}
      {claudeAvailability.kind === 'check_failed' && (
        <div className="agent-panel__banner agent-panel__banner--warn">
          Couldn't probe agent health: {claudeAvailability.message}
        </div>
      )}
      <ol className="agent-panel__messages" ref={messageListRef} data-testid="agent-panel-messages">
        {messages.length === 0 && projectId && connection.kind === 'open' && (
          <li className="agent-panel__empty">
            Ask the agent anything about this project. Try:
            <ul>
              <li>"list trainers in cerulean city"</li>
              <li>"what NPCs are on route 1?"</li>
              <li>"how many flags does this game define?"</li>
            </ul>
          </li>
        )}
        {!projectId && (
          <li className="agent-panel__empty">Load a project to start a conversation with the agent.</li>
        )}
        {messages.map((m) => {
          if (m.kind === 'patch_proposal' && m.proposalId) {
            const proposal = proposals.get(m.proposalId);
            if (!proposal) return null;
            const action = patchActions.get(proposal.id) ?? { kind: 'idle' };
            return (
              <li
                key={m.id}
                className={`agent-panel__msg agent-panel__patch agent-panel__patch--${proposal.status}`}
                data-testid={`agent-panel-patch-${proposal.id}`}
                data-status={proposal.status}
              >
                <PatchProposalCard
                  proposal={proposal}
                  action={action}
                  onApply={() => void applyProposal(proposal.id)}
                  onReject={() => void rejectProposal(proposal.id)}
                />
              </li>
            );
          }
          return (
            <li key={m.id} className={`agent-panel__msg agent-panel__msg--${m.kind}`}>
              <pre className="agent-panel__msg-body">{m.text}</pre>
              {m.meta && (
                <details className="agent-panel__msg-meta">
                  <summary>details</summary>
                  <pre>{JSON.stringify(m.meta, null, 2)}</pre>
                </details>
              )}
            </li>
          );
        })}
      </ol>
      <form
        className="agent-panel__composer"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit();
        }}
      >
        <textarea
          ref={inputRef}
          className="agent-panel__input"
          rows={2}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={projectId ? 'Ask the agent…' : 'Load a project to begin…'}
          disabled={!projectId || connection.kind !== 'open' || inFlight}
          data-testid="agent-panel-input"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              onSubmit();
            }
          }}
        />
        <div className="agent-panel__composer-actions">
          {inFlight ? (
            <button type="button" className="agent-panel__btn agent-panel__btn--danger" onClick={abortTurn}>
              Stop
            </button>
          ) : (
            <button
              type="submit"
              className="agent-panel__btn agent-panel__btn--primary"
              disabled={!canSend}
              data-testid="agent-panel-send"
            >
              Send
            </button>
          )}
        </div>
      </form>
    </aside>
  );
}
