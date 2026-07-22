import { useCallback, useMemo, useState } from 'react';
import type { ProjectManifest, ScriptStep, ScriptStepKind } from '@rom-editor/shared';
import {
  pushToast,
  useProjectStore,
  useSelection,
  useViewStore,
} from '../../state';
import {
  categoryFor,
  commandMetadata,
  summarizeStep,
} from '../../lib/scriptCommands';
import { editBinaryRomScriptStep, ProjectApiError } from '../../api';
import { AddEventPopover } from './AddEventPopover';
import './VisualScriptEditor.css';

// Phase R / WP3 - Visual Script Editor card-list.
//
// Replaces the old `details > ol > li.script-steps__item` rendering
// with a GB Studio-style vertical card list. Each card is a single
// script step shown as a plain-English one-line summary, a category
// chip, and a coloured left border that maps the step to its
// category (text / flow / flags / etc.). Cards are click-targets:
// they call `useSelection.select({ kind: 'scriptStep', id })`, which
// opens the existing ScriptStepInspector in the right rail for the
// full per-kind editor.
//
// Goals:
//   - Plain English everywhere - no opcode bytes, no kind enums with
//     underscores. The user sees "Show dialogue - \"Welcome!\"",
//     "Mark \"Defeated Brock (Pewter)\" as done", "Give 5 × Poké Ball".
//   - Always expanded - no collapsed `<details>` hiding the script.
//   - Card-list ergonomics - left-border colour per category, hover
//     state, keyboard navigation, filter by category.
//   - Drop-in alternative to ScriptStepsList in the map editor's
//     script panel. ScriptStepsList stays in place as the back-up
//     surface until the visual editor reaches feature parity for
//     inline editing (WP3.4).
//
// Not in scope for this iteration:
//   - Add-step popover (WP3.4 - requires propose-script-edit MCP).
//   - Inline editing inside the cards (each card click jumps to the
//     ScriptStepInspector which already handles per-kind editing).
//   - Nested if/loop/multichoice indentation (engine emits flat steps
//     with branch metadata; threading is deferred to WP3.5).

interface VisualScriptEditorProps {
  readonly scriptId: string;
  readonly manifest: ProjectManifest;
}

export function VisualScriptEditor({
  scriptId,
  manifest,
}: VisualScriptEditorProps): JSX.Element {
  const select = useSelection((s) => s.select);
  const selectedRef = useSelection((s) => s.current);
  const sessionId = useProjectStore((s) =>
    s.load.kind === 'loaded' ? s.load.data.session.id : null,
  );
  const scanCurrent = useProjectStore((s) => s.scanCurrentProject);
  const bootFromHere = useViewStore((s) => s.bootFromHere);
  const [filter, setFilter] = useState<string>('all');

  // Decomp projects decode their scripts from source `.inc` files (read-only
  // here - structural edits go through the agent / a future decomp script-edit
  // route). The Add/Delete step controls drive `editBinaryRomScriptStep`, a
  // binary-ROM-only route, so they are hidden on decomp. Reading the script in
  // plain English still works for both paths.
  const isDecomp = !manifest.binaryRom;
  const canEditSteps = sessionId !== null && !isDecomp;

  // Phase 9G - Resolve the script's owning map by scanning the
  // manifest's objectEvents for one whose `scriptId` references this
  // script. Falls back to the empty string when no event references
  // the script (the SceneBootPicker then asks the user to pick a
  // map manually). Memoised so the scan runs once per scriptId
  // change, not per render.
  const owningMapId = useMemo<string>(() => {
    if (!Array.isArray(manifest.objectEvents)) return '';
    for (const event of manifest.objectEvents) {
      if (event.scriptId === scriptId) {
        return event.mapId ?? '';
      }
    }
    return '';
  }, [manifest.objectEvents, scriptId]);

  /** Phase 9G - handler the card renders behind its ▶ button. */
  const handleBootFromStep = useCallback(
    (step: ScriptStep, stepIndex: number) => {
      if (!owningMapId) {
        pushToast(
          'info',
          'Boot from here: no map references this script. Pick a map in the picker.',
        );
        bootFromHere({
          startingMapId: '',
          startingPosition: null,
          suggestedName: `Run ${scriptId} from step ${String(stepIndex + 1)}`,
          suggestedNotes: `Boot point: ${scriptId} step #${String(stepIndex + 1)} (${step.kind}).`,
        });
        return;
      }
      bootFromHere({
        startingMapId: owningMapId,
        startingPosition: null,
        suggestedName: `Run ${scriptId} from step ${String(stepIndex + 1)}`,
        suggestedNotes: `Boot point: ${scriptId} step #${String(stepIndex + 1)} (${step.kind}). Map: ${owningMapId}.`,
      });
    },
    [bootFromHere, owningMapId, scriptId],
  );
  // WP-A4 - Add Event popover state. `addAtIndex` is the position
  // where a new step would be inserted (0 = prepend, length = append,
  // i = between (i-1)th and i-th existing cards). `null` = popover
  // closed. `busy` is true while the API call is in flight; we disable
  // every + button so the user doesn't double-trigger.
  const [addAtIndex, setAddAtIndex] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const handleAddStep = async (kind: ScriptStepKind, insertAt: number): Promise<void> => {
    if (!sessionId) {
      pushToast('error', 'Open a project to add script steps.');
      return;
    }
    setBusy(true);
    try {
      // Build a minimal default step for the chosen kind. The script
      // encoder fills in required engine defaults; the user edits the
      // step's params via the ScriptStepInspector after insertion.
      const newStep = defaultStepFor(kind);
      await editBinaryRomScriptStep(sessionId, {
        scriptId,
        op: 'insertStep',
        stepIndex: insertAt,
        newStep,
        description: `Add ${kind} step at index ${String(insertAt)}`,
      });
      // WP-C stale-while-revalidate - the rescan keeps the editor
      // mounted (it doesn't unmount + remount the way it used to), so
      // the toast can be plain "Step added" without warning the user
      // about a re-index. The status bar shows a subtle "syncing" pip.
      pushToast('success', 'Step added');
      setAddAtIndex(null);
      await scanCurrent();
    } catch (e) {
      const msg =
        e instanceof ProjectApiError
          ? `${e.code}: ${e.message}`
          : e instanceof Error
            ? e.message
            : String(e);
      pushToast('error', `Add step failed - ${msg}`);
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteStep = async (stepIndex: number): Promise<void> => {
    if (!sessionId) {
      pushToast('error', 'Open a project to delete script steps.');
      return;
    }
    if (
      typeof window !== 'undefined' &&
      !window.confirm(`Delete step #${String(stepIndex + 1)} from this script?`)
    ) {
      return;
    }
    setBusy(true);
    try {
      await editBinaryRomScriptStep(sessionId, {
        scriptId,
        op: 'deleteStep',
        stepIndex,
        description: `Delete step at index ${String(stepIndex)}`,
      });
      pushToast('success', 'Step deleted');
      await scanCurrent();
    } catch (e) {
      const msg =
        e instanceof ProjectApiError
          ? `${e.code}: ${e.message}`
          : e instanceof Error
            ? e.message
            : String(e);
      pushToast('error', `Delete step failed - ${msg}`);
    } finally {
      setBusy(false);
    }
  };

  // Pull every step belonging to this scriptId. The decoder names them
  // `${scriptId}__${index}` so a prefix match + numeric sort is the
  // right order.
  const allSteps = useMemo<ReadonlyArray<ScriptStep>>(() => {
    // `scriptId` is normally a script *label* (object events store the label
    // directly). Triggers, however, pass `scriptStepIds[0]` - a full step id
    // `<label>__<n>`. Strip a trailing `__<digits>` so both resolve to the
    // same label prefix. The `__` separator never appears in real symbols, so
    // this is unambiguous.
    const scriptLabel = scriptId.replace(/__\d+$/, '');
    const prefix = `${scriptLabel}__`;
    const matches = manifest.scriptSteps.filter((s) => s.id.startsWith(prefix));
    matches.sort((a, b) => {
      const ai = parseInt(a.id.slice(prefix.length), 10);
      const bi = parseInt(b.id.slice(prefix.length), 10);
      return ai - bi;
    });
    return matches;
  }, [scriptId, manifest.scriptSteps]);

  const visible = useMemo<ReadonlyArray<ScriptStep>>(() => {
    if (filter === 'all') return allSteps;
    if (filter === 'meaningful') return allSteps.filter((s) => s.kind !== 'raw');
    return allSteps.filter((s) => categoryFor(s.kind).id === filter);
  }, [allSteps, filter]);

  const meaningfulCount = useMemo(
    () => allSteps.filter((s) => s.kind !== 'raw').length,
    [allSteps],
  );
  const rawCount = allSteps.length - meaningfulCount;

  if (allSteps.length === 0) {
    return (
      <div className="visual-script visual-script--empty" data-testid="visual-script-empty">
        <p className="visual-script__empty-text">
          No decoded steps for this script yet. Re-scan the project to try again,
          or this script may live in raw bytecode that the decoder hasn't been
          taught to read.
        </p>
      </div>
    );
  }

  return (
    <section className="visual-script" data-testid="visual-script">
      <header className="visual-script__header">
        <h3 className="visual-script__title">
          What this script does
        </h3>
        <div className="visual-script__stats">
          <span data-testid="visual-script-action-count">
            {String(meaningfulCount)} action{meaningfulCount === 1 ? '' : 's'}
          </span>
          {rawCount > 0 && (
            <span
              className="visual-script__internal-count"
              title="Engine-internal opcodes the decoder didn't categorize. Toggle the 'Engine commands' filter to inspect them."
              data-testid="visual-script-internal-count"
            >
              · {String(rawCount)} engine command{rawCount === 1 ? '' : 's'}
            </span>
          )}
        </div>
        <select
          className="visual-script__filter"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label="Filter steps by category"
          data-testid="visual-script-filter"
        >
          <option value="all">Show everything</option>
          <option value="meaningful">Hide engine commands</option>
          <option value="text">Only text & dialogue</option>
          <option value="flags_vars">Only story state</option>
          <option value="battle">Only battles</option>
          <option value="movement">Only movement & warps</option>
          <option value="inventory">Only items</option>
          <option value="advanced">Only engine commands</option>
        </select>
      </header>
      <ol className="visual-script__list" data-testid="visual-script-list">
        {/* WP-A4 - Prepend "+ Add step" gap. Inserts at index 0. */}
        {canEditSteps && (
          <AddStepGap
            insertAt={0}
            disabled={busy}
            isOpen={addAtIndex === 0}
            onToggle={() => setAddAtIndex(addAtIndex === 0 ? null : 0)}
            onPick={(kind) => void handleAddStep(kind, 0)}
          />
        )}
        {visible.map((step, idx) => {
          // Use the actual step's index in the full step list (not the
          // filter-visible index) for backend ops.
          const fullIndex = allSteps.findIndex((s) => s.id === step.id);
          return (
            <ScriptCardWithGap
              key={step.id}
              step={step}
              index={idx}
              fullIndex={fullIndex}
              manifest={manifest}
              selected={selectedRef?.kind === 'scriptStep' && selectedRef.id === step.id}
              onSelect={() => select({ kind: 'scriptStep', id: step.id })}
              onDelete={canEditSteps ? () => void handleDeleteStep(fullIndex) : undefined}
              canEdit={canEditSteps}
              // Phase 9G - Boot-from-here button on every card.
              onBootFromHere={() => handleBootFromStep(step, fullIndex)}
              // Gap after this card. Index in the full list.
              showGapAfter={canEditSteps}
              gapIsOpen={addAtIndex === fullIndex + 1}
              gapDisabled={busy}
              onGapToggle={() =>
                setAddAtIndex(addAtIndex === fullIndex + 1 ? null : fullIndex + 1)
              }
              onGapPick={(kind) => void handleAddStep(kind, fullIndex + 1)}
            />
          );
        })}
      </ol>
    </section>
  );
}

interface ScriptCardWithGapProps extends ScriptCardProps {
  readonly fullIndex: number;
  readonly showGapAfter: boolean;
  readonly gapIsOpen: boolean;
  readonly gapDisabled: boolean;
  readonly onGapToggle: () => void;
  readonly onGapPick: (kind: ScriptStepKind) => void;
}

function ScriptCardWithGap({
  step,
  index,
  manifest,
  selected,
  onSelect,
  onDelete,
  canEdit,
  onBootFromHere,
  showGapAfter,
  gapIsOpen,
  gapDisabled,
  onGapToggle,
  onGapPick,
}: ScriptCardWithGapProps): JSX.Element {
  return (
    <>
      <ScriptCard
        step={step}
        index={index}
        manifest={manifest}
        selected={selected}
        onSelect={onSelect}
        onDelete={onDelete}
        canEdit={canEdit}
        onBootFromHere={onBootFromHere}
      />
      {showGapAfter && (
        <AddStepGap
          insertAt={index + 1}
          disabled={gapDisabled}
          isOpen={gapIsOpen}
          onToggle={onGapToggle}
          onPick={onGapPick}
        />
      )}
    </>
  );
}

interface AddStepGapProps {
  readonly insertAt: number;
  readonly disabled: boolean;
  readonly isOpen: boolean;
  readonly onToggle: () => void;
  readonly onPick: (kind: ScriptStepKind) => void;
}

function AddStepGap({
  insertAt,
  disabled,
  isOpen,
  onToggle,
  onPick,
}: AddStepGapProps): JSX.Element {
  return (
    <li className="visual-script__add-gap" data-testid={`visual-script-add-gap-${insertAt}`}>
      <button
        type="button"
        className="visual-script__add-btn"
        disabled={disabled}
        onClick={onToggle}
        title={`Insert a step at position ${String(insertAt + 1)}`}
        data-testid={`visual-script-add-btn-${insertAt}`}
      >
        + Add step
      </button>
      {isOpen && (
        <div className="visual-script__add-popover-wrap">
          <AddEventPopover
            onPick={(kind) => onPick(kind)}
            onClose={onToggle}
          />
        </div>
      )}
    </li>
  );
}

/** Build a sensible default ScriptStep for a kind, with placeholder
 *  params the encoder accepts. The user can refine the params after
 *  insertion via the ScriptStepInspector. Defaults are chosen to
 *  minimize "this step does nothing visible" surprises. */
function defaultStepFor(kind: ScriptStepKind): {
  readonly kind: ScriptStepKind;
  readonly params: Readonly<Record<string, unknown>>;
} {
  switch (kind) {
    case 'dialogue':
      // Fresh text needs an allocator. Default to a one-line message
      // the user will replace. dialogueDirty forces fresh allocation.
      return {
        kind: 'dialogue',
        params: { dialogueText: 'Hello!', stdType: 4, dialogueDirty: true },
      };
    case 'set_flag':
      return { kind: 'set_flag', params: { flagId: 0x800, opcodeName: 'setflag' } };
    case 'clear_flag':
      return { kind: 'clear_flag', params: { flagId: 0x800, opcodeName: 'clearflag' } };
    case 'set_variable':
      return {
        kind: 'set_variable',
        params: { opcodeName: 'setvar', varId: 0x4000, value: 0 },
      };
    case 'branch':
      // Default to compare-and-end; user will customise.
      return { kind: 'branch', params: { opcodeName: 'compare', varId: 0x4000, value: 0 } };
    case 'branch_on_var':
      // Phase 2B - Resonance Alignment-shaped default: "If VAR_RA_EMO_LOG ≥
      // 3 → 0x08000000" (user re-targets in the inspector).
      return {
        kind: 'branch_on_var',
        params: {
          varId: 0x40d0,
          value: 1,
          operator: 'greaterorequal',
          targetRomPtr: 0x08000000,
        },
      };
    case 'give_item':
      return {
        kind: 'give_item',
        params: { opcodeName: 'giveitem', itemId: 0x0d, quantity: 1, callbackType: 0 },
      };
    case 'start_battle':
      return {
        kind: 'start_battle',
        params: { battleType: 0, trainerId: 0, trainerbattleRemainder: new Array(12).fill(0) },
      };
    case 'play_sound':
      return { kind: 'play_sound', params: { opcodeName: 'playse', songId: 0 } };
    case 'move_npc':
      return {
        kind: 'move_npc',
        params: { opcodeName: 'waitmovement', objectId: 0 },
      };
    case 'fade_scene':
      return { kind: 'fade_scene', params: { opcodeName: 'fadescreen', fadeType: 1 } };
    case 'warp_player':
      return {
        kind: 'warp_player',
        params: {
          opcodeName: 'warp',
          destMapBank: 0,
          destMapNum: 0,
          warpId: 0,
          x: 0,
          y: 0,
        },
      };
    case 'randomize_branch':
      return { kind: 'randomize_branch', params: { range: 2 } };
    case 'raw':
      // Default to lock - a 1-byte safe opcode the user can replace.
      return { kind: 'raw', params: { opcode: 0x6a } };
  }
}

interface ScriptCardProps {
  readonly step: ScriptStep;
  readonly index: number;
  readonly manifest: ProjectManifest;
  readonly selected: boolean;
  readonly onSelect: () => void;
  readonly onDelete?: () => void;
  readonly canEdit: boolean;
  /** Phase 9G - when present, renders a "Boot to this step" button
   *  on the card that opens the SceneBootPicker pre-filled with the
   *  step's owning map + a friendly recipe name. */
  readonly onBootFromHere?: () => void;
}

/** One card in the visual scripter. Plain-English summary, category
 *  chip, click-to-open in the inspector. */
function ScriptCard({
  step,
  index,
  manifest,
  selected,
  onSelect,
  onDelete,
  canEdit,
  onBootFromHere,
}: ScriptCardProps): JSX.Element {
  const meta = commandMetadata(step.kind);
  const category = categoryFor(step.kind);
  const summary = summarizeStep(step, manifest);

  return (
    <li
      className={`visual-script__card visual-script__card--${meta.category}${
        selected ? ' visual-script__card--selected' : ''
      }`}
      style={{ borderLeftColor: category.color }}
      data-testid={`visual-script-card-${step.id}`}
      data-kind={step.kind}
      data-category={meta.category}
    >
      <button
        type="button"
        className="visual-script__card-button"
        onClick={onSelect}
        title={`${category.label} - click to edit in the inspector`}
        data-testid={`visual-script-card-button-${step.id}`}
      >
        <span className="visual-script__card-index" aria-hidden="true">
          {String(index + 1)}
        </span>
        <span className="visual-script__card-icon" aria-hidden="true">
          {meta.icon}
        </span>
        <span className="visual-script__card-summary" data-testid={`visual-script-card-summary-${step.id}`}>
          {summary}
        </span>
        <span
          className="visual-script__card-category"
          style={{ color: category.color }}
        >
          {category.label}
        </span>
      </button>
      {/* Phase 9G - Boot to this step. Renders a small ▶ button on
          the card; clicking opens the SceneBootPicker in the live-
          preview view, pre-filled with the step's owning map + a
          suggested recipe name. The action is non-destructive (it
          only sets editor view state - no ROM writes). */}
      {onBootFromHere && (
        <button
          type="button"
          className="visual-script__card-boot"
          onClick={(e) => {
            e.stopPropagation();
            onBootFromHere();
          }}
          title="Boot the emulator to this step (opens SceneBootPicker pre-filled)"
          data-testid={`visual-script-card-boot-${step.id}`}
          aria-label="Boot to this step"
        >
          ▶
        </button>
      )}
      {canEdit && onDelete && (
        <button
          type="button"
          className="visual-script__card-delete"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          title="Delete this step"
          data-testid={`visual-script-card-delete-${step.id}`}
          aria-label="Delete step"
        >
          ×
        </button>
      )}
    </li>
  );
}
