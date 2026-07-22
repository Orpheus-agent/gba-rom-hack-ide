import { useMemo, useState } from 'react';
import type { InspectorPanelProps } from '../lib/inspectorRegistry';
import { displayName } from '../lib/displayName';
import {
  pushToast,
  useProjectStore,
  useSelection,
  useUiPreferencesStore,
} from '../state';
import { editDialogueText, ProjectApiError } from '../api';
import type {
  DialogueNode,
  MultichoiceListRecord,
  ProjectManifest,
} from '@rom-editor/shared';
import './InspectorShared.css';

export const DIALOGUE_INSPECTOR_SECTIONS = {
  text: 'text',
  multichoice: 'multichoice',
} as const;

// Phase S - DialogueInspector. Reads dialogue body + speaker, surfaces
// every script step that displays it as a click-through, and offers
// inline text editing for decomp workspaces via the existing
// editDialogueText route.

function findDialogue(
  manifest: ProjectManifest | null,
  selectionId: string,
): DialogueNode | null {
  if (!manifest) return null;
  return manifest.dialogue.find((d) => d.id === selectionId) ?? null;
}

export function DialogueInspector(props: InspectorPanelProps) {
  // Consolidated dispatch - multichoice menus open here.
  if (props.selection.kind === 'multichoice') {
    return <MultichoiceSubView {...props} />;
  }
  return <DialogueInspectorBody {...props} />;
}

function DialogueInspectorBody({
  selection,
  manifest,
  sessionId,
}: InspectorPanelProps) {
  const showInternalIds = useUiPreferencesStore((s) => s.showInternalIds);
  const select = useSelection((s) => s.select);
  const scanCurrentProject = useProjectStore((s) => s.scanCurrentProject);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draftText, setDraftText] = useState('');

  const dialogue = useMemo(
    () => findDialogue(manifest, selection.id),
    [manifest, selection.id],
  );

  // Cross-ref: script steps whose msgbox params reference this dialogue.
  const callerSteps = useMemo(() => {
    if (!manifest || !dialogue) return [];
    const out: Array<{ id: string }> = [];
    for (const s of manifest.scriptSteps ?? []) {
      const text = (s.params as Record<string, unknown>)['text'];
      if (typeof text === 'string' && text === dialogue.id) {
        out.push({ id: s.id });
      }
    }
    return out;
  }, [manifest, dialogue]);

  if (!manifest) {
    return (
      <div className="entity-inspector entity-inspector--empty" data-testid="dialogue-inspector">
        <p>Open a project to inspect <code>{selection.id}</code>.</p>
      </div>
    );
  }
  if (!dialogue) {
    return (
      <div className="entity-inspector entity-inspector--empty" data-testid="dialogue-inspector">
        <p>
          No dialogue node with id <code>{selection.id}</code> in the manifest
          ({manifest.dialogue.length} dialogue nodes indexed).
        </p>
      </div>
    );
  }

  function beginEdit() {
    if (!dialogue) return;
    setDraftText(dialogue.text);
    setEditing(true);
  }

  async function commitEdit() {
    if (!dialogue || !sessionId) return;
    setSaving(true);
    try {
      await editDialogueText(sessionId, dialogue.id, draftText);
      pushToast('success', 'Dialogue saved');
      await scanCurrentProject();
      setEditing(false);
    } catch (err) {
      const msg =
        err instanceof ProjectApiError
          ? `${err.code}: ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err);
      pushToast('error', `Save failed: ${msg}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="entity-inspector" data-testid="dialogue-inspector">
      <header className="entity-inspector__header">
        <div className="entity-inspector__sub">Dialogue</div>
        <div
          className="entity-inspector__title"
          data-testid="dialogue-inspector-name"
        >
          {displayName(manifest, dialogue.id, showInternalIds)}
        </div>
        {dialogue.speakerName && (
          <div className="entity-inspector__sub">
            Speaker: <strong>{dialogue.speakerName}</strong>
          </div>
        )}
      </header>

      {!editing ? (
        <>
          <section
            className="entity-inspector__refs"
            data-testid="dialogue-inspector-text"
          >
            <h3 className="entity-inspector__refs-heading">Text</h3>
            <p
              style={{
                margin: 0,
                padding: '8px 10px',
                background: 'rgba(255, 255, 255, 0.03)',
                border: '1px solid var(--color-border)',
                borderRadius: 3,
                fontSize: 13,
                lineHeight: 1.5,
                whiteSpace: 'pre-line',
              }}
            >
              {dialogue.text || '(empty)'}
            </p>
          </section>
          {sessionId && (
            <button
              type="button"
              className="entity-inspector__edit-btn"
              onClick={beginEdit}
              data-testid="dialogue-inspector-edit-btn"
            >
              Edit text…
            </button>
          )}
        </>
      ) : (
        <div
          className="entity-inspector__edit-form"
          data-testid="dialogue-inspector-edit-form"
        >
          <textarea
            className="entity-inspector__textarea"
            value={draftText}
            onChange={(e) => setDraftText(e.target.value)}
            rows={6}
            data-testid="dialogue-inspector-textarea"
            style={{
              width: '100%',
              padding: '6px 8px',
              background: 'var(--color-bg)',
              border: '1px solid var(--color-accent)',
              borderRadius: 3,
              color: 'var(--color-text)',
              font: 'inherit',
              fontSize: 13,
              resize: 'vertical',
            }}
          />
          <div className="entity-inspector__edit-actions">
            <button
              type="button"
              className="entity-inspector__save-btn"
              onClick={commitEdit}
              disabled={saving}
              data-testid="dialogue-inspector-save-btn"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              className="entity-inspector__cancel-btn"
              onClick={() => setEditing(false)}
              disabled={saving}
              data-testid="dialogue-inspector-cancel-btn"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {dialogue.choices.length > 0 && (
        <section
          className="entity-inspector__refs"
          data-testid="dialogue-inspector-choices"
        >
          <h3 className="entity-inspector__refs-heading">
            Choices ({dialogue.choices.length})
          </h3>
          <ul className="entity-inspector__refs-list">
            {dialogue.choices.map((c, i) => (
              <li key={i}>
                <div className="entity-inspector__refs-btn" style={{ cursor: 'default' }}>
                  <span className="entity-inspector__refs-btn-label">
                    {c.label}
                  </span>
                  <span className="entity-inspector__refs-btn-meta">
                    {c.nextDialogueId
                      ? `→ ${c.nextDialogueId}`
                      : c.setsFlagIds.length > 0
                        ? `sets ${c.setsFlagIds.length} flag(s)`
                        : 'end'}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {callerSteps.length > 0 && (
        <section
          className="entity-inspector__refs"
          data-testid="dialogue-inspector-callers"
        >
          <h3 className="entity-inspector__refs-heading">
            Shown by{' '}
            <span className="entity-inspector__refs-count">
              ({callerSteps.length})
            </span>
          </h3>
          <ul className="entity-inspector__refs-list">
            {callerSteps.slice(0, 20).map((s, i) => (
              <li key={`${s.id}-${i}`}>
                <button
                  type="button"
                  className="entity-inspector__refs-btn"
                  onClick={() => select({ kind: 'scriptStep', id: s.id })}
                >
                  <span className="entity-inspector__refs-btn-label">
                    {displayName(manifest, s.id, showInternalIds)}
                  </span>
                  <span className="entity-inspector__refs-btn-meta">msgbox</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

// === Consolidated sub-view (absorbed from deleted MultichoiceInspector) ===

function findMultichoiceList(
  manifest: ProjectManifest,
  selectionId: string,
): MultichoiceListRecord | null {
  const lists = manifest.multichoiceLists ?? [];
  const direct = lists.find((l) => l.id === selectionId);
  if (direct) return direct;
  const synth = /^(?:multichoice|choices)_(\d+)$/.exec(selectionId);
  if (synth) {
    const idx = Number.parseInt(synth[1]!, 10);
    return lists.find((l) => l.listIndex === idx) ?? null;
  }
  return null;
}

/** Renders the menu options of a multichoice list. Replaces the deleted
 *  MultichoiceInspector. */
function MultichoiceSubView({ selection, manifest }: InspectorPanelProps): JSX.Element {
  if (!manifest) {
    return (
      <div className="entity-inspector entity-inspector--empty" data-testid="multichoice-inspector">
        <p>Open a project to inspect this menu.</p>
      </div>
    );
  }
  const list = findMultichoiceList(manifest, selection.id);
  if (!list) {
    return (
      <div className="entity-inspector entity-inspector--empty" data-testid="multichoice-inspector">
        <p>No multichoice menu matches this selection.</p>
      </div>
    );
  }

  return (
    <div className="entity-inspector" data-testid="multichoice-inspector">
      <header className="entity-inspector__header">
        <div className="entity-inspector__sub">Choice menu</div>
        <div className="entity-inspector__title" data-testid="multichoice-inspector-name">
          Multichoice #{list.listIndex}
        </div>
        <div className="entity-inspector__sub">
          {list.count} option{list.count === 1 ? '' : 's'}
        </div>
      </header>
      <section className="entity-inspector__refs" data-testid="multichoice-inspector-choices">
        <h3 className="entity-inspector__refs-heading">Options</h3>
        <ul className="entity-inspector__refs-list">
          {list.choices.map((c) => (
            <li key={c.choiceIndex}>
              <div className="entity-inspector__refs-btn" style={{ cursor: 'default' }}>
                <span className="entity-inspector__refs-btn-label">
                  {c.choiceIndex + 1}. {c.text || ' - '}
                </span>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
