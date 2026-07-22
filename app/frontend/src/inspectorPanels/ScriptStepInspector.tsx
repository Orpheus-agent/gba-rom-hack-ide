import { useEffect, useMemo, useState } from 'react';
import type { InspectorPanelProps } from '../lib/inspectorRegistry';
import { displayName } from '../lib/displayName';
import {
  pushToast,
  useProjectStore,
  useSelection,
  useUiPreferencesStore,
  type EntityKind,
} from '../state';
import { editBinaryRomDialogueString, ProjectApiError } from '../api';
import type { ProjectManifest, ScriptStep, Trigger } from '@rom-editor/shared';
import { useEditFormKeyboard } from '../lib/useEditFormKeyboard';
import './InspectorShared.css';

// Phase V (lite) - ScriptStepInspector. The most-referenced entity in
// the workspace. Surfaces the step's kind + every parameter, with
// known-shape params resolved as click-through references (flag, var,
// species, item, move, song, dialogue, map). The parent trigger (if
// any) surfaces as a back-ref so the user can jump to the trigger
// chain and walk neighboring steps.

const KIND_LABEL: Record<string, { label: string; tint: string }> = {
  dialogue: { label: 'Dialogue (msgbox)', tint: '#4a9eff' },
  set_flag: { label: 'Set flag', tint: '#50c878' },
  clear_flag: { label: 'Clear flag', tint: '#a83d3d' },
  branch: { label: 'Branch (conditional)', tint: '#b46aff' },
  branch_on_var: { label: 'Branch on story number', tint: '#b46aff' },
  give_item: { label: 'Give item', tint: '#f0b429' },
  start_battle: { label: 'Start battle', tint: '#a83d3d' },
  play_sound: { label: 'Play sound', tint: '#4a9eff' },
  move_npc: { label: 'Move NPC', tint: '#c98a3d' },
  fade_scene: { label: 'Fade scene', tint: '#7c8088' },
  warp_player: { label: 'Warp player', tint: '#50c878' },
  set_variable: { label: 'Set variable', tint: '#b46aff' },
  randomize_branch: { label: 'Randomize branch', tint: '#b46aff' },
  raw: { label: 'Raw bytecode', tint: '#7c8088' },
};

// Maps param key → EntityKind so we can render click-through refs.
const PARAM_KIND: Record<string, EntityKind> = {
  flag: 'flag',
  condition: 'flag',
  variable: 'variable',
  dest: 'variable',
  source: 'variable',
  left: 'variable',
  right: 'variable',
  item: 'item',
  itemId: 'item',
  species: 'species',
  speciesId: 'species',
  move: 'move',
  moveId: 'move',
  soundId: 'song',
  songId: 'song',
  text: 'dialogue',
  dialogueId: 'dialogue',
  mapId: 'map',
  trainerId: 'trainer',
};

function findStep(
  manifest: ProjectManifest | null,
  selectionId: string,
): ScriptStep | null {
  if (!manifest) return null;
  return (manifest.scriptSteps ?? []).find((s) => s.id === selectionId) ?? null;
}

function findOwningTrigger(
  manifest: ProjectManifest,
  stepId: string,
): Trigger | null {
  for (const t of manifest.triggers) {
    if (t.scriptStepIds.includes(stepId)) return t;
  }
  return null;
}

export function ScriptStepInspector({ selection, manifest, sessionId }: InspectorPanelProps) {
  const showInternalIds = useUiPreferencesStore((s) => s.showInternalIds);
  const select = useSelection((s) => s.select);

  const step = useMemo(
    () => findStep(manifest, selection.id),
    [manifest, selection.id],
  );

  if (!manifest) {
    return (
      <div className="entity-inspector entity-inspector--empty" data-testid="script-step-inspector">
        <p>Open a project to inspect <code>{selection.id}</code>.</p>
      </div>
    );
  }
  if (!step) {
    return (
      <div className="entity-inspector entity-inspector--empty" data-testid="script-step-inspector">
        <p>
          No script step with id <code>{selection.id}</code> in the manifest
          ({(manifest.scriptSteps ?? []).length} steps indexed).
        </p>
      </div>
    );
  }

  const meta = KIND_LABEL[step.kind] ?? {
    label: step.kind,
    tint: 'var(--color-text-dim)',
  };
  const owningTrigger = findOwningTrigger(manifest, step.id);
  const paramEntries = Object.entries(step.params);

  // Phase Q.6.1 - extract dialogue text + file-offset on dialogue
  // steps so the body can render an inline text editor right in the
  // ScriptStepInspector (instead of forcing the user back to the map
  // editor's ScriptStepsList to change a single line). The decoder
  // names these `dialogueText` and `textFileOffset` on the step's
  // params dict.
  const dialogueText =
    step.kind === 'dialogue' && typeof step.params['dialogueText'] === 'string'
      ? (step.params['dialogueText'] as string)
      : null;
  const dialogueFileOffset =
    step.kind === 'dialogue' && typeof step.params['textFileOffset'] === 'number'
      ? (step.params['textFileOffset'] as number)
      : null;

  // Parent-script id, recovered from the step id convention
  // `<scriptId>__<index>`. Used by the "Open in script context" link
  // for non-dialogue kinds (which have multi-field editors that live
  // in ScriptStepsList / MapEditor, not here).
  const parentScriptId = useMemo(() => {
    const m = /^(.+)__\d+$/.exec(step.id);
    return m ? m[1]! : null;
  }, [step.id]);

  return (
    <div className="entity-inspector" data-testid="script-step-inspector">
      <header className="entity-inspector__header">
        <div
          className="entity-inspector__sub"
          style={{ color: meta.tint }}
          data-testid="script-step-inspector-kind"
        >
          {meta.label}
        </div>
        <div
          className="entity-inspector__title"
          data-testid="script-step-inspector-name"
        >
          {displayName(manifest, step.id, showInternalIds)}
        </div>
      </header>

      {/* Phase Q.6.1 - inline dialogue editor. Dialogue cards are the
          most-clicked surface in the visual scripter; landing the user
          on a "you can't edit this here, go elsewhere" page would be
          the exact failure mode the overhaul plan rejects. Save calls
          editBinaryRomDialogueString which re-encodes via the Gen-3
          codec + writes in place if length permits. */}
      {step.kind === 'dialogue' && dialogueText !== null && (
        <InlineDialogueEditor
          stepId={step.id}
          initialText={dialogueText}
          textFileOffset={dialogueFileOffset}
          sessionId={sessionId}
        />
      )}

      {/* For non-dialogue kinds, surface an explicit affordance to
          jump to the surface where the inline editor lives. Avoids
          leaving the user stuck on a read-only inspector wondering how
          to change anything. */}
      {step.kind !== 'dialogue' && parentScriptId && (
        <section
          className="entity-inspector__refs"
          style={{ marginTop: 12 }}
          data-testid="script-step-inspector-edit-hint"
        >
          <p
            style={{
              margin: 0,
              padding: '8px 10px',
              background: 'rgba(74, 158, 255, 0.05)',
              borderLeft: '3px solid var(--color-accent)',
              borderRadius: 3,
              fontSize: 12,
              color: 'var(--color-text-muted)',
              lineHeight: 1.4,
            }}
          >
            This step's parameters are editable on the map editor's
            script panel (every step in the script is rendered with its
            inline editor). The card list above already let you click
            into this step - use the map editor's right rail to change
            its parameters.
          </p>
        </section>
      )}

      <section
        className="entity-inspector__refs"
        data-testid="script-step-inspector-params"
      >
        <h3 className="entity-inspector__refs-heading">Parameters</h3>
        {paramEntries.length === 0 ? (
          <p className="entity-inspector__refs-empty">No params (raw opcode).</p>
        ) : (
          <dl className="entity-inspector__meta-grid">
            {paramEntries.map(([k, v]) => {
              const refKind = PARAM_KIND[k];
              const stringV = typeof v === 'string' ? v : null;
              const isClickable = !!(refKind && stringV);
              return (
                <div key={k} className="entity-inspector__meta-row">
                  <dt>{k}</dt>
                  <dd>
                    {isClickable ? (
                      <button
                        type="button"
                        style={{
                          padding: 0,
                          background: 'transparent',
                          border: 'none',
                          color: 'var(--color-accent)',
                          textDecoration: 'underline',
                          textDecorationStyle: 'dotted',
                          cursor: 'pointer',
                          font: 'inherit',
                          fontSize: 'inherit',
                        }}
                        onClick={() =>
                          select({ kind: refKind, id: stringV! })
                        }
                        data-testid={`script-step-inspector-param-${k}`}
                      >
                        {displayName(manifest, stringV!, showInternalIds)}
                      </button>
                    ) : Array.isArray(v) ? (
                      <code style={{ fontSize: 11 }}>[{(v as unknown[]).join(', ')}]</code>
                    ) : typeof v === 'object' && v !== null ? (
                      <code style={{ fontSize: 11 }}>{JSON.stringify(v)}</code>
                    ) : (
                      String(v)
                    )}
                  </dd>
                </div>
              );
            })}
          </dl>
        )}
      </section>

      {/* fallthrough - keep the trigger backref section after the
          edit affordances so the navigation context stays at the
          bottom of the panel. */}
      {owningTrigger && (
        <section
          className="entity-inspector__refs"
          data-testid="script-step-inspector-trigger"
        >
          <h3 className="entity-inspector__refs-heading">Inside trigger</h3>
          <button
            type="button"
            className="entity-inspector__refs-btn"
            onClick={() =>
              select({
                kind: 'trigger',
                id: owningTrigger.id,
                mapContext: owningTrigger.mapId ?? undefined,
              })
            }
            data-testid="script-step-inspector-trigger-link"
          >
            <span className="entity-inspector__refs-btn-label">
              {displayName(manifest, owningTrigger.id, showInternalIds)}
            </span>
            <span className="entity-inspector__refs-btn-meta">
              {owningTrigger.kind}
              {owningTrigger.mapId
                ? ` · ${displayName(manifest, owningTrigger.mapId, showInternalIds)}`
                : ''}
            </span>
          </button>
        </section>
      )}
    </div>
  );
}

/** Phase Q.6.1 - inline dialogue text editor for dialogue-kind script
 *  steps. Mirrors the MsgboxEditor pattern from ScriptStepsList: the
 *  user types new text, hits Save (or Ctrl+Enter), and the call lands
 *  in editBinaryRomDialogueString which re-encodes via the Gen-3 codec
 *  and writes in place. If the new text doesn't fit in the original
 *  span the backend returns a clear error.
 *
 *  Why duplicate the editor rather than import it from ScriptStepsList?
 *  The existing one is tied to ScriptStepsList's full-script render
 *  context and isn't exported. Lifting it out is a larger refactor;
 *  the local copy here is small enough to be self-contained. */
function InlineDialogueEditor({
  stepId,
  initialText,
  textFileOffset,
  sessionId,
}: {
  readonly stepId: string;
  readonly initialText: string;
  readonly textFileOffset: number | null;
  readonly sessionId: string | null;
}): JSX.Element {
  const scanCurrent = useProjectStore((s) => s.scanCurrentProject);
  const [text, setText] = useState(initialText);
  const [state, setState] = useState<
    | { kind: 'idle' }
    | { kind: 'saving' }
    | { kind: 'saved' }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' });

  useEffect(() => {
    setText(initialText);
    setState({ kind: 'idle' });
  }, [initialText, stepId]);

  const dirty = text !== initialText;
  const canSave = dirty && textFileOffset !== null && sessionId !== null;

  async function save(): Promise<void> {
    if (!sessionId || textFileOffset === null) return;
    setState({ kind: 'saving' });
    try {
      await editBinaryRomDialogueString(sessionId, {
        stringFileOffset: textFileOffset,
        newText: text,
      });
      setState({ kind: 'saved' });
      pushToast('success', 'Dialogue saved');
      await scanCurrent();
    } catch (e) {
      const message =
        e instanceof ProjectApiError
          ? `${e.code}: ${e.message}`
          : e instanceof Error
            ? e.message
            : String(e);
      setState({ kind: 'error', message });
      pushToast('error', `Dialogue save failed - ${message}`);
    }
  }

  const onKeyDown = useEditFormKeyboard({
    canSave,
    save,
    cancel: () => {
      setText(initialText);
      setState({ kind: 'idle' });
    },
    isSaving: state.kind === 'saving',
  });

  return (
    <section
      className="entity-inspector__refs"
      data-testid="script-step-inspector-dialogue-editor"
      style={{ marginTop: 12 }}
    >
      <h3 className="entity-inspector__refs-heading">Dialogue text</h3>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        rows={4}
        data-testid="script-step-inspector-dialogue-text"
        spellCheck={false}
        style={{
          width: '100%',
          padding: '6px 8px',
          background: 'rgba(0, 0, 0, 0.2)',
          border: '1px solid var(--color-border)',
          borderRadius: 3,
          color: 'var(--color-text)',
          font: 'inherit',
          fontSize: 13,
          lineHeight: 1.4,
          resize: 'vertical',
          minHeight: 70,
        }}
        placeholder="Dialogue text - Ctrl+Enter to save, Esc to revert"
      />
      <div style={{ display: 'flex', gap: 8, marginTop: 6, alignItems: 'center' }}>
        <button
          type="button"
          className="entity-inspector__save-btn"
          onClick={() => void save()}
          disabled={!canSave || state.kind === 'saving'}
          data-testid="script-step-inspector-dialogue-save"
          title={
            !sessionId
              ? 'Open a project to save edits.'
              : textFileOffset === null
                ? 'No file offset on this step - re-scan the project to enable saving.'
                : !dirty
                  ? 'Type new text to enable Save.'
                  : 'Write the new dialogue text to the ROM.'
          }
        >
          {state.kind === 'saving' ? 'Saving…' : 'Save'}
        </button>
        {state.kind === 'saved' && !dirty && (
          <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
            Saved · ROM patched
          </span>
        )}
        {state.kind === 'error' && (
          <span
            style={{ fontSize: 11, color: 'var(--color-error)' }}
            data-testid="script-step-inspector-dialogue-error"
          >
            {state.message}
          </span>
        )}
      </div>
      {textFileOffset === null && (
        <p
          style={{
            margin: '6px 0 0',
            fontSize: 11,
            color: 'var(--color-text-muted)',
          }}
        >
          This dialogue line has no file-offset metadata; the lifter
          didn't record where to write. Re-scan the project from a
          newer manifest format to enable saving.
        </p>
      )}
    </section>
  );
}
