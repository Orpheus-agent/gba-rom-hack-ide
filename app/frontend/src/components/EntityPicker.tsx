import { useEffect, useMemo, useRef, useState } from 'react';
import type { ProjectManifest } from '@rom-editor/shared';
import { listSymbolsForIdentity, type SymbolKind } from '../lib/symbols';
import { prettifyConstantName } from '../lib/displayName';

/**
 * Phase 7.2 - Reusable name-autocomplete picker for species / moves /
 * items / abilities / maps / trainer-classes / trainers. Replaces the
 * earlier Phase O.17 datalist-backed implementation.
 *
 * Why a custom typeahead (vs the browser's `<datalist>`)?
 *
 *   1. The datalist parses raw numeric input as a complete id and fires
 *      onChange after every keystroke. Typing "7" then "3" then "4" to
 *      mean species 734 commits 7 first, which re-renders the input as
 *      "Bulbasaur (7)" - destroying the in-flight value.
 *
 *   2. Browser-native datalists cap visible results around 10. With
 *      1267 species (CFRU+DPE), the user can't actually see most of
 *      them and search behaviour varies across browsers.
 *
 *   3. Custom dropdown gives us proper keyboard nav (↑/↓/Enter/Esc),
 *      "sorted-by-relevance" filtering (startsWith beats includes),
 *      and a stable visible result count.
 *
 * Commit semantics: typed text lives in local `draft` state and does
 * NOT fire `onChange` until the user commits via:
 *   - Enter key (selects the currently-highlighted result)
 *   - clicking a result
 *   - blur (commits the parsed value if any)
 *   - Esc reverts draft to the canonical current value
 *
 * The displayed name format on idle is `"NAME (id)"` so the operator
 * always sees the numeric id alongside the resolved name.
 */

export type EntityPickerKind =
  | 'species'
  | 'move'
  | 'item'
  | 'ability'
  | 'map'
  | 'trainerClass'
  | 'trainer';

/** Phase O.19 - packed (group, num) → u16 encoding for map picker.
 *  Maps are identified by (mapGroup u8, mapNum u8) in Gen-3 ROMs but
 *  the picker's value is a single number. Pack as `(group << 8) | num`
 *  so callers can use destGroup + destNum independently. */
export function packMapId(group: number, num: number): number {
  return ((group & 0xff) << 8) | (num & 0xff);
}
export function unpackMapGroup(packed: number): number {
  return (packed >> 8) & 0xff;
}
export function unpackMapNum(packed: number): number {
  return packed & 0xff;
}

interface EntityPickerProps {
  readonly kind: EntityPickerKind;
  readonly manifest: ProjectManifest;
  readonly value: number;
  readonly onChange: (next: number) => void;
  readonly minId?: number;
  readonly maxId?: number;
  readonly testIdPrefix?: string;
  readonly disabled?: boolean;
}

interface NamedEntry {
  readonly id: number;
  readonly name: string;
}

/** Phase 7.1 - pretty-format prefix per kind so picker entries read
 *  "Pikachu" / "Hydro Pump" rather than "SPECIES_PIKACHU" /
 *  "MOVE_HYDRO_PUMP". */
const SYMBOL_DB_KIND_PREFIX: Readonly<Record<string, string>> = {
  species: 'SPECIES_',
  move: 'MOVE_',
  item: 'ITEM_',
  ability: 'ABILITY_',
};

/** Phase 7.1 - names like "?", "??????", or empty strings are the
 *  binary scanner's stand-in for slots whose in-ROM name byte was
 *  unreadable. Symbol DB names beat these. */
function looksLikeGarbageName(name: string): boolean {
  const trimmed = name.trim();
  if (trimmed.length === 0) return true;
  if (/^[?]+$/.test(trimmed)) return true;
  return false;
}

function mergeWithSymbolDb(
  kind: SymbolKind,
  manifest: ProjectManifest,
  fromManifest: ReadonlyArray<NamedEntry>,
): ReadonlyArray<NamedEntry> {
  const prefix = SYMBOL_DB_KIND_PREFIX[kind];
  if (!prefix) return fromManifest;
  const byId = new Map<number, NamedEntry>();
  for (const e of fromManifest) byId.set(e.id, e);
  const fromDb = listSymbolsForIdentity(manifest.identity, kind);
  for (const dbEntry of fromDb) {
    const id = Number.parseInt(dbEntry.hex, 16);
    if (!Number.isFinite(id)) continue;
    const pretty = prettifyConstantName(dbEntry.name, prefix);
    const existing = byId.get(id);
    if (!existing || looksLikeGarbageName(existing.name)) {
      byId.set(id, { id, name: pretty });
    }
  }
  return Array.from(byId.values()).sort((a, b) => a.id - b.id);
}

function entriesForKind(
  kind: EntityPickerKind,
  manifest: ProjectManifest,
): ReadonlyArray<NamedEntry> {
  switch (kind) {
    case 'species': {
      const names = manifest.speciesNames ?? [];
      const out: NamedEntry[] = [];
      for (const n of names) {
        out.push({ id: n.speciesIndex, name: n.name });
      }
      return mergeWithSymbolDb('species', manifest, out);
    }
    case 'move': {
      const names = manifest.moveNames ?? [];
      const out: NamedEntry[] = [];
      for (const n of names) {
        out.push({ id: n.moveIndex, name: n.name });
      }
      return mergeWithSymbolDb('move', manifest, out);
    }
    case 'item': {
      const items = manifest.items ?? [];
      const out: NamedEntry[] = [];
      for (const it of items) {
        out.push({ id: it.itemIndex, name: it.name });
      }
      return mergeWithSymbolDb('item', manifest, out);
    }
    case 'ability': {
      const abilities = manifest.abilities ?? [];
      const out: NamedEntry[] = [];
      for (const a of abilities) {
        out.push({ id: a.abilityIndex, name: a.name });
      }
      return mergeWithSymbolDb('ability', manifest, out);
    }
    case 'trainerClass': {
      const classes = manifest.trainerClassNames ?? [];
      const out: NamedEntry[] = [];
      for (const c of classes) {
        out.push({ id: c.classIndex, name: c.name });
      }
      return out;
    }
    case 'trainer': {
      const out: NamedEntry[] = [];
      for (const t of manifest.trainers) {
        const match = /^binary_trainer_(\d+)$/.exec(t.id);
        if (!match) continue;
        const idx = Number.parseInt(match[1]!, 10);
        if (!Number.isFinite(idx)) continue;
        out.push({ id: idx, name: t.name });
      }
      return out;
    }
    case 'map': {
      const maps = manifest.maps;
      const out: NamedEntry[] = [];
      for (const map of maps) {
        const match = /^binary_map_(\d+)_(\d+)$/.exec(map.id);
        if (!match) continue;
        const group = Number.parseInt(match[1]!, 10);
        const num = Number.parseInt(match[2]!, 10);
        if (!Number.isFinite(group) || !Number.isFinite(num)) continue;
        out.push({ id: packMapId(group, num), name: map.name });
      }
      return out;
    }
  }
}

const KIND_PLACEHOLDER: Readonly<Record<EntityPickerKind, string>> = {
  species: 'e.g. Charmander or 4',
  move: 'e.g. Ember or 52',
  item: 'e.g. Potion or 13',
  ability: 'e.g. Blaze or 66',
  map: 'e.g. Pallet Town or Map 1.4',
  trainerClass: 'e.g. Pkmn Trainer or 1',
  trainer: 'e.g. Gary or 5',
};

/** Compose the canonical "NAME (id)" display string. */
function formatCanonical(entry: NamedEntry): string {
  return `${entry.name} (${String(entry.id)})`;
}

/** Parse a raw input value back to a numeric id. Accepts:
 *  - "NAME (id)" - picks id from parens
 *  - "NAME" - exact name match (case-insensitive)
 *  - bare number "734"
 *  Returns null if nothing parses. */
function parseInput(
  raw: string,
  entries: ReadonlyArray<NamedEntry>,
): number | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const parenMatch = /\((\d+)\)\s*$/.exec(trimmed);
  if (parenMatch) {
    const n = Number.parseInt(parenMatch[1]!, 10);
    return Number.isFinite(n) ? n : null;
  }
  if (/^\d+$/.test(trimmed)) {
    return Number.parseInt(trimmed, 10);
  }
  const lower = trimmed.toLowerCase();
  for (const e of entries) {
    if (e.name.toLowerCase() === lower) return e.id;
  }
  return null;
}

const MAX_RESULTS = 100;

/** Rank entries against the user's query. Empty query returns the
 *  full list sorted by id. Otherwise:
 *   1. Exact id match floats to the top.
 *   2. Name starts-with the query (case-insensitive).
 *   3. Name contains the query.
 *   4. Numeric-id-as-string contains the query.
 *  Ties broken by id ascending. */
function filterEntries(
  entries: ReadonlyArray<NamedEntry>,
  query: string,
): ReadonlyArray<NamedEntry> {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return entries.slice(0, MAX_RESULTS);
  const numeric = /^\d+$/.test(q) ? Number.parseInt(q, 10) : null;
  const scored: Array<{ entry: NamedEntry; score: number }> = [];
  for (const e of entries) {
    const name = e.name.toLowerCase();
    let score = 0;
    if (numeric !== null && e.id === numeric) score = 100;
    else if (name === q) score = 90;
    else if (name.startsWith(q)) score = 80;
    else if (name.includes(q)) score = 60;
    else if (numeric !== null && String(e.id).startsWith(q)) score = 40;
    else if (String(e.id).includes(q)) score = 20;
    else continue;
    scored.push({ entry: e, score });
  }
  scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    return a.entry.id - b.entry.id;
  });
  return scored.slice(0, MAX_RESULTS).map((s) => s.entry);
}

export function EntityPicker({
  kind,
  manifest,
  value,
  onChange,
  minId,
  maxId,
  testIdPrefix,
  disabled,
}: EntityPickerProps): JSX.Element {
  const entries = useMemo(() => entriesForKind(kind, manifest), [kind, manifest]);
  const byId = useMemo(() => {
    const m = new Map<number, NamedEntry>();
    for (const e of entries) m.set(e.id, e);
    return m;
  }, [entries]);
  const lo = minId ?? 0;
  const hi = maxId ?? 0xffff;
  const current = byId.get(value);
  const canonical = current ? formatCanonical(current) : String(value);

  // Local input draft. null means "show the canonical value derived
  // from `value`". A non-null draft means the user is typing, and no
  // onChange has fired yet - we hold the visible text in local state
  // so each keystroke doesn't re-derive a numeric value and clobber
  // the in-flight text.
  const [draft, setDraft] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  // Reset highlight whenever the visible result list changes.
  const filtered = useMemo(
    () => filterEntries(entries, draft ?? ''),
    [entries, draft],
  );
  useEffect(() => {
    setHighlight(0);
  }, [draft]);

  // Close the dropdown when clicking outside.
  useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) {
      const t = e.target;
      if (!(t instanceof Node)) return;
      if (containerRef.current && !containerRef.current.contains(t)) {
        setOpen(false);
        setDraft(null);
      }
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  function commitId(rawId: number): void {
    const clamped = Math.max(lo, Math.min(hi, rawId));
    if (clamped !== value) onChange(clamped);
    setDraft(null);
    setOpen(false);
  }

  function commitFromDraft(): void {
    if (draft === null) return;
    const parsed = parseInput(draft, entries);
    if (parsed !== null) {
      commitId(parsed);
    } else {
      // Couldn't parse - revert to the canonical value.
      setDraft(null);
      setOpen(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setHighlight((h) => Math.min(h + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (open && filtered[highlight]) {
        commitId(filtered[highlight]!.id);
      } else {
        commitFromDraft();
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setDraft(null);
      setOpen(false);
    }
  }

  return (
    <div
      ref={containerRef}
      className="entity-picker"
      style={{ position: 'relative', display: 'inline-block' }}
    >
      <input
        type="text"
        value={draft ?? canonical}
        placeholder={KIND_PLACEHOLDER[kind]}
        disabled={disabled}
        data-testid={testIdPrefix ? `${testIdPrefix}-input` : undefined}
        spellCheck={false}
        autoComplete="off"
        onFocus={(e) => {
          e.currentTarget.select();
          setOpen(true);
        }}
        onChange={(e) => {
          setDraft(e.target.value);
          setOpen(true);
        }}
        onKeyDown={handleKeyDown}
        onBlur={() => {
          // Defer so a mousedown on a dropdown row can fire its commit
          // before blur tears down the local draft state.
          window.setTimeout(() => {
            if (draft !== null) commitFromDraft();
            setOpen(false);
          }, 150);
        }}
      />
      {open && filtered.length > 0 && (
        <ul
          className="entity-picker__results"
          data-testid={
            testIdPrefix ? `${testIdPrefix}-results` : 'entity-picker-results'
          }
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            zIndex: 1000,
            margin: 0,
            padding: 0,
            listStyle: 'none',
            background: 'var(--color-bg-elev-1, #1a1a1a)',
            border: '1px solid var(--color-border, #333)',
            borderRadius: 4,
            boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
            maxHeight: 280,
            overflowY: 'auto',
            minWidth: 220,
          }}
        >
          {filtered.map((e, i) => (
            <li
              key={e.id}
              data-testid={
                testIdPrefix
                  ? `${testIdPrefix}-result-${e.id}`
                  : `entity-picker-result-${e.id}`
              }
              onMouseDown={(ev) => {
                // mousedown fires BEFORE blur, so the click registers
                // before the blur handler dismisses the dropdown.
                ev.preventDefault();
                commitId(e.id);
              }}
              onMouseEnter={() => setHighlight(i)}
              style={{
                padding: '4px 10px',
                cursor: 'pointer',
                fontSize: 12,
                lineHeight: '18px',
                background:
                  i === highlight
                    ? 'var(--color-bg-elev-2, #2a3a4a)'
                    : 'transparent',
                color: 'var(--color-text, #eee)',
                display: 'flex',
                justifyContent: 'space-between',
                gap: 12,
              }}
            >
              <span>{e.name}</span>
              <span style={{ opacity: 0.5, fontVariantNumeric: 'tabular-nums' }}>
                #{e.id}
              </span>
            </li>
          ))}
        </ul>
      )}
      {open && filtered.length === 0 && draft && draft.trim().length > 0 && (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            zIndex: 1000,
            padding: '6px 10px',
            background: 'var(--color-bg-elev-1, #1a1a1a)',
            border: '1px solid var(--color-border, #333)',
            borderRadius: 4,
            fontSize: 11,
            color: 'var(--color-text-dim, #888)',
            minWidth: 220,
          }}
        >
          No matches for "{draft}"
        </div>
      )}
    </div>
  );
}
