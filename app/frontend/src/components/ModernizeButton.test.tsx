import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ProjectIdentity } from '@rom-editor/shared';
import { useProjectStore } from '../state';
import { ModernizeButton } from './ModernizeButton';

vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api');
  return {
    ...actual,
    modernizeRom: vi.fn(),
    fetchModernizeAttribution: vi.fn().mockResolvedValue({
      cfruVersion: '(test)',
      cfruCommitShortSha: 'test',
      built: false,
      attribution: '(test attribution)',
    }),
  };
});

const VANILLA_IDENTITY: ProjectIdentity = {
  kind: 'patch',
  confidence: 1,
  displayName: 'Pokémon FireRed (USA)',
  baseGame: 'Pokémon FireRed',
  fork: null,
  featureFlags: [],
  warnings: [],
  evidence: ['firered.gba'],
  upgradeOffer: 'vanilla-frlg-rev0',
};

function setLoaded(identity: ProjectIdentity) {
  act(() => {
    useProjectStore.setState({
      load: {
        kind: 'loaded',
        data: {
          session: {
            id: 's1',
            projectRoot: '/tmp/firered',
            openedAtUtc: '2026-05-26T00:00:00.000Z',
          },
          rootListing: { path: '', entries: [] },
          identity,
        },
      },
    });
  });
}

function setIdle() {
  act(() => {
    useProjectStore.setState({ load: { kind: 'empty' } });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  setIdle();
});

afterEach(() => {
  cleanup();
  setIdle();
});

describe('ModernizeButton - conditional render', () => {
  it('renders nothing when no project is loaded', () => {
    render(<ModernizeButton />);
    expect(screen.queryByTestId('titlebar-modernize-button')).toBeNull();
  });

  it('renders nothing when the project is loaded but upgradeOffer is not set', () => {
    setLoaded({ ...VANILLA_IDENTITY, upgradeOffer: null });
    render(<ModernizeButton />);
    expect(screen.queryByTestId('titlebar-modernize-button')).toBeNull();
  });

  it('renders nothing when upgradeOffer is undefined (older manifest)', () => {
    const { upgradeOffer: _omitted, ...rest } = VANILLA_IDENTITY;
    setLoaded(rest as ProjectIdentity);
    render(<ModernizeButton />);
    expect(screen.queryByTestId('titlebar-modernize-button')).toBeNull();
  });

  it('renders the titlebar button when upgradeOffer === "vanilla-frlg-rev0"', () => {
    setLoaded(VANILLA_IDENTITY);
    render(<ModernizeButton />);
    expect(screen.getByTestId('titlebar-modernize-button')).toBeTruthy();
  });
});

describe('ModernizeButton - modal flow', () => {
  it('opens the modal on click and renders the ModernizeCard inside', () => {
    setLoaded(VANILLA_IDENTITY);
    render(<ModernizeButton />);
    fireEvent.click(screen.getByTestId('titlebar-modernize-button'));
    expect(screen.getByTestId('modernize-modal')).toBeTruthy();
    expect(screen.getByTestId('modernize-card')).toBeTruthy();
    expect(screen.getByTestId('modernize-modal-close')).toBeTruthy();
  });

  it('closes the modal when the X button is clicked', () => {
    setLoaded(VANILLA_IDENTITY);
    render(<ModernizeButton />);
    fireEvent.click(screen.getByTestId('titlebar-modernize-button'));
    expect(screen.getByTestId('modernize-modal')).toBeTruthy();
    fireEvent.click(screen.getByTestId('modernize-modal-close'));
    expect(screen.queryByTestId('modernize-modal')).toBeNull();
  });

  it('closes the modal when the backdrop is clicked (not the inner modal body)', () => {
    setLoaded(VANILLA_IDENTITY);
    render(<ModernizeButton />);
    fireEvent.click(screen.getByTestId('titlebar-modernize-button'));
    const overlay = screen.getByTestId('modernize-modal');
    // Backdrop click - fire on the overlay itself, not bubbled from a child.
    fireEvent.click(overlay);
    expect(screen.queryByTestId('modernize-modal')).toBeNull();
  });

  it('closes the modal on Escape', () => {
    setLoaded(VANILLA_IDENTITY);
    render(<ModernizeButton />);
    fireEvent.click(screen.getByTestId('titlebar-modernize-button'));
    expect(screen.getByTestId('modernize-modal')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('modernize-modal')).toBeNull();
  });
});
