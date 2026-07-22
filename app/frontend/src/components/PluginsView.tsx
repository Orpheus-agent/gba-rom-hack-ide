import { useEffect, useMemo, useState } from 'react';
import type {
  AdapterExtension,
  EventTypeExtension,
  MapLayerExtension,
  PluginManifest,
  PluginParseError,
  PluginsResponse,
  ProjectManifest,
  ValidatorExtension,
} from '@rom-editor/shared';
import { fetchProjectPlugins } from '../api';
import { useProjectStore, useUiPreferencesStore } from '../state';
import {
  runPluginValidators,
  type PluginFinding,
  type PluginFindingReport,
} from '../lib/pluginValidators';
import './PluginsView.css';

interface PluginsViewProps {
  readonly manifest: ProjectManifest;
}

type LoadState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'loaded'; readonly data: PluginsResponse }
  | { readonly kind: 'error'; readonly message: string };

export function PluginsView({ manifest }: PluginsViewProps) {
  const sessionId = useProjectStore((s) =>
    s.load.kind === 'loaded' ? s.load.data.session.id : null,
  );
  const showInternalIds = useUiPreferencesStore((s) => s.showInternalIds);
  const [load, setLoad] = useState<LoadState>({ kind: 'idle' });
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionId) {
      setLoad({ kind: 'idle' });
      return;
    }
    let cancelled = false;
    setLoad({ kind: 'loading' });
    void (async () => {
      try {
        const r = await fetchProjectPlugins(sessionId);
        if (cancelled) return;
        setLoad({ kind: 'loaded', data: r });
        if (r.plugins.length > 0 && selectedId === null) {
          setSelectedId(r.plugins[0]!.id);
        }
      } catch (e) {
        if (!cancelled) {
          setLoad({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // We deliberately exclude selectedId from deps - it's only used to pick a
    // default on first load, and re-running this effect on every selection
    // would re-fetch the plugins list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  const plugins = load.kind === 'loaded' ? load.data.plugins : [];
  const parseErrors = load.kind === 'loaded' ? load.data.parseErrors : [];

  const report = useMemo<PluginFindingReport>(
    () => runPluginValidators(manifest, plugins),
    [manifest, plugins],
  );

  const selected = useMemo(
    () => plugins.find((p) => p.id === selectedId) ?? plugins[0] ?? null,
    [plugins, selectedId],
  );

  return (
    <div className="plugins-view" data-testid="plugins-view">
      <aside className="plugins-view__rail" aria-label="Plugins list">
        <h3 className="plugins-view__rail-heading">
          Plugins <span className="plugins-view__rail-count">({plugins.length})</span>
        </h3>
        {load.kind === 'loading' && (
          <div className="plugins-view__rail-status" data-testid="plugins-view-loading">
            loading…
          </div>
        )}
        {load.kind === 'error' && (
          <div className="plugins-view__rail-status plugins-view__rail-status--err" data-testid="plugins-view-error">
            {load.message}
          </div>
        )}
        {load.kind === 'idle' && (
          <div className="plugins-view__rail-status" data-testid="plugins-view-idle">
            No project session - open a project to load its plugins.
          </div>
        )}
        {load.kind === 'loaded' && plugins.length === 0 && parseErrors.length === 0 && (
          <div className="plugins-view__rail-status" data-testid="plugins-view-empty">
            No plugins installed.<br />
            Drop a JSON file in <code>.editor/plugins/</code> to register one.
          </div>
        )}
        <ul className="plugins-view__list">
          {plugins.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                className={`plugins-view__item${
                  selected?.id === p.id ? ' plugins-view__item--selected' : ''
                }`}
                onClick={() => setSelectedId(p.id)}
                data-testid={`plugins-item-${p.id}`}
              >
                <span className="plugins-view__item-label">{p.label}</span>
                <span className="plugins-view__item-version">v{p.version}</span>
              </button>
            </li>
          ))}
        </ul>
        {parseErrors.length > 0 && (
          <div className="plugins-view__parse-errors" data-testid="plugins-view-parse-errors">
            <h4 className="plugins-view__parse-errors-heading">Parse errors</h4>
            <ul>
              {parseErrors.map((e, i) => (
                <li key={`${e.filePath}-${i}`} data-testid={`plugin-parse-error-${i}`}>
                  <code>{shortName(e.filePath)}</code>
                  <span className="plugins-view__parse-errors-code">{e.code}</span>
                  <span className="plugins-view__parse-errors-msg">{e.message}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </aside>
      <section className="plugins-view__detail">
        {selected ? (
          <PluginDetail
            plugin={selected}
            pluginFindings={report.findings.filter((f) => f.pluginId === selected.id)}
            showInternalIds={showInternalIds}
          />
        ) : (
          <EmptyDetail loaded={load.kind === 'loaded'} errors={parseErrors} />
        )}
      </section>
    </div>
  );
}

function shortName(filePath: string): string {
  const parts = filePath.split(/[\\/]/);
  return parts[parts.length - 1] ?? filePath;
}

function EmptyDetail({
  loaded,
  errors,
}: {
  loaded: boolean;
  errors: ReadonlyArray<PluginParseError>;
}) {
  return (
    <div className="plugin-detail plugin-detail--empty" data-testid="plugin-detail-empty">
      <h2>Plugin Inspector</h2>
      <p>
        Plugins extend the editor with project-specific validator rules,
        event-type aliases, map layer hints, and adapter metadata. They are
        declarative JSON files in <code>&lt;projectRoot&gt;/.editor/plugins/</code>;
        the editor evaluates them - no plugin code runs in this process.
      </p>
      {loaded && errors.length === 0 && (
        <p>
          No plugins installed. Drop a manifest file into the plugins directory and re-open the
          Plugins tab to load it.
        </p>
      )}
    </div>
  );
}

function PluginDetail({
  plugin,
  pluginFindings,
  showInternalIds,
}: {
  plugin: PluginManifest;
  pluginFindings: ReadonlyArray<PluginFinding>;
  showInternalIds: boolean;
}) {
  return (
    <div className="plugin-detail" data-testid="plugin-detail">
      <header className="plugin-detail__header">
        <div className="plugin-detail__title">
          <h2 className="plugin-detail__label">{plugin.label}</h2>
          {/* Phase I.1 - id is a developer-facing identifier (the plugin author
              chose it). Hide unless the operator explicitly opted in to power-
              user diagnosis via "show internal ids". */}
          {showInternalIds && <span className="plugin-detail__id">{plugin.id}</span>}
        </div>
        <span className="plugin-detail__version">v{plugin.version}</span>
      </header>
      {plugin.description && <p className="plugin-detail__desc">{plugin.description}</p>}

      <ValidatorsSection
        validators={plugin.validators ?? []}
        findings={pluginFindings}
      />
      <EventTypesSection eventTypes={plugin.eventTypes ?? []} />
      <MapLayersSection mapLayers={plugin.mapLayers ?? []} />
      <AdaptersSection adapters={plugin.adapters ?? []} />
    </div>
  );
}

function ValidatorsSection({
  validators,
  findings,
}: {
  validators: ReadonlyArray<ValidatorExtension>;
  findings: ReadonlyArray<PluginFinding>;
}) {
  if (validators.length === 0) return null;
  return (
    <section className="plugin-detail__section" data-testid="plugin-detail-validators">
      <h3 className="plugin-detail__section-heading">
        Validators <span className="plugin-detail__count">({validators.length})</span>
        {findings.length > 0 && (
          <span
            className="plugin-detail__finding-count"
            data-testid="plugin-detail-finding-count"
          >
            {findings.length} {findings.length === 1 ? 'finding' : 'findings'}
          </span>
        )}
      </h3>
      <ul className="plugin-detail__validators">
        {validators.map((v) => {
          const ruleFindings = findings.filter((f) => f.ruleId === v.ruleId);
          return (
            <li
              key={v.ruleId}
              className={`plugin-validator plugin-validator--${v.severity}`}
              data-testid={`plugin-validator-${v.ruleId}`}
              data-severity={v.severity}
            >
              <div className="plugin-validator__head">
                <code className="plugin-validator__ruleid">{v.ruleId}</code>
                <span className="plugin-validator__severity">{v.severity}</span>
                <span className="plugin-validator__predicate">{v.predicate.kind}</span>
                <span className="plugin-validator__entity-kind">{v.predicate.entityKind}</span>
              </div>
              <div className="plugin-validator__msg">{v.message}</div>
              {ruleFindings.length > 0 && (
                <ul className="plugin-validator__findings">
                  {ruleFindings.map((f, i) => (
                    <li
                      key={`${f.entityId}-${i}`}
                      data-testid={`plugin-finding-${v.ruleId}-${f.entityId}`}
                    >
                      <code>{f.entityId}</code>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function EventTypesSection({ eventTypes }: { eventTypes: ReadonlyArray<EventTypeExtension> }) {
  if (eventTypes.length === 0) return null;
  return (
    <section className="plugin-detail__section" data-testid="plugin-detail-event-types">
      <h3 className="plugin-detail__section-heading">
        Event types <span className="plugin-detail__count">({eventTypes.length})</span>
      </h3>
      <ul>
        {eventTypes.map((e) => (
          <li key={e.macroName} data-testid={`plugin-event-type-${e.macroName}`}>
            <code>{e.macroName}</code> → <code>{e.kindAlias}</code>
            <span className="plugin-detail__hint">{e.description}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function MapLayersSection({ mapLayers }: { mapLayers: ReadonlyArray<MapLayerExtension> }) {
  if (mapLayers.length === 0) return null;
  return (
    <section className="plugin-detail__section" data-testid="plugin-detail-map-layers">
      <h3 className="plugin-detail__section-heading">
        Map layers (metadata-only)
        <span className="plugin-detail__count">({mapLayers.length})</span>
      </h3>
      <ul>
        {mapLayers.map((l) => (
          <li key={l.layerId} data-testid={`plugin-map-layer-${l.layerId}`}>
            <span
              className="plugin-detail__swatch"
              style={{ backgroundColor: l.color }}
              aria-hidden="true"
            />
            <code>{l.layerId}</code>
            <span>{l.label}</span>
            <span className="plugin-detail__hint">source: {l.source}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function AdaptersSection({ adapters }: { adapters: ReadonlyArray<AdapterExtension> }) {
  if (adapters.length === 0) return null;
  return (
    <section className="plugin-detail__section" data-testid="plugin-detail-adapters">
      <h3 className="plugin-detail__section-heading">
        Adapters (metadata-only)
        <span className="plugin-detail__count">({adapters.length})</span>
      </h3>
      <ul>
        {adapters.map((a) => (
          <li key={a.adapterId} data-testid={`plugin-adapter-${a.adapterId}`}>
            <span className={`plugin-detail__direction plugin-detail__direction--${a.direction}`}>
              {a.direction}
            </span>
            <code>{a.adapterId}</code>
            <span>{a.label}</span>
            <span className="plugin-detail__hint">{a.description}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
