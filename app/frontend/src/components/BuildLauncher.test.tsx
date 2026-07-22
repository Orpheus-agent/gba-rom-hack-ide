import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { BuildProfile } from '@rom-editor/shared';
import { BuildLauncher } from './BuildLauncher';

function profile(opts?: Partial<BuildProfile>): BuildProfile {
  return {
    toolchain: 'agbcc+make',
    buildCommand: 'make all',
    outputPaths: ['pokeemerald.gba'],
    testCommand: null,
    ...opts,
  };
}

describe('BuildLauncher', () => {
  afterEach(() => cleanup());

  it('renders the no-profile fallback when buildProfile is null', () => {
    render(<BuildLauncher buildProfile={null} />);
    const root = screen.getByTestId('build-launcher');
    expect(root).toHaveTextContent(/No build profile detected/);
  });

  it('renders the run button labelled with the detected build command', () => {
    render(<BuildLauncher buildProfile={profile()} />);
    const btn = screen.getByTestId('build-launcher-run');
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveTextContent(/make all/);
  });

  it('disables the run button when there is no project session', () => {
    // No project is loaded into the store in the test harness, so sessionId is null.
    render(<BuildLauncher buildProfile={profile()} />);
    const btn = screen.getByTestId('build-launcher-run') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('does not render the output toggle in the idle state', () => {
    render(<BuildLauncher buildProfile={profile()} />);
    expect(screen.queryByTestId('build-launcher-toggle-output')).not.toBeInTheDocument();
    expect(screen.queryByTestId('build-launcher-status')).not.toBeInTheDocument();
  });

  it('shows the detected command in the button title attribute (full text visible on hover)', () => {
    render(<BuildLauncher buildProfile={profile({ buildCommand: 'flips --apply patch.ips base.gba out.gba' })} />);
    const btn = screen.getByTestId('build-launcher-run');
    expect(btn).toHaveAttribute('title', 'Run: flips --apply patch.ips base.gba out.gba');
  });
});
