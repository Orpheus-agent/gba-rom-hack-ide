import { useCallback, useEffect, useState } from 'react';
import {
  fetchUndoState,
  redoLastOp,
  undoLastOp,
  type UndoStateResponse,
} from '../api';
import { useProjectStore } from '../state';

const OP_HUMAN: Record<string, string> = {
  move_event: 'Move event',
  patch_event_fields: 'Edit event fields',
  edit_dialogue: 'Edit dialogue',
  replace_asset: 'Replace asset',
  import_asset: 'Import asset',
  stage_template: 'Stage template',
  patch_mechanic_config: 'Update mechanic config',
};

export function UndoRedoButtons() {
  const sessionId = useProjectStore((s) =>
    s.load.kind === 'loaded' ? s.load.data.session.id : null,
  );
  const rescan = useProjectStore((s) => s.scanCurrentProject);
  const [state, setState] = useState<UndoStateResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);

  const refresh = useCallback(async () => {
    if (!sessionId) {
      setState(null);
      return;
    }
    try {
      const r = await fetchUndoState(sessionId);
      setState(r);
    } catch {
      // Silent - undo button just gets disabled if state can't be loaded.
    }
  }, [sessionId]);

  useEffect(() => {
    void refresh();
  }, [refresh, tick]);

  const onUndo = useCallback(async () => {
    if (!sessionId || !state?.canUndo || busy) return;
    setBusy(true);
    try {
      await undoLastOp(sessionId);
      await rescan();
      setTick((t) => t + 1);
    } catch (e) {
       
      console.error('undo failed:', e);
    } finally {
      setBusy(false);
    }
  }, [sessionId, state?.canUndo, busy, rescan]);

  const onRedo = useCallback(async () => {
    if (!sessionId || !state?.canRedo || busy) return;
    setBusy(true);
    try {
      await redoLastOp(sessionId);
      await rescan();
      setTick((t) => t + 1);
    } catch (e) {
       
      console.error('redo failed:', e);
    } finally {
      setBusy(false);
    }
  }, [sessionId, state?.canRedo, busy, rescan]);

  // Global Ctrl+Z / Ctrl+Shift+Z (Cmd-Z on Mac) keyboard handler. Skipped
  // when focus is inside an input/textarea/select/contentEditable so the
  // browser's native field-level undo still works for typing.
  useEffect(() => {
    function isTypingTarget(t: EventTarget | null): boolean {
      if (!(t instanceof HTMLElement)) return false;
      const tag = t.tagName.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
      if (t.isContentEditable) return true;
      return false;
    }
    function onKey(e: KeyboardEvent) {
      const isMod = e.ctrlKey || e.metaKey;
      if (!isMod) return;
      if (e.key !== 'z' && e.key !== 'Z') return;
      if (isTypingTarget(e.target)) return;
      e.preventDefault();
      if (e.shiftKey) void onRedo();
      else void onUndo();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onUndo, onRedo]);

  const undoTitle = state?.canUndo && state.nextUndoOp
    ? `Undo: ${OP_HUMAN[state.nextUndoOp] ?? state.nextUndoOp} (Ctrl+Z)`
    : 'Nothing to undo';
  const redoTitle = state?.canRedo && state.nextRedoOp
    ? `Redo: ${OP_HUMAN[state.nextRedoOp] ?? state.nextRedoOp} (Ctrl+Shift+Z)`
    : 'Nothing to redo';

  return (
    <div className="undo-redo" data-testid="undo-redo-buttons">
      <button
        type="button"
        className="undo-redo__btn"
        onClick={() => void onUndo()}
        disabled={!sessionId || !state?.canUndo || busy}
        title={undoTitle}
        aria-label={undoTitle}
        data-testid="undo-btn"
      >
        ↶
      </button>
      <button
        type="button"
        className="undo-redo__btn"
        onClick={() => void onRedo()}
        disabled={!sessionId || !state?.canRedo || busy}
        title={redoTitle}
        aria-label={redoTitle}
        data-testid="redo-btn"
      >
        ↷
      </button>
    </div>
  );
}
