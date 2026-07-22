import { useCallback, useState } from 'react';
import type { SharePackageResponse } from '@rom-editor/shared';
import { materializeSharePackage, ProjectApiError } from '../api';
import { useProjectStore } from '../state';
import './SharePackagePanel.css';

interface SharePackagePanelProps {
  /** Pre-populated default patch path (typically the one PatchPanel just produced). */
  readonly defaultPatchPath?: string;
}

type ShareState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'materializing' }
  | { readonly kind: 'done'; readonly response: SharePackageResponse }
  | { readonly kind: 'error'; readonly message: string };

export function SharePackagePanel({ defaultPatchPath }: SharePackagePanelProps) {
  const sessionId = useProjectStore((s) =>
    s.load.kind === 'loaded' ? s.load.data.session.id : null,
  );

  const [patchPath, setPatchPath] = useState(defaultPatchPath ?? 'patches/my-mod.ips');
  const [baseRomPath, setBaseRomPath] = useState('');
  const [outputDir, setOutputDir] = useState('dist/share');
  const [modName, setModName] = useState('');
  const [version, setVersion] = useState('1.0.0');
  const [author, setAuthor] = useState('');
  const [description, setDescription] = useState('');
  const [state, setState] = useState<ShareState>({ kind: 'idle' });

  const canRun =
    sessionId !== null &&
    patchPath.trim().length > 0 &&
    baseRomPath.trim().length > 0 &&
    outputDir.trim().length > 0 &&
    modName.trim().length > 0 &&
    state.kind !== 'materializing';

  const onMaterialize = useCallback(async (): Promise<void> => {
    if (!sessionId) return;
    setState({ kind: 'materializing' });
    try {
      const response = await materializeSharePackage(sessionId, {
        patchPath: patchPath.trim(),
        baseRomPath: baseRomPath.trim(),
        outputDir: outputDir.trim(),
        meta: {
          modName: modName.trim(),
          version: version.trim(),
          author: author.trim(),
          description: description.trim(),
        },
      });
      setState({ kind: 'done', response });
    } catch (e) {
      const message =
        e instanceof ProjectApiError
          ? `${e.code}: ${e.message}`
          : e instanceof Error
            ? e.message
            : String(e);
      setState({ kind: 'error', message });
    }
  }, [sessionId, patchPath, baseRomPath, outputDir, modName, version, author, description]);

  return (
    <section className="share-panel" data-testid="share-panel">
      <h3 className="share-panel__heading">Share package</h3>
      <p className="share-panel__hint">
        Materializes a clean, shareable directory containing the patch + a README with mod
        metadata + base-ROM SHA-256 - no source tree, no <code>.editor/</code> cache, no node_modules.
        The output directory is what you zip and hand over.
      </p>
      <div className="share-panel__fields">
        <label className="share-panel__field">
          <span className="share-panel__field-label">Mod name *</span>
          <input
            type="text"
            className="share-panel__input"
            value={modName}
            onChange={(e) => setModName(e.target.value)}
            placeholder="My Awesome Mod"
            spellCheck={false}
            data-testid="share-panel-modName"
          />
        </label>
        <div className="share-panel__field-row">
          <label className="share-panel__field share-panel__field--small">
            <span className="share-panel__field-label">Version</span>
            <input
              type="text"
              className="share-panel__input"
              value={version}
              onChange={(e) => setVersion(e.target.value)}
              placeholder="1.0.0"
              spellCheck={false}
              data-testid="share-panel-version"
            />
          </label>
          <label className="share-panel__field share-panel__field--small">
            <span className="share-panel__field-label">Author</span>
            <input
              type="text"
              className="share-panel__input"
              value={author}
              onChange={(e) => setAuthor(e.target.value)}
              placeholder="(your name)"
              spellCheck={false}
              data-testid="share-panel-author"
            />
          </label>
        </div>
        <label className="share-panel__field">
          <span className="share-panel__field-label">Description</span>
          <textarea
            className="share-panel__textarea"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What does this mod do?"
            rows={3}
            data-testid="share-panel-description"
          />
        </label>
        <label className="share-panel__field">
          <span className="share-panel__field-label">Patch path</span>
          <input
            type="text"
            className="share-panel__input"
            value={patchPath}
            onChange={(e) => setPatchPath(e.target.value)}
            placeholder="patches/my-mod.ips"
            spellCheck={false}
            data-testid="share-panel-patch"
          />
        </label>
        <label className="share-panel__field">
          <span className="share-panel__field-label">Base ROM (for hash; not copied)</span>
          <input
            type="text"
            className="share-panel__input"
            value={baseRomPath}
            onChange={(e) => setBaseRomPath(e.target.value)}
            placeholder="absolute or project-relative path"
            spellCheck={false}
            data-testid="share-panel-base"
          />
        </label>
        <label className="share-panel__field">
          <span className="share-panel__field-label">Output dir</span>
          <input
            type="text"
            className="share-panel__input"
            value={outputDir}
            onChange={(e) => setOutputDir(e.target.value)}
            placeholder="dist/share"
            spellCheck={false}
            data-testid="share-panel-output"
          />
        </label>
      </div>
      <div className="share-panel__actions">
        <button
          type="button"
          className="share-panel__gen-btn"
          onClick={() => void onMaterialize()}
          disabled={!canRun}
          data-testid="share-panel-materialize"
        >
          {state.kind === 'materializing' ? 'Materializing…' : 'Materialize share'}
        </button>
        <StatusBadge state={state} />
      </div>
      {state.kind === 'done' && (
        <div className="share-panel__result" data-testid="share-panel-result">
          <div>
            Wrote <code>{state.response.outputDir}</code> ({state.response.files.length} files,{' '}
            {formatBytes(state.response.totalSize)})
          </div>
          <ul className="share-panel__result-files">
            {state.response.files.map((f) => (
              <li key={f.relativePath}>
                <code>{f.relativePath}</code> · {formatBytes(f.sizeBytes)}
              </li>
            ))}
          </ul>
          <div className="share-panel__result-hash">
            base ROM SHA-256: <code>{state.response.baseRomSha256}</code>
          </div>
        </div>
      )}
      {state.kind === 'error' && (
        <div className="share-panel__error" data-testid="share-panel-error">
          {state.message}
        </div>
      )}
    </section>
  );
}

function StatusBadge({ state }: { state: ShareState }) {
  switch (state.kind) {
    case 'idle':
      return null;
    case 'materializing':
      return (
        <span className="share-panel__badge share-panel__badge--running" data-testid="share-panel-status">
          materializing
        </span>
      );
    case 'done':
      return (
        <span className="share-panel__badge share-panel__badge--ok" data-testid="share-panel-status">
          done
        </span>
      );
    case 'error':
      return (
        <span className="share-panel__badge share-panel__badge--err" data-testid="share-panel-status">
          error
        </span>
      );
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
