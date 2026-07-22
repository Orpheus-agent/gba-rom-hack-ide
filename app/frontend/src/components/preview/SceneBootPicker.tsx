/**
 * Phase 4.1B - Scene-boot picker.
 *
 * Toggleable popover next to the "Save states" button. Lets the user:
 *
 *   - Compose a new scene-boot recipe (map id, flags, vars, notes).
 *   - List saved recipes; apply one to the running game.
 *   - Rename, edit, delete a recipe.
 *
 * Applying a recipe routes through `applySceneBoot` in lib/sceneBoot.ts.
 * The result is summarized inline (flags set, vars set, guidance).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ProjectApiError,
  createSceneBoot,
  deleteSceneBoot,
  listSceneBoots,
  updateSceneBoot,
} from '../../api';
import type { SceneBootRecipe, SceneBootVarSeed } from '@rom-editor/shared';
import { applySceneBoot, summarizeSceneBootResult } from '../../lib/sceneBoot';
import type { EmulatorMemoryHost } from '../../lib/emulatorMemory';
import { useViewStore } from '../../state';
import './SceneBootPicker.css';

/** Minimal interface we need from the live mGBA instance - same shape
 *  as the SaveStateLibrary host. */
export interface SceneBootEmulatorHost extends EmulatorMemoryHost {
  readonly pauseGame?: () => void;
  readonly resumeGame?: () => void;
}

interface SceneBootPickerProps {
  readonly sessionId: string | null;
  readonly host: SceneBootEmulatorHost | null;
  /** Whether the emulator is currently running/paused. We disable Apply
   *  when it's idle. */
  readonly emulatorActive: boolean;
  /** Project family for save-data layout. Optional; defaults to
   *  firered-vanilla (which CFRU inherits). */
  readonly family?: string;
  /** Optional: prefill the composer when the picker is opened via
   *  "Boot from here" in 4.1C. */
  readonly prefill?: Partial<{
    startingMapId: string;
    startingPosition: { x: number; y: number; facing: 'down' | 'up' | 'left' | 'right' };
  }>;
}

interface ListState {
  readonly recipes: ReadonlyArray<SceneBootRecipe>;
  readonly loading: boolean;
  readonly error: string | null;
}

const FACINGS: ReadonlyArray<'down' | 'up' | 'left' | 'right'> = ['down', 'up', 'left', 'right'];

/** Parse a comma- or whitespace-separated hex/decimal list into u16 numbers.
 *  Accepts "0x820, 0x821" or "0x820 0x821" or "2080" - anything Number()
 *  parses to a non-negative integer within u16 range. */
function parseFlagList(text: string): { ids: number[]; bad: string[] } {
  const ids: number[] = [];
  const bad: string[] = [];
  text
    .split(/[,\s]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .forEach((token) => {
      const n = Number(token);
      if (Number.isFinite(n) && Number.isInteger(n) && n >= 0 && n <= 0xffff) {
        ids.push(n);
      } else {
        bad.push(token);
      }
    });
  return { ids, bad };
}

/** Parse a multi-line "VAR_ID = VALUE" textarea, one pair per line. */
function parseVarList(text: string): { seeds: SceneBootVarSeed[]; bad: string[] } {
  const seeds: SceneBootVarSeed[] = [];
  const bad: string[] = [];
  text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .forEach((line) => {
      const m = /^([0-9a-fx]+)\s*[=:]\s*(-?[0-9a-fx]+)$/i.exec(line);
      if (!m) {
        bad.push(line);
        return;
      }
      const varId = Number(m[1]!);
      const value = Number(m[2]!);
      if (
        Number.isFinite(varId) &&
        Number.isFinite(value) &&
        Number.isInteger(varId) &&
        Number.isInteger(value) &&
        varId >= 0 &&
        varId <= 0xffff &&
        value >= 0 &&
        value <= 0xffff
      ) {
        seeds.push({ varId, value });
      } else {
        bad.push(line);
      }
    });
  return { seeds, bad };
}

export function SceneBootPicker({
  sessionId,
  host,
  emulatorActive,
  family,
  prefill,
}: SceneBootPickerProps): JSX.Element {
  // Phase 4.1C - also subscribe to the view-store prefill (set by
  // MapCanvasContextMenu's "Boot from here"). Either source can drive
  // the composer's initial values; the view-store version takes
  // precedence when both are present.
  const storePrefill = useViewStore((s) => s.sceneBootPrefill);
  const consumeStorePrefill = useViewStore((s) => s.consumeSceneBootPrefill);
  const effectivePrefill = storePrefill ?? prefill ?? null;

  const [open, setOpen] = useState(false);
  const [list, setList] = useState<ListState>({ recipes: [], loading: false, error: null });
  const [composerOpen, setComposerOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [lastApply, setLastApply] = useState<string | null>(null);

  // Composer fields.
  const [name, setName] = useState('');
  const [notes, setNotes] = useState('');
  const [startingMapId, setStartingMapId] = useState(effectivePrefill?.startingMapId ?? '');
  const [posX, setPosX] = useState<number | null>(effectivePrefill?.startingPosition?.x ?? null);
  const [posY, setPosY] = useState<number | null>(effectivePrefill?.startingPosition?.y ?? null);
  const [facing, setFacing] = useState<'down' | 'up' | 'left' | 'right'>(
    effectivePrefill?.startingPosition?.facing ?? 'down',
  );
  const [flagsText, setFlagsText] = useState('');
  const [varsText, setVarsText] = useState('');
  const [skipIntro, setSkipIntro] = useState(false);

  const refresh = useCallback(async () => {
    if (!sessionId) return;
    setList((s) => ({ ...s, loading: true, error: null }));
    try {
      const recipes = await listSceneBoots(sessionId);
      setList({ recipes, loading: false, error: null });
    } catch (e) {
      const message =
        e instanceof ProjectApiError
          ? `${e.code}: ${e.message}`
          : e instanceof Error
            ? e.message
            : String(e);
      setList({ recipes: [], loading: false, error: message });
    }
  }, [sessionId]);

  useEffect(() => {
    if (open && sessionId) void refresh();
  }, [open, sessionId, refresh]);

  // Sync prefill when opened from a context menu - either via prop
  // (4.1B direct integration) or via the view store (4.1C "Boot from
  // here"). Auto-opens the picker when a store-prefill arrives.
  useEffect(() => {
    if (storePrefill) {
      setOpen(true);
      setStartingMapId(storePrefill.startingMapId);
      if (storePrefill.startingPosition) {
        setPosX(storePrefill.startingPosition.x);
        setPosY(storePrefill.startingPosition.y);
        setFacing(storePrefill.startingPosition.facing);
      }
      // Phase 9G - script + scene affordances pre-fill suggested
      // name/notes + initial flags/vars. We never overwrite the
      // user's existing input - only fill when the field is empty.
      if (storePrefill.suggestedName) {
        setName((cur) => (cur ? cur : storePrefill.suggestedName!));
      }
      if (storePrefill.suggestedNotes) {
        setNotes((cur) => (cur ? cur : storePrefill.suggestedNotes!));
      }
      if (storePrefill.initialFlags && storePrefill.initialFlags.length > 0) {
        const formatted = storePrefill.initialFlags
          .map((f) => '0x' + f.toString(16).toUpperCase().padStart(4, '0'))
          .join(', ');
        setFlagsText((cur) => (cur ? cur : formatted));
      }
      if (storePrefill.initialVars && storePrefill.initialVars.length > 0) {
        const formatted = storePrefill.initialVars
          .map(
            (v) =>
              '0x' +
              v.id.toString(16).toUpperCase().padStart(4, '0') +
              '=' +
              String(v.value),
          )
          .join(', ');
        setVarsText((cur) => (cur ? cur : formatted));
      }
      setComposerOpen(true);
      consumeStorePrefill();
    } else if (open && prefill?.startingMapId) {
      setStartingMapId(prefill.startingMapId);
      if (prefill.startingPosition) {
        setPosX(prefill.startingPosition.x);
        setPosY(prefill.startingPosition.y);
        setFacing(prefill.startingPosition.facing);
      }
      setComposerOpen(true);
    }
  }, [open, prefill, storePrefill, consumeStorePrefill]);

  const composerValid = useMemo(
    () => name.trim().length > 0 && startingMapId.trim().length > 0,
    [name, startingMapId],
  );

  const handleSave = useCallback(async () => {
    if (!sessionId || !composerValid) return;
    const { ids: flagIds, bad: badFlags } = parseFlagList(flagsText);
    const { seeds: varSeeds, bad: badVars } = parseVarList(varsText);
    if (badFlags.length > 0) {
      setList((s) => ({ ...s, error: `Bad flag tokens: ${badFlags.join(', ')}` }));
      return;
    }
    if (badVars.length > 0) {
      setList((s) => ({ ...s, error: `Bad var lines: ${badVars.join(' | ')}` }));
      return;
    }
    setBusy('save');
    try {
      await createSceneBoot(sessionId, {
        name: name.trim(),
        notes: notes.trim().length === 0 ? null : notes.trim(),
        startingMapId: startingMapId.trim(),
        startingPosition:
          posX !== null && posY !== null
            ? { x: posX, y: posY, facing }
            : null,
        initialFlags: flagIds,
        initialVars: varSeeds,
        skipIntro,
      });
      // Reset composer.
      setName('');
      setNotes('');
      setFlagsText('');
      setVarsText('');
      setComposerOpen(false);
      await refresh();
    } catch (e) {
      const message =
        e instanceof ProjectApiError
          ? `${e.code}: ${e.message}`
          : e instanceof Error
            ? e.message
            : String(e);
      setList((s) => ({ ...s, error: message }));
    } finally {
      setBusy(null);
    }
  }, [sessionId, composerValid, name, notes, startingMapId, posX, posY, facing, flagsText, varsText, skipIntro, refresh]);

  const handleApply = useCallback(
    async (recipe: SceneBootRecipe) => {
      if (!host) {
        setList((s) => ({ ...s, error: 'Boot the game first to apply a scene-boot.' }));
        return;
      }
      setBusy(`apply-${recipe.id}`);
      setLastApply(null);
      try {
        const result = await applySceneBoot({
          recipe,
          host,
          family: family ?? 'firered-vanilla',
        });
        setLastApply(summarizeSceneBootResult(recipe, result));
      } catch (e) {
        const message =
          e instanceof Error ? e.message : String(e);
        setList((s) => ({ ...s, error: `Apply failed: ${message}` }));
      } finally {
        setBusy(null);
      }
    },
    [host, family],
  );

  const handleDelete = useCallback(
    async (recipe: SceneBootRecipe) => {
      if (!sessionId) return;
      if (!window.confirm(`Delete recipe "${recipe.name}"?`)) return;
      setBusy(`delete-${recipe.id}`);
      try {
        await deleteSceneBoot(sessionId, recipe.id);
        await refresh();
      } catch (e) {
        const message =
          e instanceof ProjectApiError
            ? `${e.code}: ${e.message}`
            : e instanceof Error
              ? e.message
              : String(e);
        setList((s) => ({ ...s, error: message }));
      } finally {
        setBusy(null);
      }
    },
    [sessionId, refresh],
  );

  const handleRename = useCallback(
    async (recipe: SceneBootRecipe) => {
      if (!sessionId) return;
      const next = window.prompt('Rename recipe', recipe.name);
      if (!next || next.trim().length === 0 || next.trim() === recipe.name) return;
      setBusy(`rename-${recipe.id}`);
      try {
        await updateSceneBoot(sessionId, recipe.id, { name: next.trim() });
        await refresh();
      } catch (e) {
        const message =
          e instanceof ProjectApiError
            ? `${e.code}: ${e.message}`
            : e instanceof Error
              ? e.message
              : String(e);
        setList((s) => ({ ...s, error: message }));
      } finally {
        setBusy(null);
      }
    },
    [sessionId, refresh],
  );

  return (
    <div className="scene-boot-picker" data-testid="scene-boot-picker">
      <button
        type="button"
        className="emulator-host__btn"
        onClick={() => setOpen((v) => !v)}
        data-testid="scene-boot-picker-toggle"
        title="Open the scene-boot recipe library"
      >
        🎬 Scenes {open ? '▾' : '▸'}
      </button>
      {open && (
        <div className="scene-boot-picker__panel" data-testid="scene-boot-picker-panel">
          <div className="scene-boot-picker__row scene-boot-picker__row--header">
            <span className="scene-boot-picker__title">Scene-boot recipes</span>
            <button
              type="button"
              className="emulator-host__btn emulator-host__btn--primary"
              onClick={() => setComposerOpen((v) => !v)}
              data-testid="scene-boot-picker-new"
            >
              {composerOpen ? 'Cancel' : '+ New'}
            </button>
          </div>
          {list.error && (
            <div className="scene-boot-picker__error" data-testid="scene-boot-picker-error">
              {list.error}
            </div>
          )}
          {lastApply && (
            <div className="scene-boot-picker__applied" data-testid="scene-boot-picker-applied">
              {lastApply}
            </div>
          )}

          {composerOpen && (
            <div className="scene-boot-picker__composer" data-testid="scene-boot-picker-composer">
              <label>
                <span>Name</span>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="cosmog-handoff"
                  data-testid="scene-boot-picker-name"
                  maxLength={80}
                />
              </label>
              <label>
                <span>Notes (optional)</span>
                <input
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="after Oak gives Cosmog"
                  data-testid="scene-boot-picker-notes"
                />
              </label>
              <label>
                <span>Starting map id</span>
                <input
                  value={startingMapId}
                  onChange={(e) => setStartingMapId(e.target.value)}
                  placeholder="pallet_town"
                  data-testid="scene-boot-picker-map"
                />
              </label>
              <div className="scene-boot-picker__pos-row">
                <label>
                  <span>x</span>
                  <input
                    type="number"
                    min={0}
                    max={255}
                    value={posX ?? ''}
                    onChange={(e) => {
                      const n = Number.parseInt(e.target.value, 10);
                      setPosX(Number.isFinite(n) ? n : null);
                    }}
                    data-testid="scene-boot-picker-x"
                  />
                </label>
                <label>
                  <span>y</span>
                  <input
                    type="number"
                    min={0}
                    max={255}
                    value={posY ?? ''}
                    onChange={(e) => {
                      const n = Number.parseInt(e.target.value, 10);
                      setPosY(Number.isFinite(n) ? n : null);
                    }}
                    data-testid="scene-boot-picker-y"
                  />
                </label>
                <label>
                  <span>facing</span>
                  <select
                    value={facing}
                    onChange={(e) => setFacing(e.target.value as typeof facing)}
                    data-testid="scene-boot-picker-facing"
                  >
                    {FACINGS.map((f) => (
                      <option key={f} value={f}>
                        {f}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <label>
                <span>Flags to SET (comma-separated, hex or decimal)</span>
                <textarea
                  value={flagsText}
                  onChange={(e) => setFlagsText(e.target.value)}
                  placeholder="0x820, 0x821"
                  data-testid="scene-boot-picker-flags"
                  rows={2}
                />
              </label>
              <label>
                <span>Vars to set (one per line - VAR_ID = VALUE)</span>
                <textarea
                  value={varsText}
                  onChange={(e) => setVarsText(e.target.value)}
                  placeholder="0x40D0 = 3"
                  data-testid="scene-boot-picker-vars"
                  rows={3}
                />
              </label>
              <label className="scene-boot-picker__inline">
                <input
                  type="checkbox"
                  checked={skipIntro}
                  onChange={(e) => setSkipIntro(e.target.checked)}
                  data-testid="scene-boot-picker-skip-intro"
                />
                <span>Fast-forward intro on boot</span>
              </label>
              <div className="scene-boot-picker__actions">
                <button
                  type="button"
                  className="emulator-host__btn emulator-host__btn--primary"
                  onClick={() => void handleSave()}
                  disabled={!composerValid || busy !== null}
                  data-testid="scene-boot-picker-save"
                >
                  {busy === 'save' ? 'Saving…' : 'Save recipe'}
                </button>
              </div>
            </div>
          )}

          {list.loading ? (
            <div className="scene-boot-picker__empty">Loading…</div>
          ) : list.recipes.length === 0 ? (
            <div className="scene-boot-picker__empty" data-testid="scene-boot-picker-empty">
              No recipes yet. Click <strong>+ New</strong> to compose one.
            </div>
          ) : (
            <ul className="scene-boot-picker__list">
              {list.recipes.map((recipe) => (
                <li
                  key={recipe.id}
                  className="scene-boot-picker__item"
                  data-testid={`scene-boot-picker-item-${recipe.id}`}
                >
                  <div className="scene-boot-picker__item-main">
                    <div className="scene-boot-picker__item-name">{recipe.name}</div>
                    <div className="scene-boot-picker__item-summary">
                      <span title="Starting map">📍 {recipe.startingMapId}</span>
                      {recipe.initialFlags.length > 0 && (
                        <span title="Flags to set">🏁 {String(recipe.initialFlags.length)}</span>
                      )}
                      {recipe.initialVars.length > 0 && (
                        <span title="Vars to set">📊 {String(recipe.initialVars.length)}</span>
                      )}
                      {recipe.triggerScriptId && (
                        <span title="Trigger script">⚡ {recipe.triggerScriptId}</span>
                      )}
                    </div>
                    {recipe.notes && (
                      <div className="scene-boot-picker__item-notes">{recipe.notes}</div>
                    )}
                  </div>
                  <div className="scene-boot-picker__item-actions">
                    <button
                      type="button"
                      className="emulator-host__debug-btn"
                      onClick={() => void handleApply(recipe)}
                      disabled={busy !== null || !emulatorActive || !host}
                      data-testid={`scene-boot-picker-apply-${recipe.id}`}
                      title={
                        emulatorActive
                          ? 'Apply this recipe to the running game'
                          : 'Boot the game first'
                      }
                    >
                      Apply
                    </button>
                    <button
                      type="button"
                      className="emulator-host__debug-btn"
                      onClick={() => void handleRename(recipe)}
                      disabled={busy !== null}
                      data-testid={`scene-boot-picker-rename-${recipe.id}`}
                    >
                      Rename
                    </button>
                    <button
                      type="button"
                      className="emulator-host__debug-btn save-state-library__delete-btn"
                      onClick={() => void handleDelete(recipe)}
                      disabled={busy !== null}
                      data-testid={`scene-boot-picker-delete-${recipe.id}`}
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
