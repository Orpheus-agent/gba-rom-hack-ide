import { useEffect, useMemo, useState } from 'react';
import type { ProjectManifest, ScriptStep, Trigger } from '@rom-editor/shared';
import { EventGraph, STEP_KIND_COLORS } from './EventGraph';
import { fetchScriptSource, patchEventFields, ProjectApiError } from '../api';
import { useProjectStore, useUiPreferencesStore } from '../state';
import { displayName, prettifyMapName } from '../lib/displayName';
import { ScriptParamValue } from '../lib/scriptParamView';
import './EventsView.css';

interface EventsViewProps {
  readonly manifest: ProjectManifest;
}

export function EventsView({ manifest }: EventsViewProps) {
  const [selectedTriggerId, setSelectedTriggerId] = useState<string | null>(null);
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const showInternalIds = useUiPreferencesStore((s) => s.showInternalIds);
  const mapNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const map of manifest.maps) m.set(map.id, prettifyMapName(map.name, map.id));
    return m;
  }, [manifest.maps]);

  const triggers = manifest.triggers;
  const triggersByMap = useMemo(() => {
    const m = new Map<string, Trigger[]>();
    for (const t of triggers) {
      const key = t.mapId ?? '(global)';
      const arr = m.get(key) ?? [];
      arr.push(t);
      m.set(key, arr);
    }
    for (const [, arr] of m) arr.sort((a, b) => a.id.localeCompare(b.id));
    return m;
  }, [triggers]);

  const selectedTrigger = selectedTriggerId
    ? triggers.find((t) => t.id === selectedTriggerId) ?? null
    : null;

  const stepById = useMemo(() => {
    const m = new Map<string, ScriptStep>();
    for (const s of manifest.scriptSteps) m.set(s.id, s);
    return m;
  }, [manifest.scriptSteps]);
  const selectedStep = selectedStepId ? stepById.get(selectedStepId) ?? null : null;

  if (triggers.length === 0) {
    return (
      <div className="events-view events-view--empty" data-testid="events-view-empty">
        <h2>No events indexed</h2>
        <p>
          The current project's scan didn't produce any <code>Trigger</code> entries. Open a
          decomp project with <code>data/maps/*/map.json</code> + <code>scripts.inc</code> files
          and scan it from the Project view.
        </p>
      </div>
    );
  }

  return (
    <div className="events-view" data-testid="events-view">
      <aside className="events-view__list" aria-label="Trigger list">
        {Array.from(triggersByMap.entries())
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([mapId, list]) => (
            <div key={mapId} className="events-view__map-group">
              <h3 className="events-view__map-heading">
                {mapId === '(global)'
                  ? 'Global'
                  : mapNameById.get(mapId) ?? displayName(manifest, mapId, showInternalIds)}
                {showInternalIds && mapId !== '(global)' && (
                  <span className="events-view__map-heading-id"> ({mapId})</span>
                )}
              </h3>
              <ul className="events-view__triggers">
                {list.map((t) => (
                  <li key={t.id}>
                    <button
                      type="button"
                      className={`events-view__trigger${
                        t.id === selectedTriggerId ? ' events-view__trigger--selected' : ''
                      }`}
                      data-testid={`events-view-trigger-${t.id}`}
                      onClick={() => {
                        setSelectedTriggerId(t.id);
                        setSelectedStepId(null);
                      }}
                    >
                      <span
                        className="events-view__trigger-kind"
                        style={{ color: kindColor(t.kind) }}
                      >
                        {t.kind}
                      </span>
                      <span className="events-view__trigger-name">{t.name}</span>
                      <span className="events-view__trigger-meta">
                        {t.scriptStepIds.length} step{t.scriptStepIds.length === 1 ? '' : 's'}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
      </aside>

      <section className="events-view__main">
        {selectedTrigger ? (
          <TriggerEditorPanel
            manifest={manifest}
            trigger={selectedTrigger}
            selectedStepId={selectedStepId}
            onSelectStep={setSelectedStepId}
          />
        ) : (
          <div className="events-view__placeholder" data-testid="events-view-no-selection">
            <h2>Pick an event</h2>
            <p>
              {triggers.length} trigger{triggers.length === 1 ? '' : 's'} across{' '}
              {triggersByMap.size} map{triggersByMap.size === 1 ? '' : 's'}. Select one in the
              list to see its script as a node graph.
            </p>
          </div>
        )}
      </section>

      <aside className="events-view__inspector" data-testid="events-view-inspector">
        {selectedStep ? (
          <SelectedStepInspector
            step={selectedStep}
            manifest={manifest}
            showInternalIds={showInternalIds}
          />
        ) : selectedTrigger ? (
          <TriggerInspector
            trigger={selectedTrigger}
            manifest={manifest}
            showInternalIds={showInternalIds}
          />
        ) : (
          <p className="events-view__inspector-empty">
            Selection details will appear here.
          </p>
        )}
      </aside>
    </div>
  );
}

type SourceState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'loaded'; readonly text: string; readonly sourcePath: string }
  | { readonly kind: 'error'; readonly message: string };

function TriggerEditorPanel({
  manifest,
  trigger,
  selectedStepId,
  onSelectStep,
}: {
  manifest: ProjectManifest;
  trigger: Trigger;
  selectedStepId: string | null;
  onSelectStep: (id: string | null) => void;
}) {
  const sessionId = useProjectStore((s) =>
    s.load.kind === 'loaded' ? s.load.data.session.id : null,
  );
  const [mode, setMode] = useState<'graph' | 'source'>('graph');
  const [source, setSource] = useState<SourceState>({ kind: 'idle' });

  useEffect(() => {
    setMode('graph');
    setSource({ kind: 'idle' });
  }, [trigger.id]);

  useEffect(() => {
    if (mode !== 'source' || !sessionId) return;
    if (source.kind !== 'idle' && source.kind !== 'error') return;
    let cancelled = false;
    setSource({ kind: 'loading' });
    void (async () => {
      try {
        const data = await fetchScriptSource(sessionId, trigger.name);
        if (!cancelled) {
          setSource({ kind: 'loaded', text: data.text, sourcePath: data.sourcePath });
        }
      } catch (e) {
        if (cancelled) return;
        const msg =
          e instanceof ProjectApiError
            ? `${e.code}: ${e.message}`
            : e instanceof Error
              ? e.message
              : String(e);
        setSource({ kind: 'error', message: msg });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mode, sessionId, trigger.name, source.kind]);

  return (
    <div className="events-view__panel">
      <div className="events-view__panel-toolbar" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'graph'}
          className={`events-view__panel-tab${mode === 'graph' ? ' events-view__panel-tab--active' : ''}`}
          data-testid="events-view-tab-graph"
          onClick={() => setMode('graph')}
        >
          Graph
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'source'}
          className={`events-view__panel-tab${mode === 'source' ? ' events-view__panel-tab--active' : ''}`}
          data-testid="events-view-tab-source"
          onClick={() => setMode('source')}
        >
          Source
        </button>
      </div>
      <div className="events-view__panel-body">
        {mode === 'graph' && (
          <EventGraph
            manifest={manifest}
            trigger={trigger}
            selectedStepId={selectedStepId}
            onSelect={onSelectStep}
          />
        )}
        {mode === 'source' && (
          <div className="events-view__source" data-testid="events-view-source">
            {source.kind === 'loading' && <p className="events-view__source-info">Loading source…</p>}
            {source.kind === 'idle' && <p className="events-view__source-info">Fetching source…</p>}
            {source.kind === 'error' && (
              <p className="events-view__source-error" data-testid="events-view-source-error">
                {source.message}
              </p>
            )}
            {source.kind === 'loaded' && (
              <>
                <div className="events-view__source-path">{source.sourcePath}</div>
                <pre className="events-view__source-text" data-testid="events-view-source-text">
                  {source.text}
                </pre>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function kindColor(k: string): string {
  const map: Record<string, string> = {
    on_enter: '#50c878',
    on_interact: '#4a9eff',
    on_flag_set: '#b46aff',
    on_battle_end: '#e25555',
    on_first_visit: '#f0b429',
    custom: '#7c8088',
  };
  return map[k] ?? '#7c8088';
}

function TriggerInspector({
  trigger,
  manifest,
  showInternalIds,
}: {
  trigger: Trigger;
  manifest: ProjectManifest;
  showInternalIds: boolean;
}) {
  return (
    <div className="events-view__inspector-body">
      <h3>{displayName(manifest, trigger.id, showInternalIds)}</h3>
      <dl>
        <dt>Kind</dt><dd>{trigger.kind}</dd>
        <dt>Map</dt><dd>{trigger.mapId ? displayName(manifest, trigger.mapId, showInternalIds) : ' - '}</dd>
        <dt>Coord</dt><dd>{trigger.coord ? `(${trigger.coord.x}, ${trigger.coord.y})` : ' - '}</dd>
        <dt>Condition</dt><dd>{trigger.conditionExpression ?? ' - '}</dd>
        <dt>Script steps</dt><dd>{trigger.scriptStepIds.length}</dd>
      </dl>
      <ConditionEditor trigger={trigger} />
    </div>
  );
}

type ConditionSaveState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'saving' }
  | { readonly kind: 'saved' }
  | { readonly kind: 'error'; readonly message: string };

function inferTriggerShape(t: Trigger): 'coord' | 'bg' | 'unknown' {
  if (t.id.includes('_coord_')) return 'coord';
  if (t.id.includes('_bg_')) return 'bg';
  return 'unknown';
}

function ConditionEditor({ trigger }: { trigger: Trigger }) {
  const sessionId = useProjectStore((s) =>
    s.load.kind === 'loaded' ? s.load.data.session.id : null,
  );
  const scanCurrent = useProjectStore((s) => s.scanCurrentProject);
  const shape = inferTriggerShape(trigger);

  // Pull current values from conditionExpression: coord triggers have
  // "VAR_X == V"; bg triggers have "facing == DIR". Both are best-effort
  // recoveries from the manifest, since the source-of-truth is in map.json.
  const initialVar = useMemo(() => {
    if (shape !== 'coord' || !trigger.conditionExpression) return '';
    const m = /^([A-Z_][A-Z0-9_]*) == /.exec(trigger.conditionExpression);
    return m?.[1] ?? '';
  }, [trigger.conditionExpression, shape]);
  const initialValue = useMemo(() => {
    if (shape !== 'coord' || !trigger.conditionExpression) return '';
    const m = / == (.+)$/.exec(trigger.conditionExpression);
    return m?.[1] ?? '';
  }, [trigger.conditionExpression, shape]);
  const initialFacing = useMemo(() => {
    if (shape !== 'bg') return 'BG_EVENT_PLAYER_FACING_ANY';
    if (!trigger.conditionExpression) return 'BG_EVENT_PLAYER_FACING_ANY';
    const m = /^facing == (.+)$/.exec(trigger.conditionExpression);
    return m?.[1] ?? 'BG_EVENT_PLAYER_FACING_ANY';
  }, [trigger.conditionExpression, shape]);

  const [varName, setVarName] = useState(initialVar);
  const [varValue, setVarValue] = useState(initialValue);
  const [facing, setFacing] = useState(initialFacing);
  const [state, setState] = useState<ConditionSaveState>({ kind: 'idle' });

  useEffect(() => {
    setVarName(initialVar);
    setVarValue(initialValue);
    setFacing(initialFacing);
    setState({ kind: 'idle' });
  }, [initialVar, initialValue, initialFacing]);

  if (shape === 'unknown') {
    return (
      <div className="condition-editor" data-testid="condition-editor-unknown">
        <p className="condition-editor__note">
          This trigger's source shape ({trigger.kind}) isn't directly editable yet - it lives in
          a non-coord_event/bg_event array. P4-T3 will surface the raw script source for
          editing.
        </p>
      </div>
    );
  }

  const dirty =
    shape === 'coord'
      ? varName !== initialVar || varValue !== initialValue
      : facing !== initialFacing;
  const valid =
    shape === 'coord' ? varName.length > 0 && varValue.length > 0 : facing.length > 0;

  async function save(): Promise<void> {
    if (!sessionId || !dirty || !valid) return;
    setState({ kind: 'saving' });
    try {
      const fields: Record<string, string | number | boolean | null> =
        shape === 'coord'
          ? { var: varName, var_value: varValue }
          : { player_facing_dir: facing };
      await patchEventFields(sessionId, 'trigger', trigger.id, fields);
      setState({ kind: 'saved' });
      await scanCurrent();
    } catch (e) {
      const msg =
        e instanceof ProjectApiError
          ? `${e.code}: ${e.message}`
          : e instanceof Error
            ? e.message
            : String(e);
      setState({ kind: 'error', message: msg });
    }
  }

  return (
    <div className="condition-editor" data-testid="condition-editor">
      <h4 className="condition-editor__heading">
        {shape === 'coord' ? 'Coord trigger condition' : 'Sign-facing condition'}
      </h4>
      {shape === 'coord' && (
        <>
          <div className="condition-editor__row">
            <label>
              Variable
              <input
                type="text"
                data-testid="condition-editor-var"
                value={varName}
                onChange={(e) => setVarName(e.target.value.toUpperCase())}
                placeholder="VAR_INTRO_STATE"
                spellCheck={false}
              />
            </label>
          </div>
          <div className="condition-editor__row">
            <label>
              Equals
              <input
                type="text"
                data-testid="condition-editor-value"
                value={varValue}
                onChange={(e) => setVarValue(e.target.value)}
                placeholder="1"
                spellCheck={false}
              />
            </label>
          </div>
        </>
      )}
      {shape === 'bg' && (
        <div className="condition-editor__row">
          <label>
            Facing
            <select
              data-testid="condition-editor-facing"
              value={facing}
              onChange={(e) => setFacing(e.target.value)}
            >
              <option value="BG_EVENT_PLAYER_FACING_ANY">Any direction</option>
              <option value="BG_EVENT_PLAYER_FACING_NORTH">North</option>
              <option value="BG_EVENT_PLAYER_FACING_SOUTH">South</option>
              <option value="BG_EVENT_PLAYER_FACING_EAST">East</option>
              <option value="BG_EVENT_PLAYER_FACING_WEST">West</option>
            </select>
          </label>
        </div>
      )}
      <div className="condition-editor__actions">
        <button
          type="button"
          className="btn btn--primary"
          data-testid="condition-editor-save"
          disabled={!dirty || !valid || state.kind === 'saving' || !sessionId}
          onClick={() => void save()}
        >
          {state.kind === 'saving' ? 'Saving…' : 'Save condition'}
        </button>
        {state.kind === 'saved' && !dirty && (
          <span className="condition-editor__ok">Saved · map.json rewritten</span>
        )}
        {state.kind === 'error' && (
          <span className="condition-editor__err">{state.message}</span>
        )}
      </div>
    </div>
  );
}

function SelectedStepInspector({
  step,
  manifest,
  showInternalIds,
}: {
  step: ScriptStep;
  manifest: ProjectManifest;
  showInternalIds: boolean;
}) {
  return (
    <div className="events-view__inspector-body" data-testid="events-view-step-inspector">
      <h3>
        <span
          className="events-view__inspector-kind"
          style={{ color: STEP_KIND_COLORS[step.kind] }}
        >
          {step.kind}
        </span>
      </h3>
      <dl>
        <dt>Step</dt>
        <dd>{displayName(manifest, step.id, showInternalIds)}</dd>
        {Object.entries(step.params).map(([k, v]) => (
          <span key={k} style={{ display: 'contents' }}>
            <dt>{k}</dt>
            <dd>
              <ScriptParamValue
                value={v}
                manifest={manifest}
                showInternalIds={showInternalIds}
              />
            </dd>
          </span>
        ))}
      </dl>
    </div>
  );
}
