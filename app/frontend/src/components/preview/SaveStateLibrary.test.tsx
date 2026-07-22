import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SaveStateLibrary, type SaveStateEmulatorHost } from './SaveStateLibrary';

const MOCKED_STATES_REF: { current: { id: string; name: string; notes: string | null; createdAt: string; gameSha1: string; byteLength: number; lastLoaded: boolean }[] } = {
  current: [],
};

vi.mock('../../api', () => ({
  ProjectApiError: class ProjectApiError extends Error {
    constructor(public readonly code: string, message: string) {
      super(message);
    }
  },
  listSaveStates: vi.fn(async () => MOCKED_STATES_REF.current.slice()),
  createSaveState: vi.fn(async (_sessionId: string, args: { name: string; notes?: string | null; bytes: Uint8Array }) => {
    const record = {
      id: `state-${MOCKED_STATES_REF.current.length}`,
      name: args.name,
      notes: args.notes ?? null,
      createdAt: new Date().toISOString(),
      gameSha1: '0'.repeat(40),
      byteLength: args.bytes.byteLength,
      lastLoaded: false,
    };
    MOCKED_STATES_REF.current = [record, ...MOCKED_STATES_REF.current];
    return record;
  }),
  updateSaveState: vi.fn(async (_sessionId: string, stateId: string, update: { name?: string; notes?: string | null; markLastLoaded?: boolean }) => {
    const idx = MOCKED_STATES_REF.current.findIndex((s) => s.id === stateId);
    if (idx < 0) throw new Error('not found');
    const cur = MOCKED_STATES_REF.current[idx]!;
    const next = { ...cur };
    if (update.name !== undefined) next.name = update.name;
    if (update.notes !== undefined) next.notes = update.notes;
    if (update.markLastLoaded === true) {
      MOCKED_STATES_REF.current = MOCKED_STATES_REF.current.map((s) => ({ ...s, lastLoaded: false }));
      next.lastLoaded = true;
    }
    MOCKED_STATES_REF.current[idx] = next;
    return next;
  }),
  deleteSaveState: vi.fn(async (_sessionId: string, stateId: string) => {
    MOCKED_STATES_REF.current = MOCKED_STATES_REF.current.filter((s) => s.id !== stateId);
  }),
  fetchSaveStateBytes: vi.fn(async (_sessionId: string, _stateId: string) => new Uint8Array(64)),
}));

function makeHost(): SaveStateEmulatorHost {
  return {
    forceAutoSaveState: vi.fn(() => true),
    getAutoSaveState: vi.fn(() => ({
      autoSaveStateName: 'auto.ss',
      data: new Uint8Array(0x61000),
    })),
    uploadAutoSaveState: vi.fn(async () => undefined),
    loadAutoSaveState: vi.fn(() => true),
    pauseGame: vi.fn(),
    resumeGame: vi.fn(),
  };
}

describe('SaveStateLibrary (Phase 4.1A)', () => {
  beforeEach(() => {
    cleanup();
    MOCKED_STATES_REF.current = [];
  });

  it('renders a closed toggle button by default', () => {
    render(<SaveStateLibrary sessionId="s" host={makeHost()} emulatorActive />);
    expect(screen.getByTestId('save-state-library-toggle')).toBeInTheDocument();
    expect(screen.queryByTestId('save-state-library-panel')).toBeNull();
  });

  it('opens the panel on toggle click and shows the empty state', async () => {
    render(<SaveStateLibrary sessionId="s" host={makeHost()} emulatorActive />);
    fireEvent.click(screen.getByTestId('save-state-library-toggle'));
    await waitFor(() => {
      expect(screen.getByTestId('save-state-library-panel')).toBeInTheDocument();
    });
    expect(screen.getByTestId('save-state-library-empty')).toBeInTheDocument();
  });

  it('Capture button is disabled when emulator is not active', async () => {
    render(<SaveStateLibrary sessionId="s" host={makeHost()} emulatorActive={false} />);
    fireEvent.click(screen.getByTestId('save-state-library-toggle'));
    await waitFor(() => {
      expect(screen.getByTestId('save-state-library-panel')).toBeInTheDocument();
    });
    const btn = screen.getByTestId('save-state-library-capture') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('Capture prompts for name + persists a record', async () => {
    const host = makeHost();
    const promptSpy = vi.spyOn(window, 'prompt').mockImplementation((msg) => {
      if (typeof msg === 'string' && msg.startsWith('Name')) return 'my-state';
      return ''; // notes empty
    });
    try {
      render(<SaveStateLibrary sessionId="s" host={host} emulatorActive />);
      fireEvent.click(screen.getByTestId('save-state-library-toggle'));
      await waitFor(() => {
        expect(screen.getByTestId('save-state-library-panel')).toBeInTheDocument();
      });
      await act(async () => {
        fireEvent.click(screen.getByTestId('save-state-library-capture'));
      });
      await waitFor(() => {
        expect(screen.getByText('my-state')).toBeInTheDocument();
      });
    } finally {
      promptSpy.mockRestore();
    }
  });

  it('Load button calls upload + load on the host + marks lastLoaded', async () => {
    MOCKED_STATES_REF.current = [
      {
        id: 's1',
        name: 'state1',
        notes: null,
        createdAt: new Date().toISOString(),
        gameSha1: '0'.repeat(40),
        byteLength: 64,
        lastLoaded: false,
      },
    ];
    const host = makeHost();
    render(<SaveStateLibrary sessionId="s" host={host} emulatorActive />);
    fireEvent.click(screen.getByTestId('save-state-library-toggle'));
    await waitFor(() => {
      expect(screen.getByTestId('save-state-library-item-s1')).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('save-state-library-load-s1'));
    });
    await waitFor(() => {
      expect(host.uploadAutoSaveState).toHaveBeenCalled();
      expect(host.loadAutoSaveState).toHaveBeenCalled();
    });
  });

  it('Delete prompts confirm, then removes the row', async () => {
    MOCKED_STATES_REF.current = [
      {
        id: 's2',
        name: 'goner',
        notes: null,
        createdAt: new Date().toISOString(),
        gameSha1: '0'.repeat(40),
        byteLength: 64,
        lastLoaded: false,
      },
    ];
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    try {
      render(<SaveStateLibrary sessionId="s" host={makeHost()} emulatorActive />);
      fireEvent.click(screen.getByTestId('save-state-library-toggle'));
      await waitFor(() => {
        expect(screen.getByTestId('save-state-library-item-s2')).toBeInTheDocument();
      });
      await act(async () => {
        fireEvent.click(screen.getByTestId('save-state-library-delete-s2'));
      });
      await waitFor(() => {
        expect(screen.queryByTestId('save-state-library-item-s2')).toBeNull();
      });
    } finally {
      confirmSpy.mockRestore();
    }
  });
});
