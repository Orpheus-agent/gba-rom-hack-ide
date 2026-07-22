/**
 * Phase 9C - HudOverlay smoke tests.
 *
 * Uses a synthetic EmulatorMemoryHost that returns a mock savestate
 * blob with patched BattleMon structs. The HudOverlay polls via the
 * same `EmulatorMemory` class the rest of the app uses, so this
 * exercises the full read path end-to-end without an emulator.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { HudOverlay } from './HudOverlay';
import {
  BATTLEMON_OFFSETS,
  BATTLEMON_STRUCT_SIZE,
  FRLG_VANILLA_GBATTLEMONS_ADDR,
} from '../../lib/battleStateReader';
import {
  SAVESTATE_EWRAM_OFFSET,
  SAVESTATE_TOTAL_SIZE,
} from '../../lib/emulatorMemory';
import type { EmulatorMemoryHost } from '../../lib/emulatorMemory';

function buildHost(opts: {
  playerSpecies?: number;
  playerHp?: number;
  playerMaxHp?: number;
  opponentSpecies?: number;
} = {}): EmulatorMemoryHost {
  const blob = new Uint8Array(SAVESTATE_TOTAL_SIZE);
  const ewramBase = 0x02000000;
  const offsetInEwram = FRLG_VANILLA_GBATTLEMONS_ADDR - ewramBase;
  const playerBase = SAVESTATE_EWRAM_OFFSET + offsetInEwram;
  const opponentBase = playerBase + BATTLEMON_STRUCT_SIZE;
  function u16(off: number, val: number) {
    blob[off] = val & 0xff;
    blob[off + 1] = (val >> 8) & 0xff;
  }
  function u8(off: number, val: number) {
    blob[off] = val & 0xff;
  }
  u16(playerBase + BATTLEMON_OFFSETS.species, opts.playerSpecies ?? 25);
  u8(playerBase + BATTLEMON_OFFSETS.level, 50);
  u16(playerBase + BATTLEMON_OFFSETS.hp, opts.playerHp ?? 80);
  u16(playerBase + BATTLEMON_OFFSETS.maxHp, opts.playerMaxHp ?? 100);
  u16(opponentBase + BATTLEMON_OFFSETS.species, opts.opponentSpecies ?? 6);
  u8(opponentBase + BATTLEMON_OFFSETS.level, 55);
  u16(opponentBase + BATTLEMON_OFFSETS.hp, 120);
  u16(opponentBase + BATTLEMON_OFFSETS.maxHp, 150);
  return {
    forceAutoSaveState: () => true,
    getAutoSaveState: () => ({
      autoSaveStateName: '/autosave/0',
      data: blob,
    }),
    uploadAutoSaveState: async () => undefined,
    loadAutoSaveState: () => true,
    pauseGame: () => undefined,
    resumeGame: () => undefined,
  };
}

afterEach(() => {
  cleanup();
});

describe('HudOverlay', () => {
  it('renders nothing when disabled', () => {
    const { container } = render(
      <HudOverlay host={buildHost()} emulatorActive enabled={false} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when the emulator is not active', () => {
    const { container } = render(
      <HudOverlay host={buildHost()} emulatorActive={false} enabled />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders the empty-state hint while no battle has been detected yet', () => {
    render(<HudOverlay host={null} emulatorActive enabled />);
    expect(
      screen.getByText(/Battle HUD on - waiting for an active battle/i),
    ).toBeInTheDocument();
  });

  it('renders player + opponent cards once the poll resolves', async () => {
    render(
      <HudOverlay host={buildHost()} emulatorActive enabled />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('hud-overlay-player')).toBeInTheDocument();
      expect(screen.getByTestId('hud-overlay-opponent')).toBeInTheDocument();
    });
  });

  it('HP percent maps to the bar fill width', async () => {
    render(
      <HudOverlay
        host={buildHost({ playerHp: 25, playerMaxHp: 100 })}
        emulatorActive
        enabled
      />,
    );
    await waitFor(() => {
      const bar = screen.getByTestId('hud-overlay-player-bar');
      expect(bar.getAttribute('data-percent')).toBe('25');
    });
  });

  it('clicking a card calls onMonsterClick with species + side', async () => {
    const onClick = vi.fn();
    render(
      <HudOverlay
        host={buildHost({ playerSpecies: 25, opponentSpecies: 6 })}
        emulatorActive
        enabled
        onMonsterClick={onClick}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('hud-overlay-player')).toBeInTheDocument();
    });
    act(() => {
      screen.getByTestId('hud-overlay-player').click();
      screen.getByTestId('hud-overlay-opponent').click();
    });
    expect(onClick).toHaveBeenCalledTimes(2);
    expect(onClick).toHaveBeenCalledWith(25, 'player');
    expect(onClick).toHaveBeenCalledWith(6, 'opponent');
  });
});
