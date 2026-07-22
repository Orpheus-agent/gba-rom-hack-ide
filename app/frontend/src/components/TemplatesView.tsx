import { useCallback, useMemo, useState } from 'react';
import {
  getTemplate,
  listTemplates,
  materializeTemplate,
  TemplateError,
  type TemplateDefinition,
  type TemplateId,
  type TemplateMaterialization,
} from '../lib/templates';
import { ProjectApiError, stageTemplate } from '../api';
import { useProjectStore } from '../state';
import './TemplatesView.css';

type StageState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'staging' }
  | { readonly kind: 'done'; readonly stagedPath: string; readonly stagedAtUtc: string }
  | { readonly kind: 'error'; readonly message: string };

export function TemplatesView() {
  const templates = useMemo(() => listTemplates(), []);
  const [selectedId, setSelectedId] = useState<TemplateId>(templates[0]?.id ?? 'town_skeleton');
  const selected = useMemo(() => getTemplate(selectedId), [selectedId]);

  // Per-template form state - a flat map of paramKey → value, reset when
  // the selection changes.
  const [paramValues, setParamValues] = useState<Record<string, string>>(() =>
    paramDefaultsFor(selected),
  );
  const [stageState, setStageState] = useState<StageState>({ kind: 'idle' });

  const onSelect = useCallback(
    (id: TemplateId) => {
      setSelectedId(id);
      setParamValues(paramDefaultsFor(getTemplate(id)));
      setStageState({ kind: 'idle' });
    },
    [],
  );

  let materialization: TemplateMaterialization | null = null;
  let materializeError: string | null = null;
  try {
    materialization = materializeTemplate(selectedId, paramValues);
  } catch (e) {
    if (e instanceof TemplateError) {
      materializeError = e.message;
    } else {
      materializeError = e instanceof Error ? e.message : String(e);
    }
  }

  const sessionId = useProjectStore((s) =>
    s.load.kind === 'loaded' ? s.load.data.session.id : null,
  );

  const onStage = useCallback(async (): Promise<void> => {
    if (!sessionId || !materialization) return;
    setStageState({ kind: 'staging' });
    try {
      const r = await stageTemplate(
        sessionId,
        selectedId,
        paramValues,
        materialization as unknown as Record<string, unknown>,
      );
      setStageState({ kind: 'done', stagedPath: r.stagedPath, stagedAtUtc: r.stagedAtUtc });
    } catch (e) {
      const message =
        e instanceof ProjectApiError
          ? `${e.code}: ${e.message}`
          : e instanceof Error
            ? e.message
            : String(e);
      setStageState({ kind: 'error', message });
    }
  }, [sessionId, selectedId, paramValues, materialization]);

  return (
    <div className="templates-view" data-testid="templates-view">
      <aside className="templates-view__rail" aria-label="Template list">
        <h3 className="templates-view__rail-heading">
          Templates <span className="templates-view__rail-count">({templates.length})</span>
        </h3>
        <ul className="templates-view__list">
          {templates.map((t) => (
            <li key={t.id}>
              <button
                type="button"
                className={`templates-view__item templates-view__item--${t.category}${
                  t.id === selectedId ? ' templates-view__item--selected' : ''
                }`}
                onClick={() => onSelect(t.id)}
                data-testid={`templates-item-${t.id}`}
              >
                <span className="templates-view__item-label">{t.label}</span>
                <span className={`templates-view__chip templates-view__chip--${t.category}`}>
                  {t.category}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </aside>
      <section className="templates-view__detail">
        <TemplateDetail
          definition={selected}
          paramValues={paramValues}
          onParamChange={(key, value) =>
            setParamValues((p) => ({ ...p, [key]: value }))
          }
          materialization={materialization}
          materializeError={materializeError}
          sessionId={sessionId}
          stageState={stageState}
          onStage={onStage}
        />
      </section>
    </div>
  );
}

function paramDefaultsFor(def: TemplateDefinition): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of def.params) {
    out[p.key] = p.defaultValue ?? '';
  }
  return out;
}

function TemplateDetail({
  definition,
  paramValues,
  onParamChange,
  materialization,
  materializeError,
  sessionId,
  stageState,
  onStage,
}: {
  definition: TemplateDefinition;
  paramValues: Record<string, string>;
  onParamChange: (key: string, value: string) => void;
  materialization: TemplateMaterialization | null;
  materializeError: string | null;
  sessionId: string | null;
  stageState: StageState;
  onStage: () => Promise<void>;
}) {
  const canStage =
    sessionId !== null &&
    materialization !== null &&
    stageState.kind !== 'staging';

  return (
    <div className="template-detail" data-testid="template-detail">
      <header className="template-detail__header">
        <h2 className="template-detail__label">{definition.label}</h2>
        <span className={`template-detail__category template-detail__category--${definition.category}`}>
          {definition.category}
        </span>
      </header>
      <p className="template-detail__desc">{definition.description}</p>

      {definition.params.length > 0 && (
        <section className="template-detail__params" data-testid="template-detail-params">
          <h3 className="template-detail__section-heading">Parameters</h3>
          <div className="template-detail__param-rows">
            {definition.params.map((p) => (
              <label key={p.key} className="template-detail__param">
                <span className="template-detail__param-label">
                  {p.label}
                  {p.required && <span className="template-detail__required"> *</span>}
                </span>
                <input
                  type="text"
                  className="template-detail__param-input"
                  value={paramValues[p.key] ?? ''}
                  onChange={(e) => onParamChange(p.key, e.target.value)}
                  placeholder={p.placeholder}
                  spellCheck={false}
                  data-testid={`template-param-${p.key}`}
                />
              </label>
            ))}
          </div>
        </section>
      )}

      <section className="template-detail__preview" data-testid="template-detail-preview">
        <h3 className="template-detail__section-heading">Preview</h3>
        {materializeError ? (
          <div className="template-detail__error" data-testid="template-detail-error">
            {materializeError}
          </div>
        ) : materialization ? (
          <>
            <div className="template-detail__summary">{materialization.summary}</div>
            {/* Phase I.1 - replaced raw JSON.stringify dump with a structured
                per-collection summary. The user pointed at "raw JSON dumps" as
                one of the things they wanted gone. The collapsible JSON
                disclosure stays for power users who need to copy/paste. */}
            <TemplatePreview entities={materialization.entities} />
          </>
        ) : null}
      </section>

      <section className="template-detail__actions">
        <button
          type="button"
          className="template-detail__stage-btn"
          onClick={() => void onStage()}
          disabled={!canStage}
          data-testid="template-detail-stage"
          title={sessionId ? `Stage to .editor/staged-templates/` : 'No project session'}
        >
          {stageState.kind === 'staging' ? 'Staging…' : 'Stage template'}
        </button>
        <StageStatus state={stageState} />
      </section>
    </div>
  );
}

function TemplatePreview({
  entities,
}: {
  entities: TemplateMaterialization['entities'];
}) {
  const collections: ReadonlyArray<{
    readonly label: string;
    readonly items: ReadonlyArray<{ readonly id?: string; readonly name?: string }>;
  }> = [
    { label: 'Maps', items: (entities.maps ?? []) as ReadonlyArray<{ id?: string; name?: string }> },
    {
      label: 'Object events',
      items: (entities.objectEvents ?? []) as ReadonlyArray<{ id?: string; name?: string }>,
    },
    { label: 'Warps', items: (entities.warps ?? []) as ReadonlyArray<{ id?: string; name?: string }> },
    {
      label: 'Triggers',
      items: (entities.triggers ?? []) as ReadonlyArray<{ id?: string; name?: string }>,
    },
    {
      label: 'Dialogue lines',
      items: (entities.dialogue ?? []) as ReadonlyArray<{ id?: string; name?: string }>,
    },
    {
      label: 'Script steps',
      items: (entities.scriptSteps ?? []) as ReadonlyArray<{ id?: string; name?: string }>,
    },
    { label: 'Flags', items: (entities.flags ?? []) as ReadonlyArray<{ id?: string; name?: string }> },
    {
      label: 'Variables',
      items: (entities.variables ?? []) as ReadonlyArray<{ id?: string; name?: string }>,
    },
  ];
  return (
    <div className="template-detail__entities" data-testid="template-detail-entities">
      {collections.map((c) =>
        c.items.length > 0 ? (
          <div key={c.label} className="template-detail__entities-row">
            <strong>
              {c.label} ({c.items.length})
            </strong>
            <ul>
              {c.items.map((it, i) => (
                <li key={(it.id ?? '') + i}>{it.name ?? it.id ?? '(unnamed)'}</li>
              ))}
            </ul>
          </div>
        ) : null,
      )}
      <details className="template-detail__entities-raw">
        <summary>Show raw template JSON (for copy/paste)</summary>
        <pre className="template-detail__json">{JSON.stringify(entities, null, 2)}</pre>
      </details>
    </div>
  );
}

function StageStatus({ state }: { state: StageState }) {
  switch (state.kind) {
    case 'idle':
      return null;
    case 'staging':
      return (
        <span className="template-detail__badge template-detail__badge--running" data-testid="template-detail-status">
          staging
        </span>
      );
    case 'done':
      return (
        <span className="template-detail__badge template-detail__badge--ok" data-testid="template-detail-status">
          Staged → <code>{state.stagedPath}</code>
        </span>
      );
    case 'error':
      return (
        <span className="template-detail__badge template-detail__badge--err" data-testid="template-detail-status">
          {state.message}
        </span>
      );
  }
}
