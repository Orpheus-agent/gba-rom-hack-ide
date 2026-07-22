import { useState } from 'react';
import {
  useProjectStore,
  useSelection,
  useUiPreferencesStore,
  type EntityKind,
} from '../state';
import { displayName } from '../lib/displayName';
import { getInspectorPanels } from '../lib/inspectorRegistry';
import {
  lookupAnnotation,
  lookupAnnotationDescription,
  useAnnotationsStore,
} from '../lib/annotations';
import './InspectorDock.css';

// Phase P.2 - Right-rail Inspector dock. Subscribes to the global
// useSelection store and renders a kind-aware placeholder for the
// currently-selected entity. Phase P.3 plugs in the actual inspector
// registry (extracted from MapEditor's right-aside pattern) so each
// EntityKind dispatches to a real editor component. Until then this
// dock simply makes the selection visible so the rest of the workspace
// can be wired to call `useSelection.select(...)` without waiting on
// the full inspector implementation.

const KIND_LABELS: Record<EntityKind, string> = {
  map: 'Map',
  warp: 'Warp',
  trigger: 'Trigger',
  objectEvent: 'NPC / object event',
  sign: 'Sign',
  door: 'Door',
  healLocation: 'Heal location',
  tile: 'Tile',
  connection: 'Map connection',
  species: 'Pokémon',
  move: 'Move',
  ability: 'Ability',
  type: 'Type',
  item: 'Item',
  trainer: 'Trainer',
  trainerClass: 'Trainer class',
  flag: 'Flag',
  variable: 'Variable',
  script: 'Script',
  scriptStep: 'Script step',
  dialogue: 'Dialogue',
  multichoice: 'Multichoice menu',
  choice: 'Choice option',
  tileset: 'Tileset',
  palette: 'Palette',
  asset: 'Asset',
  sprite: 'Sprite',
  song: 'Music track',
  encounterTable: 'Encounter table',
  encounterSlot: 'Encounter slot',
  pokedexEntry: 'Pokédex entry',
  region: 'Region',
  structure: 'Structure',
  cutscene: 'Cutscene',
};

export function InspectorDock() {
  const current = useSelection((s) => s.current);
  const clearSelection = useSelection((s) => s.clear);
  const projectLoad = useProjectStore((s) => s.load);
  const manifest = useProjectStore((s) =>
    s.scan.kind === 'loaded' ? s.scan.data.manifest : null,
  );
  const showInternalIds = useUiPreferencesStore((s) => s.showInternalIds);
  // Phase Q.6 - subscribe to the annotations map so any user rename
  // re-renders the dock (and re-runs displayName, which reads from
  // lookupAnnotation under the hood).
  useAnnotationsStore((s) => s.map);

  if (!current) {
    return (
      <aside
        className="inspector-dock inspector-dock--empty"
        data-testid="inspector-dock"
        aria-label="Inspector"
      >
        <div className="inspector-dock__empty">
          <p className="inspector-dock__empty-title">Nothing selected</p>
          <p className="inspector-dock__empty-hint">
            Click an NPC, warp, Pokémon, trainer, tile, flag, item - anywhere in the workspace - 
            and its editor will open here.
          </p>
          <InspectorDockRecentHistory />
        </div>
      </aside>
    );
  }

  // Phase Q.6 - user-set annotation wins regardless of manifest. If no
  // annotation, fall back to displayName (manifest-aware) or the raw id.
  const userName = lookupAnnotation(current.kind, current.id);
  const semanticName = userName
    ? userName
    : manifest
      ? displayName(manifest, current.id, showInternalIds)
      : current.id;
  const contextLabel = manifest && current.mapContext
    ? displayName(manifest, current.mapContext, showInternalIds)
    : current.mapContext ?? null;

  const sessionId = projectLoad.kind === 'loaded' ? projectLoad.data.session.id : null;
  const panels = getInspectorPanels(current.kind);

  return (
    <aside
      className="inspector-dock"
      data-testid="inspector-dock"
      data-selection-kind={current.kind}
      data-selection-id={current.id}
      aria-label="Inspector"
    >
      <InspectorDockBackButton />
      <header className="inspector-dock__header">
        <button
          type="button"
          className="inspector-dock__close"
          onClick={() => clearSelection()}
          title="Close the inspector (Esc)"
          aria-label="Close inspector"
          data-testid="inspector-dock-close"
        >
          ✕
        </button>
        <span className="inspector-dock__kind-chip" data-testid="inspector-dock-kind">
          {KIND_LABELS[current.kind] ?? current.kind}
        </span>
        <InspectorTitleWithRename
          kind={current.kind}
          id={current.id}
          name={semanticName}
        />
        {contextLabel && (
          <span className="inspector-dock__context" data-testid="inspector-dock-mapContext">
            in {contextLabel}
          </span>
        )}
      </header>
      <div className="inspector-dock__body">
        {/* User-authored prose context for this entity. Always available
            for every entity kind - flag, NPC, script, tile, anything - 
            so the user can leave themselves notes ("Brock-defeat flag",
            "rival's gym scene", "ledge to skip Route 1 grass"). Persists
            via annotations.ts and is read back wherever this entity is
            referenced. */}
        <DescriptionAffordance kind={current.kind} id={current.id} />
        {panels.length === 0 ? (
          <p
            className="inspector-dock__placeholder"
            data-testid="inspector-dock-placeholder"
          >
            No detail editor exists yet for <strong>{KIND_LABELS[current.kind]}</strong>.
            You can still rename it (pencil icon) and attach a description above so the rest
            of the workspace shows your friendly name.
          </p>
        ) : (
          panels.map((reg, idx) => (
            <section
              key={`${reg.kind}-${reg.slot}-${idx}`}
              className={`inspector-dock__panel inspector-dock__panel--${reg.slot}`}
              data-testid={`inspector-dock-panel-${reg.kind}-${reg.slot}`}
              data-slot={reg.slot}
            >
              <reg.component
                selection={current}
                manifest={manifest}
                sessionId={sessionId}
                mapContext={current.mapContext}
              />
            </section>
          ))
        )}
      </div>
    </aside>
  );
}

/** Always-present prose-notes editor at the top of the inspector body.
 *  Click "Add a note" to expand into a textarea; save/cancel via the
 *  buttons. Persists to the annotations store (description field) and is
 *  read back by anyone who looks the entity up via
 *  `lookupAnnotationDescription`. The author writes it once; every
 *  inspector that references the entity surfaces the note inline. */
function DescriptionAffordance({ kind, id }: { kind: EntityKind; id: string }) {
  // Subscribe to the annotations map so writes anywhere in the app
  // re-render us. The lookup helper reads the current state.
  useAnnotationsStore((s) => s.map);
  const setAnnotationDescription = useAnnotationsStore(
    (s) => s.setAnnotationDescription,
  );
  const currentDescription = lookupAnnotationDescription(kind, id);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  const startEdit = () => {
    setDraft(currentDescription ?? '');
    setEditing(true);
  };
  const save = () => {
    setAnnotationDescription(kind, id, draft);
    setEditing(false);
  };
  const cancel = () => {
    setEditing(false);
  };
  const clearNote = () => {
    setAnnotationDescription(kind, id, '');
    setEditing(false);
  };

  if (editing) {
    return (
      <div className="inspector-dock__description-editor" data-testid="inspector-dock-description-editor">
        <label
          className="inspector-dock__description-label"
          htmlFor="inspector-dock-description-textarea"
        >
          Notes
        </label>
        <textarea
          id="inspector-dock-description-textarea"
          className="inspector-dock__description-textarea"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Ctrl/Cmd+Enter to save (Enter alone is a newline in textareas).
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
              e.preventDefault();
              save();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              cancel();
            }
          }}
          rows={4}
          autoFocus
          placeholder="Why is this important? When does it fire? What does it connect to?"
          data-testid="inspector-dock-description-input"
        />
        <div className="inspector-dock__description-actions">
          <button
            type="button"
            className="inspector-dock__description-save"
            onClick={save}
            data-testid="inspector-dock-description-save"
          >
            Save note
          </button>
          <button
            type="button"
            className="inspector-dock__description-cancel"
            onClick={cancel}
            data-testid="inspector-dock-description-cancel"
          >
            Cancel
          </button>
          {currentDescription && (
            <button
              type="button"
              className="inspector-dock__description-clear"
              onClick={clearNote}
              data-testid="inspector-dock-description-clear"
              title="Remove your note (this entity reverts to auto-resolved data only)"
            >
              Remove
            </button>
          )}
        </div>
      </div>
    );
  }

  if (currentDescription) {
    return (
      <div className="inspector-dock__description-display" data-testid="inspector-dock-description-display">
        <div className="inspector-dock__description-heading">
          <span className="inspector-dock__description-icon" aria-hidden="true">
            📝
          </span>
          <span className="inspector-dock__description-title">Your note</span>
          <button
            type="button"
            className="inspector-dock__description-edit-btn"
            onClick={startEdit}
            data-testid="inspector-dock-description-edit-btn"
            title="Edit this note"
          >
            edit
          </button>
        </div>
        <p
          className="inspector-dock__description-text"
          data-testid="inspector-dock-description-text"
        >
          {currentDescription}
        </p>
      </div>
    );
  }

  return (
    <button
      type="button"
      className="inspector-dock__description-empty"
      onClick={startEdit}
      data-testid="inspector-dock-description-empty"
      title="Add a freeform note. Shown anywhere this entity is referenced."
    >
      + Add a note about this {KIND_LABELS[kind].toLowerCase()}
    </button>
  );
}

// "← Back" affordance - when the user has a history of selections,
// show a button that re-selects the most recent prior entity. Mirrors
// the browser back button for the workspace dock. Click cycles through
// history one step at a time.
function InspectorDockBackButton() {
  const history = useSelection((s) => s.history);
  const select = useSelection((s) => s.select);
  const manifest = useProjectStore((s) =>
    s.scan.kind === 'loaded' ? s.scan.data.manifest : null,
  );
  const showInternalIds = useUiPreferencesStore((s) => s.showInternalIds);
  if (history.length === 0) return null;
  const prev = history[0]!;
  const label = manifest
    ? displayName(manifest, prev.id, showInternalIds)
    : prev.id;
  return (
    <div className="inspector-dock__back-row" data-testid="inspector-dock-back-row">
      <button
        type="button"
        className="inspector-dock__back-btn"
        data-testid="inspector-dock-back-btn"
        onClick={() => select(prev)}
        title={`Back to ${label}`}
      >
        ← {label}
      </button>
    </div>
  );
}

// Recent selection history surface shown in the empty state. Lets
// users jump back to anything they've inspected in this session
// without re-finding it through the Command Palette.
function InspectorDockRecentHistory() {
  const history = useSelection((s) => s.history);
  const select = useSelection((s) => s.select);
  const manifest = useProjectStore((s) =>
    s.scan.kind === 'loaded' ? s.scan.data.manifest : null,
  );
  const showInternalIds = useUiPreferencesStore((s) => s.showInternalIds);
  if (history.length === 0) return null;
  return (
    <div className="inspector-dock__recent" data-testid="inspector-dock-recent">
      <p className="inspector-dock__recent-heading">Recent</p>
      <ul className="inspector-dock__recent-list">
        {history.slice(0, 8).map((ref, i) => {
          const label = manifest
            ? displayName(manifest, ref.id, showInternalIds)
            : ref.id;
          return (
            <li key={`${ref.kind}-${ref.id}-${i}`}>
              <button
                type="button"
                className="inspector-dock__recent-btn"
                data-testid={`inspector-dock-recent-${i}`}
                onClick={() => select(ref)}
                title={`${ref.kind}: ${ref.id}`}
              >
                <span className="inspector-dock__recent-kind">{ref.kind}</span>
                <span className="inspector-dock__recent-label">{label}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// Phase Q.6 - Inline rename UI. Pencil icon next to the title; click
// flips into an input box. Save persists to the annotations store, and
// the next render picks up the new name via lookupAnnotation inside
// displayName. Esc cancels, Enter saves.
function InspectorTitleWithRename({
  kind,
  id,
  name,
}: {
  kind: EntityKind;
  id: string;
  name: string;
}) {
  const setAnnotation = useAnnotationsStore((s) => s.setAnnotation);
  const clearAnnotation = useAnnotationsStore((s) => s.clearAnnotation);
  const currentAnnotation = useAnnotationsStore((s) =>
    s.getAnnotation(kind, id),
  );
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);

  const startEdit = () => {
    setDraft(currentAnnotation ?? name);
    setEditing(true);
  };
  const save = () => {
    setAnnotation(kind, id, draft);
    setEditing(false);
  };
  const cancel = () => setEditing(false);
  const reset = () => {
    clearAnnotation(kind, id);
    setEditing(false);
  };

  if (editing) {
    return (
      <div className="inspector-dock__rename-row">
        <input
          type="text"
          className="inspector-dock__rename-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              save();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              cancel();
            }
          }}
          autoFocus
          data-testid="inspector-dock-rename-input"
          placeholder="Custom name…"
        />
        <button
          type="button"
          className="inspector-dock__rename-action"
          onClick={save}
          data-testid="inspector-dock-rename-save"
          title="Save (Enter)"
        >
          ✓
        </button>
        <button
          type="button"
          className="inspector-dock__rename-action inspector-dock__rename-action--cancel"
          onClick={cancel}
          data-testid="inspector-dock-rename-cancel"
          title="Cancel (Esc)"
        >
          ✕
        </button>
        {currentAnnotation && (
          <button
            type="button"
            className="inspector-dock__rename-reset"
            onClick={reset}
            data-testid="inspector-dock-rename-reset"
            title="Use auto-resolved name"
          >
            reset
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="inspector-dock__title-row">
      <h2 className="inspector-dock__title" data-testid="inspector-dock-title">
        {name}
        {currentAnnotation && (
          <span
            className="inspector-dock__custom-tag"
            title="Custom name set by you - click pencil to edit, or use reset."
            data-testid="inspector-dock-custom-tag"
          >
            custom
          </span>
        )}
      </h2>
      <button
        type="button"
        className="inspector-dock__rename-btn"
        onClick={startEdit}
        data-testid="inspector-dock-rename-btn"
        title="Rename this entity"
        aria-label="Rename"
      >
        ✎
      </button>
    </div>
  );
}
