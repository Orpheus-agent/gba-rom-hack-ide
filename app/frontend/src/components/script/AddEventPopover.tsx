import { useEffect, useMemo, useRef, useState } from 'react';
import type { ScriptStepKind } from '@rom-editor/shared';
import {
  commandsByCategory,
  type ScriptCommandCategory,
  type ScriptCommandMetadata,
} from '../../lib/scriptCommands';
import './AddEventPopover.css';

/**
 * WP-A4 - Categorised, searchable, favourite-able Add Event popover.
 *
 * Modelled on GB Studio's "+ Add Event" surface. Open it, type a few
 * letters to filter, click a command to insert it at the host position.
 * Each command card carries its category colour and icon so visual
 * scanning matches the rest of the visual scripter.
 *
 * Favorites persist to localStorage so common patterns (Show dialogue,
 * Set flag) bubble to the top across sessions.
 *
 * This component owns ONLY the UI for picking the command. The host
 * (VisualScriptEditor) decides what to do with the pick - usually
 * calls `editBinaryRomScriptStep` with `op: 'insertStep'`.
 */

const FAVORITES_STORAGE_KEY = 'rom-editor.add-event.favorites';
const RECENT_STORAGE_KEY = 'rom-editor.add-event.recent';
const RECENT_LIMIT = 6;

interface AddEventPopoverProps {
  readonly onPick: (kind: ScriptStepKind) => void;
  readonly onClose: () => void;
  /** Display position - top of the popover anchor (in CSS pixels
   *  within the host's coordinate frame). The popover positions itself
   *  with absolute + max-height-aware overflow. */
  readonly anchorTop?: number;
  /** Optional pre-filter for context-aware uses (e.g., a "+ branch"
   *  button might force category=flow). */
  readonly initialFilter?: string;
}

function loadFavoritesFromStorage(): Set<ScriptStepKind> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = window.localStorage.getItem(FAVORITES_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return new Set(parsed.filter((k): k is ScriptStepKind => typeof k === 'string'));
    }
  } catch {
    // ignore
  }
  return new Set();
}

function loadRecentFromStorage(): ScriptStepKind[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(RECENT_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((k): k is ScriptStepKind => typeof k === 'string').slice(0, RECENT_LIMIT);
    }
  } catch {
    // ignore
  }
  return [];
}

function saveFavorites(favs: Set<ScriptStepKind>): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify(Array.from(favs)));
  } catch {
    // ignore
  }
}

function saveRecent(recent: ScriptStepKind[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(recent));
  } catch {
    // ignore
  }
}

export function AddEventPopover({
  onPick,
  onClose,
  anchorTop,
  initialFilter,
}: AddEventPopoverProps): JSX.Element {
  const [filter, setFilter] = useState(initialFilter ?? '');
  const [favorites, setFavorites] = useState<Set<ScriptStepKind>>(() => loadFavoritesFromStorage());
  const [recent, setRecent] = useState<ScriptStepKind[]>(() => loadRecentFromStorage());
  const containerRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Close on outside click / Esc.
  useEffect(() => {
    const onDocClick = (ev: MouseEvent) => {
      if (!containerRef.current?.contains(ev.target as Node)) onClose();
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  useEffect(() => {
    // Autofocus the filter input on mount.
    inputRef.current?.focus();
  }, []);

  const groups = useMemo(() => commandsByCategory(), []);
  const q = filter.trim().toLowerCase();

  const filteredGroups = useMemo<
    ReadonlyArray<{
      category: { id: ScriptCommandCategory; label: string; color: string };
      commands: ReadonlyArray<ScriptCommandMetadata>;
    }>
  >(() => {
    if (q.length === 0) return groups;
    return groups
      .map((g) => ({
        ...g,
        commands: g.commands.filter(
          (c) =>
            c.defaultLabel.toLowerCase().includes(q) ||
            c.kind.toLowerCase().includes(q) ||
            g.category.label.toLowerCase().includes(q),
        ),
      }))
      .filter((g) => g.commands.length > 0);
  }, [groups, q]);

  const handlePick = (kind: ScriptStepKind): void => {
    // Update recent list.
    const next = [kind, ...recent.filter((k) => k !== kind)].slice(0, RECENT_LIMIT);
    setRecent(next);
    saveRecent(next);
    onPick(kind);
  };

  const toggleFavorite = (kind: ScriptStepKind, ev: React.MouseEvent): void => {
    ev.stopPropagation();
    const next = new Set(favorites);
    if (next.has(kind)) next.delete(kind);
    else next.add(kind);
    setFavorites(next);
    saveFavorites(next);
  };

  // Build the "Recent" + "Favorites" virtual groups when no filter is
  // active. These take priority at the top of the list.
  const allCmdsByKind = useMemo(() => {
    const m = new Map<ScriptStepKind, { meta: ScriptCommandMetadata; category: ScriptCommandCategory; categoryColor: string }>();
    for (const g of groups) {
      for (const c of g.commands) m.set(c.kind, { meta: c, category: g.category.id, categoryColor: g.category.color });
    }
    return m;
  }, [groups]);

  const recentCmds = useMemo(
    () => recent.map((k) => allCmdsByKind.get(k)).filter((x): x is NonNullable<typeof x> => x !== undefined),
    [recent, allCmdsByKind],
  );
  const favoriteCmds = useMemo(
    () =>
      Array.from(favorites)
        .map((k) => allCmdsByKind.get(k))
        .filter((x): x is NonNullable<typeof x> => x !== undefined),
    [favorites, allCmdsByKind],
  );

  return (
    <div
      ref={containerRef}
      className="add-event-popover"
      style={anchorTop !== undefined ? { top: anchorTop } : undefined}
      data-testid="add-event-popover"
      role="dialog"
      aria-label="Add a script step"
    >
      <div className="add-event-popover__header">
        <input
          ref={inputRef}
          type="search"
          className="add-event-popover__filter"
          placeholder="Type to search - e.g. 'dialogue', 'flag', 'battle'…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          spellCheck={false}
          data-testid="add-event-popover-filter"
        />
      </div>
      <div className="add-event-popover__list">
        {q.length === 0 && (
          <>
            {recentCmds.length > 0 && (
              <CommandGroup
                heading="Recent"
                color="#7c8088"
                commands={recentCmds.map((c) => c.meta)}
                colorByKind={(k) => allCmdsByKind.get(k)!.categoryColor}
                favorites={favorites}
                onPick={handlePick}
                onToggleFav={toggleFavorite}
              />
            )}
            {favoriteCmds.length > 0 && (
              <CommandGroup
                heading="★ Favorites"
                color="#f0b429"
                commands={favoriteCmds.map((c) => c.meta)}
                colorByKind={(k) => allCmdsByKind.get(k)!.categoryColor}
                favorites={favorites}
                onPick={handlePick}
                onToggleFav={toggleFavorite}
              />
            )}
          </>
        )}
        {filteredGroups.length === 0 ? (
          <p className="add-event-popover__empty" data-testid="add-event-popover-empty">
            No commands match "{filter}". Clear the filter to see all.
          </p>
        ) : (
          filteredGroups.map((g) => (
            <CommandGroup
              key={g.category.id}
              heading={g.category.label}
              color={g.category.color}
              commands={g.commands}
              colorByKind={(_k) => g.category.color}
              favorites={favorites}
              onPick={handlePick}
              onToggleFav={toggleFavorite}
            />
          ))
        )}
      </div>
    </div>
  );
}

interface CommandGroupProps {
  readonly heading: string;
  readonly color: string;
  readonly commands: ReadonlyArray<ScriptCommandMetadata>;
  readonly colorByKind: (kind: ScriptStepKind) => string;
  readonly favorites: Set<ScriptStepKind>;
  readonly onPick: (kind: ScriptStepKind) => void;
  readonly onToggleFav: (kind: ScriptStepKind, ev: React.MouseEvent) => void;
}

function CommandGroup({
  heading,
  color,
  commands,
  colorByKind,
  favorites,
  onPick,
  onToggleFav,
}: CommandGroupProps): JSX.Element {
  return (
    <div className="add-event-popover__group">
      <h4 className="add-event-popover__group-heading" style={{ color }}>
        {heading}
        <span className="add-event-popover__group-count">({commands.length})</span>
      </h4>
      <ul className="add-event-popover__group-list">
        {commands.map((cmd) => {
          const isFav = favorites.has(cmd.kind);
          return (
            <li key={cmd.kind} className="add-event-popover__item">
              <button
                type="button"
                className="add-event-popover__item-btn"
                style={{ borderLeftColor: colorByKind(cmd.kind) }}
                onClick={() => onPick(cmd.kind)}
                data-testid={`add-event-popover-pick-${cmd.kind}`}
                title={`${cmd.defaultLabel} (kind: ${cmd.kind})`}
              >
                <span className="add-event-popover__item-icon">{cmd.icon}</span>
                <span className="add-event-popover__item-label">{cmd.defaultLabel}</span>
              </button>
              <button
                type="button"
                className={`add-event-popover__fav${isFav ? ' add-event-popover__fav--on' : ''}`}
                onClick={(e) => onToggleFav(cmd.kind, e)}
                data-testid={`add-event-popover-fav-${cmd.kind}`}
                title={isFav ? 'Remove from favorites' : 'Add to favorites'}
                aria-label={isFav ? 'Unfavorite' : 'Favorite'}
              >
                {isFav ? '★' : '☆'}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
