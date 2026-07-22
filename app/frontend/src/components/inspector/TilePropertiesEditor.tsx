import { useEffect, useMemo, useState } from 'react';
import type { LayoutCellDecoded } from '@rom-editor/shared';
import {
  editBinaryRomMapCells,
  editBinaryRomMetatileAttrs,
  fetchBinaryRomMetatileAttrs,
  ProjectApiError,
} from '../../api';
import { pushToast, useProjectStore } from '../../state';
import { useEditFormKeyboard } from '../../lib/useEditFormKeyboard';

/**
 * Phase I.2.1 - Tile properties editor.
 *
 * When the operator clicks an unowned map cell with the Pointer tool,
 * this panel shows the metatile id under the cursor and lets them edit
 * the cell's collision + elevation flags directly. Backed by the
 * existing `editBinaryRomMapCells` route (Phase UX-D), so this is a
 * pure UI addition - no new backend write paths.
 *
 * "Apply to" options:
 *   - this tile only - write the new attrs at this (x, y).
 *   - all tiles with the same metatile id on this map - useful for
 *     "make every grass tile encounter-eligible" workflows.
 */

interface TilePropertiesEditorProps {
  readonly mapId: string;
  readonly cell: { readonly x: number; readonly y: number };
  readonly currentCell: LayoutCellDecoded;
  readonly layoutOffset: number;
  readonly mapWidth: number;
  readonly mapHeight: number;
  readonly mapCells: ReadonlyArray<LayoutCellDecoded>;
  readonly metatilePixels: ReadonlyMap<number, Uint32Array> | null;
  readonly onSaved: () => void;
  /** Phase J.4 - when present, also fetch + edit MetatileAttributes
   *  (behavior / terrain / encounter type / layer type) for this tile's
   *  metatile via the new /binary-rom-metatile-attrs routes. Family is
   *  resolved from the project's game code. */
  readonly tilesetStructOffset?: number;
  readonly secondaryTilesetStructOffset?: number;
  readonly numMetatilesInPrimary?: number;
  readonly family?: 'frlg' | 'rse';
}

type SaveState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'saving' }
  | { readonly kind: 'saved' }
  | { readonly kind: 'error'; readonly message: string };

type ApplyScope = 'this-tile' | 'all-matching';

/** Gen-3 metatile collision values per pret/pokefirered `metatile_behaviors.h`.
 *  Most maps use 0 / 1 - additional values exist for edge cases (jumping,
 *  surfing transitions, etc.) but vanilla content rarely exceeds 3. */
const COLLISION_OPTIONS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 0, label: '0 - Passable' },
  { value: 1, label: '1 - Blocked' },
  { value: 2, label: '2 - Surfable (water boundary)' },
  { value: 3, label: '3 - Special (varies by engine)' },
];

/** Gen-3 metatile behavior names - common ones across FRLG + RSE.
 *  Hack-added behaviors fall through as "Behavior #N". */
const METATILE_BEHAVIOR_OPTIONS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 0x00, label: '0x00 - Normal' },
  { value: 0x01, label: '0x01 - Secret base wall' },
  { value: 0x02, label: '0x02 - Tall grass (encounters)' },
  { value: 0x03, label: '0x03 - Long grass' },
  { value: 0x06, label: '0x06 - Deep sand' },
  { value: 0x10, label: '0x10 - Sand' },
  { value: 0x11, label: '0x11 - Footprints' },
  { value: 0x14, label: '0x14 - Ice' },
  { value: 0x15, label: '0x15 - Shallow water' },
  { value: 0x16, label: '0x16 - Water (surfable)' },
  { value: 0x17, label: '0x17 - Deep water' },
  { value: 0x20, label: '0x20 - Waterfall' },
  { value: 0x2b, label: '0x2b - Cave entrance (jump down)' },
  { value: 0x30, label: '0x30 - Door' },
  { value: 0x60, label: '0x60 - Sign (read message)' },
  { value: 0x61, label: '0x61 - Pokémon Center sign' },
  { value: 0x67, label: '0x67 - Mart sign' },
];

const TERRAIN_TYPE_OPTIONS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 0, label: '0 - Normal' },
  { value: 1, label: '1 - Grass' },
  { value: 2, label: '2 - Water' },
  { value: 3, label: '3 - Waterfall' },
  { value: 4, label: '4 - Pond (fishing)' },
  { value: 5, label: '5 - Mountain' },
  { value: 6, label: '6 - Cave' },
];

const ENCOUNTER_TYPE_OPTIONS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 0, label: '0 - None' },
  { value: 1, label: '1 - Land (grass)' },
  { value: 2, label: '2 - Water (surfing)' },
];

const LAYER_TYPE_OPTIONS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 0, label: '0 - Normal (overlay)' },
  { value: 1, label: '1 - Covered (under hero)' },
  { value: 2, label: '2 - Split (mid-layer)' },
  { value: 3, label: '3 - Three-layer (alt)' },
];

export function TilePropertiesEditor({
  mapId: _mapId,
  cell,
  currentCell,
  layoutOffset,
  mapWidth,
  mapHeight,
  mapCells,
  metatilePixels,
  onSaved,
  tilesetStructOffset,
  secondaryTilesetStructOffset,
  numMetatilesInPrimary,
  family,
}: TilePropertiesEditorProps) {
  const sessionId = useProjectStore((s) =>
    s.load.kind === 'loaded' ? s.load.data.session.id : null,
  );
  const [collision, setCollision] = useState(currentCell.collision);
  const [elevation, setElevation] = useState(currentCell.elevation);
  const [scope, setScope] = useState<ApplyScope>('this-tile');
  const [state, setState] = useState<SaveState>({ kind: 'idle' });

  // Phase J.4 - metatile attribute state. Fetched async when the cell
  // changes; saved via the new /binary-rom-edit/metatile-attrs route.
  const [attrs, setAttrs] = useState<{
    behavior: number;
    terrainType: number;
    encounterType: number;
    layerType: number;
  } | null>(null);
  const [initialAttrs, setInitialAttrs] = useState<typeof attrs>(null);
  const [attrsState, setAttrsState] = useState<SaveState>({ kind: 'idle' });

  // Which tileset owns this metatile? In dual-tileset maps, metatiles
  // below `numMetatilesInPrimary` belong to the primary tileset;
  // metatiles >= that index belong to the secondary tileset (re-indexed
  // relative to the secondary's metatiles array).
  const resolvedTileset = useMemo(() => {
    if (family === undefined || tilesetStructOffset === undefined) return null;
    if (
      numMetatilesInPrimary !== undefined &&
      currentCell.metatileId >= numMetatilesInPrimary &&
      secondaryTilesetStructOffset !== undefined
    ) {
      return {
        tilesetStructOffset: secondaryTilesetStructOffset,
        relativeMetatileId: currentCell.metatileId - numMetatilesInPrimary,
        family,
      };
    }
    return {
      tilesetStructOffset,
      relativeMetatileId: currentCell.metatileId,
      family,
    };
  }, [
    family,
    tilesetStructOffset,
    secondaryTilesetStructOffset,
    numMetatilesInPrimary,
    currentCell.metatileId,
  ]);

  useEffect(() => {
    if (!sessionId || !resolvedTileset) {
      setAttrs(null);
      setInitialAttrs(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetchBinaryRomMetatileAttrs(sessionId, {
          tilesetStructOffset: resolvedTileset.tilesetStructOffset,
          metatileId: resolvedTileset.relativeMetatileId,
          family: resolvedTileset.family,
        });
        if (cancelled) return;
        const next = {
          behavior: r.behavior,
          terrainType: r.terrainType,
          encounterType: r.encounterType,
          layerType: r.layerType,
        };
        setAttrs(next);
        setInitialAttrs(next);
        setAttrsState({ kind: 'idle' });
      } catch {
        if (!cancelled) {
          setAttrs(null);
          setInitialAttrs(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, resolvedTileset]);

  // Re-sync local form when the selected cell changes.
  useEffect(() => {
    setCollision(currentCell.collision);
    setElevation(currentCell.elevation);
    setState({ kind: 'idle' });
  }, [cell.x, cell.y, currentCell.collision, currentCell.elevation]);

  const dirty =
    collision !== currentCell.collision || elevation !== currentCell.elevation;
  const matchingCount = useMemo(
    () => mapCells.filter((c) => c.metatileId === currentCell.metatileId).length,
    [mapCells, currentCell.metatileId],
  );
  const previewSrc = useMemo(() => {
    if (!metatilePixels) return null;
    const px = metatilePixels.get(currentCell.metatileId);
    if (!px) return null;
    const canvas = document.createElement('canvas');
    canvas.width = 16;
    canvas.height = 16;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const imageData = ctx.createImageData(16, 16);
    imageData.data.set(new Uint8ClampedArray(px.buffer, px.byteOffset, px.byteLength));
    ctx.putImageData(imageData, 0, 0);
    return canvas.toDataURL();
  }, [metatilePixels, currentCell.metatileId]);

  async function save(): Promise<void> {
    if (!sessionId || !dirty) return;
    setState({ kind: 'saving' });
    try {
      const edits: Array<{
        x: number;
        y: number;
        collision?: number;
        elevation?: number;
      }> = [];
      if (scope === 'this-tile') {
        edits.push({
          x: cell.x,
          y: cell.y,
          ...(collision !== currentCell.collision ? { collision } : {}),
          ...(elevation !== currentCell.elevation ? { elevation } : {}),
        });
      } else {
        // All matching: every cell with the same metatileId gets the
        // collision/elevation update (metatileId unchanged).
        for (let y = 0; y < mapHeight; y++) {
          for (let x = 0; x < mapWidth; x++) {
            const c = mapCells[y * mapWidth + x];
            if (!c || c.metatileId !== currentCell.metatileId) continue;
            edits.push({
              x,
              y,
              ...(collision !== currentCell.collision ? { collision } : {}),
              ...(elevation !== currentCell.elevation ? { elevation } : {}),
            });
          }
        }
      }
      await editBinaryRomMapCells(sessionId, {
        layoutOffset,
        width: mapWidth,
        height: mapHeight,
        edits,
      });
      setState({ kind: 'saved' });
      pushToast(
        'success',
        edits.length === 1 ? 'Tile saved' : `Saved ${edits.length} tiles`,
      );
      onSaved();
    } catch (e) {
      const msg =
        e instanceof ProjectApiError
          ? `${e.code}: ${e.message}`
          : e instanceof Error
            ? e.message
            : String(e);
      setState({ kind: 'error', message: msg });
      pushToast('error', `Tile save failed - ${msg}`);
    }
  }

  // Phase O.29 - Enter saves, Esc reverts the tile properties form.
  const onKeyDownEdit = useEditFormKeyboard({
    canSave: dirty && state.kind !== 'saving' && sessionId !== null,
    save,
    cancel: () => {
      setCollision(currentCell.collision);
      setElevation(currentCell.elevation);
      setState({ kind: 'idle' });
    },
    isSaving: state.kind === 'saving',
  });

  return (
    <div
      className="map-editor__selected tile-properties-editor"
      data-testid="map-editor-selected-tile"
      onKeyDown={onKeyDownEdit}
    >
      <span className="map-editor__kind-badge" style={{ color: '#7c8088' }}>
        tile
      </span>
      <h4>
        Metatile #{currentCell.metatileId} @ ({cell.x}, {cell.y})
      </h4>
      {previewSrc && (
        <img
          src={previewSrc}
          alt={`Metatile ${currentCell.metatileId} preview`}
          width={48}
          height={48}
          style={{ imageRendering: 'pixelated', border: '1px solid var(--color-border)', marginBottom: 8 }}
          data-testid="tile-properties-preview"
        />
      )}
      <dl>
        <dt>Metatile id</dt>
        <dd>#{currentCell.metatileId}</dd>
        <dt>Used on this map</dt>
        <dd>{matchingCount} cell{matchingCount === 1 ? '' : 's'}</dd>
      </dl>
      <div className="fields-editor" data-testid="tile-properties-fields">
        <h5 className="fields-editor__heading">Cell attributes</h5>
        <div className="fields-editor__row">
          <label>
            Collision
            <select
              data-testid="tile-properties-collision"
              value={collision}
              onChange={(e) => setCollision(Number.parseInt(e.target.value, 10))}
            >
              {COLLISION_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
              {!COLLISION_OPTIONS.some((o) => o.value === collision) && (
                <option value={collision}>{`${collision} - Hack-specific`}</option>
              )}
            </select>
          </label>
        </div>
        <div className="fields-editor__row">
          <label>
            Elevation (0 – 15)
            <input
              type="number"
              min={0}
              max={15}
              data-testid="tile-properties-elevation"
              value={elevation}
              onChange={(e) =>
                setElevation(Math.max(0, Math.min(15, Number.parseInt(e.target.value, 10) || 0)))
              }
            />
          </label>
        </div>
        <div className="fields-editor__row fields-editor__row--inline">
          <label>
            <input
              type="radio"
              name="apply-scope"
              checked={scope === 'this-tile'}
              onChange={() => setScope('this-tile')}
              data-testid="tile-properties-scope-this"
            />{' '}
            This tile only
          </label>
          <label>
            <input
              type="radio"
              name="apply-scope"
              checked={scope === 'all-matching'}
              onChange={() => setScope('all-matching')}
              data-testid="tile-properties-scope-all"
            />{' '}
            All {matchingCount} matching tiles on this map
          </label>
        </div>
        <div className="fields-editor__actions">
          <button
            type="button"
            className="btn btn--primary"
            data-testid="tile-properties-save"
            disabled={!dirty || state.kind === 'saving' || !sessionId}
            onClick={() => void save()}
          >
            {state.kind === 'saving' ? 'Saving…' : 'Save changes'}
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
      {/* Phase J.4 - MetatileAttributes editor. Shows behavior /
          terrain / encounter / layer dropdowns when the tileset offset
          + family are available. Edits patch the parallel attribute
          table (FRLG: 4-byte stride, RSE: 2-byte). Changes here
          affect every map that uses this metatile id. */}
      {attrs !== null && initialAttrs !== null && resolvedTileset !== null && (
        <div className="fields-editor" data-testid="tile-properties-attrs">
          <h5 className="fields-editor__heading">
            Metatile attributes (affects all maps using this metatile)
          </h5>
          <div className="fields-editor__row">
            <label>
              Behavior
              <select
                data-testid="tile-attrs-behavior"
                value={attrs.behavior}
                onChange={(e) =>
                  setAttrs({ ...attrs, behavior: Number.parseInt(e.target.value, 10) })
                }
              >
                {METATILE_BEHAVIOR_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
                {!METATILE_BEHAVIOR_OPTIONS.some((o) => o.value === attrs.behavior) && (
                  <option value={attrs.behavior}>{`0x${attrs.behavior.toString(16)} - Hack-specific`}</option>
                )}
              </select>
            </label>
          </div>
          {resolvedTileset.family === 'frlg' && (
            <>
              <div className="fields-editor__row">
                <label>
                  Terrain type
                  <select
                    data-testid="tile-attrs-terrain"
                    value={attrs.terrainType}
                    onChange={(e) =>
                      setAttrs({ ...attrs, terrainType: Number.parseInt(e.target.value, 10) })
                    }
                  >
                    {TERRAIN_TYPE_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                    {!TERRAIN_TYPE_OPTIONS.some((o) => o.value === attrs.terrainType) && (
                      <option value={attrs.terrainType}>{`${attrs.terrainType} - Hack-specific`}</option>
                    )}
                  </select>
                </label>
              </div>
              <div className="fields-editor__row">
                <label>
                  Encounter type (grass / water gating)
                  <select
                    data-testid="tile-attrs-encounter"
                    value={attrs.encounterType}
                    onChange={(e) =>
                      setAttrs({ ...attrs, encounterType: Number.parseInt(e.target.value, 10) })
                    }
                  >
                    {ENCOUNTER_TYPE_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </>
          )}
          <div className="fields-editor__row">
            <label>
              Layer type (composition mode)
              <select
                data-testid="tile-attrs-layer"
                value={attrs.layerType}
                onChange={(e) =>
                  setAttrs({ ...attrs, layerType: Number.parseInt(e.target.value, 10) })
                }
              >
                {LAYER_TYPE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="fields-editor__actions">
            <button
              type="button"
              className="btn btn--primary"
              data-testid="tile-attrs-save"
              disabled={
                JSON.stringify(attrs) === JSON.stringify(initialAttrs) ||
                attrsState.kind === 'saving' ||
                !sessionId
              }
              onClick={() => {
                void (async () => {
                  if (!sessionId) return;
                  setAttrsState({ kind: 'saving' });
                  try {
                    await editBinaryRomMetatileAttrs(sessionId, {
                      tilesetStructOffset: resolvedTileset.tilesetStructOffset,
                      metatileId: resolvedTileset.relativeMetatileId,
                      family: resolvedTileset.family,
                      attrs: {
                        ...(attrs.behavior !== initialAttrs.behavior
                          ? { behavior: attrs.behavior }
                          : {}),
                        ...(attrs.terrainType !== initialAttrs.terrainType
                          ? { terrainType: attrs.terrainType }
                          : {}),
                        ...(attrs.encounterType !== initialAttrs.encounterType
                          ? { encounterType: attrs.encounterType }
                          : {}),
                        ...(attrs.layerType !== initialAttrs.layerType
                          ? { layerType: attrs.layerType }
                          : {}),
                      },
                    });
                    setAttrsState({ kind: 'saved' });
                    setInitialAttrs(attrs);
                    pushToast('success', 'Metatile attributes saved');
                    onSaved();
                  } catch (e) {
                    const msg =
                      e instanceof ProjectApiError
                        ? `${e.code}: ${e.message}`
                        : e instanceof Error
                          ? e.message
                          : String(e);
                    setAttrsState({ kind: 'error', message: msg });
                    pushToast('error', `Metatile save failed - ${msg}`);
                  }
                })();
              }}
            >
              {attrsState.kind === 'saving' ? 'Saving…' : 'Save attributes'}
            </button>
            {attrsState.kind === 'saved' &&
              JSON.stringify(attrs) === JSON.stringify(initialAttrs) && (
                <span className="fields-editor__status fields-editor__status--saved">
                  Saved · attribute table patched
                </span>
              )}
            {attrsState.kind === 'error' && (
              <span className="fields-editor__status fields-editor__status--error">
                {attrsState.message}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
