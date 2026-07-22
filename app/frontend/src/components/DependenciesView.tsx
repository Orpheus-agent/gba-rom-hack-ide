import { useMemo, useState } from 'react';
import type { ProjectManifest } from '@rom-editor/shared';
import {
  findEntityReferences,
  type EntityReferenceReport,
  type ReferenceLink,
  type ReferenceableEntityKind,
} from '../lib/entityReferences';
import { useUiPreferencesStore } from '../state';
import { resolveDisplayName } from '../lib/displayName';
import './DependenciesView.css';

interface DependenciesViewProps {
  readonly manifest: ProjectManifest;
}

const KIND_OPTIONS: ReadonlyArray<{ value: ReferenceableEntityKind; label: string }> = [
  { value: 'map', label: 'Map' },
  { value: 'flag', label: 'Flag' },
  { value: 'asset', label: 'Asset' },
  { value: 'dialogue', label: 'Dialogue' },
  { value: 'object_event', label: 'Object event' },
  { value: 'trigger', label: 'Trigger' },
  { value: 'warp', label: 'Warp' },
  { value: 'variable', label: 'Variable' },
  { value: 'encounter_table', label: 'Encounter table' },
  { value: 'trainer', label: 'Trainer' },
  { value: 'script_step', label: 'Script step' },
];

function idsForKind(manifest: ProjectManifest, kind: ReferenceableEntityKind): string[] {
  switch (kind) {
    case 'map':
      return manifest.maps.map((m) => m.id);
    case 'flag':
      return manifest.flags.map((f) => f.id);
    case 'asset':
      return manifest.assets.map((a) => a.id);
    case 'dialogue':
      return manifest.dialogue.map((d) => d.id);
    case 'object_event':
      return manifest.objectEvents.map((o) => o.id);
    case 'trigger':
      return manifest.triggers.map((t) => t.id);
    case 'warp':
      return manifest.warps.map((w) => w.id);
    case 'variable':
      return manifest.variables.map((v) => v.id);
    case 'encounter_table':
      return manifest.encounterTables.map((e) => e.id);
    case 'trainer':
      return manifest.trainers.map((t) => t.id);
    case 'script_step':
      return manifest.scriptSteps.map((s) => s.id);
  }
}

export function DependenciesView({ manifest }: DependenciesViewProps) {
  const [kind, setKind] = useState<ReferenceableEntityKind>('map');
  const [id, setId] = useState('');

  // Pre-compute id list for the selected kind so the datalist autocompletes.
  const ids = useMemo(() => idsForKind(manifest, kind), [manifest, kind]);

  // Auto-select the first id of the chosen kind on first mount / when kind
  // changes, so the report panel has something to show without a click.
  const effectiveId = id.trim().length > 0 ? id.trim() : ids[0] ?? '';

  const report = useMemo<EntityReferenceReport | null>(() => {
    if (!effectiveId) return null;
    return findEntityReferences(manifest, kind, effectiveId);
  }, [manifest, kind, effectiveId]);

  return (
    <div className="deps-view" data-testid="deps-view">
      <header className="deps-view__header">
        <h2 className="deps-view__title">Dependencies</h2>
        <p className="deps-view__hint">
          Pick any entity kind + id. The report shows every entity that depends on it (inbound)
          and every entity it depends on (outbound) - derived from the canonical manifest.
        </p>
      </header>
      <div className="deps-view__controls">
        <label className="deps-view__field">
          <span className="deps-view__field-label">Kind</span>
          <select
            value={kind}
            onChange={(e) => {
              setKind(e.target.value as ReferenceableEntityKind);
              setId('');
            }}
            className="deps-view__select"
            data-testid="deps-view-kind"
          >
            {KIND_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="deps-view__field deps-view__field--grow">
          <span className="deps-view__field-label">
            Entity id <span className="deps-view__id-count">({ids.length} available)</span>
          </span>
          <input
            type="text"
            list={`deps-ids-${kind}`}
            value={id}
            onChange={(e) => setId(e.target.value)}
            placeholder={ids[0] ?? '(no entities of this kind)'}
            className="deps-view__input"
            data-testid="deps-view-id"
          />
          <datalist id={`deps-ids-${kind}`}>
            {/* Phase G-RC6: surface resolved display names alongside the
                id so the autocomplete dropdown doesn't only show raw
                synthetic ids. The `value` is the id (so picking it
                feeds the lookup), the `label`/inner text is the
                human-readable name. */}
            {ids.slice(0, 200).map((entityId) => {
              const r = resolveDisplayName(manifest, entityId);
              return (
                <option
                  key={entityId}
                  value={entityId}
                  label={r.text !== entityId ? `${r.text} - ${entityId}` : entityId}
                />
              );
            })}
          </datalist>
        </label>
      </div>
      <section className="deps-view__report" data-testid="deps-view-report">
        {!report || !effectiveId ? (
          <div className="deps-view__placeholder">No entity selected.</div>
        ) : !report.found ? (
          <div className="deps-view__placeholder" data-testid="deps-view-not-found">
            <code>{effectiveId}</code> not found among <strong>{kind}</strong> entities.
          </div>
        ) : (
          <ReportPanel report={report} manifest={manifest} />
        )}
      </section>
    </div>
  );
}

function ReportPanel({
  report,
  manifest,
}: {
  report: EntityReferenceReport;
  manifest: ProjectManifest;
}) {
  const showInternalIds = useUiPreferencesStore((s) => s.showInternalIds);
  const headerLabel = resolveDisplayName(manifest, report.entityId).text;
  return (
    <div className="deps-report">
      <header className="deps-report__header">
        <h3 className="deps-report__id" data-testid="deps-report-id">
          {headerLabel}
          {showInternalIds && headerLabel !== report.entityId && (
            <span className="deps-report__internal-id"> ({report.entityId})</span>
          )}
        </h3>
        <span className={`deps-report__kind-badge deps-report__kind-badge--${report.entityKind}`}>
          {report.entityKind.replace(/_/g, ' ')}
        </span>
      </header>
      <div className="deps-report__sections">
        <ReferenceList
          title="Inbound (entities depending on this)"
          links={report.inbound}
          testid="deps-report-inbound"
          manifest={manifest}
        />
        <ReferenceList
          title="Outbound (entities this depends on)"
          links={report.outbound}
          testid="deps-report-outbound"
          manifest={manifest}
        />
      </div>
    </div>
  );
}

function ReferenceList({
  title,
  links,
  testid,
  manifest,
}: {
  title: string;
  links: ReadonlyArray<ReferenceLink>;
  testid: string;
  manifest: ProjectManifest;
}) {
  const showInternalIds = useUiPreferencesStore((s) => s.showInternalIds);
  return (
    <section className="deps-list" data-testid={testid}>
      <h4 className="deps-list__title">
        {title} <span className="deps-list__count">({links.length})</span>
      </h4>
      {links.length === 0 ? (
        <div className="deps-list__empty">(none)</div>
      ) : (
        <ul className="deps-list__items">
          {links.map((link, i) => {
            const resolved = resolveDisplayName(manifest, link.id);
            return (
              <li
                key={`${link.kind}::${link.id}::${i}`}
                className={`deps-list__row deps-list__row--${link.kind}`}
                data-testid={`deps-link-${link.kind}-${link.id}`}
              >
                <span className={`deps-list__kind-chip deps-list__kind-chip--${link.kind}`}>
                  {link.kind.replace(/_/g, ' ')}
                </span>
                <span className="deps-list__id">{resolved.text}</span>
                {showInternalIds && resolved.text !== link.id && (
                  <code className="deps-list__id-debug">{link.id}</code>
                )}
                <span className="deps-list__relation">{link.relation}</span>
                {link.context && <span className="deps-list__context">{link.context}</span>}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
