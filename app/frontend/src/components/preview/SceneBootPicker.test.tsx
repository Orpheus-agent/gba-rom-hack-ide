import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SceneBootPicker, type SceneBootEmulatorHost } from './SceneBootPicker';

interface MockRecipe {
  id: string;
  name: string;
  notes: string | null;
  createdAt: string;
  startingMapId: string;
  startingPosition: null;
  initialFlags: number[];
  initialVars: { varId: number; value: number }[];
  triggerScriptId: string | null;
  skipIntro: boolean;
}

const MOCK_RECIPES: { current: MockRecipe[] } = { current: [] };

vi.mock('../../api', () => ({
  ProjectApiError: class extends Error {
    constructor(public readonly code: string, message: string) {
      super(message);
    }
  },
  listSceneBoots: vi.fn(async () => MOCK_RECIPES.current.slice()),
  createSceneBoot: vi.fn(async (_sessionId: string, body: {
    name: string;
    notes?: string | null;
    startingMapId: string;
    initialFlags?: number[];
    initialVars?: { varId: number; value: number }[];
    skipIntro?: boolean;
  }) => {
    const recipe: MockRecipe = {
      id: `recipe-${MOCK_RECIPES.current.length}`,
      name: body.name,
      notes: body.notes ?? null,
      createdAt: new Date().toISOString(),
      startingMapId: body.startingMapId,
      startingPosition: null,
      initialFlags: body.initialFlags ?? [],
      initialVars: body.initialVars ?? [],
      triggerScriptId: null,
      skipIntro: body.skipIntro ?? false,
    };
    MOCK_RECIPES.current = [recipe, ...MOCK_RECIPES.current];
    return recipe;
  }),
  updateSceneBoot: vi.fn(async () => ({} as MockRecipe)),
  deleteSceneBoot: vi.fn(async (_sessionId: string, recipeId: string) => {
    MOCK_RECIPES.current = MOCK_RECIPES.current.filter((r) => r.id !== recipeId);
  }),
}));

vi.mock('../../lib/sceneBoot', () => ({
  applySceneBoot: vi.fn(async () => ({
    flagsSet: 1,
    varsSet: 1,
    guidance: [],
    warnings: [],
  })),
  summarizeSceneBootResult: vi.fn(() => 'Applied recipe - 1/1 flags, 1/1 vars'),
}));

function makeHost(): SceneBootEmulatorHost {
  return {
    pauseGame: vi.fn(),
    resumeGame: vi.fn(),
  };
}

describe('SceneBootPicker (Phase 4.1B)', () => {
  beforeEach(() => {
    cleanup();
    MOCK_RECIPES.current = [];
  });

  it('renders a closed toggle button by default', () => {
    render(<SceneBootPicker sessionId="s" host={makeHost()} emulatorActive />);
    expect(screen.getByTestId('scene-boot-picker-toggle')).toBeInTheDocument();
    expect(screen.queryByTestId('scene-boot-picker-panel')).toBeNull();
  });

  it('opens the panel + shows empty state', async () => {
    render(<SceneBootPicker sessionId="s" host={makeHost()} emulatorActive />);
    fireEvent.click(screen.getByTestId('scene-boot-picker-toggle'));
    await waitFor(() => {
      expect(screen.getByTestId('scene-boot-picker-panel')).toBeInTheDocument();
    });
    expect(screen.getByTestId('scene-boot-picker-empty')).toBeInTheDocument();
  });

  it('+ New opens the composer with disabled save until valid', async () => {
    render(<SceneBootPicker sessionId="s" host={makeHost()} emulatorActive />);
    fireEvent.click(screen.getByTestId('scene-boot-picker-toggle'));
    await waitFor(() => screen.getByTestId('scene-boot-picker-panel'));
    fireEvent.click(screen.getByTestId('scene-boot-picker-new'));
    await waitFor(() => screen.getByTestId('scene-boot-picker-composer'));
    const save = screen.getByTestId('scene-boot-picker-save') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
  });

  it('Save creates a recipe with parsed flags + vars', async () => {
    render(<SceneBootPicker sessionId="s" host={makeHost()} emulatorActive />);
    fireEvent.click(screen.getByTestId('scene-boot-picker-toggle'));
    await waitFor(() => screen.getByTestId('scene-boot-picker-panel'));
    fireEvent.click(screen.getByTestId('scene-boot-picker-new'));
    await waitFor(() => screen.getByTestId('scene-boot-picker-composer'));

    fireEvent.change(screen.getByTestId('scene-boot-picker-name'), {
      target: { value: 'cosmog-handoff' },
    });
    fireEvent.change(screen.getByTestId('scene-boot-picker-map'), {
      target: { value: 'pallet_town' },
    });
    fireEvent.change(screen.getByTestId('scene-boot-picker-flags'), {
      target: { value: '0x820, 0x821' },
    });
    fireEvent.change(screen.getByTestId('scene-boot-picker-vars'), {
      target: { value: '0x40D0 = 3\n0x40D1 = 5' },
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('scene-boot-picker-save'));
    });
    await waitFor(() => {
      expect(screen.getByText('cosmog-handoff')).toBeInTheDocument();
    });
  });

  it('Apply button calls applySceneBoot + surfaces summary', async () => {
    MOCK_RECIPES.current = [
      {
        id: 'r1',
        name: 'existing',
        notes: null,
        createdAt: new Date().toISOString(),
        startingMapId: 'pallet_town',
        startingPosition: null,
        initialFlags: [0x100],
        initialVars: [],
        triggerScriptId: null,
        skipIntro: false,
      },
    ];
    const host = makeHost();
    render(<SceneBootPicker sessionId="s" host={host} emulatorActive />);
    fireEvent.click(screen.getByTestId('scene-boot-picker-toggle'));
    await waitFor(() => screen.getByTestId('scene-boot-picker-item-r1'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('scene-boot-picker-apply-r1'));
    });
    await waitFor(() => {
      expect(screen.getByTestId('scene-boot-picker-applied')).toBeInTheDocument();
    });
  });

  it('Apply button is disabled when emulator is inactive', async () => {
    MOCK_RECIPES.current = [
      {
        id: 'r2',
        name: 'idle',
        notes: null,
        createdAt: new Date().toISOString(),
        startingMapId: 'pallet_town',
        startingPosition: null,
        initialFlags: [],
        initialVars: [],
        triggerScriptId: null,
        skipIntro: false,
      },
    ];
    render(<SceneBootPicker sessionId="s" host={makeHost()} emulatorActive={false} />);
    fireEvent.click(screen.getByTestId('scene-boot-picker-toggle'));
    await waitFor(() => screen.getByTestId('scene-boot-picker-item-r2'));
    const btn = screen.getByTestId('scene-boot-picker-apply-r2') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('Delete removes the row after confirm', async () => {
    MOCK_RECIPES.current = [
      {
        id: 'r3',
        name: 'goner',
        notes: null,
        createdAt: new Date().toISOString(),
        startingMapId: 'pallet_town',
        startingPosition: null,
        initialFlags: [],
        initialVars: [],
        triggerScriptId: null,
        skipIntro: false,
      },
    ];
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    try {
      render(<SceneBootPicker sessionId="s" host={makeHost()} emulatorActive />);
      fireEvent.click(screen.getByTestId('scene-boot-picker-toggle'));
      await waitFor(() => screen.getByTestId('scene-boot-picker-item-r3'));
      await act(async () => {
        fireEvent.click(screen.getByTestId('scene-boot-picker-delete-r3'));
      });
      await waitFor(() => {
        expect(screen.queryByTestId('scene-boot-picker-item-r3')).toBeNull();
      });
    } finally {
      confirmSpy.mockRestore();
    }
  });
});
