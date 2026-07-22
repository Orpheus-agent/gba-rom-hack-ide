/**
 * Phase 4.1A - Named save-state library.
 *
 * Replaces the previous "Slot 1 / 2 / 3" debug toolbar with an
 * unlimited, named, persistent library. The component:
 *
 *   - Lists every save state for the current project (newest-first).
 *   - "Capture state" button → asks the emulator for its current
 *     savestate bytes via mGBA's forceAutoSaveState + getAutoSaveState,
 *     prompts the user for a name + optional note, POSTs to the backend.
 *   - Each row has Load / Rename / Delete affordances.
 *   - Loading a state marks it as `lastLoaded` on the server so the UI
 *     can show "where you were last."
 *
 * The bytes shuttle is one-directional in each operation - we never
 * cache savestate bytes client-side. The mGBA serialize format is the
 * source of truth.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  ProjectApiError,
  createSaveState,
  deleteSaveState,
  fetchSaveStateBytes,
  listSaveStates,
  updateSaveState,
} from '../../api';
import type { SaveStateRecord } from '@rom-editor/shared';
import './SaveStateLibrary.css';

/** Minimal interface we need from the mGBA-WASM Module to capture +
 *  restore states. The real EmulatorHost passes its `moduleRef.current`
 *  through (same shape as EmulatorMemoryHost). */
export interface SaveStateEmulatorHost {
  forceAutoSaveState?: () => boolean;
  getAutoSaveState?: () => { autoSaveStateName: string; data: Uint8Array } | null;
  uploadAutoSaveState?: (name: string, data: Uint8Array) => Promise<void>;
  loadAutoSaveState?: () => boolean;
  pauseGame?: () => void;
  resumeGame?: () => void;
}

interface SaveStateLibraryProps {
  readonly sessionId: string | null;
  readonly host: SaveStateEmulatorHost | null;
  /** True while the emulator is in 'running' or 'paused' state. We
   *  disable Capture / Load when the emulator is idle. */
  readonly emulatorActive: boolean;
}

interface LibraryState {
  readonly states: ReadonlyArray<SaveStateRecord>;
  readonly loading: boolean;
  readonly error: string | null;
}

/** Capture the running mGBA's WRAM/IO/VRAM as a Uint8Array savestate.
 *  Returns null when the emulator binding doesn't expose the savestate
 *  APIs (older mGBA-WASM builds). The forceAutoSaveState call updates
 *  the in-memory snapshot; getAutoSaveState reads it out. */
function captureSaveStateBytes(host: SaveStateEmulatorHost): Uint8Array | null {
  if (typeof host.forceAutoSaveState !== 'function') return null;
  if (typeof host.getAutoSaveState !== 'function') return null;
  const ok = host.forceAutoSaveState();
  if (!ok) return null;
  const state = host.getAutoSaveState();
  if (!state || !state.data || state.data.byteLength === 0) return null;
  // Defensive copy - the underlying buffer may be reused by the next
  // forceAutoSaveState call.
  return new Uint8Array(state.data);
}

async function restoreSaveStateBytes(
  host: SaveStateEmulatorHost,
  bytes: Uint8Array,
): Promise<boolean> {
  if (typeof host.uploadAutoSaveState !== 'function') return false;
  if (typeof host.loadAutoSaveState !== 'function') return false;
  await host.uploadAutoSaveState('library-load.ss', bytes);
  return host.loadAutoSaveState();
}

export function SaveStateLibrary({
  sessionId,
  host,
  emulatorActive,
}: SaveStateLibraryProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [lib, setLib] = useState<LibraryState>({
    states: [],
    loading: false,
    error: null,
  });
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!sessionId) return;
    setLib((s) => ({ ...s, loading: true, error: null }));
    try {
      const states = await listSaveStates(sessionId);
      setLib({ states, loading: false, error: null });
    } catch (e) {
      const message =
        e instanceof ProjectApiError
          ? `${e.code}: ${e.message}`
          : e instanceof Error
            ? e.message
            : String(e);
      setLib({ states: [], loading: false, error: message });
    }
  }, [sessionId]);

  useEffect(() => {
    if (open && sessionId) {
      void refresh();
    }
  }, [open, sessionId, refresh]);

  const handleCapture = useCallback(async () => {
    if (!sessionId || !host) return;
    const bytes = captureSaveStateBytes(host);
    if (!bytes) {
      setLib((s) => ({ ...s, error: 'This emulator build does not support save state capture.' }));
      return;
    }
    const name = window.prompt('Name this save state', `state-${new Date().toISOString().slice(11, 19)}`);
    if (!name || name.trim().length === 0) return;
    const notes = window.prompt('Optional note (leave blank for none)', '');
    setBusy('capture');
    try {
      await createSaveState(sessionId, { name: name.trim(), notes: notes ?? null, bytes });
      await refresh();
    } catch (e) {
      const message =
        e instanceof ProjectApiError
          ? `${e.code}: ${e.message}`
          : e instanceof Error
            ? e.message
            : String(e);
      setLib((s) => ({ ...s, error: message }));
    } finally {
      setBusy(null);
    }
  }, [sessionId, host, refresh]);

  const handleLoad = useCallback(
    async (state: SaveStateRecord) => {
      if (!sessionId || !host) return;
      setBusy(`load-${state.id}`);
      try {
        // Pause while patching the savestate to avoid a frame-mid-load race.
        if (typeof host.pauseGame === 'function') host.pauseGame();
        const bytes = await fetchSaveStateBytes(sessionId, state.id);
        const ok = await restoreSaveStateBytes(host, bytes);
        if (typeof host.resumeGame === 'function') host.resumeGame();
        if (!ok) {
          setLib((s) => ({ ...s, error: 'mGBA rejected the save state (incompatible ROM?).' }));
          return;
        }
        await updateSaveState(sessionId, state.id, { markLastLoaded: true });
        await refresh();
      } catch (e) {
        const message =
          e instanceof ProjectApiError
            ? `${e.code}: ${e.message}`
            : e instanceof Error
              ? e.message
              : String(e);
        setLib((s) => ({ ...s, error: message }));
      } finally {
        setBusy(null);
      }
    },
    [sessionId, host, refresh],
  );

  const handleRename = useCallback(
    async (state: SaveStateRecord) => {
      if (!sessionId) return;
      const next = window.prompt('Rename save state', state.name);
      if (!next || next.trim().length === 0 || next.trim() === state.name) return;
      setBusy(`rename-${state.id}`);
      try {
        await updateSaveState(sessionId, state.id, { name: next.trim() });
        await refresh();
      } catch (e) {
        const message =
          e instanceof ProjectApiError
            ? `${e.code}: ${e.message}`
            : e instanceof Error
              ? e.message
              : String(e);
        setLib((s) => ({ ...s, error: message }));
      } finally {
        setBusy(null);
      }
    },
    [sessionId, refresh],
  );

  const handleEditNotes = useCallback(
    async (state: SaveStateRecord) => {
      if (!sessionId) return;
      const next = window.prompt('Edit notes (blank to clear)', state.notes ?? '');
      if (next === null) return;
      setBusy(`notes-${state.id}`);
      try {
        await updateSaveState(sessionId, state.id, { notes: next });
        await refresh();
      } catch (e) {
        const message =
          e instanceof ProjectApiError
            ? `${e.code}: ${e.message}`
            : e instanceof Error
              ? e.message
              : String(e);
        setLib((s) => ({ ...s, error: message }));
      } finally {
        setBusy(null);
      }
    },
    [sessionId, refresh],
  );

  const handleDelete = useCallback(
    async (state: SaveStateRecord) => {
      if (!sessionId) return;
      if (!window.confirm(`Delete save state "${state.name}"? This cannot be undone.`)) return;
      setBusy(`delete-${state.id}`);
      try {
        await deleteSaveState(sessionId, state.id);
        await refresh();
      } catch (e) {
        const message =
          e instanceof ProjectApiError
            ? `${e.code}: ${e.message}`
            : e instanceof Error
              ? e.message
              : String(e);
        setLib((s) => ({ ...s, error: message }));
      } finally {
        setBusy(null);
      }
    },
    [sessionId, refresh],
  );

  return (
    <div className="save-state-library" data-testid="save-state-library">
      <button
        type="button"
        className="emulator-host__btn"
        onClick={() => setOpen((v) => !v)}
        data-testid="save-state-library-toggle"
        title="Open the save state library"
      >
        💾 Save states {open ? '▾' : '▸'}
      </button>
      {open && (
        <div className="save-state-library__panel" data-testid="save-state-library-panel">
          <div className="save-state-library__row save-state-library__row--header">
            <span className="save-state-library__title">Save states</span>
            <button
              type="button"
              className="emulator-host__btn emulator-host__btn--primary"
              onClick={() => void handleCapture()}
              disabled={busy !== null || !emulatorActive || !host}
              data-testid="save-state-library-capture"
              title={
                emulatorActive
                  ? 'Capture the current game state with a name + note'
                  : 'Boot the game first to capture a state'
              }
            >
              + Capture
            </button>
          </div>
          {lib.error && (
            <div className="save-state-library__error" data-testid="save-state-library-error">
              {lib.error}
            </div>
          )}
          {lib.loading ? (
            <div className="save-state-library__empty">Loading…</div>
          ) : lib.states.length === 0 ? (
            <div className="save-state-library__empty" data-testid="save-state-library-empty">
              No save states yet. Boot the game and click <strong>Capture</strong> to add one.
            </div>
          ) : (
            <ul className="save-state-library__list">
              {lib.states.map((state) => (
                <li
                  key={state.id}
                  className={
                    'save-state-library__item' +
                    (state.lastLoaded ? ' save-state-library__item--last' : '')
                  }
                  data-testid={`save-state-library-item-${state.id}`}
                >
                  <div className="save-state-library__item-main">
                    <div className="save-state-library__item-name">
                      {state.name}
                      {state.lastLoaded && (
                        <span className="save-state-library__last-pill" title="Most recently loaded">
                          last loaded
                        </span>
                      )}
                    </div>
                    {state.notes && (
                      <div className="save-state-library__item-notes">{state.notes}</div>
                    )}
                    <div className="save-state-library__item-meta">
                      {new Date(state.createdAt).toLocaleString()} ·{' '}
                      {(state.byteLength / 1024).toFixed(1)} KB
                    </div>
                  </div>
                  <div className="save-state-library__item-actions">
                    <button
                      type="button"
                      className="emulator-host__debug-btn"
                      onClick={() => void handleLoad(state)}
                      disabled={busy !== null || !emulatorActive || !host}
                      data-testid={`save-state-library-load-${state.id}`}
                      title="Restore this state into the running game"
                    >
                      Load
                    </button>
                    <button
                      type="button"
                      className="emulator-host__debug-btn"
                      onClick={() => void handleRename(state)}
                      disabled={busy !== null}
                      data-testid={`save-state-library-rename-${state.id}`}
                      title="Change the name"
                    >
                      Rename
                    </button>
                    <button
                      type="button"
                      className="emulator-host__debug-btn"
                      onClick={() => void handleEditNotes(state)}
                      disabled={busy !== null}
                      data-testid={`save-state-library-notes-${state.id}`}
                      title="Edit the note"
                    >
                      Note
                    </button>
                    <button
                      type="button"
                      className="emulator-host__debug-btn save-state-library__delete-btn"
                      onClick={() => void handleDelete(state)}
                      disabled={busy !== null}
                      data-testid={`save-state-library-delete-${state.id}`}
                      title="Delete this state"
                    >
                      ✕
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
