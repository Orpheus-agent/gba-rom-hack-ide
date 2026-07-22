import { useMemo, useState } from 'react';
import type { InspectorPanelProps } from '../lib/inspectorRegistry';
import { displayName } from '../lib/displayName';
import {
  pushToast,
  useProjectStore,
  useSelection,
  useUiPreferencesStore,
} from '../state';
import { editBinaryRomWarpFields, ProjectApiError } from '../api';
import type { ProjectManifest, Warp } from '@rom-editor/shared';
import {
  EntityPicker,
  packMapId,
  unpackMapGroup,
  unpackMapNum,
} from '../components/EntityPicker';
import './InspectorShared.css';

// Phase S.3 - WarpInspector. From-map and to-map are both clickable
// to walk the world graph one warp at a time without leaving the
// dock.

function findWarp(
  manifest: ProjectManifest | null,
  selectionId: string,
): Warp | null {
  if (!manifest) return null;
  return manifest.warps.find((w) => w.id === selectionId) ?? null;
}

export function WarpInspector({
  selection,
  manifest,
  sessionId,
}: InspectorPanelProps) {
  const showInternalIds = useUiPreferencesStore((s) => s.showInternalIds);
  const select = useSelection((s) => s.select);
  const scanCurrentProject = useProjectStore((s) => s.scanCurrentProject);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draftWarpId, setDraftWarpId] = useState(0);
  const [draftMapGroup, setDraftMapGroup] = useState(0);
  const [draftMapNum, setDraftMapNum] = useState(0);
  const [draftElevation, setDraftElevation] = useState(0);

  const warp = useMemo(
    () => findWarp(manifest, selection.id),
    [manifest, selection.id],
  );

  const warpStructOffset =
    warp?.metadata && typeof warp.metadata['structFileOffset'] === 'number'
      ? (warp.metadata['structFileOffset'] as number)
      : null;

  function beginEdit() {
    if (!warp) return;
    const meta = warp.metadata ?? {};
    setDraftWarpId(typeof meta['warpId'] === 'number' ? (meta['warpId'] as number) : 0);
    setDraftMapGroup(
      typeof meta['destMapGroup'] === 'number'
        ? (meta['destMapGroup'] as number)
        : 0,
    );
    setDraftMapNum(
      typeof meta['destMapNum'] === 'number' ? (meta['destMapNum'] as number) : 0,
    );
    setDraftElevation(
      typeof meta['elevation'] === 'number' ? (meta['elevation'] as number) : 0,
    );
    setEditing(true);
  }

  async function commitEdit() {
    if (!warp || !sessionId || warpStructOffset == null) return;
    const meta = warp.metadata ?? {};
    const fields: {
      elevation?: number;
      warpId?: number;
      destMapNum?: number;
      destMapGroup?: number;
    } = {};
    if (draftWarpId !== (typeof meta['warpId'] === 'number' ? meta['warpId'] : 0))
      fields.warpId = draftWarpId;
    if (
      draftMapGroup !==
      (typeof meta['destMapGroup'] === 'number' ? meta['destMapGroup'] : 0)
    )
      fields.destMapGroup = draftMapGroup;
    if (
      draftMapNum !==
      (typeof meta['destMapNum'] === 'number' ? meta['destMapNum'] : 0)
    )
      fields.destMapNum = draftMapNum;
    if (
      draftElevation !==
      (typeof meta['elevation'] === 'number' ? meta['elevation'] : 0)
    )
      fields.elevation = draftElevation;
    if (Object.keys(fields).length === 0) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      await editBinaryRomWarpFields(sessionId, {
        structFileOffset: warpStructOffset,
        fields,
      });
      pushToast('success', `Warp saved`);
      await scanCurrentProject();
      setEditing(false);
    } catch (err) {
      const msg =
        err instanceof ProjectApiError
          ? `${err.code}: ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err);
      pushToast('error', `Save failed: ${msg}`);
    } finally {
      setSaving(false);
    }
  }

  if (!manifest) {
    return (
      <div className="entity-inspector entity-inspector--empty" data-testid="warp-inspector">
        <p>Open a project to inspect <code>{selection.id}</code>.</p>
      </div>
    );
  }
  if (!warp) {
    return (
      <div className="entity-inspector entity-inspector--empty" data-testid="warp-inspector">
        <p>
          No warp with id <code>{selection.id}</code> in the manifest
          ({manifest.warps.length} warps indexed).
        </p>
      </div>
    );
  }

  // Find the reverse warp at the destination so the user can see the
  // round-trip (does this warp pair with one going back?).
  const reverseWarps = useMemo(() => {
    return manifest.warps.filter(
      (w) => w.fromMapId === warp.toMapId && w.toMapId === warp.fromMapId,
    );
  }, [manifest.warps, warp.fromMapId, warp.toMapId]);

  return (
    <div className="entity-inspector" data-testid="warp-inspector">
      <header className="entity-inspector__header">
        <div className="entity-inspector__sub">Warp</div>
        <div className="entity-inspector__title" data-testid="warp-inspector-name">
          {displayName(manifest, warp.id, showInternalIds)}
        </div>
      </header>

      <section className="entity-inspector__refs" data-testid="warp-inspector-from">
        <h3 className="entity-inspector__refs-heading">From</h3>
        <button
          type="button"
          className="entity-inspector__refs-btn"
          onClick={() => select({ kind: 'map', id: warp.fromMapId })}
        >
          <span className="entity-inspector__refs-btn-label">
            {displayName(manifest, warp.fromMapId, showInternalIds)}
          </span>
          <span className="entity-inspector__refs-btn-meta">
            @ ({warp.fromCoord.x}, {warp.fromCoord.y})
          </span>
        </button>
      </section>

      <section className="entity-inspector__refs" data-testid="warp-inspector-to">
        <h3 className="entity-inspector__refs-heading">→ To</h3>
        <button
          type="button"
          className="entity-inspector__refs-btn"
          onClick={() => select({ kind: 'map', id: warp.toMapId })}
        >
          <span className="entity-inspector__refs-btn-label">
            {displayName(manifest, warp.toMapId, showInternalIds)}
          </span>
          <span className="entity-inspector__refs-btn-meta">
            @ ({warp.toCoord.x}, {warp.toCoord.y})
          </span>
        </button>
      </section>

      {!editing && sessionId && warpStructOffset != null && (
        <button
          type="button"
          className="entity-inspector__edit-btn"
          onClick={beginEdit}
          data-testid="warp-inspector-edit-btn"
        >
          Edit destination…
        </button>
      )}
      {editing && (
        <div
          className="entity-inspector__edit-form"
          data-testid="warp-inspector-edit-form"
        >
          <label className="entity-inspector__num-field">
            <span>Warp ID</span>
            <input
              type="number"
              min={0}
              max={255}
              value={draftWarpId}
              data-testid="warp-inspector-edit-warp-id"
              onChange={(e) => {
                const n = Number.parseInt(e.target.value, 10);
                if (Number.isFinite(n)) setDraftWarpId(Math.max(0, Math.min(255, n)));
              }}
            />
          </label>
          {/* Phase Q.6.1 - destination map used to be two raw 0-255
              number inputs (group + num). Users had to know "Pewter
              City is group 3 map 1" by memory to point a door at it.
              EntityPicker(kind=map) lets them type "pewter" and pick
              the destination by name; packMapId/unpackMapGroup/Num
              keep the binary layout intact. */}
          <label className="entity-inspector__num-field">
            <span>Door leads to</span>
            <EntityPicker
              kind="map"
              manifest={manifest}
              value={packMapId(draftMapGroup, draftMapNum)}
              onChange={(packed) => {
                setDraftMapGroup(unpackMapGroup(packed));
                setDraftMapNum(unpackMapNum(packed));
              }}
              minId={0}
              maxId={0xffff}
              testIdPrefix="warp-inspector-edit-dest-map"
              disabled={saving}
            />
          </label>
          <label className="entity-inspector__num-field">
            <span>Elevation</span>
            <input
              type="number"
              min={0}
              max={255}
              value={draftElevation}
              data-testid="warp-inspector-edit-elevation"
              onChange={(e) => {
                const n = Number.parseInt(e.target.value, 10);
                if (Number.isFinite(n))
                  setDraftElevation(Math.max(0, Math.min(255, n)));
              }}
            />
          </label>
          <div className="entity-inspector__edit-actions">
            <button
              type="button"
              className="entity-inspector__save-btn"
              onClick={commitEdit}
              disabled={saving}
              data-testid="warp-inspector-save-btn"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              className="entity-inspector__cancel-btn"
              onClick={() => setEditing(false)}
              disabled={saving}
              data-testid="warp-inspector-cancel-btn"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <section
        className="entity-inspector__refs"
        data-testid="warp-inspector-reverse"
      >
        <h3 className="entity-inspector__refs-heading">
          Return path{' '}
          <span className="entity-inspector__refs-count">({reverseWarps.length})</span>
        </h3>
        {reverseWarps.length === 0 ? (
          <p className="entity-inspector__refs-empty">
            No reverse warp found - this is a one-way passage. (Common for
            ledges, slides, and fly destinations.)
          </p>
        ) : (
          <ul className="entity-inspector__refs-list">
            {reverseWarps.map((w) => (
              <li key={w.id}>
                <button
                  type="button"
                  className="entity-inspector__refs-btn"
                  onClick={() => select({ kind: 'warp', id: w.id })}
                >
                  <span className="entity-inspector__refs-btn-label">
                    {displayName(manifest, w.id, showInternalIds)}
                  </span>
                  <span className="entity-inspector__refs-btn-meta">
                    ({w.fromCoord.x}, {w.fromCoord.y})
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
