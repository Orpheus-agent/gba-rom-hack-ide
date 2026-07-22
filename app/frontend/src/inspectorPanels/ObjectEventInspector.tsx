import { useMemo, useState } from 'react';
import type { InspectorPanelProps } from '../lib/inspectorRegistry';
import { displayName } from '../lib/displayName';
import {
  pushToast,
  useProjectStore,
  useSelection,
  useUiPreferencesStore,
} from '../state';
import {
  editBinaryRomObjectEventFields,
  ProjectApiError,
} from '../api';
import type {
  ObjectEvent,
  ObjectEventPaletteEntry,
  OverworldSpriteEntry,
  ProjectManifest,
} from '@rom-editor/shared';
import { AdvancedDetails, AdvancedField, formatHex } from './AdvancedDetails';
import { listUniversalSymbols } from '../lib/symbols';
import { NpcGraphicsPicker } from '../components/NpcGraphicsPicker';
import './InspectorShared.css';

// Phase Q.6.1 - plain-English movement-type dropdown options, sourced
// from the universal Gen-3 registry (movementTypes). Computed once at
// module-load so the inspector doesn't re-list 40+ entries on every
// render. Keys are normalised numeric IDs ("0x2" for "Wanders randomly").
const MOVEMENT_OPTIONS = listUniversalSymbols('movement_type')
  .map((entry) => ({
    value: parseInt(entry.hex.replace(/^0x/i, ''), 16),
    label: entry.name,
    description: entry.description,
  }))
  .sort((a, b) => a.value - b.value);

export const OBJECT_EVENT_INSPECTOR_SECTIONS = {
  graphics: 'graphics',
  palette: 'palette',
} as const;

// Phase S.2 - ObjectEventInspector. Shipped as a workspace-dock view
// so clicks from outside MapEditor (FlagInspector flag-gate refs, Find,
// future Navigator drill-downs) surface real metadata. MapEditor's
// own right-aside continues to be the primary edit surface for now;
// this panel is read-mostly with click-through to related entities.

function findObjectEvent(
  manifest: ProjectManifest | null,
  selectionId: string,
): ObjectEvent | null {
  if (!manifest) return null;
  return manifest.objectEvents.find((o) => o.id === selectionId) ?? null;
}

const KIND_LABELS: Record<string, string> = {
  npc: 'NPC',
  trainer: 'Trainer',
  item: 'Item ball',
  hidden_item: 'Hidden item',
  sign: 'Sign',
};

export function ObjectEventInspector(props: InspectorPanelProps) {
  // Consolidated dispatch - when the registry routes `sprite` or
  // `palette` selections here, render a focused sub-view instead of
  // trying to find an object event with that id.
  if (props.selection.kind === 'sprite') {
    return <SpriteSubView {...props} />;
  }
  if (props.selection.kind === 'palette') {
    return <PaletteSubView {...props} />;
  }
  return <ObjectEventInspectorBody {...props} />;
}

function ObjectEventInspectorBody({
  selection,
  manifest,
  sessionId,
}: InspectorPanelProps) {
  const showInternalIds = useUiPreferencesStore((s) => s.showInternalIds);
  const select = useSelection((s) => s.select);
  const scanCurrentProject = useProjectStore((s) => s.scanCurrentProject);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draftGraphics, setDraftGraphics] = useState(0);
  const [draftMovement, setDraftMovement] = useState(0);
  const [draftFlag, setDraftFlag] = useState(0);
  const [draftElevation, setDraftElevation] = useState(0);
  const [draftVision, setDraftVision] = useState(0);

  const obj = useMemo(
    () => findObjectEvent(manifest, selection.id),
    [manifest, selection.id],
  );

  const structOffset =
    obj?.metadata && typeof obj.metadata['structFileOffset'] === 'number'
      ? (obj.metadata['structFileOffset'] as number)
      : null;

  function beginEdit() {
    if (!obj) return;
    const meta = obj.metadata ?? {};
    setDraftGraphics(
      typeof meta['graphicsId'] === 'number' ? (meta['graphicsId'] as number) : 0,
    );
    setDraftMovement(
      typeof meta['movementType'] === 'number'
        ? (meta['movementType'] as number)
        : 0,
    );
    setDraftFlag(typeof meta['flagId'] === 'number' ? (meta['flagId'] as number) : 0);
    setDraftElevation(obj.elevation);
    setDraftVision(
      typeof meta['visionRange'] === 'number'
        ? (meta['visionRange'] as number)
        : 0,
    );
    setEditing(true);
  }

  async function commitEdit() {
    if (!obj || !sessionId || structOffset == null) return;
    const meta = obj.metadata ?? {};
    const fields: Record<string, number> = {};
    const cur = (k: string): number =>
      typeof meta[k] === 'number' ? (meta[k] as number) : 0;
    if (draftGraphics !== cur('graphicsId')) fields['graphicsId'] = draftGraphics;
    if (draftMovement !== cur('movementType')) fields['movementType'] = draftMovement;
    if (draftFlag !== cur('flagId')) fields['flagId'] = draftFlag;
    if (draftElevation !== obj.elevation) fields['elevation'] = draftElevation;
    if (draftVision !== cur('visionRange')) fields['visionRange'] = draftVision;
    if (Object.keys(fields).length === 0) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      await editBinaryRomObjectEventFields(sessionId, [
        { structFileOffset: structOffset, fields },
      ]);
      pushToast('success', `NPC saved`);
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
      <div className="entity-inspector entity-inspector--empty" data-testid="object-event-inspector">
        <p>Open a project to inspect <code>{selection.id}</code>.</p>
      </div>
    );
  }
  if (!obj) {
    return (
      <div className="entity-inspector entity-inspector--empty" data-testid="object-event-inspector">
        <p>
          No object event with id <code>{selection.id}</code> in the manifest
          ({manifest.objectEvents.length} object events indexed).
        </p>
      </div>
    );
  }

  const objName = displayName(manifest, obj.id, showInternalIds);
  const kindLabel = KIND_LABELS[obj.kind] ?? obj.kind;

  return (
    <div className="entity-inspector" data-testid="object-event-inspector">
      <header className="entity-inspector__header">
        <div className="entity-inspector__sub" data-testid="object-event-inspector-kind">
          {kindLabel}
        </div>
        <div className="entity-inspector__title" data-testid="object-event-inspector-name">
          {objName}
        </div>
        <div className="entity-inspector__sub">
          on{' '}
          <button
            type="button"
            className="entity-inspector__refs-btn"
            style={{ display: 'inline-block', padding: '0 4px', background: 'transparent', border: 'none', color: 'var(--color-accent)', textDecoration: 'underline', textDecorationStyle: 'dotted', cursor: 'pointer' }}
            onClick={() => select({ kind: 'map', id: obj.mapId })}
          >
            {displayName(manifest, obj.mapId, showInternalIds)}
          </button>{' '}
          @ ({obj.coord.x}, {obj.coord.y})
        </div>
      </header>

      <dl className="entity-inspector__meta-grid">
        <div className="entity-inspector__meta-row">
          <dt>Graphics</dt>
          <dd data-testid="object-event-inspector-graphics">
            {obj.graphicsId ? (
              <button
                type="button"
                className="entity-inspector__refs-btn"
                style={{ display: 'inline-block', width: 'auto', padding: '0 6px' }}
                onClick={() =>
                  select({ kind: 'sprite', id: obj.graphicsId as string })
                }
              >
                {displayName(manifest, obj.graphicsId, showInternalIds)}
              </button>
            ) : (
              ' - '
            )}
          </dd>
        </div>
        <div className="entity-inspector__meta-row">
          <dt>Movement</dt>
          <dd>{obj.movementType ?? ' - '}</dd>
        </div>
        <div className="entity-inspector__meta-row">
          <dt>Elevation</dt>
          <dd>{obj.elevation}</dd>
        </div>
        {obj.trainerType && (
          <div className="entity-inspector__meta-row">
            <dt>Trainer type</dt>
            <dd>{obj.trainerType}</dd>
          </div>
        )}
      </dl>

      {obj.flagId && (
        <section
          className="entity-inspector__refs"
          data-testid="object-event-inspector-flag"
        >
          <h3 className="entity-inspector__refs-heading">Visibility gated by</h3>
          <button
            type="button"
            className="entity-inspector__refs-btn"
            onClick={() => select({ kind: 'flag', id: obj.flagId as string })}
          >
            <span className="entity-inspector__refs-btn-label">
              {displayName(manifest, obj.flagId, showInternalIds)}
            </span>
            <span className="entity-inspector__refs-btn-meta">flag</span>
          </button>
        </section>
      )}

      {obj.scriptId && (
        <section className="entity-inspector__refs">
          <h3 className="entity-inspector__refs-heading">Script</h3>
          <button
            type="button"
            className="entity-inspector__refs-btn"
            onClick={() => select({ kind: 'script', id: obj.scriptId as string })}
            data-testid="object-event-inspector-script"
          >
            <span className="entity-inspector__refs-btn-label">
              {displayName(manifest, obj.scriptId, showInternalIds)}
            </span>
          </button>
        </section>
      )}

      {!editing && sessionId && structOffset != null && (
        <button
          type="button"
          className="entity-inspector__edit-btn"
          onClick={beginEdit}
          data-testid="object-event-inspector-edit-btn"
        >
          Edit NPC fields…
        </button>
      )}
      {editing && (
        <div
          className="entity-inspector__edit-form"
          data-testid="object-event-inspector-edit-form"
        >
          {/* Phase Q.6.2 - Graphics ID was a raw 0-255 number. Users
              had to memorise that 0x21 means "Bug Catcher", 0x2E means
              "Brock", 0x4C means "Mewtwo" etc. NpcGraphicsPicker
              renders a categorised, searchable thumbnail-grid backed
              by the per-family OBJ_EVENT_GFX_* registry (FRLG vs
              Emerald rosters; CFRU / expansion inherit appropriately).
              Lazy-loads sprite thumbnails via fetchBinaryRomOwSprite
              for the currently-selected sprite + each tile as it
              mounts; module-level cache keeps re-opens snappy. */}
          <label className="entity-inspector__num-field">
            <span>NPC sprite</span>
            {manifest ? (
              <NpcGraphicsPicker
                manifest={manifest}
                value={draftGraphics}
                onChange={setDraftGraphics}
                sessionId={sessionId}
                disabled={saving}
                testIdPrefix="object-event-inspector-edit-graphics"
              />
            ) : (
              <input
                type="number"
                min={0}
                max={255}
                value={draftGraphics}
                data-testid="object-event-inspector-edit-graphics"
                onChange={(e) => {
                  const n = Number.parseInt(e.target.value, 10);
                  if (Number.isFinite(n))
                    setDraftGraphics(Math.max(0, Math.min(255, n)));
                }}
              />
            )}
          </label>
          {/* Phase Q.6.1 - movement was a raw 0-255 number input.
              Users had to memorise that 2 means "wanders randomly", 7
              means "faces up", etc. Dropdown with plain-English labels
              from the universal Gen-3 registry. Hack-added types
              beyond the registry render as "Movement type #N" via the
              fallback option below. */}
          <label className="entity-inspector__num-field">
            <span>Movement</span>
            <select
              value={draftMovement}
              data-testid="object-event-inspector-edit-movement"
              onChange={(e) =>
                setDraftMovement(Number.parseInt(e.target.value, 10))
              }
              title={
                MOVEMENT_OPTIONS.find((m) => m.value === draftMovement)
                  ?.description ?? undefined
              }
            >
              {MOVEMENT_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
              {!MOVEMENT_OPTIONS.some((o) => o.value === draftMovement) && (
                <option value={draftMovement}>
                  Movement type #{draftMovement} (hack-added)
                </option>
              )}
            </select>
          </label>
          <label className="entity-inspector__num-field">
            <span>Flag id</span>
            <input
              type="number"
              min={0}
              max={65535}
              value={draftFlag}
              data-testid="object-event-inspector-edit-flag"
              onChange={(e) => {
                const n = Number.parseInt(e.target.value, 10);
                if (Number.isFinite(n)) setDraftFlag(Math.max(0, Math.min(65535, n)));
              }}
            />
          </label>
          <label className="entity-inspector__num-field">
            <span>Elevation</span>
            <input
              type="number"
              min={0}
              max={15}
              value={draftElevation}
              data-testid="object-event-inspector-edit-elevation"
              onChange={(e) => {
                const n = Number.parseInt(e.target.value, 10);
                if (Number.isFinite(n))
                  setDraftElevation(Math.max(0, Math.min(15, n)));
              }}
            />
          </label>
          <label className="entity-inspector__num-field">
            <span>Vision range</span>
            <input
              type="number"
              min={0}
              max={31}
              value={draftVision}
              data-testid="object-event-inspector-edit-vision"
              onChange={(e) => {
                const n = Number.parseInt(e.target.value, 10);
                if (Number.isFinite(n))
                  setDraftVision(Math.max(0, Math.min(31, n)));
              }}
            />
          </label>
          <div className="entity-inspector__edit-actions">
            <button
              type="button"
              className="entity-inspector__save-btn"
              onClick={commitEdit}
              disabled={saving}
              data-testid="object-event-inspector-save-btn"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              className="entity-inspector__cancel-btn"
              onClick={() => setEditing(false)}
              disabled={saving}
              data-testid="object-event-inspector-cancel-btn"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// === Consolidated sub-views (absorbed from deleted inspectors) ============

function findSpriteById(manifest: ProjectManifest, id: string): OverworldSpriteEntry | null {
  const sprites = manifest.overworldSprites ?? [];
  const direct = sprites.find((s) => s.id === id);
  if (direct) return direct;
  const m = /^gfx_(\d+)$/.exec(id) ?? /^binary_owsprite_(\d+)$/.exec(id);
  if (m) {
    const idx = Number.parseInt(m[1]!, 10);
    return sprites.find((s) => s.spriteIndex === idx) ?? null;
  }
  return null;
}

function findPaletteById(manifest: ProjectManifest, id: string): ObjectEventPaletteEntry | null {
  const list = manifest.objectEventPalettes ?? [];
  const direct = list.find((p) => p.id === id);
  if (direct) return direct;
  const synth = /^palette_(\d+|0x[0-9A-Fa-f]+)$/.exec(id);
  if (synth) {
    const raw = synth[1]!;
    const idx = raw.startsWith('0x') ? parseInt(raw, 16) : parseInt(raw, 10);
    return list.find((p) => p.tag === idx) ?? list.find((p) => p.entryIndex === idx) ?? null;
  }
  return null;
}

function rgbaCss(rgba: number): string {
  const r = (rgba >>> 24) & 0xff;
  const g = (rgba >>> 16) & 0xff;
  const b = (rgba >>> 8) & 0xff;
  const a = rgba & 0xff;
  return `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(3)})`;
}

/** Sprite metadata + back-refs. Replaces the deleted SpriteInspector. */
function SpriteSubView({ selection, manifest }: InspectorPanelProps): JSX.Element {
  const showInternalIds = useUiPreferencesStore((s) => s.showInternalIds);
  const select = useSelection((s) => s.select);

  if (!manifest) {
    return (
      <div className="entity-inspector entity-inspector--empty" data-testid="sprite-inspector">
        <p>Open a project to inspect this sprite.</p>
      </div>
    );
  }
  const sprite = findSpriteById(manifest, selection.id);
  if (!sprite) {
    return (
      <div className="entity-inspector entity-inspector--empty" data-testid="sprite-inspector">
        <p>No overworld sprite matches this selection.</p>
      </div>
    );
  }
  const palette = (manifest.objectEventPalettes ?? []).find((p) => p.tag === sprite.paletteTag);
  const users = manifest.objectEvents.filter((o) => o.graphicsId === `gfx_${sprite.spriteIndex}`);

  return (
    <div className="entity-inspector" data-testid="sprite-inspector">
      <header className="entity-inspector__header">
        <div className="entity-inspector__sub">Overworld sprite</div>
        <div className="entity-inspector__title" data-testid="sprite-inspector-name">
          Sprite #{sprite.spriteIndex}
        </div>
        <div className="entity-inspector__sub">{sprite.width}×{sprite.height}px</div>
      </header>

      <dl className="entity-inspector__meta-grid">
        <div className="entity-inspector__meta-row">
          <dt>Palette</dt>
          <dd data-testid="sprite-inspector-palette-tag">
            {palette ? (
              <button
                type="button"
                className="entity-inspector__refs-btn"
                style={{ display: 'inline-block', width: 'auto', padding: '0 6px' }}
                onClick={() => select({ kind: 'palette', id: palette.id })}
              >
                Palette #{palette.entryIndex}
              </button>
            ) : (
              <span className="entity-inspector__refs-btn-meta">Unresolved</span>
            )}
          </dd>
        </div>
      </dl>

      <section className="entity-inspector__refs" data-testid="sprite-inspector-users">
        <h3 className="entity-inspector__refs-heading">
          Used by{' '}
          <span className="entity-inspector__refs-count">({users.length})</span>
        </h3>
        {users.length === 0 ? (
          <p className="entity-inspector__refs-empty">
            No NPCs reference this sprite in the scanned manifest.
          </p>
        ) : (
          <ul className="entity-inspector__refs-list">
            {users.slice(0, 40).map((o) => (
              <li key={o.id}>
                <button
                  type="button"
                  className="entity-inspector__refs-btn"
                  onClick={() => select({ kind: 'objectEvent', id: o.id, mapContext: o.mapId })}
                >
                  <span className="entity-inspector__refs-btn-label">
                    {displayName(manifest, o.id, showInternalIds)}
                  </span>
                  <span className="entity-inspector__refs-btn-meta">
                    on {displayName(manifest, o.mapId, showInternalIds)}
                  </span>
                </button>
              </li>
            ))}
            {users.length > 40 && (
              <li className="entity-inspector__refs-more">+ {users.length - 40} more</li>
            )}
          </ul>
        )}
      </section>

      <AdvancedDetails testId="sprite-inspector-advanced">
        <AdvancedField label="Sprite index" value={`#${sprite.spriteIndex}`} />
        <AdvancedField label="Tile tag" value={formatHex(sprite.tileTag, 4)} />
        <AdvancedField label="Palette tag" value={formatHex(sprite.paletteTag, 4)} />
        <AdvancedField label="Struct offset" value={formatHex(sprite.structFileOffset)} />
      </AdvancedDetails>
    </div>
  );
}

/** Visual 16-color palette swatch. Replaces the deleted PaletteInspector. */
function PaletteSubView({ selection, manifest }: InspectorPanelProps): JSX.Element {
  if (!manifest) {
    return (
      <div className="entity-inspector entity-inspector--empty" data-testid="palette-inspector">
        <p>Open a project to inspect this palette.</p>
      </div>
    );
  }
  const palette = findPaletteById(manifest, selection.id);
  if (!palette) {
    return (
      <div className="entity-inspector entity-inspector--empty" data-testid="palette-inspector">
        <p>No palette matches this selection.</p>
      </div>
    );
  }

  return (
    <div className="entity-inspector palette-inspector" data-testid="palette-inspector">
      <header className="entity-inspector__header">
        <div className="entity-inspector__sub">NPC sprite palette</div>
        <div className="entity-inspector__title" data-testid="palette-inspector-name">
          Palette #{palette.entryIndex}
        </div>
        <div className="entity-inspector__sub">16 colors · slot 0 is transparent</div>
      </header>

      <section data-testid="palette-inspector-swatches">
        <div
          aria-label="Palette swatches"
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(4, 1fr)',
            gap: 6,
            maxWidth: 240,
            marginTop: 8,
          }}
        >
          {palette.paletteRgba.slice(0, 16).map((rgba, i) => {
            const transparent = i === 0;
            return (
              <div
                key={i}
                title={`Slot ${i}`}
                data-testid={`palette-inspector-slot-${i}`}
                style={{
                  height: 44,
                  borderRadius: 3,
                  background: transparent
                    ? 'repeating-linear-gradient(45deg, #2a2a2a 0 6px, #1a1a1a 6px 12px)'
                    : rgbaCss(rgba),
                  position: 'relative',
                  border: '1px solid var(--color-border)',
                }}
              >
                <span
                  style={{
                    position: 'absolute',
                    top: 2,
                    left: 4,
                    fontSize: 9,
                    color: 'rgba(255,255,255,0.6)',
                    textShadow: '0 0 2px #000',
                  }}
                >
                  {i}
                </span>
              </div>
            );
          })}
        </div>
      </section>

      <AdvancedDetails testId="palette-inspector-advanced">
        <AdvancedField label="Palette tag" value={formatHex(palette.tag, 4)} />
        <AdvancedField label="Entry offset" value={formatHex(palette.entryFileOffset)} />
        <AdvancedField label="Block offset" value={formatHex(palette.paletteFileOffset)} />
      </AdvancedDetails>
    </div>
  );
}
