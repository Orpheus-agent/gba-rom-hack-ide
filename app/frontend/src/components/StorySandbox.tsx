import { useCallback, useMemo, useState } from 'react';
import type { DialogueNode, ProjectManifest } from '@rom-editor/shared';
import { traceDialogueNarrative } from '../lib/dialogueTrace';
import { displayName } from '../lib/displayName';
import { DialogueText } from '../lib/dialoguePrettify';
import { useUiPreferencesStore } from '../state';
import {
  availableNextOptions,
  createSession,
  diffFromDefaults,
  follow,
  resetSession,
  type NextOption,
  type SandboxSession,
} from '../lib/storySandbox';
import './StorySandbox.css';

interface StorySandboxProps {
  readonly manifest: ProjectManifest;
  readonly startDialogueId: string;
}

export function StorySandbox({ manifest, startDialogueId }: StorySandboxProps) {
  const [session, setSession] = useState<SandboxSession>(() =>
    createSession(manifest, startDialogueId),
  );
  const showInternalIds = useUiPreferencesStore((s) => s.showInternalIds);

  // Re-trace at the CURRENT node, not the start node - so as the writer walks
  // forward we always have outgoing options computed for wherever they are now.
  const trace = useMemo(
    () => traceDialogueNarrative(manifest, session.currentDialogueId, 1),
    [manifest, session.currentDialogueId],
  );

  const options = useMemo(
    () => availableNextOptions(trace, session.currentDialogueId, session.state),
    [trace, session.currentDialogueId, session.state],
  );

  const currentDialogue = useMemo<DialogueNode | null>(
    () => manifest.dialogue.find((d) => d.id === session.currentDialogueId) ?? null,
    [manifest, session.currentDialogueId],
  );

  const diff = useMemo(() => diffFromDefaults(manifest, session.state), [manifest, session.state]);

  const onFollow = useCallback(
    (option: NextOption) => {
      setSession((s) => follow(s, option.edge));
    },
    [],
  );

  const onReset = useCallback(() => {
    setSession((s) => resetSession(s, manifest));
  }, [manifest]);

  return (
    <div className="story-sandbox" data-testid="story-sandbox">
      <header className="story-sandbox__header">
        <div className="story-sandbox__header-row">
          <h3 className="story-sandbox__title">Story sandbox</h3>
          <div className="story-sandbox__counter" data-testid="story-sandbox-step-counter">
            step {session.history.length}
          </div>
          <button
            type="button"
            className="btn btn--secondary story-sandbox__reset"
            onClick={onReset}
            data-testid="story-sandbox-reset"
            disabled={session.history.length === 0 && session.currentDialogueId === startDialogueId}
          >
            Reset to start
          </button>
        </div>
        <p className="story-sandbox__hint">
          Interactive walker over the script-derived narrative. Each "follow" applies the
          edge's <code>setflag</code>/<code>setvar</code>/etc. side-effects in memory - the
          source files are not touched. Use it to verify "does the right branch fire after
          FLAG_X is set?" before launching a build.
        </p>
      </header>

      <section className="story-sandbox__current" data-testid="story-sandbox-current">
        <div className="story-sandbox__current-label">Current line</div>
        {currentDialogue ? (
          <>
            <div className="story-sandbox__current-id">
              {displayName(manifest, currentDialogue.id, showInternalIds)}
            </div>
            {currentDialogue.speakerName && (
              <div className="story-sandbox__current-speaker">{currentDialogue.speakerName}</div>
            )}
            <div className="story-sandbox__current-text">
              <DialogueText raw={currentDialogue.text} />
            </div>
          </>
        ) : (
          <div className="story-sandbox__current-unknown">
            {displayName(manifest, session.currentDialogueId, showInternalIds)} is not in the
            dialogue index - the script may reference a text label this scanner doesn't catch.
          </div>
        )}
      </section>

      <section className="story-sandbox__options" data-testid="story-sandbox-options">
        <h4 className="story-sandbox__section-heading">
          What happens next ({options.length})
        </h4>
        {options.length === 0 ? (
          <div className="story-sandbox__no-options" data-testid="story-sandbox-no-options">
            No outgoing edges from this line. The script either ends here (<code>end</code> /
            <code>return</code>), warps elsewhere, or fans out via macros the trace doesn't
            model.
          </div>
        ) : (
          <ul className="story-sandbox__options-list">
            {options.map((o) => (
              <li key={o.edge.id} className={`story-sandbox__option story-sandbox__option--${o.result}`}>
                <button
                  type="button"
                  className="story-sandbox__follow"
                  onClick={() => onFollow(o)}
                  data-testid={`story-sandbox-follow-${o.edge.toId}`}
                >
                  Follow →
                </button>
                <div className="story-sandbox__option-body">
                  <div className="story-sandbox__option-label">
                    <span className={`story-sandbox__verdict story-sandbox__verdict--${o.result}`}>
                      {verdictLabel(o.result)}
                    </span>{' '}
                    {o.edge.label}
                  </div>
                  <div className="story-sandbox__option-target">→ {o.edge.toId}</div>
                  {o.edge.sideEffects.length > 0 && (
                    <div className="story-sandbox__option-effects">
                      Side-effects: {o.edge.sideEffects.join(' · ')}
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="story-sandbox__state" data-testid="story-sandbox-state">
        <h4 className="story-sandbox__section-heading">
          State (changed from default)
        </h4>
        {diff.flags.length === 0 && diff.variables.length === 0 ? (
          <div className="story-sandbox__state-empty">
            All flags + variables still at their defaults.
          </div>
        ) : (
          <div className="story-sandbox__state-body">
            {diff.flags.length > 0 && (
              <div className="story-sandbox__state-section">
                <div className="story-sandbox__state-heading">Flags</div>
                <ul className="story-sandbox__state-list" data-testid="story-sandbox-flags">
                  {diff.flags.map((f) => (
                    <li key={f.id}>
                      <code>{f.id}</code> = <strong>{String(f.value)}</strong>{' '}
                      <span className="story-sandbox__state-was">was {String(f.defaultValue)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {diff.variables.length > 0 && (
              <div className="story-sandbox__state-section">
                <div className="story-sandbox__state-heading">Variables</div>
                <ul className="story-sandbox__state-list" data-testid="story-sandbox-vars">
                  {diff.variables.map((v) => (
                    <li key={v.id}>
                      <code>{v.id}</code> = <strong>{v.value}</strong>{' '}
                      <span className="story-sandbox__state-was">was {v.defaultValue}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </section>

      {session.history.length > 0 && (
        <section className="story-sandbox__history" data-testid="story-sandbox-history">
          <h4 className="story-sandbox__section-heading">
            History ({session.history.length})
          </h4>
          <ol className="story-sandbox__history-list">
            {session.history.map((rec, i) => (
              <li key={`${rec.fromDialogueId}->${rec.toDialogueId}#${i}`}>
                <code>{rec.fromDialogueId}</code> →{' '}
                <span className="story-sandbox__history-label">{rec.edge.label}</span>{' '}
                → <code>{rec.toDialogueId}</code>
                {rec.edge.sideEffects.length > 0 && (
                  <span className="story-sandbox__history-effects">
                    {' '}
                    [{rec.edge.sideEffects.join(', ')}]
                  </span>
                )}
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}

function verdictLabel(result: NextOption['result']): string {
  switch (result) {
    case 'true':
      return '✓';
    case 'false':
      return '✗';
    case 'unknown':
      return '?';
  }
}
