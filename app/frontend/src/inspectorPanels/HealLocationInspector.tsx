import { useMemo, useState } from 'react';
import type { InspectorPanelProps } from '../lib/inspectorRegistry';
import { displayName } from '../lib/displayName';
import {
  pushToast,
  useProjectStore,
  useSelection,
  useUiPreferencesStore,
} from '../state';
import { editBinaryRomHealLocation, ProjectApiError } from '../api';
import type { HealLocationEntry, ProjectManifest } from '@rom-editor/shared';
import { AdvancedDetails, AdvancedField, formatHex } from './AdvancedDetails';
import {
  EntityPicker,
  packMapId,
  unpackMapGroup,
  unpackMapNum,
} from '../components/EntityPicker';
import './InspectorShared.css';

// Phase S.13 - HealLocationInspector. SPAWN_* slot the engine warps
// the player to on white-out, Fly, Teleport, or initial mom's house
// spawn. Click-through to the destination map.

function findHealLocation(
  manifest: ProjectManifest | null,
  selectionId: string,
): HealLocationEntry | null {
  if (!manifest) return null;
  const locs = manifest.healLocations ?? [];
  return locs.find((h) => h.id === selectionId) ?? null;
}

export function HealLocationInspector({
  selection,
  manifest,
  sessionId,
}: InspectorPanelProps) {
  const showInternalIds = useUiPreferencesStore((s) => s.showInternalIds);
  const select = useSelection((s) => s.select);
  const scanCurrentProject = useProjectStore((s) => s.scanCurrentProject);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draftGroup, setDraftGroup] = useState(0);
  const [draftMapNum, setDraftMapNum] = useState(0);
  const [draftX, setDraftX] = useState(0);
  const [draftY, setDraftY] = useState(0);

  const heal = useMemo(
    () => findHealLocation(manifest, selection.id),
    [manifest, selection.id],
  );

  function beginEdit() {
    if (!heal) return;
    setDraftGroup(heal.group);
    setDraftMapNum(heal.mapNum);
    setDraftX(heal.x);
    setDraftY(heal.y);
    setEditing(true);
  }

  async function commitEdit() {
    if (!heal || !sessionId) return;
    const fields: {
      group?: number;
      mapNum?: number;
      x?: number;
      y?: number;
    } = {};
    if (draftGroup !== heal.group) fields.group = draftGroup;
    if (draftMapNum !== heal.mapNum) fields.mapNum = draftMapNum;
    if (draftX !== heal.x) fields.x = draftX;
    if (draftY !== heal.y) fields.y = draftY;
    if (Object.keys(fields).length === 0) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      await editBinaryRomHealLocation(sessionId, {
        sourceFileOffset: heal.sourceFileOffset,
        fields,
      });
      pushToast('success', `Heal location saved`);
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
      <div className="entity-inspector entity-inspector--empty" data-testid="heal-location-inspector">
        <p>Open a project to inspect <code>{selection.id}</code>.</p>
      </div>
    );
  }
  if (!heal) {
    return (
      <div className="entity-inspector entity-inspector--empty" data-testid="heal-location-inspector">
        <p>
          The selection references <code>{selection.id}</code> but no heal
          location with that id is present in the scanned manifest.
        </p>
      </div>
    );
  }

  return (
    <div className="entity-inspector" data-testid="heal-location-inspector">
      <header className="entity-inspector__header">
        <div className="entity-inspector__title" data-testid="heal-location-inspector-name">
          Heal location #{heal.slotIndex + 1}
        </div>
        <div className="entity-inspector__sub">
          Player respawns here on white-out, Fly, or Teleport
        </div>
      </header>

      <dl className="entity-inspector__meta-grid">
        <div className="entity-inspector__meta-row">
          <dt>Destination map</dt>
          <dd data-testid="heal-location-inspector-dest">
            {heal.destMapId ? (
              <button
                type="button"
                className="entity-inspector__refs-btn"
                style={{ display: 'inline-block', width: 'auto' }}
                onClick={() => select({ kind: 'map', id: heal.destMapId as string })}
              >
                {displayName(manifest, heal.destMapId, showInternalIds)}
              </button>
            ) : (
              <span>Map not in scanned range</span>
            )}
          </dd>
        </div>
        <div className="entity-inspector__meta-row">
          <dt>Tile coordinates</dt>
          <dd data-testid="heal-location-inspector-coords">
            x={heal.x}, y={heal.y}
          </dd>
        </div>
      </dl>

      <AdvancedDetails testId="heal-location-inspector-advanced">
        <AdvancedField label="Internal ID" value={heal.id} />
        <AdvancedField label="Slot index" value={`SPAWN_${heal.slotIndex}`} />
        <AdvancedField label="Map group / num" value={`${heal.group} / ${heal.mapNum}`} />
        <AdvancedField label="File offset" value={formatHex(heal.sourceFileOffset)} />
      </AdvancedDetails>

      {!editing && sessionId && (
        <button
          type="button"
          className="entity-inspector__edit-btn"
          onClick={beginEdit}
          data-testid="heal-location-inspector-edit-btn"
        >
          Edit destination…
        </button>
      )}
      {editing && (
        <div
          className="entity-inspector__edit-form"
          data-testid="heal-location-inspector-edit-form"
        >
          {/* Phase Q.6.1 - destination map used to be two raw 0-255
              number inputs (group + map num). Users had to know
              "Pallet Town is group 3 map 0" by memory. EntityPicker
              with kind="map" lets them type "pallet" and pick the
              destination by name; packMapId/unpackMapGroup/unpackMapNum
              keep the binary layout intact. */}
          <label className="entity-inspector__num-field">
            <span>Destination map</span>
            <EntityPicker
              kind="map"
              manifest={manifest}
              value={packMapId(draftGroup, draftMapNum)}
              onChange={(packed) => {
                setDraftGroup(unpackMapGroup(packed));
                setDraftMapNum(unpackMapNum(packed));
              }}
              minId={0}
              maxId={0xffff}
              testIdPrefix="heal-location-inspector-edit-map"
              disabled={saving}
            />
          </label>
          <label className="entity-inspector__num-field">
            <span>X</span>
            <input
              type="number"
              min={0}
              max={255}
              value={draftX}
              data-testid="heal-location-inspector-edit-x"
              onChange={(e) => {
                const n = Number.parseInt(e.target.value, 10);
                if (Number.isFinite(n)) setDraftX(Math.max(0, Math.min(255, n)));
              }}
            />
          </label>
          <label className="entity-inspector__num-field">
            <span>Y</span>
            <input
              type="number"
              min={0}
              max={255}
              value={draftY}
              data-testid="heal-location-inspector-edit-y"
              onChange={(e) => {
                const n = Number.parseInt(e.target.value, 10);
                if (Number.isFinite(n)) setDraftY(Math.max(0, Math.min(255, n)));
              }}
            />
          </label>
          <div className="entity-inspector__edit-actions">
            <button
              type="button"
              className="entity-inspector__save-btn"
              onClick={commitEdit}
              disabled={saving}
              data-testid="heal-location-inspector-save-btn"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              className="entity-inspector__cancel-btn"
              onClick={() => setEditing(false)}
              disabled={saving}
              data-testid="heal-location-inspector-cancel-btn"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
