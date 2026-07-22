/**
 * WP-B v2.3 - Pokémon Essentials-style F9 debug menu overlay.
 *
 * Floats over the emulator canvas. Tabs for Field (flags + vars),
 * Player (name + gender + money + badges), Party (heal), Items
 * (give). Toggled via the "🔧 Debug" button on the EmulatorHost
 * toolbar OR the F9 key (matching Essentials muscle memory).
 *
 * Each action:
 *   - Reads the live SaveBlock via EmulatorMemory + the per-family
 *     savedataResolver helpers.
 *   - Writes mutations back via the same helpers.
 *   - Each write pauses the emulator briefly (savestate-patch
 *     pattern) so the change is atomic w.r.t. the running frame.
 *
 * Gated on:
 *   - The emulator state slice being `running` or `paused` (not
 *     `idle`). If idle, the panel shows "Boot the game first".
 *   - The project identity being a SUPPORTED_FAMILY. If unsupported
 *     (CFRU, expansion, decomp), the panel shows a warning instead
 *     of corrupting the user's save.
 */

import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useEmulatorStore } from '../../state/emulator';
import { useProjectStore, pushToast } from '../../state';
import { resolveSymbolForIdentity, symbolFamilyForIdentity } from '../../lib/symbols';
import {
  EmulatorMemory,
  type EmulatorMemoryHost,
} from '../../lib/emulatorMemory';
import {
  getBadges,
  getFlag,
  getMoney,
  getPlayerGender,
  getPlayerName,
  getVar,
  healParty,
  setBadge,
  setFlag,
  setMoney,
  setPlayerGender,
  setPlayerName,
  setVar,
} from '../../lib/savedataResolver';
import {
  BADGE_FLAG_IDS,
  type SupportedFamily,
} from '../../lib/savedataLayout';
import { prettifyConstantName } from '../../lib/displayName';
import './DebugMenu.css';

type Tab = 'field' | 'player' | 'party' | 'live' | 'help';

/** Per-family symbol family → supported family (or null if unsupported). */
function familyFromIdentity(
  identity: ReturnType<typeof useProjectStore.getState>['load'] extends infer L
    ? L extends { kind: 'loaded'; data: { identity: infer I } }
      ? I
      : null
    : null,
): SupportedFamily | null {
  const symFamily = symbolFamilyForIdentity(identity as never);
  if (symFamily === 'firered-vanilla') return 'firered-vanilla';
  if (symFamily === 'emerald-vanilla') return 'emerald-vanilla';
  // CFRU + pokeemerald-expansion are out of scope for v2 - they may
  // share offsets but we haven't verified.
  return null;
}

export function DebugMenu(): JSX.Element {
  const emuState = useEmulatorStore((s) => s.state);
  const identity = useProjectStore((s) =>
    s.load.kind === 'loaded' ? s.load.data.identity : null,
  );
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>('field');

  // F9 toggle, matching Pokémon Essentials muscle memory.
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'F9' && !e.repeat) {
        e.preventDefault();
        setOpen((p) => !p);
      }
      if (e.key === 'Escape' && open) {
        setOpen(false);
      }
    };
    window.addEventListener('keydown', handler);
    return () => {
      window.removeEventListener('keydown', handler);
    };
  }, [open]);

  const family = familyFromIdentity(identity);
  const moduleRef =
    emuState.kind === 'running' || emuState.kind === 'paused'
      ? emuState.module
      : null;

  return (
    <div className="debug-menu" data-testid="debug-menu">
      <button
        type="button"
        className="debug-menu__toggle"
        data-testid="debug-menu-toggle"
        onClick={() => setOpen((p) => !p)}
        title="Debug menu (F9)"
      >
        🔧 Debug
      </button>
      {open && (
        <div className="debug-menu__panel" data-testid="debug-menu-panel">
          <header className="debug-menu__header">
            <h3 className="debug-menu__title">Debug menu</h3>
            <button
              type="button"
              className="debug-menu__close"
              data-testid="debug-menu-close"
              onClick={() => setOpen(false)}
              aria-label="Close debug menu"
            >
              ×
            </button>
          </header>
          {!moduleRef ? (
            <p className="debug-menu__hint" data-testid="debug-menu-hint-no-emulator">
              Click <strong>Play</strong> on the emulator to boot the game,
              then this menu can edit the running save state.
            </p>
          ) : !family ? (
            <p className="debug-menu__hint" data-testid="debug-menu-hint-unsupported">
              Debug menu currently supports vanilla FireRed/LeafGreen and
              vanilla Emerald. Detected ROM family isn't one of those, so
              SaveBlock offsets may differ - writing would risk corrupting
              the running game's save data.
            </p>
          ) : (
            <DebugMenuBody
              module={moduleRef}
              family={family}
              activeTab={tab}
              onTabChange={setTab}
            />
          )}
        </div>
      )}
    </div>
  );
}

interface DebugMenuBodyProps {
  readonly module: EmulatorMemoryHost;
  readonly family: SupportedFamily;
  readonly activeTab: Tab;
  readonly onTabChange: (t: Tab) => void;
}

function DebugMenuBody({
  module,
  family,
  activeTab,
  onTabChange,
}: DebugMenuBodyProps): JSX.Element {
  const mem = new EmulatorMemory(module);
  return (
    <div className="debug-menu__body">
      <nav className="debug-menu__tabs" role="tablist" aria-label="Debug categories">
        {(['field', 'player', 'party', 'live', 'help'] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={activeTab === t}
            className={`debug-menu__tab${activeTab === t ? ' debug-menu__tab--active' : ''}`}
            data-testid={`debug-menu-tab-${t}`}
            onClick={() => onTabChange(t)}
          >
            {tabLabel(t)}
          </button>
        ))}
      </nav>
      <div className="debug-menu__tab-body">
        {activeTab === 'field' && <FieldForm mem={mem} family={family} />}
        {activeTab === 'player' && <PlayerForm mem={mem} family={family} />}
        {activeTab === 'party' && <PartyForm mem={mem} family={family} />}
        {activeTab === 'live' && <LiveStateForm mem={mem} family={family} />}
        {activeTab === 'help' && <HelpForm />}
      </div>
    </div>
  );
}

function tabLabel(t: Tab): string {
  switch (t) {
    case 'field':
      return 'Field';
    case 'player':
      return 'Player';
    case 'party':
      return 'Pokémon';
    case 'live':
      return 'Live state';
    case 'help':
      return 'Help';
  }
}

interface FormProps {
  readonly mem: EmulatorMemory;
  readonly family: SupportedFamily;
}

/** Field tab - set flag by id, set variable by id. */
function FieldForm({ mem, family }: FormProps): JSX.Element {
  const [flagIdHex, setFlagIdHex] = useState('');
  const [varIdHex, setVarIdHex] = useState('');
  const [varValue, setVarValue] = useState('');
  const [busy, setBusy] = useState(false);

  const handleSetFlag = useCallback(
    async (value: boolean) => {
      const id = parseHexOrDec(flagIdHex);
      if (id === null) {
        pushToast('error', 'Flag id must be a hex (e.g. 0x820) or decimal number');
        return;
      }
      setBusy(true);
      try {
        await setFlag(mem, family, id, value);
        pushToast('success', `Flag 0x${id.toString(16)} ${value ? 'set' : 'cleared'}`);
      } catch (e) {
        pushToast('error', `Set flag failed: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setBusy(false);
      }
    },
    [flagIdHex, mem, family],
  );

  const handleSetVar = useCallback(async () => {
    const id = parseHexOrDec(varIdHex);
    const val = parseHexOrDec(varValue);
    if (id === null || val === null) {
      pushToast('error', 'Var id + value must be hex (0x4001) or decimal');
      return;
    }
    setBusy(true);
    try {
      await setVar(mem, family, id, val);
      pushToast('success', `Variable 0x${id.toString(16)} set to ${val}`);
    } catch (e) {
      pushToast('error', `Set variable failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }, [varIdHex, varValue, mem, family]);

  return (
    <div className="debug-menu__form" data-testid="debug-menu-field-form">
      <section className="debug-menu__section">
        <h4 className="debug-menu__section-heading">Set a flag</h4>
        <div className="debug-menu__row">
          <input
            type="text"
            placeholder="Flag id (e.g. 0x820)"
            value={flagIdHex}
            onChange={(e) => setFlagIdHex(e.target.value)}
            data-testid="debug-menu-flag-id"
            disabled={busy}
          />
          <button
            type="button"
            onClick={() => void handleSetFlag(true)}
            data-testid="debug-menu-flag-set"
            disabled={busy}
          >
            Set
          </button>
          <button
            type="button"
            onClick={() => void handleSetFlag(false)}
            data-testid="debug-menu-flag-clear"
            disabled={busy}
          >
            Clear
          </button>
        </div>
        <p className="debug-menu__hint-small">
          Example: 0x820 = first gym badge in FireRed.
        </p>
      </section>
      <section className="debug-menu__section">
        <h4 className="debug-menu__section-heading">Set a variable</h4>
        <div className="debug-menu__row">
          <input
            type="text"
            placeholder="Var id (e.g. 0x4001)"
            value={varIdHex}
            onChange={(e) => setVarIdHex(e.target.value)}
            data-testid="debug-menu-var-id"
            disabled={busy}
          />
          <input
            type="text"
            placeholder="Value"
            value={varValue}
            onChange={(e) => setVarValue(e.target.value)}
            data-testid="debug-menu-var-value"
            disabled={busy}
          />
          <button
            type="button"
            onClick={() => void handleSetVar()}
            data-testid="debug-menu-var-set"
            disabled={busy}
          >
            Set
          </button>
        </div>
        <p className="debug-menu__hint-small">
          Variable ids are 0x4000-based (VAR_TEMP_0 = 0x4000).
        </p>
      </section>
    </div>
  );
}

/** Player tab - name, gender, money, badges. */
function PlayerForm({ mem, family }: FormProps): JSX.Element {
  const [name, setName] = useState('');
  const [gender, setGender] = useState<'male' | 'female'>('male');
  const [money, setMoneyValue] = useState('');
  const [badges, setBadges] = useState<boolean[]>([false, false, false, false, false, false, false, false]);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  // Lazy initial load. Don't fire on mount because that captures a
  // savestate; only load when the user lands on this tab.
  const loadCurrent = useCallback(async () => {
    setBusy(true);
    try {
      const [n, g, m, b] = await Promise.all([
        getPlayerName(mem, family),
        getPlayerGender(mem, family),
        getMoney(mem, family),
        getBadges(mem, family),
      ]);
      setName(n);
      setGender(g);
      setMoneyValue(String(m));
      setBadges(b);
      setLoaded(true);
    } catch (e) {
      pushToast('error', `Could not read player data: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }, [mem, family]);

  const handleSave = useCallback(async () => {
    setBusy(true);
    try {
      await setPlayerName(mem, family, name);
      await setPlayerGender(mem, family, gender);
      const m = Number.parseInt(money, 10);
      if (Number.isFinite(m)) {
        await setMoney(mem, family, m);
      }
      for (let i = 0; i < BADGE_FLAG_IDS[family].length; i++) {
        await setBadge(mem, family, i, !!badges[i]);
      }
      pushToast('success', 'Player data updated');
    } catch (e) {
      pushToast('error', `Save failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }, [mem, family, name, gender, money, badges]);

  return (
    <div className="debug-menu__form" data-testid="debug-menu-player-form">
      {!loaded ? (
        <button
          type="button"
          className="debug-menu__load-btn"
          onClick={() => void loadCurrent()}
          data-testid="debug-menu-player-load"
          disabled={busy}
        >
          {busy ? 'Reading…' : 'Load current player data'}
        </button>
      ) : (
        <>
          <section className="debug-menu__section">
            <h4 className="debug-menu__section-heading">Name + gender</h4>
            <div className="debug-menu__row">
              <input
                type="text"
                value={name}
                maxLength={7}
                onChange={(e) => setName(e.target.value)}
                data-testid="debug-menu-player-name"
                disabled={busy}
              />
              <select
                value={gender}
                onChange={(e) => setGender(e.target.value as 'male' | 'female')}
                data-testid="debug-menu-player-gender"
                disabled={busy}
              >
                <option value="male">Male</option>
                <option value="female">Female</option>
              </select>
            </div>
          </section>
          <section className="debug-menu__section">
            <h4 className="debug-menu__section-heading">Money</h4>
            <div className="debug-menu__row">
              <input
                type="text"
                value={money}
                onChange={(e) => setMoneyValue(e.target.value)}
                data-testid="debug-menu-player-money"
                disabled={busy}
              />
              <span className="debug-menu__hint-small">(0–999,999)</span>
            </div>
          </section>
          <section className="debug-menu__section">
            <h4 className="debug-menu__section-heading">Gym badges</h4>
            <div className="debug-menu__badges">
              {badges.map((owned, i) => (
                <label key={i} className="debug-menu__badge">
                  <input
                    type="checkbox"
                    checked={owned}
                    onChange={(e) => {
                      const next = [...badges];
                      next[i] = e.target.checked;
                      setBadges(next);
                    }}
                    data-testid={`debug-menu-player-badge-${i}`}
                    disabled={busy}
                  />
                  <span>Badge {i + 1}</span>
                </label>
              ))}
            </div>
          </section>
          <div className="debug-menu__actions">
            <button
              type="button"
              className="debug-menu__save-btn"
              onClick={() => void handleSave()}
              data-testid="debug-menu-player-save"
              disabled={busy}
            >
              {busy ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** Party tab - heal party (zero status + set HP=maxHP per slot). */
function PartyForm({ mem, family }: FormProps): JSX.Element {
  const [busy, setBusy] = useState(false);
  const handleHeal = useCallback(async () => {
    setBusy(true);
    try {
      const r = await healParty(mem, family);
      pushToast(
        'success',
        r.healedSlots === 0
          ? 'No party Pokémon to heal'
          : `Healed ${r.healedSlots} party Pokémon`,
      );
    } catch (e) {
      pushToast('error', `Heal failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }, [mem, family]);
  return (
    <div className="debug-menu__form" data-testid="debug-menu-party-form">
      <p className="debug-menu__hint-small">
        Resets every party slot's HP to its max and clears any status
        condition (poison, paralysis, sleep, etc.). The stats themselves
        aren't recomputed - the game does that on the next switch or
        turn end.
      </p>
      <button
        type="button"
        className="debug-menu__save-btn"
        onClick={() => void handleHeal()}
        data-testid="debug-menu-party-heal"
        disabled={busy}
      >
        {busy ? 'Healing…' : 'Heal party'}
      </button>
    </div>
  );
}

function HelpForm(): JSX.Element {
  return (
    <div className="debug-menu__form" data-testid="debug-menu-help-form">
      <h4 className="debug-menu__section-heading">About this menu</h4>
      <p className="debug-menu__help-text">
        Mirrors Pokémon Essentials' F9 debug menu - but writes directly
        to the running mGBA emulator's WRAM. Each action pauses the
        emulator briefly, patches the live save state, then resumes.
      </p>
      <p className="debug-menu__help-text">
        Open this menu with the <kbd>F9</kbd> key or the
        <strong>🔧 Debug</strong> button on the emulator toolbar.
      </p>
      <h4 className="debug-menu__section-heading">Categories</h4>
      <ul className="debug-menu__help-list">
        <li><strong>Field</strong> - set any flag (event progress, badges, story gates) or variable.</li>
        <li><strong>Player</strong> - rename the player, change gender, set money, tick badge checkboxes.</li>
        <li><strong>Pokémon</strong> - heal the party with one click.</li>
      </ul>
      <p className="debug-menu__help-text">
        <strong>Currently supports:</strong> vanilla FireRed/LeafGreen and
        vanilla Emerald. Save data offsets for CFRU + pokeemerald-expansion
        forks may differ - extending this is on the roadmap.
      </p>
    </div>
  );
}

/** Parse "0xAB" or "171" → 171. Returns null on invalid input. */
function parseHexOrDec(input: string): number | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.startsWith('0x') || trimmed.startsWith('0X')) {
    const n = Number.parseInt(trimmed.slice(2), 16);
    return Number.isFinite(n) ? n : null;
  }
  const n = Number.parseInt(trimmed, 10);
  return Number.isFinite(n) ? n : null;
}

// ─────────────────────────────────────────────────────────────────
// Phase 4.1D - Live state tab.
//
// Read-only "what's the game's state right now" view. The user adds
// flag / var ids to a watchlist; the tab polls them at 500 ms while
// it's visible and surfaces symbolic names from the project's symbol
// database.
//
// The watchlist persists to localStorage so it survives reloads. The
// polling automatically pauses when the user switches away from this
// tab or closes the debug menu - useEffect's cleanup handles it.

interface WatchEntry {
  readonly kind: 'flag' | 'var';
  readonly id: number;
}

const WATCHLIST_LS_KEY = 'rom-editor:debug-menu:watchlist';

function loadWatchlist(): WatchEntry[] {
  try {
    const raw = window.localStorage.getItem(WATCHLIST_LS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (e): e is WatchEntry =>
          !!e && typeof e === 'object' &&
          ((e as WatchEntry).kind === 'flag' || (e as WatchEntry).kind === 'var') &&
          typeof (e as WatchEntry).id === 'number' &&
          Number.isInteger((e as WatchEntry).id) &&
          (e as WatchEntry).id >= 0 &&
          (e as WatchEntry).id <= 0xffff,
      );
  } catch {
    return [];
  }
}

function saveWatchlist(list: ReadonlyArray<WatchEntry>): void {
  try {
    window.localStorage.setItem(WATCHLIST_LS_KEY, JSON.stringify(list));
  } catch {
    /* localStorage quota / private mode - best effort */
  }
}

function LiveStateForm({ mem, family }: FormProps): JSX.Element {
  const identity = useProjectStore((s) =>
    s.load.kind === 'loaded' ? s.load.data.identity : null,
  );
  const [watch, setWatch] = useState<WatchEntry[]>(() => loadWatchlist());
  const [values, setValues] = useState<Record<string, number | boolean | null>>({});
  const [polling, setPolling] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [addText, setAddText] = useState('');
  const [addKind, setAddKind] = useState<'flag' | 'var'>('flag');
  const tickRef = useRef<number | null>(null);

  // Persist any watchlist mutation immediately.
  useEffect(() => {
    saveWatchlist(watch);
  }, [watch]);

  // Build a key for each watch entry. Kept stable across renders so
  // the values map doesn't churn.
  const keyOf = useCallback((e: WatchEntry): string => `${e.kind}:${e.id}`, []);

  const refresh = useCallback(async () => {
    setError(null);
    const next: Record<string, number | boolean | null> = {};
    for (const entry of watch) {
      try {
        if (entry.kind === 'flag') {
          next[keyOf(entry)] = await getFlag(mem, family, entry.id);
        } else {
          next[keyOf(entry)] = await getVar(mem, family, entry.id);
        }
      } catch {
        // Don't blow up the entire tick - surface as null + keep going.
        next[keyOf(entry)] = null;
      }
    }
    setValues(next);
  }, [mem, family, watch, keyOf]);

  // Auto-polling: refresh now + tick at 500ms while the tab is mounted
  // and polling is enabled.
  useEffect(() => {
    let cancelled = false;
    async function loop(): Promise<void> {
      if (cancelled) return;
      await refresh();
      if (cancelled || !polling) return;
      tickRef.current = window.setTimeout(() => void loop(), 500);
    }
    void loop();
    return () => {
      cancelled = true;
      if (tickRef.current !== null) {
        window.clearTimeout(tickRef.current);
        tickRef.current = null;
      }
    };
  }, [polling, refresh]);

  const handleAdd = useCallback(() => {
    const id = parseHexOrDec(addText);
    if (id === null || id < 0 || id > 0xffff) {
      setError('Enter a hex (0x820) or decimal id in u16 range.');
      return;
    }
    setWatch((prev) =>
      prev.some((e) => e.kind === addKind && e.id === id) ? prev : [...prev, { kind: addKind, id }],
    );
    setAddText('');
  }, [addText, addKind]);

  const handleRemove = useCallback((entry: WatchEntry) => {
    setWatch((prev) => prev.filter((e) => !(e.kind === entry.kind && e.id === entry.id)));
  }, []);

  // Resolve display name for a watch entry via the project's symbol DB.
  const resolveName = useMemo(
    () =>
      (entry: WatchEntry): string => {
        const kind: 'flag' | 'var' = entry.kind;
        const sym = resolveSymbolForIdentity(identity, kind, entry.id);
        if (sym) return prettifyConstantName(sym.name, kind === 'flag' ? 'FLAG_' : 'VAR_');
        return `${kind.toUpperCase()} 0x${entry.id.toString(16)}`;
      },
    [identity],
  );

  return (
    <div className="debug-menu__form" data-testid="debug-menu-live-form">
      <section className="debug-menu__section">
        <h4 className="debug-menu__section-heading">Watchlist</h4>
        <p className="debug-menu__hint-small">
          Add flags + vars to monitor in real time. Polls at 500&nbsp;ms while
          this tab is open. Persists across reloads.
        </p>
        <div className="debug-menu__row">
          <select
            value={addKind}
            onChange={(e) => setAddKind(e.target.value as 'flag' | 'var')}
            data-testid="debug-menu-live-add-kind"
          >
            <option value="flag">Flag</option>
            <option value="var">Var</option>
          </select>
          <input
            type="text"
            placeholder="Id (0x820 or 2080)"
            value={addText}
            onChange={(e) => setAddText(e.target.value)}
            data-testid="debug-menu-live-add-id"
          />
          <button
            type="button"
            onClick={handleAdd}
            data-testid="debug-menu-live-add-btn"
          >
            Watch
          </button>
        </div>
        <div className="debug-menu__row">
          <button
            type="button"
            onClick={() => setPolling((p) => !p)}
            data-testid="debug-menu-live-toggle-poll"
          >
            {polling ? 'Pause polling' : 'Resume polling'}
          </button>
          <button
            type="button"
            onClick={() => void refresh()}
            data-testid="debug-menu-live-refresh"
          >
            Refresh now
          </button>
        </div>
        {error && (
          <p className="debug-menu__hint-small" data-testid="debug-menu-live-error" style={{ color: '#ff9a9a' }}>
            {error}
          </p>
        )}
      </section>
      <section className="debug-menu__section">
        <h4 className="debug-menu__section-heading">Watched state</h4>
        {watch.length === 0 ? (
          <p className="debug-menu__hint-small" data-testid="debug-menu-live-empty">
            Watchlist is empty. Add a flag or var id above.
          </p>
        ) : (
          <ul className="debug-menu__live-list" data-testid="debug-menu-live-list">
            {watch.map((entry) => {
              const key = keyOf(entry);
              const value = values[key];
              const displayValue =
                value === null || value === undefined
                  ? ' - '
                  : entry.kind === 'flag'
                    ? value
                      ? 'SET'
                      : 'clear'
                    : typeof value === 'number'
                      ? `0x${value.toString(16)} (${String(value)})`
                      : ' - ';
              return (
                <li
                  key={key}
                  className="debug-menu__live-item"
                  data-testid={`debug-menu-live-item-${entry.kind}-${entry.id}`}
                >
                  <span className="debug-menu__live-name">{resolveName(entry)}</span>
                  <span className="debug-menu__live-id">0x{entry.id.toString(16)}</span>
                  <span
                    className={`debug-menu__live-value debug-menu__live-value--${entry.kind === 'flag' ? (value ? 'set' : 'clear') : 'num'}`}
                  >
                    {displayValue}
                  </span>
                  <button
                    type="button"
                    className="debug-menu__live-remove"
                    onClick={() => handleRemove(entry)}
                    data-testid={`debug-menu-live-remove-${entry.kind}-${entry.id}`}
                    title="Stop watching"
                  >
                    ✕
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
