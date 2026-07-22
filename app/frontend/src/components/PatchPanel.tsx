import { useCallback, useState } from 'react';
import type { BuildProfile, PatchGenerationResponse } from '@rom-editor/shared';
import { generatePatch, ProjectApiError } from '../api';
import { useProjectStore } from '../state';
import './PatchPanel.css';

interface PatchPanelProps {
  readonly buildProfile: BuildProfile;
  /** When the build profile has multiple outputPaths, the first one is the
   *  default modified ROM. Operators can override. */
  readonly defaultModifiedRomPath: string | null;
}

type GenState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'generating' }
  | { readonly kind: 'done'; readonly response: PatchGenerationResponse }
  | { readonly kind: 'error'; readonly message: string };

export function PatchPanel({ buildProfile, defaultModifiedRomPath }: PatchPanelProps) {
  const sessionId = useProjectStore((s) =>
    s.load.kind === 'loaded' ? s.load.data.session.id : null,
  );
  const [baseRomPath, setBaseRomPath] = useState('');
  const [modifiedRomPath, setModifiedRomPath] = useState(defaultModifiedRomPath ?? '');
  const [outputPath, setOutputPath] = useState('patches/my-mod.ips');
  const [state, setState] = useState<GenState>({ kind: 'idle' });

  const canRun = sessionId !== null && baseRomPath.trim().length > 0 && modifiedRomPath.trim().length > 0 && outputPath.trim().length > 0;

  const onGenerate = useCallback(async (): Promise<void> => {
    if (!sessionId) return;
    setState({ kind: 'generating' });
    try {
      const response = await generatePatch(sessionId, {
        baseRomPath: baseRomPath.trim(),
        modifiedRomPath: modifiedRomPath.trim(),
        outputPath: outputPath.trim(),
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
  }, [sessionId, baseRomPath, modifiedRomPath, outputPath]);

  void buildProfile;

  return (
    <section className="patch-panel" data-testid="patch-panel">
      <h3 className="patch-panel__heading">Generate IPS patch</h3>
      <p className="patch-panel__hint">
        Diffs the unmodified base ROM against the built ROM and writes a deterministic <code>.ips</code>{' '}
        patch the writer can share. RLE-compressed; no external tool required.
      </p>
      <div className="patch-panel__fields">
        <label className="patch-panel__field">
          <span className="patch-panel__field-label">Base ROM</span>
          <input
            type="text"
            className="patch-panel__input"
            value={baseRomPath}
            onChange={(e) => setBaseRomPath(e.target.value)}
            placeholder="absolute path or project-relative (e.g. base/pokeemerald.gba)"
            spellCheck={false}
            data-testid="patch-panel-base"
          />
        </label>
        <label className="patch-panel__field">
          <span className="patch-panel__field-label">Built ROM</span>
          <input
            type="text"
            className="patch-panel__input"
            value={modifiedRomPath}
            onChange={(e) => setModifiedRomPath(e.target.value)}
            placeholder="project-relative (e.g. pokeemerald.gba)"
            spellCheck={false}
            data-testid="patch-panel-modified"
          />
        </label>
        <label className="patch-panel__field">
          <span className="patch-panel__field-label">Output patch</span>
          <input
            type="text"
            className="patch-panel__input"
            value={outputPath}
            onChange={(e) => setOutputPath(e.target.value)}
            placeholder="project-relative (e.g. patches/my-mod.ips)"
            spellCheck={false}
            data-testid="patch-panel-output"
          />
        </label>
      </div>
      <div className="patch-panel__actions">
        <button
          type="button"
          className="patch-panel__gen-btn"
          onClick={() => void onGenerate()}
          disabled={!canRun || state.kind === 'generating'}
          data-testid="patch-panel-generate"
        >
          {state.kind === 'generating' ? 'Generating…' : 'Generate patch'}
        </button>
        <StatusBadge state={state} />
      </div>
      {state.kind === 'done' && (
        <div className="patch-panel__result" data-testid="patch-panel-result">
          Wrote <code>{state.response.outputPath}</code> · {state.response.recordCount} records ·{' '}
          {state.response.totalPatchedBytes} patched bytes · {formatBytes(state.response.patchBytes)} on disk
          {' '}({formatBytes(state.response.modifiedSizeBytes)} ROM diff'd against{' '}
          {formatBytes(state.response.baseSizeBytes)} base)
        </div>
      )}
      {state.kind === 'error' && (
        <div className="patch-panel__error" data-testid="patch-panel-error">
          {state.message}
        </div>
      )}
    </section>
  );
}

function StatusBadge({ state }: { state: GenState }) {
  switch (state.kind) {
    case 'idle':
      return null;
    case 'generating':
      return (
        <span className="patch-panel__badge patch-panel__badge--running" data-testid="patch-panel-status">
          generating
        </span>
      );
    case 'done':
      return (
        <span className="patch-panel__badge patch-panel__badge--ok" data-testid="patch-panel-status">
          done
        </span>
      );
    case 'error':
      return (
        <span className="patch-panel__badge patch-panel__badge--err" data-testid="patch-panel-status">
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
