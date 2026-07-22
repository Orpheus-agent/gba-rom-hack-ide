/**
 * Phase 8I-3 - SkeletonEditor.
 *
 * Minimum viable: lists skeleton documents authored by
 * propose_generate_map_skeleton at `<projectRoot>/.editor/skeletons/`,
 * shows their metadata, and exposes Resolve + Validate buttons that
 * exercise the tile-intel pipeline. The visual DSL editor (draggable
 * regions, drawn paths, etc.) is deferred to a future polish pass - 
 * for v1 the user edits the JSON directly on disk and clicks Resolve
 * to see the metatile grid + traversal report.
 *
 * All hex / opcode numbers are kept out of the primary UX (size as
 * tiles, biome as human-readable slug, regions/paths/POIs as plain
 * counts).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useProjectStore } from '../state';
import {
  fetchResolvedMapBody,
  fetchSkeletonBody,
  listSkeletons,
  type SkeletonBodyResponse,
  type SkeletonEntry,
} from '../lib/projectSkeletonsApi';
import { resolveSkeleton, validateTraversal } from '../lib/tileIntelApi';
import type { TileIntelClientResult } from '../lib/tileIntelApi';
import type {
  ResolveSkeletonResponse,
  TileIntelUnavailable,
  ValidateTraversalResponse,
} from '../lib/tileIntelTypes';
import './TileIntelligencePanel.css';

type ResolveState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | {
      readonly kind: 'loaded';
      readonly response: ResolveSkeletonResponse;
    }
  | {
      readonly kind: 'unavailable';
      readonly status: TileIntelUnavailable;
    }
  | { readonly kind: 'error'; readonly message: string };

type ValidateState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | {
      readonly kind: 'loaded';
      readonly response: ValidateTraversalResponse;
    }
  | {
      readonly kind: 'unavailable';
      readonly status: TileIntelUnavailable;
    }
  | { readonly kind: 'error'; readonly message: string };

function describeUnavailable(status: TileIntelUnavailable): string {
  switch (status.reason) {
    case 'sidecar_offline':
      return `The tile intelligence service is offline. ${status.details}`;
    case 'sidecar_crashed':
      return `The tile intelligence service crashed. ${status.details}`;
    case 'storage_unhealthy':
      return `Tile intelligence storage isn't reachable. ${status.details}`;
    case 'version_mismatch':
      return `Version mismatch (expected v${status.expected}, observed v${status.observed}).`;
    case 'warming_up':
      return `The service is starting up - try again in ${status.etaSeconds}s.`;
    case 'embedding_unavailable':
      return `The visual-similarity model isn't installed. ${status.details}`;
  }
}

function unwrapResolve<T>(
  result: TileIntelClientResult<T>,
): { ok: true; data: T } | { ok: false; status: TileIntelUnavailable } {
  if (result.available) {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { available, ...body } = result as { available: true } & T;
    return { ok: true, data: body as T };
  }
  return { ok: false, status: result };
}

export function SkeletonEditor(): JSX.Element {
  const sessionId = useProjectStore((s) =>
    s.load.kind === 'loaded' ? s.load.data.session.id : null,
  );

  if (!sessionId) {
    return (
      <section className="tile-intel-panel">
        <header className="tile-intel-panel__header">
          <h2>Map Skeletons</h2>
          <p className="tile-intel-panel__subtitle">
            Open a project to author + manage map skeletons.
          </p>
        </header>
      </section>
    );
  }

  return <SkeletonEditorContent sessionId={sessionId} />;
}

function SkeletonEditorContent({
  sessionId,
}: {
  sessionId: string;
}): JSX.Element {
  const [entries, setEntries] = useState<ReadonlyArray<SkeletonEntry> | null>(
    null,
  );
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoadError(null);
    try {
      const result = await listSkeletons(sessionId);
      setEntries(result.entries);
    } catch (e) {
      setEntries([]);
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }, [sessionId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const selectedEntry = useMemo(
    () => entries?.find((e) => e.slug === selectedSlug) ?? null,
    [entries, selectedSlug],
  );

  return (
    <section className="tile-intel-panel">
      <header className="tile-intel-panel__header">
        <h2>Map Skeletons</h2>
        <p className="tile-intel-panel__subtitle">
          High-level map outlines in <code>.editor/skeletons/</code>. The
          agent&apos;s <code>propose_generate_map_skeleton</code> tool authors
          these; resolve them here to see what metatiles the tile-intel
          pipeline would place, and validate them to check traversal before
          applying the resulting plan to your ROM.
        </p>
        <button
          type="button"
          onClick={() => {
            void refresh();
          }}
          style={{ marginTop: 8 }}
        >
          Refresh list
        </button>
        {loadError && (
          <p className="tile-intel-panel__warning">
            Couldn&apos;t list skeletons: {loadError}
          </p>
        )}
      </header>

      <div className="skeleton-editor__layout">
        <div className="skeleton-editor__list-pane">
          <SkeletonList
            entries={entries}
            selectedSlug={selectedSlug}
            onSelect={setSelectedSlug}
          />
        </div>
        <div className="skeleton-editor__detail-pane">
          {selectedEntry ? (
            <SkeletonDetail
              key={selectedEntry.slug}
              sessionId={sessionId}
              entry={selectedEntry}
            />
          ) : (
            <p className="tile-intel-panel__hint">
              Select a skeleton from the left to see its details, resolve
              it, or validate its traversal.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

function SkeletonList({
  entries,
  selectedSlug,
  onSelect,
}: {
  entries: ReadonlyArray<SkeletonEntry> | null;
  selectedSlug: string | null;
  onSelect(slug: string): void;
}): JSX.Element {
  if (entries === null) {
    return <p className="tile-intel-panel__hint">Loading skeletons…</p>;
  }
  if (entries.length === 0) {
    return (
      <p className="tile-intel-panel__hint">
        No skeletons yet. Ask the agent to{' '}
        <code>propose_generate_map_skeleton</code> to create one.
      </p>
    );
  }
  return (
    <ul className="tile-intel-panel__list">
      {entries.map((entry) => (
        <li
          key={entry.slug}
          className={
            'tile-intel-panel__row' +
            (entry.slug === selectedSlug ? ' tile-intel-panel__row--selected' : '')
          }
          onClick={() => onSelect(entry.slug)}
          style={{ cursor: 'pointer' }}
        >
          <div className="tile-intel-panel__row-title">
            <strong>{entry.name}</strong>
            <span className="tile-intel-panel__row-badge">
              {entry.width} × {entry.height}
            </span>
          </div>
          <div className="tile-intel-panel__row-meta">
            {entry.defaultBiome} · {entry.regionCount} region
            {entry.regionCount === 1 ? '' : 's'} · {entry.poiCount} POI
            {entry.poiCount === 1 ? '' : 's'} · {entry.pathCount} path
            {entry.pathCount === 1 ? '' : 's'}
            {entry.templateCount > 0
              ? ` · ${entry.templateCount} template anchor${entry.templateCount === 1 ? '' : 's'}`
              : ''}
          </div>
          <code className="tile-intel-panel__row-slug">{entry.slug}</code>
        </li>
      ))}
    </ul>
  );
}

function SkeletonDetail({
  sessionId,
  entry,
}: {
  sessionId: string;
  entry: SkeletonEntry;
}): JSX.Element {
  const [body, setBody] = useState<SkeletonBodyResponse | null>(null);
  const [bodyError, setBodyError] = useState<string | null>(null);
  const [resolveState, setResolveState] = useState<ResolveState>({
    kind: 'idle',
  });
  const [validateState, setValidateState] = useState<ValidateState>({
    kind: 'idle',
  });

  useEffect(() => {
    let cancelled = false;
    setBody(null);
    setBodyError(null);
    fetchSkeletonBody(sessionId, entry.slug)
      .then((b) => {
        if (!cancelled) setBody(b);
      })
      .catch((e: unknown) => {
        if (!cancelled)
          setBodyError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, entry.slug]);

  async function handleResolve() {
    if (!body) return;
    setResolveState({ kind: 'loading' });
    const result = await resolveSkeleton({ skeleton: body.body });
    const unwrapped = unwrapResolve(result);
    if (unwrapped.ok) {
      setResolveState({ kind: 'loaded', response: unwrapped.data });
    } else {
      setResolveState({ kind: 'unavailable', status: unwrapped.status });
    }
  }

  async function handleValidate() {
    setValidateState({ kind: 'loading' });
    try {
      const resolved = await fetchResolvedMapBody(sessionId, entry.slug);
      const result = await validateTraversal({ resolved: resolved.body });
      const unwrapped = unwrapResolve(result);
      if (unwrapped.ok) {
        setValidateState({ kind: 'loaded', response: unwrapped.data });
      } else {
        setValidateState({ kind: 'unavailable', status: unwrapped.status });
      }
    } catch (e) {
      setValidateState({
        kind: 'error',
        message:
          'Could not read the resolved-map file. Run Resolve first - that ' +
          'persists the file to disk: ' +
          (e instanceof Error ? e.message : String(e)),
      });
    }
  }

  return (
    <div>
      <h3 style={{ marginTop: 0 }}>{entry.name}</h3>
      <p className="tile-intel-panel__hint">
        Size: {entry.width} × {entry.height} tiles. Biome:{' '}
        <code>{entry.defaultBiome}</code>. Tilesets:{' '}
        <code>{entry.primaryTileset}</code> (primary),{' '}
        <code>{entry.secondaryTileset}</code> (secondary).
      </p>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <button
          type="button"
          onClick={() => {
            void handleResolve();
          }}
          disabled={!body || resolveState.kind === 'loading'}
        >
          {resolveState.kind === 'loading' ? 'Resolving…' : 'Resolve'}
        </button>
        <button
          type="button"
          onClick={() => {
            void handleValidate();
          }}
          disabled={validateState.kind === 'loading'}
        >
          {validateState.kind === 'loading' ? 'Validating…' : 'Validate traversal'}
        </button>
      </div>
      {bodyError && (
        <p className="tile-intel-panel__warning">
          Couldn&apos;t load skeleton body: {bodyError}
        </p>
      )}
      {resolveState.kind === 'loaded' && (
        <ResolveReport response={resolveState.response} />
      )}
      {resolveState.kind === 'unavailable' && (
        <p className="tile-intel-panel__warning">
          {describeUnavailable(resolveState.status)}
        </p>
      )}
      {validateState.kind === 'loaded' && (
        <ValidateReport response={validateState.response} />
      )}
      {validateState.kind === 'unavailable' && (
        <p className="tile-intel-panel__warning">
          {describeUnavailable(validateState.status)}
        </p>
      )}
      {validateState.kind === 'error' && (
        <p className="tile-intel-panel__warning">{validateState.message}</p>
      )}
    </div>
  );
}

function ResolveReport({
  response,
}: {
  response: ResolveSkeletonResponse;
}): JSX.Element {
  const r = response.report;
  const totalCells = response.width * response.height;
  const respect =
    r.rules_consulted > 0
      ? 100 - Math.round((r.rule_violations / r.rules_consulted) * 100)
      : null;
  return (
    <section
      style={{ borderTop: '1px solid #444', paddingTop: 12, marginTop: 8 }}
    >
      <h4 style={{ marginTop: 0 }}>Resolve report</h4>
      <ul>
        <li>
          {r.assigned_cells} / {totalCells} cells assigned ({r.unassigned_cells}{' '}
          unassigned)
        </li>
        <li>
          Template anchors placed: {r.template_anchors_placed} (
          {r.template_anchors_skipped} skipped)
        </li>
        <li>
          Paths solved: {r.paths_solved} ({r.paths_failed} failed)
        </li>
        {respect !== null && (
          <li>
            Adjacency rule respect: {respect}% ({r.rules_consulted} rules
            consulted)
          </li>
        )}
      </ul>
      {r.warnings.length > 0 && (
        <div>
          <strong>Notes:</strong>
          <ul>
            {r.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}
      <p className="tile-intel-panel__hint">
        The full resolved grid has been persisted under{' '}
        <code>.editor/resolved-maps/</code>. Click "Validate traversal" to
        check reachability.
      </p>
    </section>
  );
}

function ValidateReport({
  response,
}: {
  response: ValidateTraversalResponse;
}): JSX.Element {
  return (
    <section
      style={{ borderTop: '1px solid #444', paddingTop: 12, marginTop: 8 }}
    >
      <h4 style={{ marginTop: 0 }}>
        Traversal check: {response.ok ? '✅ passed' : '⚠ failed'}
      </h4>
      <pre
        style={{
          whiteSpace: 'pre-wrap',
          fontFamily: 'inherit',
          margin: 0,
        }}
      >
        {response.summary}
      </pre>
      {response.issues.length > 0 && (
        <details>
          <summary>{response.issues.length} issue(s)</summary>
          <ul>
            {response.issues.map((i, idx) => (
              <li key={idx}>
                <strong>[{i.severity}]</strong> {i.message}
                {i.x !== undefined && i.y !== undefined && i.x !== null
                  ? ` @ (${i.x}, ${i.y})`
                  : ''}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
