import { useCallback, useEffect, useMemo, useState } from 'react';
import type { MechanicConfigDoc, ProjectManifest } from '@rom-editor/shared';
import { emptyMechanicConfigDoc } from '@rom-editor/shared';
import {
  assessAllMechanics,
  type MechanicDetection,
  type MechanicId,
} from '../lib/mechanicDetectors';
import { fetchMechanicConfig, patchMechanicConfig, ProjectApiError } from '../api';
import { useProjectStore, useUiPreferencesStore } from '../state';
import { displayName } from '../lib/displayName';
import './MechanicsView.css';

interface MechanicsViewProps {
  readonly manifest: ProjectManifest;
}

/** Phase G-RC6 - resolve an entity id embedded in a signature string to
 *  a display name. Signature lines come in a few shapes:
 *    - bare id: "binary_map_1_4"
 *    - id with trailing note: "binary_map_1_4 (2 tables)"
 *    - dialogue-or-script id: "MyMap_EventScript_NPC" (already friendly)
 *  We try to extract a leading id, resolve via `displayName`, and
 *  preserve any trailing note. When the toggle is on we append the
 *  raw id in parens for diagnosis. */
function resolveSignatureDisplay(
  manifest: ProjectManifest,
  raw: string,
  showInternalIds: boolean,
): string {
  const m = /^(\S+)(\s+\(.+\))?$/.exec(raw);
  if (!m) return raw;
  const id = m[1]!;
  const trail = m[2] ?? '';
  return `${displayName(manifest, id, showInternalIds)}${trail}`;
}

export function MechanicsView({ manifest }: MechanicsViewProps) {
  const showInternalIds = useUiPreferencesStore((s) => s.showInternalIds);
  const detections = useMemo(() => assessAllMechanics(manifest), [manifest]);
  const [selectedId, setSelectedId] = useState<MechanicId | null>(
    detections.find((d) => d.present)?.id ?? detections[0]?.id ?? null,
  );
  const selected = detections.find((d) => d.id === selectedId) ?? null;
  const presentCount = detections.filter((d) => d.present).length;
  const sessionId = useProjectStore((s) =>
    s.load.kind === 'loaded' ? s.load.data.session.id : null,
  );

  const [configDoc, setConfigDoc] = useState<MechanicConfigDoc>(() => emptyMechanicConfigDoc());
  const [configLoaded, setConfigLoaded] = useState(false);

  useEffect(() => {
    if (!sessionId) {
      setConfigLoaded(false);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetchMechanicConfig(sessionId);
        if (!cancelled) {
          setConfigDoc(r.doc);
          setConfigLoaded(true);
        }
      } catch {
        if (!cancelled) setConfigLoaded(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const handleConfigChange = useCallback(
    async (mechanicId: MechanicId, partial: Record<string, unknown>): Promise<void> => {
      if (!sessionId) return;
      try {
        const r = await patchMechanicConfig(sessionId, mechanicId, partial);
        setConfigDoc(r.doc);
      } catch (e) {
        // Surface the error via console; the UI keeps the local state so the
        // writer doesn't lose their edits.
        // eslint-disable-next-line no-console
        console.error('patchMechanicConfig failed:', e);
      }
    },
    [sessionId],
  );

  return (
    <div className="mechanics-view" data-testid="mechanics-view">
      <aside className="mechanics-view__rail" aria-label="Mechanics list">
        <h3 className="mechanics-view__rail-heading">
          Mechanics{' '}
          <span className="mechanics-view__rail-count">
            ({presentCount}/{detections.length} detected)
          </span>
        </h3>
        <ul className="mechanics-view__list">
          {detections.map((d) => (
            <li key={d.id}>
              <button
                type="button"
                className={`mechanics-view__item mechanics-view__item--${d.severity}${d.id === selectedId ? ' mechanics-view__item--selected' : ''}`}
                onClick={() => setSelectedId(d.id)}
                data-testid={`mechanics-item-${d.id}`}
                data-severity={d.severity}
              >
                <span className="mechanics-view__item-label">{d.label}</span>
                <span className={`mechanics-view__chip mechanics-view__chip--${d.severity}`}>
                  {d.severity}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </aside>
      <section className="mechanics-view__detail">
        {selected ? (
          <MechanicDetail
            manifest={manifest}
            detection={selected}
            config={configDoc}
            configLoaded={configLoaded}
            onConfigChange={handleConfigChange}
            showInternalIds={showInternalIds}
          />
        ) : (
          <div className="mechanics-view__placeholder">
            Pick a mechanic to inspect its signature.
          </div>
        )}
      </section>
    </div>
  );
}

function MechanicDetail({
  manifest,
  detection,
  config,
  configLoaded,
  onConfigChange,
  showInternalIds,
}: {
  manifest: ProjectManifest;
  detection: MechanicDetection;
  config: MechanicConfigDoc;
  configLoaded: boolean;
  onConfigChange: (mechanicId: MechanicId, partial: Record<string, unknown>) => Promise<void>;
  showInternalIds: boolean;
}) {
  return (
    <div className="mechanic-detail" data-testid="mechanic-detail">
      <header className="mechanic-detail__header">
        <h2 className="mechanic-detail__label">{detection.label}</h2>
        <span
          className={`mechanic-detail__severity mechanic-detail__severity--${detection.severity}`}
          data-testid="mechanic-detail-severity"
        >
          {detection.severity}
        </span>
      </header>
      <dl className="mechanic-detail__meta">
        <span style={{ display: 'contents' }}>
          <dt>Status</dt>
          <dd data-testid="mechanic-detail-present">
            {detection.present ? 'Present' : 'Vanilla (not customized)'}
          </dd>
        </span>
      </dl>
      <section className="mechanic-detail__section">
        <h3 className="mechanic-detail__section-heading">Notes</h3>
        <ul className="mechanic-detail__notes">
          {detection.notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      </section>
      <section className="mechanic-detail__section">
        <h3 className="mechanic-detail__section-heading">
          Signature{' '}
          <span className="mechanic-detail__count">({detection.signature.length})</span>
        </h3>
        {detection.signature.length === 0 ? (
          <div className="mechanic-detail__empty">
            No entity ids in the signature - the project doesn't use this mechanic.
          </div>
        ) : (
          <ul className="mechanic-detail__signature">
            {detection.signature.map((s) => {
              // Phase G-RC6: each signature line is either a bare
              // entity id or a "label (id)" / "id (note)" composite
              // string. Try to extract the entity id and resolve it;
              // fall back to passthrough when nothing matches.
              const display = resolveSignatureDisplay(manifest, s, showInternalIds);
              return (
                <li key={s}>{display}</li>
              );
            })}
          </ul>
        )}
      </section>
      <MechanicConfigEditor
        mechanicId={detection.id}
        config={config}
        configLoaded={configLoaded}
        onChange={onConfigChange}
      />
    </div>
  );
}

const FIELD_LABELS: Readonly<Record<MechanicId, Readonly<Record<string, string>>>> = {
  starter_selection: { starters: 'Starters (species ids)' },
  difficulty_system: { enabledModes: 'Enabled mode flag ids' },
  evolution_flags: { giftSpecies: 'Gift species ids' },
  encounter_variants: { enabledTypes: 'Enabled encounter types' },
};

const FIELD_KEYS: Readonly<Record<MechanicId, ReadonlyArray<string>>> = {
  starter_selection: ['starters'],
  difficulty_system: ['enabledModes'],
  evolution_flags: ['giftSpecies'],
  encounter_variants: ['enabledTypes'],
};

function getCurrentList(config: MechanicConfigDoc, mechanicId: MechanicId, fieldKey: string): string[] {
  const bag = (config as unknown as Record<string, Record<string, unknown>>)[mechanicId];
  if (!bag) return [];
  const v = bag[fieldKey];
  return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
}

function MechanicConfigEditor({
  mechanicId,
  config,
  configLoaded,
  onChange,
}: {
  mechanicId: MechanicId;
  config: MechanicConfigDoc;
  configLoaded: boolean;
  onChange: (mechanicId: MechanicId, partial: Record<string, unknown>) => Promise<void>;
}) {
  const fields = FIELD_KEYS[mechanicId];
  return (
    <section className="mechanic-detail__section" data-testid="mechanic-config-editor">
      <h3 className="mechanic-detail__section-heading">Configuration</h3>
      {!configLoaded && (
        <div className="mechanic-detail__empty">
          Config not loaded (no session yet) - once a project is open, your edits persist to
          <code> .editor/mechanic-config.json</code>.
        </div>
      )}
      {fields.map((fieldKey) => (
        <ListEditor
          key={fieldKey}
          mechanicId={mechanicId}
          fieldKey={fieldKey}
          label={FIELD_LABELS[mechanicId][fieldKey] ?? fieldKey}
          values={getCurrentList(config, mechanicId, fieldKey)}
          disabled={!configLoaded}
          onChange={(next) => void onChange(mechanicId, { [fieldKey]: next })}
        />
      ))}
    </section>
  );
}

function ListEditor({
  mechanicId,
  fieldKey,
  label,
  values,
  disabled,
  onChange,
}: {
  mechanicId: MechanicId;
  fieldKey: string;
  label: string;
  values: ReadonlyArray<string>;
  disabled: boolean;
  onChange: (next: string[]) => void;
}) {
  const [input, setInput] = useState('');
  return (
    <div className="mechanic-config-field" data-testid={`mc-field-${mechanicId}-${fieldKey}`}>
      <div className="mechanic-config-field__label">{label}</div>
      <ul className="mechanic-config-field__chips">
        {values.length === 0 ? (
          <li className="mechanic-config-field__empty">(none)</li>
        ) : (
          values.map((v) => (
            <li key={v} className="mechanic-config-field__chip">
              <code>{v}</code>
              <button
                type="button"
                className="mechanic-config-field__remove"
                disabled={disabled}
                onClick={() => onChange(values.filter((x) => x !== v))}
                data-testid={`mc-remove-${mechanicId}-${fieldKey}-${v}`}
                title="Remove"
              >
                ×
              </button>
            </li>
          ))
        )}
      </ul>
      <div className="mechanic-config-field__add">
        <input
          type="text"
          className="mechanic-config-field__input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="add identifier"
          spellCheck={false}
          disabled={disabled}
          data-testid={`mc-input-${mechanicId}-${fieldKey}`}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              const t = input.trim();
              if (t && !values.includes(t)) {
                onChange([...values, t]);
                setInput('');
              }
            }
          }}
        />
        <button
          type="button"
          className="mechanic-config-field__add-btn"
          disabled={disabled || input.trim().length === 0}
          onClick={() => {
            const t = input.trim();
            if (t && !values.includes(t)) {
              onChange([...values, t]);
              setInput('');
            }
          }}
          data-testid={`mc-add-${mechanicId}-${fieldKey}`}
        >
          Add
        </button>
      </div>
    </div>
  );
}

void ProjectApiError;
