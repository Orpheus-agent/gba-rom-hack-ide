/**
 * Phase 8J-2 - Curation dashboard.
 *
 * Renders aggregate counts of human-override rows + lists recent
 * entries with the option to recall mistakes. The detailed per-
 * placement curation UI (right-click a metatile in the map editor
 * → mark good/bad) is a follow-up polish pass; this surface gives
 * the user visibility into what's been recorded so far + a way to
 * undo misclicks.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  deleteOverride,
  fetchOverridesSummary,
  listOverrides,
  type OverrideEntry,
  type OverridesSummary,
  type TileIntelClientResult,
} from '../lib/tileIntelApi';
import type { TileIntelUnavailable } from '../lib/tileIntelTypes';

type State<T> =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'loaded'; readonly data: T }
  | {
      readonly kind: 'unavailable';
      readonly status: TileIntelUnavailable;
    };

function unwrap<T>(result: TileIntelClientResult<T>): State<T> {
  if (result.available) {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { available, ...body } = result as { available: true } & T;
    return { kind: 'loaded', data: body as T };
  }
  return { kind: 'unavailable', status: result };
}

function describeUnavailable(s: TileIntelUnavailable): string {
  switch (s.reason) {
    case 'sidecar_offline':
      return `Tile intelligence is offline. ${s.details}`;
    case 'sidecar_crashed':
      return `Tile intelligence crashed. ${s.details}`;
    case 'storage_unhealthy':
      return `Tile intelligence storage isn't reachable. ${s.details}`;
    case 'version_mismatch':
      return `Version mismatch (expected v${s.expected}, observed v${s.observed}).`;
    case 'warming_up':
      return `Tile intelligence warming up - try again in ${s.etaSeconds}s.`;
    case 'embedding_unavailable':
      return `Visual model isn't installed. ${s.details}`;
  }
}

export function CurationDashboard(): JSX.Element {
  const [summary, setSummary] = useState<State<OverridesSummary>>({
    kind: 'idle',
  });
  const [overrides, setOverrides] = useState<
    State<{
      readonly overrides: ReadonlyArray<OverrideEntry>;
      readonly total: number;
    }>
  >({ kind: 'idle' });

  const refresh = useCallback(async () => {
    setSummary({ kind: 'loading' });
    setOverrides({ kind: 'loading' });
    const [s, o] = await Promise.all([
      fetchOverridesSummary(),
      listOverrides({ limit: 20 }),
    ]);
    setSummary(unwrap(s));
    setOverrides(unwrap(o));
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleDelete(id: number) {
    const result = await deleteOverride(id);
    if (result.available) void refresh();
  }

  return (
    <div className="tile-intel-panel__tab">
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <p className="tile-intel-panel__hint" style={{ flex: 1 }}>
          Mark generated tile placements as good or bad to bias future
          adjacency-rule rebuilds toward what works in your project.
          Right-click a metatile in the map editor or call the
          <code> /api/tile-intel/curation/overrides</code> endpoint
          from a tool to record one.
        </p>
        <button type="button" onClick={() => void refresh()}>
          Refresh
        </button>
      </div>

      {summary.kind === 'unavailable' && (
        <p className="tile-intel-panel__warning">
          {describeUnavailable(summary.status)}
        </p>
      )}
      {summary.kind === 'loaded' && (
        <div className="curation-dashboard__summary">
          <SummaryStat label="Total" value={summary.data.total} />
          <SummaryStat label="Good" value={summary.data.good} accent="good" />
          <SummaryStat label="Bad" value={summary.data.bad} accent="bad" />
          <SummaryStat
            label="Neutral"
            value={summary.data.neutral}
            accent="neutral"
          />
          {Object.entries(summary.data.by_kind).map(([k, v]) => (
            <SummaryStat key={k} label={k.replace(/_/g, ' ')} value={v} />
          ))}
        </div>
      )}

      {overrides.kind === 'loaded' && (
        <>
          <p className="tile-intel-panel__hint">
            Showing {overrides.data.overrides.length} of {overrides.data.total}{' '}
            most-recent override(s).
          </p>
          <ul className="tile-intel-panel__list">
            {overrides.data.overrides.map((row) => (
              <li key={row.id} className="tile-intel-panel__row">
                <div className="tile-intel-panel__row-title">
                  <strong>{row.label.toUpperCase()}</strong>
                  <span className="tile-intel-panel__row-badge">
                    {row.kind.replace(/_/g, ' ')}
                  </span>
                  <span
                    className="tile-intel-panel__row-badge"
                    style={{ marginLeft: 'auto', cursor: 'pointer' }}
                    onClick={() => void handleDelete(row.id)}
                    title="Recall this judgment"
                  >
                    ×
                  </span>
                </div>
                <div className="tile-intel-panel__row-meta">
                  weight {row.weight.toFixed(2)} ·{' '}
                  {row.note ?? 'no note'} ·{' '}
                  <span style={{ fontSize: '0.75rem' }}>
                    {row.created_at.split('.')[0]}
                  </span>
                </div>
                <code className="tile-intel-panel__row-slug">
                  {JSON.stringify(row.payload).slice(0, 120)}
                </code>
              </li>
            ))}
            {overrides.data.overrides.length === 0 && (
              <li className="tile-intel-panel__row tile-intel-panel__row--empty">
                No overrides recorded yet.
              </li>
            )}
          </ul>
        </>
      )}
      {overrides.kind === 'unavailable' && (
        <p className="tile-intel-panel__warning">
          {describeUnavailable(overrides.status)}
        </p>
      )}
    </div>
  );
}

function SummaryStat({
  label,
  value,
  accent,
}: {
  label: string;
  value: number;
  accent?: 'good' | 'bad' | 'neutral';
}): JSX.Element {
  const accentColors: Record<string, string> = {
    good: '#7bdc8f',
    bad: '#f08a8a',
    neutral: '#c8c8c8',
  };
  return (
    <div className="curation-dashboard__stat">
      <div
        className="curation-dashboard__stat-value"
        style={accent ? { color: accentColors[accent] } : undefined}
      >
        {value}
      </div>
      <div className="curation-dashboard__stat-label">{label}</div>
    </div>
  );
}
