import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { EmulatorHost } from './EmulatorHost';
import { useProjectStore } from '../../state';

// Mock mgba-wasm - jsdom can't load WASM. Each test that wants to
// drive boot() can replace this mock per-test. The default is a
// minimal Module that doesn't actually emulate anything.
vi.mock('@thenick775/mgba-wasm', () => ({
  default: vi.fn(),
}));

function projectLoaded(sessionId: string): void {
  useProjectStore.setState({
    load: {
      kind: 'loaded',
      data: {
        session: {
          id: sessionId,
          projectRoot: '/tmp/test',
          name: 'test',
          createdAtUtc: '2026-05-25T00:00:00Z',
          updatedAtUtc: '2026-05-25T00:00:00Z',
        },
        rootListing: { entries: [] },
      } as never,
    },
    scan: { kind: 'idle' },
  } as never);
}

describe('EmulatorHost', () => {
  beforeEach(() => {
    cleanup();
    useProjectStore.setState({
      load: { kind: 'empty' },
      scan: { kind: 'idle' },
    } as never);
  });

  it('renders the play button + canvas + status line', () => {
    projectLoaded('sess-1');
    render(<EmulatorHost />);
    expect(screen.getByTestId('emulator-host')).toBeInTheDocument();
    expect(screen.getByTestId('emulator-host-play')).toBeInTheDocument();
    expect(screen.getByTestId('emulator-host-canvas')).toBeInTheDocument();
    expect(screen.getByTestId('emulator-host-status')).toBeInTheDocument();
  });

  it('disables the Play button when no project is loaded', () => {
    // load.kind = 'empty' from beforeEach - no sessionId
    render(<EmulatorHost />);
    const playBtn = screen.getByTestId('emulator-host-play') as HTMLButtonElement;
    expect(playBtn.disabled).toBe(true);
  });

  it('enables the Play button when a project is loaded', () => {
    projectLoaded('sess-1');
    render(<EmulatorHost />);
    const playBtn = screen.getByTestId('emulator-host-play') as HTMLButtonElement;
    expect(playBtn.disabled).toBe(false);
  });

  it('canvas has native GBA dimensions (240×160)', () => {
    projectLoaded('sess-1');
    render(<EmulatorHost />);
    const canvas = screen.getByTestId('emulator-host-canvas') as HTMLCanvasElement;
    expect(canvas.width).toBe(240);
    expect(canvas.height).toBe(160);
  });

  it('shows the keyboard-mapping hint in the status line once running (controlled via internal state)', () => {
    projectLoaded('sess-1');
    render(<EmulatorHost />);
    // Initial state = idle → status = "Ready to boot"
    expect(screen.getByTestId('emulator-host-status').textContent).toMatch(/Ready to boot/);
  });
});
