import { useEffect, useMemo, useState } from 'react';
import type { HealLocationEntry, ProjectManifest } from '@rom-editor/shared';
import { editBinaryRomHealLocation, ProjectApiError } from '../api';
import { pushToast, useProjectStore, useViewStore } from '../state';
import { useEditFormKeyboard } from '../lib/useEditFormKeyboard';
import {
  EntityPicker,
  packMapId,
  unpackMapGroup,
  unpackMapNum,
} from './EntityPicker';
import { displayName } from '../lib/displayName';
import './SpeciesView.css';

/**
 * Phase O.42 step 5/5 - Heal locations workspace.
 *
 * Surfaces every entry from sHealLocations[] (the universal Gen-3
 * spawn table that drives white-out / Fly / Teleport / mom's-house
 * destinations) and lets the operator pick a different destination
 * map or shift the (x, y) coords for each slot. Each entry's 6-byte
 * struct gets patched in place via the new
 * `editBinaryRomHealLocation` route - first-edit creates `<rom>.bak`.
 *
 * Read-only beyond field editing: adding / removing slots requires
 * relocation of the entire sHealLocations array (the SPAWN_* indices
 * are hardcoded constants the rest of the game logic references - 
 * adding a slot also needs script-side changes that vary across
 * forks). Deferred to a later pass.
 */

const HEAL_LOC_COORD_MAX = 511;

interface HealLocationsViewProps {
  readonly manifest: ProjectManifest;
}

export function HealLocationsView({ manifest }: HealLocationsViewProps): JSX.Element {
  const entries = manifest.healLocations ?? [];
  const [filter, setFilter] = useState('');
  const [selectedIdx, setSelectedIdx] = useState<number | null>(
    entries.length > 0 ? 0 : null,
  );
  const filtered = useMemo(() => {
    if (!filter.trim()) return entries;
    const q = filter.toLowerCase();
    return entries.filter((e) => {
      const destLabel = e.destMapId
        ? displayName(manifest, e.destMapId, false).toLowerCase()
        : '';
      return (
        String(e.slotIndex).includes(q) ||
        destLabel.includes(q) ||
        `${e.group}.${e.mapNum}`.includes(q)
      );
    });
  }, [entries, filter, manifest]);
  const selected =
    selectedIdx !== null && selectedIdx >= 0 && selectedIdx < entries.length
      ? entries[selectedIdx]!
      : null;

  if (entries.length === 0) {
    return (
      <div className="species-view species-view--empty">
        <h2>No heal locations</h2>
        <p>
          The heal_locations_system detector didn't lift any entries - either
          this ROM doesn't have a recognizable sHealLocations table or its
          layout falls outside the detector's heuristic (group ≤ 50,
          mapNum ≤ 200, x/y ∈ [0, 511], ≥ 8 consecutive entries with ≥ 50%
          non-zero mapNum).
        </p>
      </div>
    );
  }

  return (
    <div className="species-view">
      <aside className="species-view__list">
        <input
          type="search"
          className="species-view__filter"
          placeholder="Filter by slot / map / group.num…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          data-testid="heal-locations-view-filter"
          spellCheck={false}
        />
        <ul>
          {filtered.map((entry) => {
            const realIdx = entries.indexOf(entry);
            const destLabel = entry.destMapId
              ? displayName(manifest, entry.destMapId, false)
              : `Map ${entry.group}.${entry.mapNum}`;
            return (
              <li key={entry.id}>
                <button
                  type="button"
                  className={`species-view__item${realIdx === selectedIdx ? ' species-view__item--selected' : ''}`}
                  data-testid={`heal-locations-view-item-${entry.id}`}
                  onClick={() => setSelectedIdx(realIdx)}
                >
                  <span className="species-view__item-idx">#{entry.slotIndex}</span>
                  <span className="species-view__item-name">
                    {destLabel}
                    {/* Phase O.69 - surface the tile coord in the
                        list row so operators can scan all 13
                        FRLG heal locations + their landing tiles
                        without opening each detail pane. */}
                    <span
                      className="species-view__item-meta"
                      data-testid={`heal-locations-view-item-coord-${entry.id}`}
                      style={{
                        marginLeft: 8,
                        color: 'var(--color-text-muted)',
                        fontSize: 11,
                      }}
                    >
                      ({entry.x}, {entry.y})
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </aside>
      <section className="species-view__detail">
        {selected ? (
          <HealLocationEditor entry={selected} manifest={manifest} />
        ) : (
          <p>Pick a heal location to edit.</p>
        )}
      </section>
    </div>
  );
}

type SaveState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'saving' }
  | { readonly kind: 'saved' }
  | { readonly kind: 'error'; readonly message: string };

function HealLocationEditor({
  entry,
  manifest,
}: {
  readonly entry: HealLocationEntry;
  readonly manifest: ProjectManifest;
}): JSX.Element {
  const sessionId = useProjectStore((s) =>
    s.load.kind === 'loaded' ? s.load.data.session.id : null,
  );
  const scanCurrent = useProjectStore((s) => s.scanCurrentProject);
  const openMapInEditor = useViewStore((s) => s.openMapInEditor);
  const [group, setGroup] = useState(entry.group);
  const [mapNum, setMapNum] = useState(entry.mapNum);
  const [x, setX] = useState(entry.x);
  const [y, setY] = useState(entry.y);
  const [state, setState] = useState<SaveState>({ kind: 'idle' });

  useEffect(() => {
    setGroup(entry.group);
    setMapNum(entry.mapNum);
    setX(entry.x);
    setY(entry.y);
    setState({ kind: 'idle' });
  }, [entry.id, entry.group, entry.mapNum, entry.x, entry.y]);

  const dirty =
    group !== entry.group ||
    mapNum !== entry.mapNum ||
    x !== entry.x ||
    y !== entry.y;
  const canSave =
    dirty &&
    sessionId !== null &&
    x >= 0 &&
    x <= HEAL_LOC_COORD_MAX &&
    y >= 0 &&
    y <= HEAL_LOC_COORD_MAX;

  async function save(): Promise<void> {
    if (!sessionId || !canSave) return;
    setState({ kind: 'saving' });
    try {
      const fields: {
        group?: number;
        mapNum?: number;
        x?: number;
        y?: number;
      } = {};
      if (group !== entry.group) fields.group = group;
      if (mapNum !== entry.mapNum) fields.mapNum = mapNum;
      if (x !== entry.x) fields.x = x;
      if (y !== entry.y) fields.y = y;
      await editBinaryRomHealLocation(sessionId, {
        sourceFileOffset: entry.sourceFileOffset,
        fields,
      });
      setState({ kind: 'saved' });
      pushToast('success', `Heal location #${entry.slotIndex} saved`);
      await scanCurrent();
    } catch (e) {
      const message =
        e instanceof ProjectApiError
          ? `${e.code}: ${e.message}`
          : e instanceof Error
            ? e.message
            : String(e);
      setState({ kind: 'error', message });
      pushToast('error', `Heal location save failed - ${message}`);
    }
  }

  const onKeyDownEdit = useEditFormKeyboard({
    canSave: canSave && state.kind !== 'saving',
    save,
    cancel: () => {
      setGroup(entry.group);
      setMapNum(entry.mapNum);
      setX(entry.x);
      setY(entry.y);
      setState({ kind: 'idle' });
    },
    isSaving: state.kind === 'saving',
  });

  return (
    <div className="species-editor" onKeyDown={onKeyDownEdit}>
      <header>
        <h2>Heal location #{entry.slotIndex}</h2>
        <p>
          {entry.destMapId
            ? `Destination: ${displayName(manifest, entry.destMapId, false)}`
            : 'Destination map is outside the scanned range'}
        </p>
      </header>
      <fieldset>
        <legend>Destination</legend>
        <div className="species-field-grid">
          <label className="species-field">
            <span>Map (group.num)</span>
            <EntityPicker
              kind="map"
              manifest={manifest}
              value={packMapId(group, mapNum)}
              onChange={(next) => {
                setGroup(unpackMapGroup(next));
                setMapNum(unpackMapNum(next));
              }}
              minId={0}
              maxId={0xffff}
              testIdPrefix={`heal-loc-map-${entry.id}`}
            />
          </label>
        </div>
        <div className="species-field-grid">
          <label className="species-field">
            <span>x (tile)</span>
            <input
              type="number"
              min={0}
              max={HEAL_LOC_COORD_MAX}
              value={x}
              onChange={(e) =>
                setX(
                  Math.max(
                    0,
                    Math.min(
                      HEAL_LOC_COORD_MAX,
                      Number.parseInt(e.target.value, 10) || 0,
                    ),
                  ),
                )
              }
              data-testid={`heal-loc-x-${entry.id}`}
            />
          </label>
          <label className="species-field">
            <span>y (tile)</span>
            <input
              type="number"
              min={0}
              max={HEAL_LOC_COORD_MAX}
              value={y}
              onChange={(e) =>
                setY(
                  Math.max(
                    0,
                    Math.min(
                      HEAL_LOC_COORD_MAX,
                      Number.parseInt(e.target.value, 10) || 0,
                    ),
                  ),
                )
              }
              data-testid={`heal-loc-y-${entry.id}`}
            />
          </label>
        </div>
      </fieldset>
      <div className="species-editor__actions">
        <button
          type="button"
          className="btn btn--primary"
          disabled={!canSave || state.kind === 'saving'}
          onClick={() => void save()}
          data-testid={`heal-loc-save-${entry.id}`}
        >
          {state.kind === 'saving' ? 'Saving…' : 'Save heal location'}
        </button>
        {/* Phase O.49 - jump to destination map. Disabled when no map
            resolved (group/mapNum points outside the lifted map table).
            Phase O.80 - extra defensive check: verify the id still
            exists in the live manifest before rendering. Cross-ref 21
            only sets destMapId on a match at lift-time, but a re-scan
            that drops the map would leave a stale reference. Mirrors
            the O.78/O.79 defense-in-depth pattern. */}
        {entry.destMapId &&
          manifest.maps.some((m) => m.id === entry.destMapId) && (
            <button
              type="button"
              className="btn btn--secondary"
              data-testid={`heal-loc-show-on-map-${entry.id}`}
              onClick={() => openMapInEditor(entry.destMapId!)}
            >
              → Show on map
            </button>
          )}
        {state.kind === 'saved' && !dirty && (
          <span className="fields-editor__status fields-editor__status--saved">
            Saved · 6-byte struct patched
          </span>
        )}
        {state.kind === 'error' && (
          <span className="fields-editor__status fields-editor__status--error">
            {state.message}
          </span>
        )}
      </div>
      <p style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 8 }}>
        Slot indices are SPAWN_* constants the game logic references by
        index - changing slot 0's destination changes where SPAWN_PALLET_TOWN
        sends the player (white-out, mom's house initial spawn).
        Adding / removing slots requires script changes elsewhere in the
        ROM; not exposed here.
      </p>
    </div>
  );
}
