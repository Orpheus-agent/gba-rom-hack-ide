import { useCallback, useEffect, useState } from 'react';
import type { BuildArtifactsResponse, BuildProfile, ProjectManifest } from '@rom-editor/shared';
import { fetchBuildArtifacts, ProjectApiError } from '../api';
import { useProjectStore } from '../state';
import { BuildLauncher } from './BuildLauncher';
import { PatchPanel } from './PatchPanel';
import { SharePackagePanel } from './SharePackagePanel';
import './BuildView.css';

interface BuildViewProps {
  readonly manifest: ProjectManifest;
}

type ArtifactsState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'loaded'; readonly data: BuildArtifactsResponse }
  | { readonly kind: 'error'; readonly message: string };

export function BuildView({ manifest }: BuildViewProps) {
  const sessionId = useProjectStore((s) =>
    s.load.kind === 'loaded' ? s.load.data.session.id : null,
  );
  const [artifacts, setArtifacts] = useState<ArtifactsState>({ kind: 'idle' });

  const refresh = useCallback(async (): Promise<void> => {
    if (!sessionId) return;
    setArtifacts({ kind: 'loading' });
    try {
      const data = await fetchBuildArtifacts(sessionId);
      setArtifacts({ kind: 'loaded', data });
    } catch (e) {
      const message =
        e instanceof ProjectApiError
          ? `${e.code}: ${e.message}`
          : e instanceof Error
            ? e.message
            : String(e);
      setArtifacts({ kind: 'error', message });
    }
  }, [sessionId]);

  // Probe artifacts on mount + when the buildProfile changes (e.g. after a rescan).
  useEffect(() => {
    void refresh();
  }, [refresh, manifest.buildProfile]);

  const profile = manifest.buildProfile;

  return (
    <div className="build-view" data-testid="build-view">
      <header className="build-view__header">
        <h1 className="build-view__title">Build</h1>
        <p className="build-view__subtitle">
          Detected toolchain, the build command the editor will run, and the on-disk artifacts
          the last build produced. Source → toolchain → compiled output, made visible.
        </p>
      </header>

      <section className="build-view__profile" data-testid="build-view-profile">
        <h3 className="build-view__section-heading">Build profile</h3>
        {profile ? (
          <ProfileTable profile={profile} />
        ) : (
          <div className="build-view__no-profile" data-testid="build-view-no-profile">
            No build profile detected. The detector looks for a top-level <code>Makefile</code>{' '}
            (decomp), <code>flips</code>-applicable patch files in <code>patches/</code> or the
            project root, or <code>devkitARM</code> setup. Make a scan from the Project tab to
            try again.
          </div>
        )}
      </section>

      {profile && (
        <section className="build-view__run" data-testid="build-view-run">
          <h3 className="build-view__section-heading">Run</h3>
          <BuildLauncher buildProfile={profile} />
        </section>
      )}

      {profile && (
        <PatchPanel
          buildProfile={profile}
          defaultModifiedRomPath={profile.outputPaths[0] ?? null}
        />
      )}

      {profile && <SharePackagePanel />}

      <section className="build-view__artifacts" data-testid="build-view-artifacts">
        <div className="build-view__artifacts-header">
          <h3 className="build-view__section-heading">Artifacts</h3>
          <button
            type="button"
            className="build-view__refresh"
            onClick={() => void refresh()}
            disabled={!sessionId || artifacts.kind === 'loading'}
            data-testid="build-view-refresh"
          >
            {artifacts.kind === 'loading' ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
        {artifacts.kind === 'idle' && (
          <div className="build-view__artifacts-empty">Probing…</div>
        )}
        {artifacts.kind === 'loading' && (
          <div className="build-view__artifacts-empty">Probing…</div>
        )}
        {artifacts.kind === 'error' && (
          <div className="build-view__artifacts-error" data-testid="build-view-artifacts-error">
            {artifacts.message}
          </div>
        )}
        {artifacts.kind === 'loaded' && (
          <ArtifactsTable response={artifacts.data} />
        )}
      </section>
    </div>
  );
}

function ProfileTable({ profile }: { profile: BuildProfile }) {
  return (
    <dl className="build-view__profile-fields">
      <span style={{ display: 'contents' }}>
        <dt>Toolchain</dt>
        <dd data-testid="build-view-toolchain">{profile.toolchain}</dd>
      </span>
      <span style={{ display: 'contents' }}>
        <dt>Build command</dt>
        <dd data-testid="build-view-buildcommand">
          <code>{profile.buildCommand}</code>
        </dd>
      </span>
      {profile.testCommand && (
        <span style={{ display: 'contents' }}>
          <dt>Test command</dt>
          <dd>
            <code>{profile.testCommand}</code>
          </dd>
        </span>
      )}
      <span style={{ display: 'contents' }}>
        <dt>Output paths</dt>
        <dd data-testid="build-view-outputpaths">
          {profile.outputPaths.length === 0 ? (
            <em>none</em>
          ) : (
            <ul className="build-view__output-list">
              {profile.outputPaths.map((p) => (
                <li key={p}>
                  <code>{p}</code>
                </li>
              ))}
            </ul>
          )}
        </dd>
      </span>
    </dl>
  );
}

function ArtifactsTable({ response }: { response: BuildArtifactsResponse }) {
  if (!response.buildProfileDetected) {
    return (
      <div className="build-view__artifacts-empty" data-testid="build-view-artifacts-no-profile">
        No build profile detected - no artifacts to probe.
      </div>
    );
  }
  if (response.outputPaths.length === 0) {
    return (
      <div className="build-view__artifacts-empty">
        Build profile has no declared output paths.
      </div>
    );
  }
  return (
    <table className="build-view__artifacts-table" data-testid="build-view-artifacts-table">
      <thead>
        <tr>
          <th>Path</th>
          <th>Status</th>
          <th>Size</th>
          <th>Built</th>
        </tr>
      </thead>
      <tbody>
        {response.outputPaths.map((a) => (
          <tr key={a.relativePath} data-testid={`build-view-artifact-${a.relativePath}`}>
            <td>
              <code>{a.relativePath}</code>{' '}
              {a.isPatchFormat && (
                <span className="build-view__patch-chip">patch</span>
              )}
            </td>
            <td>
              {a.exists ? (
                <span className="build-view__artifact-ok">present</span>
              ) : (
                <span className="build-view__artifact-missing">not built yet</span>
              )}
            </td>
            <td className="build-view__artifact-size">
              {a.sizeBytes !== null ? formatBytes(a.sizeBytes) : ' - '}
            </td>
            <td className="build-view__artifact-mtime">
              {a.mtimeUtc ? formatMtime(a.mtimeUtc) : ' - '}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatMtime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}
