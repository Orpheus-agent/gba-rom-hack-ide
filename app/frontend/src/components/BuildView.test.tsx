import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { ProjectManifest } from '@rom-editor/shared';
import { emptyManifest } from '@rom-editor/shared';
import { BuildView } from './BuildView';

function withProfile(opts?: { hasProfile?: boolean }): ProjectManifest {
  const base = emptyManifest('/tmp/x', '2026-05-16T00:00:00Z');
  if (opts?.hasProfile === false) return base;
  return {
    ...base,
    buildProfile: {
      toolchain: 'agbcc+make',
      buildCommand: 'make all',
      outputPaths: ['pokeemerald.gba'],
      testCommand: 'make compare',
    },
  };
}

describe('BuildView', () => {
  afterEach(() => cleanup());

  it('renders the no-profile state when buildProfile is null', () => {
    render(<BuildView manifest={withProfile({ hasProfile: false })} />);
    expect(screen.getByTestId('build-view-no-profile')).toBeInTheDocument();
  });

  it('renders detected toolchain + build command when a profile is present', () => {
    render(<BuildView manifest={withProfile()} />);
    expect(screen.getByTestId('build-view-toolchain')).toHaveTextContent('agbcc+make');
    expect(screen.getByTestId('build-view-buildcommand')).toHaveTextContent('make all');
    expect(screen.getByTestId('build-view-outputpaths')).toHaveTextContent('pokeemerald.gba');
  });

  it('mounts a BuildLauncher in the Run section when a profile is present', () => {
    render(<BuildView manifest={withProfile()} />);
    expect(screen.getByTestId('build-launcher')).toBeInTheDocument();
    expect(screen.getByTestId('build-launcher-run')).toHaveTextContent(/make all/);
  });

  it('shows the Artifacts section with a Refresh button (button disabled without session)', () => {
    render(<BuildView manifest={withProfile()} />);
    const refreshBtn = screen.getByTestId('build-view-refresh') as HTMLButtonElement;
    expect(refreshBtn).toBeInTheDocument();
    // No project session loaded in test harness → button disabled.
    expect(refreshBtn.disabled).toBe(true);
  });

  it('always renders the Build view shell with title + subtitle', () => {
    render(<BuildView manifest={withProfile()} />);
    expect(screen.getByTestId('build-view')).toBeInTheDocument();
    expect(screen.getByText(/Build/, { selector: 'h1' })).toBeInTheDocument();
  });

  it('mounts the PatchPanel when a build profile is detected', () => {
    render(<BuildView manifest={withProfile()} />);
    expect(screen.getByTestId('patch-panel')).toBeInTheDocument();
    expect(screen.getByTestId('patch-panel-generate')).toBeInTheDocument();
  });

  it('PatchPanel pre-populates the Built ROM field with the first detected output path', () => {
    render(<BuildView manifest={withProfile()} />);
    const modifiedInput = screen.getByTestId('patch-panel-modified') as HTMLInputElement;
    expect(modifiedInput.value).toBe('pokeemerald.gba');
  });

  it('does NOT mount the PatchPanel when no build profile is detected', () => {
    render(<BuildView manifest={withProfile({ hasProfile: false })} />);
    expect(screen.queryByTestId('patch-panel')).not.toBeInTheDocument();
  });

  it('mounts the SharePackagePanel when a build profile is detected', () => {
    render(<BuildView manifest={withProfile()} />);
    expect(screen.getByTestId('share-panel')).toBeInTheDocument();
    expect(screen.getByTestId('share-panel-materialize')).toBeInTheDocument();
  });

  it('disables Materialize button until required fields are filled', () => {
    render(<BuildView manifest={withProfile()} />);
    const btn = screen.getByTestId('share-panel-materialize') as HTMLButtonElement;
    // No session, no modName, no base ROM by default → disabled.
    expect(btn.disabled).toBe(true);
  });

  it('does NOT mount SharePackagePanel without a build profile', () => {
    render(<BuildView manifest={withProfile({ hasProfile: false })} />);
    expect(screen.queryByTestId('share-panel')).not.toBeInTheDocument();
  });
});
