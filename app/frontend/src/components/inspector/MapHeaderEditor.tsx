import { useEffect, useState } from 'react';
import type { MapNode, ProjectManifest } from '@rom-editor/shared';
import {
  editBinaryRomMapConnection,
  editBinaryRomMapConnectionAppend,
  editBinaryRomMapConnectionDelete,
  editBinaryRomMapDimensions,
  editBinaryRomMapEventTable,
  editBinaryRomMapHeader,
  editBinaryRomObjectEventTable,
  ProjectApiError,
} from '../../api';
import { pushToast, useProjectStore, useUiPreferencesStore, useViewStore } from '../../state';
import { displayName, prettifyMapName } from '../../lib/displayName';
import { EncounterTablesView } from './EncounterTablesView';
import {
  EntityPicker,
  packMapId,
  unpackMapGroup,
  unpackMapNum,
} from '../EntityPicker';
import { useEditFormKeyboard } from '../../lib/useEditFormKeyboard';

/**
 * Phase I.4 - edit map header u8 / u16 fields (music id, region map
 * section, weather, battle type, etc.) for binary-ROM maps. Backed by
 * the new `POST /binary-rom-edit/map-header` route that patches the
 * 28-byte MapHeader struct in place at the offset stashed on the map's
 * metadata.
 *
 * Visible in the right-rail inspector when no marker/tile is selected
 * so the operator can edit the map's identity (which song plays here,
 * which area name shows on the player's pause-menu region map, etc.)
 * without having to leave the editor.
 */

interface MapHeaderEditorProps {
  readonly map: MapNode;
  readonly manifest: ProjectManifest;
  readonly showInternalIds: boolean;
}

type SaveState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'saving' }
  | { readonly kind: 'saved' }
  | { readonly kind: 'error'; readonly message: string };

/** Gen-3 weather constants per pret/pokefirered include/constants/weather.h. */
const WEATHER_OPTIONS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 0, label: '0 - None' },
  { value: 1, label: '1 - Sunny' },
  { value: 2, label: '2 - Rain' },
  { value: 3, label: '3 - Snow' },
  { value: 4, label: '4 - Rain (thunder)' },
  { value: 5, label: '5 - Fog (horizontal)' },
  { value: 6, label: '6 - Volcanic ash' },
  { value: 7, label: '7 - Sandstorm' },
  { value: 8, label: '8 - Fog (diagonal)' },
  { value: 9, label: '9 - Underwater' },
  { value: 10, label: '10 - Shade' },
  { value: 11, label: '11 - Drought' },
  { value: 12, label: '12 - Downpour' },
  { value: 13, label: '13 - Underwater bubbles' },
  { value: 14, label: '14 - Abnormal' },
  { value: 15, label: '15 - Route 119 cycle' },
  { value: 16, label: '16 - Route 123 cycle' },
];

/** Map type constants per pret/pokefirered include/constants/map_types.h. */
const MAP_TYPE_OPTIONS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 0, label: '0 - None' },
  { value: 1, label: '1 - Town' },
  { value: 2, label: '2 - City' },
  { value: 3, label: '3 - Route' },
  { value: 4, label: '4 - Underground' },
  { value: 5, label: '5 - Underwater' },
  { value: 6, label: '6 - Ocean route' },
  { value: 7, label: '7 - Unknown' },
  { value: 8, label: '8 - Indoor' },
  { value: 9, label: '9 - Secret base' },
];

const BATTLE_TYPE_OPTIONS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 0, label: '0 - Standard' },
  { value: 1, label: '1 - Gym' },
  { value: 2, label: '2 - Elite Four' },
  { value: 3, label: '3 - Champion' },
  { value: 4, label: '4 - Final boss' },
  { value: 5, label: '5 - Eevee evolution' },
  { value: 6, label: '6 - Wallace' },
  { value: 7, label: '7 - Frontier (Battle Tower)' },
  { value: 8, label: '8 - Frontier (Battle Dome)' },
];

export function MapHeaderEditor({
  map,
  manifest,
  showInternalIds,
}: MapHeaderEditorProps) {
  const sessionId = useProjectStore((s) =>
    s.load.kind === 'loaded' ? s.load.data.session.id : null,
  );
  const scanCurrent = useProjectStore((s) => s.scanCurrentProject);

  const headerOffset =
    typeof map.metadata['mapHeaderOffset'] === 'number'
      ? (map.metadata['mapHeaderOffset'] as number)
      : -1;

  const initialMusicId =
    typeof map.musicId === 'string'
      ? Number.parseInt(map.musicId.replace(/^song_/, ''), 10) || 0
      : 0;
  const initialRegionMapSectionId =
    typeof map.metadata['regionMapSectionId'] === 'number'
      ? (map.metadata['regionMapSectionId'] as number)
      : 0;
  const initialWeather =
    typeof map.metadata['weather'] === 'number'
      ? (map.metadata['weather'] as number)
      : 0;
  const initialMapType =
    typeof map.metadata['mapType'] === 'number'
      ? (map.metadata['mapType'] as number)
      : 0;
  const initialBattleType =
    typeof map.metadata['battleType'] === 'number'
      ? (map.metadata['battleType'] as number)
      : 0;
  const initialCaveOrType =
    typeof map.metadata['caveOrType'] === 'number'
      ? (map.metadata['caveOrType'] as number)
      : 0;
  const initialFlags =
    typeof map.metadata['flags'] === 'number'
      ? (map.metadata['flags'] as number)
      : 0;

  const [musicId, setMusicId] = useState(initialMusicId);
  const [regionMapSectionId, setRegionMapSectionId] = useState(initialRegionMapSectionId);
  const [weather, setWeather] = useState(initialWeather);
  const [mapType, setMapType] = useState(initialMapType);
  const [battleType, setBattleType] = useState(initialBattleType);
  const [caveOrType, setCaveOrType] = useState(initialCaveOrType);
  const [flags, setFlags] = useState(initialFlags);
  const [state, setState] = useState<SaveState>({ kind: 'idle' });

  useEffect(() => {
    setMusicId(initialMusicId);
    setRegionMapSectionId(initialRegionMapSectionId);
    setWeather(initialWeather);
    setMapType(initialMapType);
    setBattleType(initialBattleType);
    setCaveOrType(initialCaveOrType);
    setFlags(initialFlags);
    setState({ kind: 'idle' });
  }, [
    map.id,
    initialMusicId,
    initialRegionMapSectionId,
    initialWeather,
    initialMapType,
    initialBattleType,
    initialCaveOrType,
    initialFlags,
  ]);

  const dirty =
    musicId !== initialMusicId ||
    regionMapSectionId !== initialRegionMapSectionId ||
    weather !== initialWeather ||
    mapType !== initialMapType ||
    battleType !== initialBattleType ||
    caveOrType !== initialCaveOrType ||
    flags !== initialFlags;
  const canSave = dirty && headerOffset > 0 && sessionId !== null;

  async function save(): Promise<void> {
    if (!sessionId || headerOffset <= 0) return;
    setState({ kind: 'saving' });
    try {
      await editBinaryRomMapHeader(sessionId, {
        mapHeaderOffset: headerOffset,
        fields: {
          ...(musicId !== initialMusicId ? { musicId } : {}),
          ...(regionMapSectionId !== initialRegionMapSectionId
            ? { regionMapSectionId }
            : {}),
          ...(weather !== initialWeather ? { weather } : {}),
          ...(mapType !== initialMapType ? { mapType } : {}),
          ...(battleType !== initialBattleType ? { battleType } : {}),
          ...(caveOrType !== initialCaveOrType ? { caveOrType } : {}),
          ...(flags !== initialFlags ? { flags } : {}),
        },
      });
      setState({ kind: 'saved' });
      pushToast('success', 'Map header saved');
      await scanCurrent();
    } catch (e) {
      const message =
        e instanceof ProjectApiError
          ? `${e.code}: ${e.message}`
          : e instanceof Error
            ? e.message
            : String(e);
      setState({ kind: 'error', message });
      pushToast('error', `Map header save failed - ${message}`);
    }
  }

  // Phase O.28 - Enter saves, Esc reverts header fields.
  const onKeyDownHeader = useEditFormKeyboard({
    canSave: canSave && state.kind !== 'saving',
    save,
    cancel: () => {
      setMusicId(initialMusicId);
      setRegionMapSectionId(initialRegionMapSectionId);
      setWeather(initialWeather);
      setMapType(initialMapType);
      setBattleType(initialBattleType);
      setCaveOrType(initialCaveOrType);
      setFlags(initialFlags);
      setState({ kind: 'idle' });
    },
    isSaving: state.kind === 'saving',
  });

  if (headerOffset <= 0) {
    return (
      <div className="map-editor__inspector-empty">
        Map header not editable - this map's binary-rom header offset isn't
        in the manifest yet. (Decomp maps edit via map.json.)
      </div>
    );
  }

  // Resolve the region map section name from the manifest for context.
  const sectionNameById = new Map<number, string>();
  for (const s of manifest.regionMapSections ?? []) {
    sectionNameById.set(s.sectionIndex, s.name);
  }

  return (
    <div className="map-editor__selected" data-testid="map-editor-selected-map">
      <span className="map-editor__kind-badge" style={{ color: '#7c8088' }}>
        map header
      </span>
      <h4>
        {prettifyMapName(map.name, map.id)}
        {showInternalIds && (
          <span className="map-editor__title-internal-id"> ({map.id})</span>
        )}
      </h4>
      <dl>
        <dt>Header @</dt>
        <dd>0x{headerOffset.toString(16)}</dd>
        <dt>Dimensions</dt>
        <dd>
          {map.dimensions.width} × {map.dimensions.height} tiles
        </dd>
        <dt>Tilesets</dt>
        <dd>{map.tilesetIds.length}</dd>
      </dl>
      <div
        className="fields-editor"
        data-testid="map-header-fields"
        onKeyDown={onKeyDownHeader}
      >
        <h5 className="fields-editor__heading">Map header</h5>
        <div className="fields-editor__row">
          <label>
            Music id (u16)
            <input
              type="number"
              min={0}
              max={0xffff}
              data-testid="map-header-music-id"
              value={musicId}
              onChange={(e) =>
                setMusicId(
                  Math.max(0, Math.min(0xffff, Number.parseInt(e.target.value, 10) || 0)),
                )
              }
            />
            <span className="fields-editor__hint">
              {musicId !== 0 ? displayName(manifest, `song_${musicId}`, false) : '(silent)'}
            </span>
          </label>
        </div>
        <div className="fields-editor__row">
          <label>
            Region map section (u8) - pause-menu area name
            <input
              type="number"
              min={0}
              max={0xff}
              data-testid="map-header-region-id"
              value={regionMapSectionId}
              onChange={(e) =>
                setRegionMapSectionId(
                  Math.max(0, Math.min(0xff, Number.parseInt(e.target.value, 10) || 0)),
                )
              }
            />
            <span className="fields-editor__hint">
              {sectionNameById.get(regionMapSectionId) ?? '(no name detected for this id)'}
            </span>
          </label>
        </div>
        <div className="fields-editor__row">
          <label>
            Weather
            <select
              data-testid="map-header-weather"
              value={weather}
              onChange={(e) => setWeather(Number.parseInt(e.target.value, 10))}
            >
              {WEATHER_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
              {!WEATHER_OPTIONS.some((o) => o.value === weather) && (
                <option value={weather}>{`${weather} - Hack-specific`}</option>
              )}
            </select>
          </label>
        </div>
        <div className="fields-editor__row">
          <label>
            Map type
            <select
              data-testid="map-header-map-type"
              value={mapType}
              onChange={(e) => setMapType(Number.parseInt(e.target.value, 10))}
            >
              {MAP_TYPE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
              {!MAP_TYPE_OPTIONS.some((o) => o.value === mapType) && (
                <option value={mapType}>{`${mapType} - Hack-specific`}</option>
              )}
            </select>
          </label>
        </div>
        <div className="fields-editor__row">
          <label>
            Battle type
            <select
              data-testid="map-header-battle-type"
              value={battleType}
              onChange={(e) => setBattleType(Number.parseInt(e.target.value, 10))}
            >
              {BATTLE_TYPE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
              {!BATTLE_TYPE_OPTIONS.some((o) => o.value === battleType) && (
                <option value={battleType}>{`${battleType} - Hack-specific`}</option>
              )}
            </select>
          </label>
        </div>
        <div className="fields-editor__row fields-editor__row--inline">
          <label>
            Cave/type (u8)
            <input
              type="number"
              min={0}
              max={0xff}
              data-testid="map-header-cave"
              value={caveOrType}
              onChange={(e) =>
                setCaveOrType(
                  Math.max(0, Math.min(0xff, Number.parseInt(e.target.value, 10) || 0)),
                )
              }
            />
          </label>
          <label>
            Flags (u8)
            <input
              type="number"
              min={0}
              max={0xff}
              data-testid="map-header-flags"
              value={flags}
              onChange={(e) =>
                setFlags(
                  Math.max(0, Math.min(0xff, Number.parseInt(e.target.value, 10) || 0)),
                )
              }
            />
          </label>
        </div>
        <div className="fields-editor__actions">
          <button
            type="button"
            className="btn btn--primary"
            data-testid="map-header-save"
            disabled={!canSave || state.kind === 'saving'}
            onClick={() => void save()}
          >
            {state.kind === 'saving' ? 'Saving…' : 'Save map header'}
          </button>
          {state.kind === 'saved' && !dirty && (
            <span className="fields-editor__status fields-editor__status--saved">
              Saved · ROM patched in place
            </span>
          )}
          {state.kind === 'error' && (
            <span className="fields-editor__status fields-editor__status--error">
              {state.message}
            </span>
          )}
        </div>
      </div>
      <MapDimensionsCard map={map} />
      <AddNpcCard map={map} />
      <ConnectionsCard map={map} manifest={manifest} />
      <IncomingWarpsCard map={map} manifest={manifest} />
      <IncomingHealLocationsCard map={map} manifest={manifest} />
      <EncounterTablesView mapId={map.id} manifest={manifest} />
    </div>
  );
}

/** Phase O.85 - read-only hint card listing every warp from another
 *  map that targets the open map. Mirrors O.48's heal-locations
 *  card. Helps operators see "what places lead here?" without
 *  hunting through every other map's warp list.
 *
 *  Vanilla FRLG: Pallet Town has ~6 inbound warps (Mom's house x2,
 *  Player's house x2, Rival's house x2). Routes have ~2-4 each. */
function IncomingWarpsCard({
  map,
  manifest,
}: {
  map: import('@rom-editor/shared').MapNode;
  manifest: ProjectManifest;
}): JSX.Element | null {
  const incoming = manifest.warps.filter((w) => w.toMapId === map.id);
  if (incoming.length === 0) return null;
  // Group by source map so the list reads "From <Map>: warp #N, warp
  // #M" instead of one row per warp. With ~6 inbound warps on Pallet
  // Town from 3 source maps, grouping cuts the row count in half.
  const bySource = new Map<string, typeof incoming>();
  for (const w of incoming) {
    const existing = bySource.get(w.fromMapId);
    if (existing) {
      existing.push(w);
    } else {
      bySource.set(w.fromMapId, [w]);
    }
  }
  return (
    <div
      className="fields-editor fields-editor--readonly"
      data-testid="incoming-warps-card"
    >
      <h5 className="fields-editor__heading">
        Incoming warps · {incoming.length}
      </h5>
      <p className="fields-editor__note">
        Other maps that warp the player into this one:
      </p>
      <ul style={{ margin: '4px 0 0 0', paddingLeft: 18, fontSize: 12 }}>
        {Array.from(bySource.entries()).map(([sourceId, warps]) => {
          const sourceMap = manifest.maps.find((m) => m.id === sourceId);
          const sourceLabel = sourceMap
            ? prettifyMapName(sourceMap.name, sourceMap.id)
            : sourceId;
          return (
            <li
              key={sourceId}
              data-testid={`incoming-warp-from-${sourceId}`}
            >
              <strong>{sourceLabel}</strong> · {warps.length} warp
              {warps.length === 1 ? '' : 's'}{' '}
              ({warps
                .map((w) => `(${w.fromCoord.x}, ${w.fromCoord.y})`)
                .join(', ')})
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Phase O.48 - read-only hint card listing every heal location whose
 *  destMapId resolved to the open map. Helps operators see the
 *  inbound SPAWN_* warps without enabling the map-canvas layer
 *  overlay. Hidden when the map has no incoming heal locations
 *  (which is the common case - vanilla FRLG has ~13 total). */
function IncomingHealLocationsCard({
  map,
  manifest,
}: {
  map: import('@rom-editor/shared').MapNode;
  manifest: ProjectManifest;
}): JSX.Element | null {
  const incoming = (manifest.healLocations ?? []).filter(
    (h) => h.destMapId === map.id,
  );
  if (incoming.length === 0) return null;
  return (
    <div
      className="fields-editor fields-editor--readonly"
      data-testid="incoming-heal-locations-card"
    >
      <h5 className="fields-editor__heading">
        Incoming heal locations · {incoming.length}
      </h5>
      <p className="fields-editor__note">
        The game warps the player here on white-out / Fly / Teleport via:
      </p>
      <ul style={{ margin: '4px 0 0 0', paddingLeft: 18, fontSize: 12 }}>
        {incoming.map((h) => (
          <li key={h.id} data-testid={`incoming-heal-${h.id}`}>
            <strong>Slot #{h.slotIndex}</strong> at ({h.x}, {h.y})
          </li>
        ))}
      </ul>
      <p className="fields-editor__note" style={{ marginTop: 6 }}>
        Edit destinations + coords in the Heal Locations sidebar tab.
      </p>
    </div>
  );
}

/** Phase N.1 - map connections viewer. Lists every directional link
 *  (DOWN/UP/LEFT/RIGHT/DIVE/EMERGE) the engine detected, with a
 *  "Jump to →" button that opens the destination map in the editor.
 *  Editing the direction byte / dest map / offset writes to the
 *  12-byte MapConnection struct in place. */
const CONNECTION_DIRECTION_NAMES: ReadonlyArray<{ value: number; label: string }> = [
  { value: 0, label: 'None' },
  { value: 1, label: 'Down (south)' },
  { value: 2, label: 'Up (north)' },
  { value: 3, label: 'Left (west)' },
  { value: 4, label: 'Right (east)' },
  { value: 5, label: 'Dive (underwater)' },
  { value: 6, label: 'Emerge (surface)' },
];

function ConnectionsCard({
  map,
  manifest,
}: {
  map: import('@rom-editor/shared').MapNode;
  manifest: import('@rom-editor/shared').ProjectManifest;
}): JSX.Element | null {
  if (!map.connections || map.connections.length === 0) return null;
  return (
    <div className="fields-editor" data-testid="connections-card">
      <h5 className="fields-editor__heading">
        Map connections ({map.connections.length})
      </h5>
      <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 6 }}>
        {map.connections.map((c, i) => (
          <ConnectionRow
            key={c.fileOffset}
            connection={c}
            connectionIndex={i}
            map={map}
            manifest={manifest}
          />
        ))}
      </ul>
      {/* Phase O.7 - Add connection button. Relocates the parent
          connections array into free ROM space and updates the
          MapConnections header's count + pointer. */}
      <AddConnectionButton map={map} manifest={manifest} />
      <p className="fields-editor__hint">
        Edit a connection in place to change which map it leads to or
        which direction it fires on. Add connection relocates the
        connections array (allocates a new larger one in free ROM
        space). Removing connections still queued.
      </p>
    </div>
  );
}

const CONNECTION_DIRECTION_OPTIONS: ReadonlyArray<{
  value: number;
  label: string;
}> = [
  { value: 1, label: 'Down (south)' },
  { value: 2, label: 'Up (north)' },
  { value: 3, label: 'Left (west)' },
  { value: 4, label: 'Right (east)' },
  { value: 5, label: 'Dive' },
  { value: 6, label: 'Emerge' },
];

function AddConnectionButton({
  map,
  manifest,
}: {
  map: import('@rom-editor/shared').MapNode;
  manifest: import('@rom-editor/shared').ProjectManifest;
}): JSX.Element | null {
  const sessionId = useProjectStore((s) =>
    s.load.kind === 'loaded' ? s.load.data.session.id : null,
  );
  const scanCurrent = useProjectStore((s) => s.scanCurrentProject);
  const [open, setOpen] = useState(false);
  const [direction, setDirection] = useState(1);
  const [offset, setOffset] = useState(0);
  const [destMapGroup, setDestMapGroup] = useState(0);
  const [destMapNum, setDestMapNum] = useState(0);
  const [state, setState] = useState<
    { kind: 'idle' } | { kind: 'saving' } | { kind: 'error'; message: string }
  >({ kind: 'idle' });

  const headerOffset =
    typeof map.metadata['binaryRomConnectionsHeaderOffset'] === 'number'
      ? (map.metadata['binaryRomConnectionsHeaderOffset'] as number)
      : -1;
  const arrayOffset =
    typeof map.metadata['binaryRomConnectionsArrayOffset'] === 'number'
      ? (map.metadata['binaryRomConnectionsArrayOffset'] as number)
      : -1;
  const GBA_ROM_BASE = 0x08000000;
  const currentCount = map.connections?.length ?? 0;
  const currentPointer = arrayOffset > 0 ? (GBA_ROM_BASE + arrayOffset) >>> 0 : 0;

  if (headerOffset <= 0) {
    // Map has no MapConnections struct at all - adding the first
    // connection needs a different flow that allocates the 8-byte
    // header itself. Deferred.
    return null;
  }

  async function add(): Promise<void> {
    if (!sessionId) return;
    setState({ kind: 'saving' });
    try {
      const r = await editBinaryRomMapConnectionAppend(sessionId, {
        connectionsHeaderOffset: headerOffset,
        currentCount,
        currentConnectionsArrayPointer: currentPointer,
        newConnection: { direction, offset, destMapGroup, destMapNum },
      });
      setState({ kind: 'idle' });
      pushToast(
        'success',
        `Connection added - map now has ${String(r.newCount)} connection${r.newCount === 1 ? '' : 's'}`,
      );
      setOpen(false);
      await scanCurrent();
    } catch (e) {
      const message =
        e instanceof ProjectApiError
          ? `${e.code}: ${e.message}`
          : e instanceof Error
            ? e.message
            : String(e);
      setState({ kind: 'error', message });
      pushToast('error', `Add connection failed - ${message}`);
    }
  }

  if (!open) {
    return (
      <div className="fields-editor__actions" style={{ marginTop: 8 }}>
        <button
          type="button"
          className="btn btn--secondary"
          onClick={() => setOpen(true)}
          data-testid="add-connection-open"
        >
          {`＋ Add connection (${currentCount} current)`}
        </button>
      </div>
    );
  }
  return (
    <div
      className="fields-editor"
      data-testid="add-connection-form"
      style={{ marginTop: 8, padding: 8, border: '1px solid var(--color-border)' }}
    >
      <h5 className="fields-editor__heading">New connection</h5>
      <label className="fields-editor__row">
        <span>Direction</span>
        <select
          value={direction}
          onChange={(e) => setDirection(parseInt(e.target.value, 10))}
        >
          {CONNECTION_DIRECTION_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </label>
      <label className="fields-editor__row">
        <span>Offset (tile)</span>
        <input
          type="number"
          value={offset}
          onChange={(e) => setOffset(parseInt(e.target.value, 10) || 0)}
        />
      </label>
      <label className="fields-editor__row">
        <span>Destination map</span>
        {/* Phase O.19 - single map picker replaces twin (group, num)
            inputs. Pack the current values into a u16 and unpack the
            picker's choice back into separate group + num for the
            route. */}
        <EntityPicker
          kind="map"
          manifest={manifest}
          value={packMapId(destMapGroup, destMapNum)}
          onChange={(next) => {
            setDestMapGroup(unpackMapGroup(next));
            setDestMapNum(unpackMapNum(next));
          }}
          minId={0}
          maxId={0xffff}
          testIdPrefix="add-connection-dest"
        />
      </label>
      <div className="fields-editor__actions">
        <button
          type="button"
          className="btn btn--primary"
          disabled={state.kind === 'saving'}
          onClick={() => void add()}
          data-testid="add-connection-save"
        >
          {state.kind === 'saving' ? 'Adding…' : 'Add'}
        </button>
        <button
          type="button"
          className="btn btn--secondary"
          onClick={() => {
            setOpen(false);
            setState({ kind: 'idle' });
          }}
        >
          Cancel
        </button>
        {state.kind === 'error' && (
          <span className="fields-editor__status fields-editor__status--error">
            {state.message}
          </span>
        )}
      </div>
    </div>
  );
}

function ConnectionRow({
  connection,
  connectionIndex,
  map,
  manifest,
}: {
  connection: import('@rom-editor/shared').MapConnectionLink;
  connectionIndex: number;
  map: import('@rom-editor/shared').MapNode;
  manifest: import('@rom-editor/shared').ProjectManifest;
}): JSX.Element {
  const sessionId = useProjectStore((s) =>
    s.load.kind === 'loaded' ? s.load.data.session.id : null,
  );
  const scanCurrent = useProjectStore((s) => s.scanCurrentProject);
  const openMapInEditor = useViewStore((s) => s.openMapInEditor);
  const showInternalIds = useUiPreferencesStore((s) => s.showInternalIds);
  const [editing, setEditing] = useState(false);
  const [direction, setDirection] = useState(connection.direction);
  const [offset, setOffset] = useState(connection.offset);
  const [destGroup, setDestGroup] = useState(connection.destMapGroup);
  const [destNum, setDestNum] = useState(connection.destMapNum);
  const [state, setState] = useState<SaveState>({ kind: 'idle' });
  useEffect(() => {
    setDirection(connection.direction);
    setOffset(connection.offset);
    setDestGroup(connection.destMapGroup);
    setDestNum(connection.destMapNum);
    setState({ kind: 'idle' });
  }, [
    connection.fileOffset,
    connection.direction,
    connection.offset,
    connection.destMapGroup,
    connection.destMapNum,
  ]);

  const dirty =
    direction !== connection.direction ||
    offset !== connection.offset ||
    destGroup !== connection.destMapGroup ||
    destNum !== connection.destMapNum;
  const canSave =
    dirty && sessionId !== null && state.kind !== 'saving';
  const cancelEdit = (): void => {
    setEditing(false);
    setDirection(connection.direction);
    setOffset(connection.offset);
    setDestGroup(connection.destMapGroup);
    setDestNum(connection.destMapNum);
    setState({ kind: 'idle' });
  };

  async function save(): Promise<void> {
    if (!sessionId || !dirty) return;
    setState({ kind: 'saving' });
    try {
      const fields: {
        direction?: number;
        offset?: number;
        destMapGroup?: number;
        destMapNum?: number;
      } = {};
      if (direction !== connection.direction) fields.direction = direction;
      if (offset !== connection.offset) fields.offset = offset;
      if (destGroup !== connection.destMapGroup) fields.destMapGroup = destGroup;
      if (destNum !== connection.destMapNum) fields.destMapNum = destNum;
      await editBinaryRomMapConnection(sessionId, {
        slotFileOffset: connection.fileOffset,
        fields,
      });
      setState({ kind: 'saved' });
      pushToast('success', 'Connection saved');
      await scanCurrent();
      setEditing(false);
    } catch (e) {
      const message =
        e instanceof ProjectApiError
          ? `${e.code}: ${e.message}`
          : e instanceof Error
            ? e.message
            : String(e);
      setState({ kind: 'error', message });
      pushToast('error', `Connection save failed - ${message}`);
    }
  }

  const dirLabel =
    CONNECTION_DIRECTION_NAMES.find((d) => d.value === connection.direction)?.label ??
    `Direction ${connection.direction}`;
  const destName = connection.destMapId
    ? displayName(manifest, connection.destMapId, showInternalIds)
    : `Map ${connection.destMapGroup}.${connection.destMapNum} (unresolved)`;

  // Phase O.9 - delete handler. Pulls header offset + array pointer +
  // current count from the map's metadata (lifter stashed them at
  // binary-rom-registry:618-621). Gated on the metadata fields being
  // present + currentCount ≥ 1.
  const headerOffset =
    typeof map.metadata['binaryRomConnectionsHeaderOffset'] === 'number'
      ? (map.metadata['binaryRomConnectionsHeaderOffset'] as number)
      : -1;
  const arrayOffset =
    typeof map.metadata['binaryRomConnectionsArrayOffset'] === 'number'
      ? (map.metadata['binaryRomConnectionsArrayOffset'] as number)
      : -1;
  const GBA_ROM_BASE = 0x08000000;
  const currentCount = map.connections?.length ?? 0;
  const currentPointer = arrayOffset > 0 ? (GBA_ROM_BASE + arrayOffset) >>> 0 : 0;
  const canDelete = headerOffset > 0 && currentPointer !== 0 && currentCount >= 1;

  async function deleteConnection(): Promise<void> {
    if (!sessionId || !canDelete) return;
    if (
      !window.confirm(
        `Delete this ${dirLabel.toLowerCase()} connection to ${destName}? Subsequent connections shift up. Map will have ${String(currentCount - 1)} connection${currentCount - 1 === 1 ? '' : 's'}.`,
      )
    ) {
      return;
    }
    setState({ kind: 'saving' });
    try {
      await editBinaryRomMapConnectionDelete(sessionId, {
        connectionsHeaderOffset: headerOffset,
        currentCount,
        currentConnectionsArrayPointer: currentPointer,
        connectionIndex,
      });
      pushToast('success', 'Connection deleted');
      await scanCurrent();
    } catch (e) {
      const message =
        e instanceof ProjectApiError
          ? `${e.code}: ${e.message}`
          : e instanceof Error
            ? e.message
            : String(e);
      setState({ kind: 'error', message });
      pushToast('error', `Delete failed - ${message}`);
    }
  }

  // Phase O.28 - Enter saves, Esc cancels (editing form).
  const onKeyDownEdit = useEditFormKeyboard({
    canSave,
    save,
    cancel: cancelEdit,
    isSaving: state.kind === 'saving',
  });

  if (!editing) {
    return (
      <li
        style={{
          display: 'grid',
          gridTemplateColumns: '120px 1fr auto auto auto',
          gap: 8,
          alignItems: 'center',
          padding: '4px 6px',
          background: 'var(--color-bg)',
          border: '1px solid var(--color-border)',
          borderRadius: 4,
          fontSize: 11,
        }}
      >
        <span style={{ color: 'var(--color-text-muted)' }}>{dirLabel}</span>
        <span>
          → {destName}
          <span
            style={{
              color: 'var(--color-text-muted)',
              marginLeft: 6,
              fontFamily: 'var(--font-mono)',
            }}
          >
            (offset {connection.offset})
          </span>
        </span>
        <button
          type="button"
          className="btn btn--secondary"
          data-testid={`connection-edit-${connectionIndex}`}
          style={{ height: 22, fontSize: 10, padding: '0 8px' }}
          onClick={() => setEditing(true)}
        >
          Edit
        </button>
        {/* Phase O.79 - same defensive lookup as O.78's warp fix.
            connection.destMapId is already gated by the connection
            lifter's resolution, but a follow-up re-scan that drops
            a map could leave a stale id pointing at nothing. Check
            against the live manifest before enabling the jump. */}
        {connection.destMapId &&
        manifest.maps.some((m) => m.id === connection.destMapId) ? (
          <button
            type="button"
            className="btn btn--secondary"
            data-testid={`connection-open-${connectionIndex}`}
            style={{ height: 22, fontSize: 10, padding: '0 8px' }}
            onClick={() => openMapInEditor(connection.destMapId!)}
          >
            Jump →
          </button>
        ) : (
          <span />
        )}
        {canDelete && (
          <button
            type="button"
            className="btn btn--secondary"
            data-testid={`connection-delete-${connectionIndex}`}
            style={{
              height: 22,
              fontSize: 10,
              padding: '0 8px',
              color: 'var(--color-error, #e25555)',
            }}
            onClick={() => void deleteConnection()}
            disabled={state.kind === 'saving'}
            title="Remove this connection. Subsequent connections shift up."
          >
            {state.kind === 'saving' ? '…' : 'Delete'}
          </button>
        )}
      </li>
    );
  }
  return (
    <li
      onKeyDown={onKeyDownEdit}
      style={{
        padding: 6,
        background: 'var(--color-bg)',
        border: '1px solid var(--color-accent)',
        borderRadius: 4,
        fontSize: 11,
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
      }}
    >
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '120px 80px 1fr',
          gap: 6,
          alignItems: 'end',
        }}
      >
        <label style={{ display: 'flex', flexDirection: 'column', fontSize: 10 }}>
          <span style={{ color: 'var(--color-text-muted)' }}>Direction</span>
          <select
            value={direction}
            onChange={(e) => setDirection(Number.parseInt(e.target.value, 10))}
            style={{ height: 22, fontFamily: 'var(--font-mono)', fontSize: 11 }}
          >
            {CONNECTION_DIRECTION_NAMES.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
            {!CONNECTION_DIRECTION_NAMES.some((o) => o.value === direction) && (
              <option value={direction}>Direction {direction}</option>
            )}
          </select>
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', fontSize: 10 }}>
          <span style={{ color: 'var(--color-text-muted)' }}>Offset (s32)</span>
          <input
            type="number"
            min={-32767}
            max={32767}
            value={offset}
            onChange={(e) => setOffset(Number.parseInt(e.target.value, 10) || 0)}
            style={{ height: 22, padding: '0 4px', fontFamily: 'var(--font-mono)', fontSize: 11 }}
          />
        </label>
        {/* Phase O.19 - single map picker replaces twin (group, num) inputs */}
        <label style={{ display: 'flex', flexDirection: 'column', fontSize: 10 }}>
          <span style={{ color: 'var(--color-text-muted)' }}>Destination map</span>
          <EntityPicker
            kind="map"
            manifest={manifest}
            value={packMapId(destGroup, destNum)}
            onChange={(next) => {
              setDestGroup(unpackMapGroup(next));
              setDestNum(unpackMapNum(next));
            }}
            minId={0}
            maxId={0xffff}
            testIdPrefix={`connection-${connectionIndex}-dest`}
          />
        </label>
      </div>
      <div style={{ display: 'flex', gap: 4 }}>
        <button
          type="button"
          className="btn btn--primary"
          disabled={!dirty || state.kind === 'saving' || !sessionId}
          onClick={() => void save()}
          style={{ height: 22, fontSize: 10, padding: '0 8px' }}
        >
          {state.kind === 'saving' ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          className="btn btn--secondary"
          onClick={() => {
            setEditing(false);
            setDirection(connection.direction);
            setOffset(connection.offset);
            setDestGroup(connection.destMapGroup);
            setDestNum(connection.destMapNum);
            setState({ kind: 'idle' });
          }}
          style={{ height: 22, fontSize: 10, padding: '0 8px' }}
        >
          Cancel
        </button>
        {state.kind === 'error' && (
          <span className="fields-editor__status fields-editor__status--error">
            {state.message}
          </span>
        )}
      </div>
    </li>
  );
}

/**
 * Phase J.8 - Add NPC button. Appends a new ObjectEvent slot at the
 * end of the map's table (count byte += 1, fresh 24-byte struct
 * initialized at (1, 1) elevation 3 with no script/flag/trainer).
 *
 * Append is risky in Gen-3 - the table has no documented allocation
 * size, so writing past the end could corrupt the adjacent struct.
 * The backend allows it up to count=255 and warns; this UI surfaces
 * the same caveat. The .bak file is always written first.
 */
function AddNpcCard({ map }: { map: import('@rom-editor/shared').MapNode }) {
  const sessionId = useProjectStore((s) =>
    s.load.kind === 'loaded' ? s.load.data.session.id : null,
  );
  const scanCurrent = useProjectStore((s) => s.scanCurrentProject);
  const mapEventsStructOffset =
    typeof map.metadata['binaryRomMapEventsStructOffset'] === 'number'
      ? (map.metadata['binaryRomMapEventsStructOffset'] as number)
      : -1;
  const objectEventsArrayOffset =
    typeof map.metadata['binaryRomObjectEventsArrayOffset'] === 'number'
      ? (map.metadata['binaryRomObjectEventsArrayOffset'] as number)
      : -1;
  const [state, setState] = useState<SaveState>({ kind: 'idle' });
  if (mapEventsStructOffset <= 0 || objectEventsArrayOffset <= 0) return null;
  return (
    <div className="fields-editor" data-testid="add-npc-card">
      <h5 className="fields-editor__heading">Map events</h5>
      <p className="fields-editor__hint">
        Append a new NPC slot at the end of this map's ObjectEvent
        table. Defaults: graphicsId 1, position (1, 1), elevation 3,
        no script / no flag. Edit the new NPC's fields afterward via
        its marker on the canvas. <strong>Warning:</strong> Gen-3 doesn't
        expose the table's allocated buffer size; append may corrupt
        the adjacent struct on tightly-packed ROMs. .bak created on
        first edit.
      </p>
      <div className="fields-editor__actions">
        <button
          type="button"
          className="btn btn--primary"
          data-testid="add-npc-button"
          disabled={!sessionId || state.kind === 'saving'}
          onClick={() => {
            if (
              !window.confirm(
                'Append a new NPC slot? Defaults to invisible/idle at (1,1). Edit afterward via the marker.',
              )
            ) {
              return;
            }
            void (async () => {
              if (!sessionId) return;
              setState({ kind: 'saving' });
              try {
                await editBinaryRomObjectEventTable(sessionId, {
                  mapEventsStructOffset,
                  objectEventsArrayOffset,
                  op: 'append',
                  newObject: {
                    localId: 0xff, // engine assigns; 0xFF is "no-id" sentinel
                    graphicsId: 1,
                    x: 1,
                    y: 1,
                    elevation: 3,
                    movementType: 0,
                    movementRangeXY: 0,
                    trainerType: 0,
                    trainerSightOrBerryTreeId: 0,
                    scriptPointer: 0,
                    flagId: 0,
                  },
                });
                setState({ kind: 'saved' });
                pushToast('success', 'NPC added - re-scan to see it');
                await scanCurrent();
              } catch (e) {
                const message =
                  e instanceof ProjectApiError
                    ? `${e.code}: ${e.message}`
                    : e instanceof Error
                      ? e.message
                      : String(e);
                setState({ kind: 'error', message });
                pushToast('error', `Add NPC failed - ${message}`);
              }
            })();
          }}
        >
          {state.kind === 'saving' ? 'Adding…' : '＋ Add NPC to this map'}
        </button>
        {state.kind === 'saved' && (
          <span className="fields-editor__status fields-editor__status--saved">
            Added · re-scan picked up new slot
          </span>
        )}
        {state.kind === 'error' && (
          <span className="fields-editor__status fields-editor__status--error">
            {state.message}
          </span>
        )}
      </div>
      <AddEventButtons map={map} />
    </div>
  );
}

/** Phase K.2 - Add Warp / Coord trigger / Sign buttons. Each appends
 *  a default-initialized slot at the end of the relevant sub-array.
 *  Same buffer-overflow caveat as Add NPC applies. */
function AddEventButtons({ map }: { map: import('@rom-editor/shared').MapNode }) {
  const sessionId = useProjectStore((s) =>
    s.load.kind === 'loaded' ? s.load.data.session.id : null,
  );
  const scanCurrent = useProjectStore((s) => s.scanCurrentProject);
  const mapEventsStructOffset =
    typeof map.metadata['binaryRomMapEventsStructOffset'] === 'number'
      ? (map.metadata['binaryRomMapEventsStructOffset'] as number)
      : -1;
  const warpsArrayOffset =
    typeof map.metadata['binaryRomWarpsArrayOffset'] === 'number'
      ? (map.metadata['binaryRomWarpsArrayOffset'] as number)
      : -1;
  const coordEventsArrayOffset =
    typeof map.metadata['binaryRomCoordEventsArrayOffset'] === 'number'
      ? (map.metadata['binaryRomCoordEventsArrayOffset'] as number)
      : -1;
  const bgEventsArrayOffset =
    typeof map.metadata['binaryRomBgEventsArrayOffset'] === 'number'
      ? (map.metadata['binaryRomBgEventsArrayOffset'] as number)
      : -1;
  const [state, setState] = useState<SaveState>({ kind: 'idle' });

  async function append(
    kind: 'warp' | 'coordEvent' | 'bgEvent',
    subArrayOffset: number,
    bgEventKindOverride?: number,
  ): Promise<void> {
    if (!sessionId || mapEventsStructOffset <= 0 || subArrayOffset <= 0) return;
    const isHiddenItem = bgEventKindOverride === 5 || bgEventKindOverride === 7;
    const friendlyKindLabel =
      kind === 'warp'
        ? 'warp'
        : kind === 'coordEvent'
          ? 'step trigger'
          : isHiddenItem
            ? 'hidden item'
            : 'sign';
    if (
      !window.confirm(
        `Append a new ${friendlyKindLabel}? Defaults at (1,1). Edit afterward via the marker.`,
      )
    )
      return;
    setState({ kind: 'saving' });
    try {
      // Phase O.37 - when the operator clicks "+ Hidden item" the kind
      // byte is pre-set to 5 (BG_EVENT_HIDDEN_ITEM) and the 4 data
      // bytes default to itemId=0, flagOffset=0, quantity=1 - the same
      // sane defaults the O.34 cross-kind toggle uses. Item must be
      // picked before the hidden item works in-game.
      const bgEventKindToUse = bgEventKindOverride ?? 0;
      const bgEventDataDefault =
        bgEventKindToUse === 5 || bgEventKindToUse === 7
          ? (1 << 24) >>> 0 // quantity=1 in high byte; flag=0, item=0
          : 0;
      await editBinaryRomMapEventTable(sessionId, {
        mapEventsStructOffset,
        subArrayOffset,
        kind,
        op: 'append',
        ...(kind === 'warp'
          ? {
              newWarp: {
                x: 1,
                y: 1,
                elevation: 3,
                warpId: 0,
                destMapNum: 0,
                destMapGroup: 0,
              },
            }
          : kind === 'coordEvent'
            ? {
                newCoordEvent: {
                  x: 1,
                  y: 1,
                  elevation: 3,
                  trigger: 0,
                  index: 0,
                  scriptPointer: 0,
                },
              }
            : {
                newBgEvent: {
                  x: 1,
                  y: 1,
                  elevation: 0,
                  kind: bgEventKindToUse,
                  data: bgEventDataDefault,
                },
              }),
      });
      setState({ kind: 'saved' });
      const kindLabel =
        kind === 'warp'
          ? 'Warp'
          : kind === 'coordEvent'
            ? 'Step trigger'
            : isHiddenItem
              ? 'Hidden item'
              : 'Sign';
      pushToast('success', `${kindLabel} added - re-scan to see it`);
      await scanCurrent();
    } catch (e) {
      const message =
        e instanceof ProjectApiError
          ? `${e.code}: ${e.message}`
          : e instanceof Error
            ? e.message
            : String(e);
      setState({ kind: 'error', message });
      pushToast('error', `Add event failed - ${message}`);
    }
  }

  const canAddWarp = warpsArrayOffset > 0 && mapEventsStructOffset > 0;
  const canAddCoord = coordEventsArrayOffset > 0 && mapEventsStructOffset > 0;
  const canAddBg = bgEventsArrayOffset > 0 && mapEventsStructOffset > 0;
  if (!canAddWarp && !canAddCoord && !canAddBg) return null;

  return (
    <div className="fields-editor__row fields-editor__row--inline" style={{ marginTop: 8 }}>
      {canAddWarp && (
        <button
          type="button"
          className="btn btn--secondary"
          data-testid="add-warp-button"
          disabled={!sessionId || state.kind === 'saving'}
          onClick={() => void append('warp', warpsArrayOffset)}
        >
          ＋ Warp
        </button>
      )}
      {canAddCoord && (
        <button
          type="button"
          className="btn btn--secondary"
          data-testid="add-coord-trigger-button"
          disabled={!sessionId || state.kind === 'saving'}
          onClick={() => void append('coordEvent', coordEventsArrayOffset)}
        >
          ＋ Step trigger
        </button>
      )}
      {canAddBg && (
        <button
          type="button"
          className="btn btn--secondary"
          data-testid="add-sign-button"
          disabled={!sessionId || state.kind === 'saving'}
          onClick={() => void append('bgEvent', bgEventsArrayOffset)}
        >
          ＋ Sign
        </button>
      )}
      {canAddBg && (
        <button
          type="button"
          className="btn btn--secondary"
          data-testid="add-hidden-item-button"
          disabled={!sessionId || state.kind === 'saving'}
          onClick={() => void append('bgEvent', bgEventsArrayOffset, 5)}
        >
          ＋ Hidden item
        </button>
      )}
      {state.kind === 'saved' && (
        <span className="fields-editor__status fields-editor__status--saved">Added</span>
      )}
      {state.kind === 'error' && (
        <span className="fields-editor__status fields-editor__status--error">
          {state.message}
        </span>
      )}
    </div>
  );
}

/**
 * Phase J.3 / O.16 - Map dimensions sub-card. Lives inside the
 * MapHeaderEditor. Shrink edits the width/height fields in place
 * (metatile buffer stays at original size; trailing rows/cols are
 * unreachable). Grow allocates a new primaryBlocks buffer in free
 * ROM space, copies existing cells top-left aligned with 0-fill for
 * new area, and rewrites the layout's primaryBlocks pointer.
 */
const MAP_MAX_DIMENSION = 256;

function MapDimensionsCard({ map }: { map: import('@rom-editor/shared').MapNode }) {
  const sessionId = useProjectStore((s) =>
    s.load.kind === 'loaded' ? s.load.data.session.id : null,
  );
  const scanCurrent = useProjectStore((s) => s.scanCurrentProject);
  const layoutFileOffset =
    typeof map.metadata['binaryRomLayoutOffset'] === 'number'
      ? (map.metadata['binaryRomLayoutOffset'] as number)
      : -1;
  const currentWidth =
    typeof map.metadata['binaryRomMapWidth'] === 'number'
      ? (map.metadata['binaryRomMapWidth'] as number)
      : map.dimensions.width;
  const currentHeight =
    typeof map.metadata['binaryRomMapHeight'] === 'number'
      ? (map.metadata['binaryRomMapHeight'] as number)
      : map.dimensions.height;
  const [width, setWidth] = useState(currentWidth);
  const [height, setHeight] = useState(currentHeight);
  const [state, setState] = useState<SaveState>({ kind: 'idle' });

  useEffect(() => {
    setWidth(currentWidth);
    setHeight(currentHeight);
    setState({ kind: 'idle' });
  }, [map.id, currentWidth, currentHeight]);

  if (layoutFileOffset <= 0) return null;
  const dirty = width !== currentWidth || height !== currentHeight;
  const valid =
    width >= 1 &&
    height >= 1 &&
    width <= MAP_MAX_DIMENSION &&
    height <= MAP_MAX_DIMENSION;
  const canSave = dirty && valid && sessionId !== null;
  const isGrow = width * height > currentWidth * currentHeight;

  async function save(): Promise<void> {
    if (!sessionId) return;
    setState({ kind: 'saving' });
    try {
      await editBinaryRomMapDimensions(sessionId, {
        layoutFileOffset,
        currentWidth,
        currentHeight,
        newWidth: width,
        newHeight: height,
      });
      setState({ kind: 'saved' });
      pushToast(
        'success',
        `Map resized to ${width} × ${height}${isGrow ? ' (buffer relocated)' : ''}`,
      );
      await scanCurrent();
    } catch (e) {
      const message =
        e instanceof ProjectApiError
          ? `${e.code}: ${e.message}`
          : e instanceof Error
            ? e.message
            : String(e);
      setState({ kind: 'error', message });
      pushToast('error', `Map resize failed - ${message}`);
    }
  }
  // Phase O.28 - Enter saves, Esc reverts dimensions.
  const onKeyDownDim = useEditFormKeyboard({
    canSave: canSave && state.kind !== 'saving',
    save,
    cancel: () => {
      setWidth(currentWidth);
      setHeight(currentHeight);
      setState({ kind: 'idle' });
    },
    isSaving: state.kind === 'saving',
  });
  return (
    <div
      className="fields-editor"
      data-testid="map-dimensions-card"
      onKeyDown={onKeyDownDim}
    >
      <h5 className="fields-editor__heading">Map dimensions</h5>
      <div className="fields-editor__row fields-editor__row--inline">
        <label>
          Width
          <input
            type="number"
            min={1}
            max={MAP_MAX_DIMENSION}
            value={width}
            data-testid="map-dim-width"
            onChange={(e) =>
              setWidth(
                Math.max(
                  1,
                  Math.min(MAP_MAX_DIMENSION, Number.parseInt(e.target.value, 10) || 1),
                ),
              )
            }
          />
        </label>
        <label>
          Height
          <input
            type="number"
            min={1}
            max={MAP_MAX_DIMENSION}
            value={height}
            data-testid="map-dim-height"
            onChange={(e) =>
              setHeight(
                Math.max(
                  1,
                  Math.min(MAP_MAX_DIMENSION, Number.parseInt(e.target.value, 10) || 1),
                ),
              )
            }
          />
        </label>
      </div>
      <p className="fields-editor__hint">
        Current: {currentWidth}×{currentHeight} ({currentWidth * currentHeight} cells).
        New: {width}×{height} ({width * height} cells).
        {isGrow ? (
          <> Grow relocates the primaryBlocks buffer in free ROM space - existing cells stay at the same (x, y); new area fills with metatile 0.</>
        ) : (
          <> Shrink leaves the buffer at its original size in ROM; engine renders only the new dimensions.</>
        )}
      </p>
      <div className="fields-editor__actions">
        <button
          type="button"
          className="btn btn--primary"
          data-testid="map-dim-save"
          disabled={!canSave || state.kind === 'saving'}
          onClick={() => void save()}
        >
          {state.kind === 'saving' ? 'Saving…' : 'Save dimensions'}
        </button>
        {state.kind === 'saved' && !dirty && (
          <span className="fields-editor__status fields-editor__status--saved">
            Saved · MapLayout struct patched
          </span>
        )}
        {state.kind === 'error' && (
          <span className="fields-editor__status fields-editor__status--error">
            {state.message}
          </span>
        )}
      </div>
    </div>
  );
}
