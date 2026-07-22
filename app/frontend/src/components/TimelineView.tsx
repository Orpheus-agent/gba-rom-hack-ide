import { useEffect, useState } from 'react';
import type { ProjectManifest } from '@rom-editor/shared';
import { fetchOpLog, type OpKind, type OpLogEntry, type OpLogResponse } from '../api';
import { useProjectStore, useUiPreferencesStore } from '../state';
import { ScriptParamValue } from '../lib/scriptParamView';
import './TimelineView.css';

interface TimelineViewProps {
  /** Loaded manifest used to resolve entity ids in payloads. When null
   *  or absent (no scan loaded), payloads still render as a structured
   *  key/value block but ids fall through unresolved. */
  readonly manifest?: ProjectManifest | null;
}

type LoadState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'loaded'; readonly data: OpLogResponse }
  | { readonly kind: 'error'; readonly message: string };

const OP_LABEL: Record<OpKind, string> = {
  move_event: 'Move event',
  patch_event_fields: 'Edit event fields',
  edit_dialogue: 'Edit dialogue',
  replace_asset: 'Replace asset',
  import_asset: 'Import asset',
  stage_template: 'Stage template',
  patch_mechanic_config: 'Update mechanic config',
};

const OP_COLOR: Record<OpKind, string> = {
  move_event: '#d066c4',
  patch_event_fields: '#d066c4',
  edit_dialogue: '#4a9eff',
  replace_asset: '#b46aff',
  import_asset: '#b46aff',
  stage_template: '#50c878',
  patch_mechanic_config: '#f0b429',
};

export function TimelineView({ manifest = null }: TimelineViewProps) {
  const sessionId = useProjectStore((s) =>
    s.load.kind === 'loaded' ? s.load.data.session.id : null,
  );
  const showInternalIds = useUiPreferencesStore((s) => s.showInternalIds);
  const [load, setLoad] = useState<LoadState>({ kind: 'idle' });
  const [tick, setTick] = useState(0); // increment to force refetch

  useEffect(() => {
    if (!sessionId) {
      setLoad({ kind: 'idle' });
      return;
    }
    let cancelled = false;
    setLoad({ kind: 'loading' });
    void (async () => {
      try {
        const r = await fetchOpLog(sessionId, 200);
        if (!cancelled) setLoad({ kind: 'loaded', data: r });
      } catch (e) {
        if (!cancelled) {
          setLoad({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, tick]);

  return (
    <div className="timeline-view" data-testid="timeline-view">
      <header className="timeline-view__header">
        <div>
          <h2 className="timeline-view__title">Project Timeline</h2>
          <p className="timeline-view__subtitle">
            Append-only record of every editor mutation. Reads from{' '}
            <code>.editor/op-log.jsonl</code>.
          </p>
        </div>
        <button
          type="button"
          className="timeline-view__refresh"
          onClick={() => setTick((t) => t + 1)}
          disabled={!sessionId || load.kind === 'loading'}
          data-testid="timeline-refresh-btn"
        >
          {load.kind === 'loading' ? 'Refreshing…' : 'Refresh'}
        </button>
      </header>

      {load.kind === 'idle' && (
        <div className="timeline-view__status" data-testid="timeline-status-idle">
          No project session - open a project to see its operation log.
        </div>
      )}
      {load.kind === 'loading' && (
        <div className="timeline-view__status" data-testid="timeline-status-loading">
          loading log…
        </div>
      )}
      {load.kind === 'error' && (
        <div
          className="timeline-view__status timeline-view__status--err"
          data-testid="timeline-status-error"
        >
          {load.message}
        </div>
      )}
      {load.kind === 'loaded' && (
        <TimelineBody
          data={load.data}
          manifest={manifest}
          showInternalIds={showInternalIds}
        />
      )}
    </div>
  );
}

function TimelineBody({
  data,
  manifest,
  showInternalIds,
}: {
  data: OpLogResponse;
  manifest: ProjectManifest | null;
  showInternalIds: boolean;
}) {
  if (data.entries.length === 0 && data.parseErrors.length === 0) {
    return (
      <div className="timeline-view__status" data-testid="timeline-status-empty">
        No operations recorded yet. As you make edits in other tabs, they
        will appear here, newest first.
      </div>
    );
  }
  const grouped = groupByDate(data.entries);
  return (
    <div className="timeline-view__body">
      <div className="timeline-view__count" data-testid="timeline-count">
        Showing {data.entries.length} of {data.totalLines} entries
        {data.parseErrors.length > 0 && (
          <span className="timeline-view__parse-warn" data-testid="timeline-parse-warn">
            {' '}({data.parseErrors.length} unparseable)
          </span>
        )}
      </div>
      {grouped.map((group) => (
        <section key={group.date} className="timeline-day" data-testid={`timeline-day-${group.date}`}>
          <h3 className="timeline-day__heading">{group.date}</h3>
          <ul className="timeline-day__list">
            {group.entries.map((e) => (
              <TimelineEntry
                key={e.entryId}
                entry={e}
                manifest={manifest}
                showInternalIds={showInternalIds}
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function TimelineEntry({
  entry,
  manifest,
  showInternalIds,
}: {
  entry: OpLogEntry;
  manifest: ProjectManifest | null;
  showInternalIds: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const color = OP_COLOR[entry.op] ?? '#7c8088';
  const label = OP_LABEL[entry.op] ?? entry.op;
  return (
    <li
      className="timeline-entry"
      style={{ borderLeftColor: color }}
      data-testid={`timeline-entry-${entry.entryId}`}
      data-op={entry.op}
    >
      <div className="timeline-entry__head">
        <span className="timeline-entry__time" title={entry.atUtc}>
          {formatTime(entry.atUtc)}
        </span>
        <span className="timeline-entry__op" style={{ color }}>
          {label}
        </span>
        <span className="timeline-entry__session">{entry.sessionId.slice(0, 8)}</span>
        <button
          type="button"
          className="timeline-entry__toggle"
          onClick={() => setExpanded((v) => !v)}
          data-testid={`timeline-entry-toggle-${entry.entryId}`}
        >
          {expanded ? 'hide payload' : 'show payload'}
        </button>
      </div>
      {expanded && (
        <div
          className="timeline-entry__payload"
          data-testid={`timeline-entry-payload-${entry.entryId}`}
        >
          {/* Phase I.1 - replaced raw JSON.stringify with structured
              key/value rendering that resolves entity ids via
              displayName. The disclosure below keeps the raw JSON for
              power-user diagnosis. */}
          {manifest ? (
            <ScriptParamValue
              value={entry.payload}
              manifest={manifest}
              showInternalIds={showInternalIds}
            />
          ) : (
            <pre>{JSON.stringify(entry.payload, null, 2)}</pre>
          )}
          <details className="timeline-entry__payload-raw">
            <summary>Show raw JSON</summary>
            <pre>{JSON.stringify(entry.payload, null, 2)}</pre>
          </details>
        </div>
      )}
    </li>
  );
}

function groupByDate(
  entries: ReadonlyArray<OpLogEntry>,
): Array<{ readonly date: string; readonly entries: ReadonlyArray<OpLogEntry> }> {
  const byDate = new Map<string, OpLogEntry[]>();
  for (const e of entries) {
    const date = e.atUtc.slice(0, 10);
    let bucket = byDate.get(date);
    if (!bucket) {
      bucket = [];
      byDate.set(date, bucket);
    }
    bucket.push(e);
  }
  // entries are already newest-first; dates iterated in insertion order
  // preserve that since we walked newest-first.
  return Array.from(byDate.entries()).map(([date, bucketEntries]) => ({
    date,
    entries: bucketEntries,
  }));
}

function formatTime(atUtc: string): string {
  // Render HH:MM:SS - the date header above provides the YYYY-MM-DD context.
  const m = atUtc.match(/T(\d{2}:\d{2}:\d{2})/);
  return m ? m[1]! : atUtc;
}
