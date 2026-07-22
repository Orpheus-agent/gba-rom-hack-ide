import { useEffect, useMemo, useState } from 'react';
import type { DialogueNode, ProjectManifest } from '@rom-editor/shared';
import { editDialogueText, ProjectApiError } from '../api';
import { useProjectStore, useUiPreferencesStore } from '../state';
import { displayName } from '../lib/displayName';
import { dialogueToPlainText, DialogueText } from '../lib/dialoguePrettify';
import { DialogueNarrativeGraph } from './DialogueNarrativeGraph';
import { StorySandbox } from './StorySandbox';
import './DialogueView.css';

type DialogueDetailTab = 'editor' | 'narrative' | 'sandbox';

interface DialogueViewProps {
  readonly manifest: ProjectManifest;
}

export function DialogueView({ manifest }: DialogueViewProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [detailTab, setDetailTab] = useState<DialogueDetailTab>('editor');
  const showInternalIds = useUiPreferencesStore((s) => s.showInternalIds);

  const dialogue = manifest.dialogue;

  // Group by inferred map prefix (everything before the first underscore that
  // looks like a map name). Fall back to a "(global)" bucket.
  const grouped = useMemo(() => {
    const m = new Map<string, DialogueNode[]>();
    for (const d of dialogue) {
      const key = inferMapPrefix(d.id) ?? '(global)';
      const arr = m.get(key) ?? [];
      arr.push(d);
      m.set(key, arr);
    }
    for (const [, arr] of m) arr.sort((a, b) => a.id.localeCompare(b.id));
    return m;
  }, [dialogue]);

  const filteredDialogue = useMemo(() => {
    if (!filter.trim()) return dialogue;
    const q = filter.toLowerCase();
    return dialogue.filter(
      (d) =>
        d.id.toLowerCase().includes(q) ||
        (d.speakerName ?? '').toLowerCase().includes(q) ||
        d.text.toLowerCase().includes(q),
    );
  }, [dialogue, filter]);

  const selected = selectedId ? dialogue.find((d) => d.id === selectedId) ?? null : null;

  if (dialogue.length === 0) {
    return (
      <div className="dialogue-view dialogue-view--empty" data-testid="dialogue-view-empty">
        <h2>No dialogue indexed</h2>
        <p>
          The project's scan didn't produce any `DialogueNode` entries. Open a project with
          per-map <code>text.inc</code> files and scan it from the Project view.
        </p>
      </div>
    );
  }

  return (
    <div className="dialogue-view" data-testid="dialogue-view">
      <aside className="dialogue-view__list" aria-label="Dialogue list">
        <input
          type="search"
          className="dialogue-view__filter"
          placeholder="Filter by label, speaker, or text…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          spellCheck={false}
          data-testid="dialogue-view-filter"
        />
        {filter.trim() ? (
          <ul className="dialogue-view__flat-results">
            {filteredDialogue.map((d) => (
              <DialogueListItem
                key={d.id}
                d={d}
                manifest={manifest}
                showInternalIds={showInternalIds}
                selected={d.id === selectedId}
                onClick={() => setSelectedId(d.id)}
              />
            ))}
            {filteredDialogue.length === 0 && (
              <li className="dialogue-view__empty-msg">No matches</li>
            )}
          </ul>
        ) : (
          Array.from(grouped.entries())
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([group, list]) => (
              <div key={group} className="dialogue-view__group">
                <h3 className="dialogue-view__group-heading">{group}</h3>
                <ul className="dialogue-view__items">
                  {list.map((d) => (
                    <DialogueListItem
                      key={d.id}
                      d={d}
                      manifest={manifest}
                      showInternalIds={showInternalIds}
                      selected={d.id === selectedId}
                      onClick={() => setSelectedId(d.id)}
                    />
                  ))}
                </ul>
              </div>
            ))
        )}
      </aside>
      <section className="dialogue-view__editor">
        {selected ? (
          <div className="dialogue-detail" data-testid="dialogue-detail">
            <div className="dialogue-detail__tabs" role="tablist" aria-label="Dialogue detail">
              <button
                type="button"
                role="tab"
                aria-selected={detailTab === 'editor'}
                className={`dialogue-detail__tab${detailTab === 'editor' ? ' dialogue-detail__tab--active' : ''}`}
                data-testid="dialogue-tab-editor"
                onClick={() => setDetailTab('editor')}
              >
                Text editor
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={detailTab === 'narrative'}
                className={`dialogue-detail__tab${detailTab === 'narrative' ? ' dialogue-detail__tab--active' : ''}`}
                data-testid="dialogue-tab-narrative"
                onClick={() => setDetailTab('narrative')}
              >
                Narrative graph
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={detailTab === 'sandbox'}
                className={`dialogue-detail__tab${detailTab === 'sandbox' ? ' dialogue-detail__tab--active' : ''}`}
                data-testid="dialogue-tab-sandbox"
                onClick={() => setDetailTab('sandbox')}
              >
                Story sandbox
              </button>
            </div>
            <div className="dialogue-detail__panel">
              {detailTab === 'editor' && (
                <DialogueEditor
                  node={selected}
                  manifest={manifest}
                  showInternalIds={showInternalIds}
                />
              )}
              {detailTab === 'narrative' && (
                <DialogueNarrativeGraph manifest={manifest} dialogueId={selected.id} />
              )}
              {detailTab === 'sandbox' && (
                <StorySandbox manifest={manifest} startDialogueId={selected.id} />
              )}
            </div>
          </div>
        ) : (
          <div className="dialogue-view__placeholder" data-testid="dialogue-view-placeholder">
            <h2>Pick a line</h2>
            <p>
              {dialogue.length} dialogue line{dialogue.length === 1 ? '' : 's'} across{' '}
              {grouped.size} group{grouped.size === 1 ? '' : 's'}.
            </p>
            <p>
              Each line opens in two views: the <strong>text editor</strong> to rewrite the
              body and persist atomically, or the <strong>narrative graph</strong> to see
              what comes after this line in the story - branches, flag-sets, and all.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}

function inferMapPrefix(id: string): string | null {
  // Common pattern: <PascalCaseMap>_<Speaker>_Text_<Topic> - the prefix up to
  // the first occurrence of "_Text_" gives the (Map + speaker) bucket; we take
  // just the leading map portion if it's distinguishable, else fall back to id.
  const i = id.indexOf('_Text_');
  if (i <= 0) return null;
  // Take everything up to the second underscore (e.g. "LittlerootTown" for "LittlerootTown_Mom_Text_Hi").
  const parts = id.slice(0, i).split('_');
  if (parts.length >= 2) return parts[0] ?? null;
  return parts[0] ?? null;
}

function DialogueListItem({
  d,
  manifest,
  showInternalIds,
  selected,
  onClick,
}: {
  d: DialogueNode;
  manifest: ProjectManifest;
  showInternalIds: boolean;
  selected: boolean;
  onClick: () => void;
}) {
  // Resolve the dialogue id into a plain-English label and prettify the
  // preview snippet so control sentinels render as spaces, not visible
  // `\p`/`\l` garbage.
  const label = displayName(manifest, d.id, showInternalIds);
  const previewPlain = dialogueToPlainText(d.text);
  return (
    <li>
      <button
        type="button"
        className={`dialogue-view__item${selected ? ' dialogue-view__item--selected' : ''}`}
        data-testid={`dialogue-view-item-${d.id}`}
        onClick={onClick}
      >
        <span className="dialogue-view__item-id">{label}</span>
        {d.speakerName && (
          <span className="dialogue-view__item-speaker">{d.speakerName}</span>
        )}
        <span className="dialogue-view__item-preview">{previewPlain.slice(0, 80)}</span>
      </button>
    </li>
  );
}

type SaveState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'saving' }
  | { readonly kind: 'saved' }
  | { readonly kind: 'error'; readonly message: string };

function DialogueEditor({
  node,
  manifest,
  showInternalIds,
}: {
  node: DialogueNode;
  manifest: ProjectManifest;
  showInternalIds: boolean;
}) {
  const sessionId = useProjectStore((s) =>
    s.load.kind === 'loaded' ? s.load.data.session.id : null,
  );
  const scanCurrent = useProjectStore((s) => s.scanCurrentProject);
  const [text, setText] = useState(node.text);
  const [state, setState] = useState<SaveState>({ kind: 'idle' });

  useEffect(() => {
    setText(node.text);
    setState({ kind: 'idle' });
  }, [node.id, node.text]);

  const dirty = text !== node.text;
  const valid = text.length > 0 && text.length <= 4096;

  async function save(): Promise<void> {
    if (!sessionId || !dirty || !valid) return;
    setState({ kind: 'saving' });
    try {
      await editDialogueText(sessionId, node.id, text);
      setState({ kind: 'saved' });
      await scanCurrent();
    } catch (e) {
      const msg =
        e instanceof ProjectApiError
          ? `${e.code}: ${e.message}`
          : e instanceof Error
            ? e.message
            : String(e);
      setState({ kind: 'error', message: msg });
    }
  }

  return (
    <div className="dialogue-editor" data-testid="dialogue-editor">
      <header className="dialogue-editor__header">
        <h2 className="dialogue-editor__id" data-testid="dialogue-editor-id">
          {displayName(manifest, node.id, showInternalIds)}
        </h2>
        <div className="dialogue-editor__meta">
          <span>
            Speaker: <strong>{node.speakerName ?? ' - '}</strong>
          </span>
          <span>{text.length} / 4096 chars</span>
        </div>
      </header>
      {/* Plain-English preview of the in-game text with paragraph/line
          breaks rendered visually. Sits above the textarea so the
          operator sees what the player will see. */}
      <div className="dialogue-editor__preview" data-testid="dialogue-editor-preview">
        <DialogueText raw={text} />
      </div>
      <textarea
        className="dialogue-editor__textarea"
        data-testid="dialogue-editor-textarea"
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck
        rows={10}
      />
      <footer className="dialogue-editor__actions">
        <button
          type="button"
          className="btn btn--primary"
          data-testid="dialogue-editor-save"
          disabled={!dirty || !valid || state.kind === 'saving' || !sessionId}
          onClick={() => void save()}
        >
          {state.kind === 'saving' ? 'Saving…' : 'Save text'}
        </button>
        {state.kind === 'saved' && !dirty && (
          <span className="dialogue-editor__ok">Saved · text.inc rewritten</span>
        )}
        {state.kind === 'error' && (
          <span className="dialogue-editor__err">{state.message}</span>
        )}
      </footer>
    </div>
  );
}
