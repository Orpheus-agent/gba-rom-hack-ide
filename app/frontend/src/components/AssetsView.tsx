import { useCallback, useMemo, useState } from 'react';
import type {
  Asset,
  AssetKind,
  ProjectManifest,
} from '@rom-editor/shared';
import {
  findAssetReferences,
  type AssetReferences,
} from '../lib/assetReferences';
import { assessAssetConstraints, type AssetConstraint } from '../lib/assetConstraints';
import { importAssetPng, ProjectApiError, replaceAssetPng } from '../api';
import { useProjectStore, useUiPreferencesStore } from '../state';
import { resolveDisplayName } from '../lib/displayName';
import './AssetsView.css';

interface AssetsViewProps {
  readonly manifest: ProjectManifest;
}

// Ordered list of every AssetKind, used to drive the grouped left rail.
const KIND_ORDER: ReadonlyArray<AssetKind> = [
  'overworld_sprite',
  'trainer_sprite',
  'battle_sprite',
  'tileset',
  'palette',
  'ui_graphic',
  'portrait',
  'animation',
  'icon',
  'music',
  'sound',
];

const KIND_LABEL: Readonly<Record<AssetKind, string>> = {
  overworld_sprite: 'Overworld sprites',
  trainer_sprite: 'Trainer sprites',
  battle_sprite: 'Battle sprites',
  tileset: 'Tilesets',
  palette: 'Palettes',
  ui_graphic: 'UI graphics',
  portrait: 'Portraits',
  animation: 'Animations',
  icon: 'Icons',
  music: 'Music',
  sound: 'Sound effects',
};

export function AssetsView({ manifest }: AssetsViewProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  const assets = manifest.assets;

  const grouped = useMemo(() => {
    const buckets = new Map<AssetKind, Asset[]>();
    for (const a of assets) {
      const arr = buckets.get(a.kind) ?? [];
      arr.push(a);
      buckets.set(a.kind, arr);
    }
    for (const [, arr] of buckets) arr.sort((a, b) => a.id.localeCompare(b.id));
    return buckets;
  }, [assets]);

  const filteredAssets = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return assets;
    return assets.filter(
      (a) =>
        a.id.toLowerCase().includes(q) ||
        a.relativePath.toLowerCase().includes(q) ||
        a.kind.toLowerCase().includes(q),
    );
  }, [assets, filter]);

  const selected = selectedId ? assets.find((a) => a.id === selectedId) ?? null : null;

  const references = useMemo<AssetReferences | null>(
    () => (selected ? findAssetReferences(manifest, selected.id) : null),
    [manifest, selected],
  );

  if (assets.length === 0) {
    return (
      <div className="assets-view assets-view--empty" data-testid="assets-view-empty">
        <h2>No assets indexed</h2>
        <p>
          The project's scan didn't produce any <code>Asset</code> entries. The asset scanner
          walks <code>graphics/</code> and <code>sound/</code>; either the project lacks those
          trees, or it uses a non-default layout the scanner doesn't recognize yet.
        </p>
      </div>
    );
  }

  return (
    <div className="assets-view" data-testid="assets-view">
      <aside className="assets-view__list" aria-label="Asset list">
        <NewAssetForm />
        <input
          type="search"
          className="assets-view__filter"
          placeholder="Filter by id, path, or kind…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          spellCheck={false}
          data-testid="assets-view-filter"
        />
        {filter.trim() ? (
          <ul className="assets-view__flat-results" data-testid="assets-view-flat-results">
            {filteredAssets.map((a) => (
              <AssetListItem
                key={a.id}
                asset={a}
                manifest={manifest}
                selected={a.id === selectedId}
                onClick={() => setSelectedId(a.id)}
              />
            ))}
            {filteredAssets.length === 0 && (
              <li className="assets-view__empty-msg">No matches</li>
            )}
          </ul>
        ) : (
          KIND_ORDER.filter((k) => (grouped.get(k)?.length ?? 0) > 0).map((kind) => {
            const items = grouped.get(kind)!;
            return (
              <div key={kind} className="assets-view__group" data-testid={`assets-view-group-${kind}`}>
                <h3 className="assets-view__group-heading">
                  {KIND_LABEL[kind]}{' '}
                  <span className="assets-view__group-count">({items.length})</span>
                </h3>
                <ul className="assets-view__items">
                  {items.map((a) => (
                    <AssetListItem
                      key={a.id}
                      asset={a}
                      manifest={manifest}
                      selected={a.id === selectedId}
                      onClick={() => setSelectedId(a.id)}
                    />
                  ))}
                </ul>
              </div>
            );
          })
        )}
      </aside>
      <section className="assets-view__detail">
        {selected && references ? (
          <AssetDetail asset={selected} references={references} manifest={manifest} />
        ) : (
          <div className="assets-view__placeholder" data-testid="assets-view-placeholder">
            <h2>Pick an asset</h2>
            <p>
              {assets.length} asset{assets.length === 1 ? '' : 's'} indexed across{' '}
              {Array.from(grouped.keys()).length} kind
              {grouped.size === 1 ? '' : 's'}.
            </p>
            <p>
              Selecting an asset surfaces its full relative path plus every map, object
              event, dialogue line, and script step that references it - so you can answer
              "is this sprite still used anywhere?" without grepping the source.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}

function AssetListItem({
  asset,
  selected,
  onClick,
  manifest,
}: {
  asset: Asset;
  selected: boolean;
  onClick: () => void;
  manifest: ProjectManifest;
}) {
  const showInternalIds = useUiPreferencesStore((s) => s.showInternalIds);
  // Prefer the asset.name (lifter populates it with a friendly description
  // for binary-rom entries; decomp imports use the file path). Fall back
  // through the displayName resolver, which catches synthetic patterns
  // like `binary_cry_N` / `tileset_0x...` / `binary_palette_*`.
  const primaryLabel = asset.name && asset.name !== asset.id
    ? asset.name
    : resolveDisplayName(manifest, asset.id).text;
  return (
    <li>
      <button
        type="button"
        className={`assets-view__item${selected ? ' assets-view__item--selected' : ''}`}
        data-testid={`assets-view-item-${asset.id}`}
        onClick={onClick}
      >
        <span className="assets-view__item-id">{primaryLabel}</span>
        <span className="assets-view__item-path">
          {asset.relativePath}
          {showInternalIds && asset.id !== primaryLabel && (
            <span className="assets-view__item-debug-id"> · {asset.id}</span>
          )}
        </span>
      </button>
    </li>
  );
}

const PNG_KINDS: ReadonlySet<AssetKind> = new Set<AssetKind>([
  'overworld_sprite',
  'trainer_sprite',
  'battle_sprite',
  'tileset',
  'ui_graphic',
  'portrait',
  'animation',
  'icon',
]);

function AssetDetail({
  asset,
  references,
  manifest,
}: {
  asset: Asset;
  references: AssetReferences;
  manifest: ProjectManifest;
}) {
  const totalRefs =
    references.maps.length +
    references.objectEvents.length +
    references.dialogueNodes.length +
    references.scriptSteps.length;
  const showInternalIds = useUiPreferencesStore((s) => s.showInternalIds);

  const metadataEntries = Object.entries(asset.metadata);

  const isPngKind = PNG_KINDS.has(asset.kind) && asset.metadata['extension'] === '.png';
  const headerLabel = asset.name && asset.name !== asset.id
    ? asset.name
    : resolveDisplayName(manifest, asset.id).text;

  return (
    <div className="asset-detail" data-testid="asset-detail">
      <header className="asset-detail__header">
        <h2 className="asset-detail__id" data-testid="asset-detail-id">
          {headerLabel}
          {showInternalIds && asset.id !== headerLabel && (
            <span className="asset-detail__internal-id"> ({asset.id})</span>
          )}
        </h2>
        <div className="asset-detail__kind-badge" data-testid="asset-detail-kind">
          {asset.kind.replace(/_/g, ' ')}
        </div>
      </header>
      <dl className="asset-detail__meta">
        <span style={{ display: 'contents' }}>
          <dt>Path</dt>
          <dd data-testid="asset-detail-path">
            <code>{asset.relativePath}</code>
          </dd>
        </span>
        {metadataEntries.length > 0 &&
          metadataEntries.map(([k, v]) => (
            <span key={k} style={{ display: 'contents' }}>
              <dt>{k}</dt>
              <dd data-testid={`asset-detail-meta-${k}`}>{String(v)}</dd>
            </span>
          ))}
      </dl>

      <AssetConstraintsList asset={asset} />

      {isPngKind && <AssetReplaceDropZone asset={asset} />}

      <section className="asset-detail__refs" data-testid="asset-detail-refs">
        <h3 className="asset-detail__refs-heading">
          References{' '}
          <span className="asset-detail__refs-count" data-testid="asset-detail-refs-count">
            ({totalRefs})
          </span>
        </h3>
        {totalRefs === 0 ? (
          <div className="asset-detail__no-refs" data-testid="asset-detail-no-refs">
            Not referenced anywhere in the indexed project. This is dead-asset territory - 
            or the asset is loaded through a path the scanner doesn't recognize yet.
          </div>
        ) : (
          <div className="asset-detail__refs-body">
            {references.maps.length > 0 && (
              <RefSection
                heading="Maps"
                count={references.maps.length}
                testid="asset-detail-maps"
              >
                {references.maps.map((m, i) => (
                  <li key={`${m.map.id}#${m.role}#${i}`} className="asset-detail__ref-row">
                    <code className="asset-detail__ref-id">{m.map.id}</code>
                    <span className="asset-detail__ref-meta">
                      <span className="asset-detail__ref-role">{m.role}</span>
                    </span>
                  </li>
                ))}
              </RefSection>
            )}
            {references.objectEvents.length > 0 && (
              <RefSection
                heading="Object events (graphics)"
                count={references.objectEvents.length}
                testid="asset-detail-objects"
              >
                {references.objectEvents.map((o) => (
                  <li key={o.id} className="asset-detail__ref-row">
                    <code className="asset-detail__ref-id">{o.id}</code>
                    <span className="asset-detail__ref-meta">
                      {o.kind} on {o.mapId} @ ({o.coord.x}, {o.coord.y})
                    </span>
                  </li>
                ))}
              </RefSection>
            )}
            {references.dialogueNodes.length > 0 && (
              <RefSection
                heading="Dialogue portraits"
                count={references.dialogueNodes.length}
                testid="asset-detail-dialogue"
              >
                {references.dialogueNodes.map((d) => (
                  <li key={d.id} className="asset-detail__ref-row">
                    <code className="asset-detail__ref-id">{d.id}</code>
                    <span className="asset-detail__ref-meta">
                      {d.speakerName ? `speaker: ${d.speakerName}` : ' - '}
                    </span>
                  </li>
                ))}
              </RefSection>
            )}
            {references.scriptSteps.length > 0 && (
              <RefSection
                heading="Script sound calls"
                count={references.scriptSteps.length}
                testid="asset-detail-scripts"
              >
                {references.scriptSteps.map((s) => (
                  <li key={s.id} className="asset-detail__ref-row">
                    <code className="asset-detail__ref-id">{s.id}</code>
                    <span className="asset-detail__ref-meta">
                      <code>{String(s.params['macro'] ?? s.kind)}</code>
                    </span>
                  </li>
                ))}
              </RefSection>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

function RefSection({
  heading,
  count,
  testid,
  children,
}: {
  heading: string;
  count: number;
  testid: string;
  children: React.ReactNode;
}) {
  return (
    <div className="asset-detail__ref-section" data-testid={testid}>
      <h4 className="asset-detail__ref-section-heading">
        {heading} <span className="asset-detail__ref-section-count">({count})</span>
      </h4>
      <ul className="asset-detail__ref-list">{children}</ul>
    </div>
  );
}

type ReplaceState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'reading' }
  | { readonly kind: 'uploading'; readonly bytes: number }
  | {
      readonly kind: 'done';
      readonly width: number;
      readonly height: number;
      readonly bytesWritten: number;
    }
  | { readonly kind: 'error'; readonly message: string };

function AssetReplaceDropZone({ asset }: { asset: Asset }) {
  const sessionId = useProjectStore((s) =>
    s.load.kind === 'loaded' ? s.load.data.session.id : null,
  );
  const scanCurrent = useProjectStore((s) => s.scanCurrentProject);
  const [state, setState] = useState<ReplaceState>({ kind: 'idle' });
  const [dragging, setDragging] = useState(false);

  const handleFile = useCallback(
    async (file: File): Promise<void> => {
      if (!sessionId) {
        setState({ kind: 'error', message: 'No active project session.' });
        return;
      }
      if (!file.name.toLowerCase().endsWith('.png')) {
        setState({ kind: 'error', message: `Expected a .png file, got '${file.name}'.` });
        return;
      }
      setState({ kind: 'reading' });
      let buf: ArrayBuffer;
      try {
        buf = await file.arrayBuffer();
      } catch (e) {
        setState({
          kind: 'error',
          message: `Could not read file: ${e instanceof Error ? e.message : String(e)}`,
        });
        return;
      }
      const base64 = arrayBufferToBase64(buf);
      setState({ kind: 'uploading', bytes: buf.byteLength });
      try {
        const result = await replaceAssetPng(sessionId, asset.id, base64);
        setState({
          kind: 'done',
          width: result.width,
          height: result.height,
          bytesWritten: result.bytesWritten,
        });
        await scanCurrent();
      } catch (e) {
        const message =
          e instanceof ProjectApiError
            ? `${e.code}: ${e.message}`
            : e instanceof Error
              ? e.message
              : String(e);
        setState({ kind: 'error', message });
      }
    },
    [sessionId, asset.id, scanCurrent],
  );

  return (
    <div
      className={`asset-replace${dragging ? ' asset-replace--dragging' : ''}`}
      data-testid="asset-replace-dropzone"
      onDragEnter={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }}
      onDragLeave={(e) => {
        e.preventDefault();
        setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        const file = e.dataTransfer.files?.[0];
        if (file) void handleFile(file);
      }}
    >
      <div className="asset-replace__title">Replace PNG</div>
      <div className="asset-replace__hint">
        Drop a PNG here to atomically overwrite <code>{asset.relativePath}</code>. The header
        is validated before the source file is touched.
      </div>
      <label className="asset-replace__file-label">
        <input
          type="file"
          accept="image/png"
          className="asset-replace__file-input"
          data-testid="asset-replace-file-input"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleFile(f);
            e.target.value = '';
          }}
          disabled={!sessionId || state.kind === 'reading' || state.kind === 'uploading'}
        />
        <span className="asset-replace__file-button">…or pick a file</span>
      </label>
      <div className="asset-replace__status" data-testid="asset-replace-status">
        {state.kind === 'idle' && <span className="asset-replace__status--idle">Ready.</span>}
        {state.kind === 'reading' && 'Reading…'}
        {state.kind === 'uploading' && `Uploading ${state.bytes} bytes…`}
        {state.kind === 'done' && (
          <span className="asset-replace__status--ok">
            Replaced · {state.width}×{state.height} · {state.bytesWritten} B written
          </span>
        )}
        {state.kind === 'error' && (
          <span className="asset-replace__status--err">{state.message}</span>
        )}
      </div>
    </div>
  );
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  // Chunked to avoid blowing the call stack on large files.
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function AssetConstraintsList({ asset }: { asset: Asset }) {
  const constraints = useMemo(() => assessAssetConstraints(asset), [asset]);
  if (constraints.length === 0) return null;
  return (
    <section className="asset-constraints" data-testid="asset-constraints">
      <h3 className="asset-constraints__heading">
        Format constraints{' '}
        <span className="asset-constraints__count">
          ({constraints.filter((c) => c.severity === 'warn').length} warn ·{' '}
          {constraints.filter((c) => c.severity === 'info').length} info ·{' '}
          {constraints.filter((c) => c.severity === 'ok').length} ok)
        </span>
      </h3>
      <ul className="asset-constraints__list">
        {constraints.map((c) => (
          <li
            key={c.rule}
            className={`asset-constraints__row asset-constraints__row--${c.severity}`}
            data-testid={`asset-constraint-${c.rule}`}
            data-severity={c.severity}
          >
            <span className={`asset-constraints__badge asset-constraints__badge--${c.severity}`}>
              {badgeLabel(c.severity)}
            </span>
            <span className="asset-constraints__msg">{c.message}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function badgeLabel(severity: AssetConstraint['severity']): string {
  switch (severity) {
    case 'ok':
      return 'ok';
    case 'info':
      return 'info';
    case 'warn':
      return 'warn';
  }
}

type ImportState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'reading' }
  | { readonly kind: 'uploading'; readonly bytes: number }
  | { readonly kind: 'done'; readonly relativePath: string; readonly width: number; readonly height: number }
  | { readonly kind: 'error'; readonly message: string };

function NewAssetForm() {
  const sessionId = useProjectStore((s) =>
    s.load.kind === 'loaded' ? s.load.data.session.id : null,
  );
  const scanCurrent = useProjectStore((s) => s.scanCurrentProject);
  const [relativePath, setRelativePath] = useState('graphics/object_events/pics/');
  const [state, setState] = useState<ImportState>({ kind: 'idle' });

  const onFile = useCallback(
    async (file: File): Promise<void> => {
      if (!sessionId) {
        setState({ kind: 'error', message: 'No active project session.' });
        return;
      }
      if (!relativePath.trim()) {
        setState({ kind: 'error', message: 'Target path is required.' });
        return;
      }
      if (!file.name.toLowerCase().endsWith('.png')) {
        setState({ kind: 'error', message: `Expected a .png file, got '${file.name}'.` });
        return;
      }
      // If the user only specified a directory (trailing slash), append the
      // dropped file's basename. Otherwise use the path verbatim.
      const target = relativePath.trim().endsWith('/')
        ? relativePath.trim() + file.name
        : relativePath.trim();
      setState({ kind: 'reading' });
      let buf: ArrayBuffer;
      try {
        buf = await file.arrayBuffer();
      } catch (e) {
        setState({
          kind: 'error',
          message: `Could not read file: ${e instanceof Error ? e.message : String(e)}`,
        });
        return;
      }
      const base64 = arrayBufferToBase64(buf);
      setState({ kind: 'uploading', bytes: buf.byteLength });
      try {
        const result = await importAssetPng(sessionId, target, base64);
        setState({
          kind: 'done',
          relativePath: result.relativePath,
          width: result.width,
          height: result.height,
        });
        await scanCurrent();
      } catch (e) {
        const message =
          e instanceof ProjectApiError
            ? `${e.code}: ${e.message}`
            : e instanceof Error
              ? e.message
              : String(e);
        setState({ kind: 'error', message });
      }
    },
    [sessionId, relativePath, scanCurrent],
  );

  return (
    <details className="new-asset" data-testid="new-asset-form">
      <summary className="new-asset__summary">+ Import new asset</summary>
      <div className="new-asset__body">
        <label className="new-asset__label">
          <span className="new-asset__label-text">Target path under graphics/ or sound/</span>
          <input
            type="text"
            className="new-asset__path"
            data-testid="new-asset-path"
            value={relativePath}
            onChange={(e) => setRelativePath(e.target.value)}
            placeholder="graphics/object_events/pics/new_npc.png"
            spellCheck={false}
          />
        </label>
        <label className="new-asset__file-label">
          <input
            type="file"
            accept="image/png"
            className="new-asset__file-input"
            data-testid="new-asset-file"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void onFile(f);
              e.target.value = '';
            }}
            disabled={!sessionId || state.kind === 'reading' || state.kind === 'uploading'}
          />
          <span className="new-asset__file-button">Pick PNG to import</span>
        </label>
        <div className="new-asset__status" data-testid="new-asset-status">
          {state.kind === 'idle' && 'Ready.'}
          {state.kind === 'reading' && 'Reading…'}
          {state.kind === 'uploading' && `Uploading ${state.bytes} bytes…`}
          {state.kind === 'done' && (
            <span className="new-asset__status--ok">
              Imported {state.relativePath} ({state.width}×{state.height})
            </span>
          )}
          {state.kind === 'error' && (
            <span className="new-asset__status--err">{state.message}</span>
          )}
        </div>
      </div>
    </details>
  );
}
