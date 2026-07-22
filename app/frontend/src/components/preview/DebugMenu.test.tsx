/**
 * WP-B v2.4 - End-to-end test for the debug menu.
 *
 * Each test mounts <DebugMenu>, seeds the reactive emulator slice
 * with a fake mgba host (a 397312-byte savestate buffer + planted
 * IWRAM SaveBlock pointers), simulates a user clicking through the
 * menu, and verifies that the expected bytes land in the savestate
 * buffer. This catches the "UI calls API but bytes never reach the
 * emulator" class of bug across the entire chain:
 *   DebugMenu → savedataResolver → EmulatorMemory → host methods → bytes
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, act, waitFor } from '@testing-library/react';
import { DebugMenu } from './DebugMenu';
import { useEmulatorStore } from '../../state/emulator';
import { useProjectStore, useToastStore } from '../../state';
import {
  SAVESTATE_TOTAL_SIZE,
  SAVESTATE_EWRAM_OFFSET,
  SAVESTATE_IWRAM_OFFSET,
  type EmulatorMemoryHost,
} from '../../lib/emulatorMemory';
import type { ProjectOpenResponse } from '@rom-editor/shared';

/** Build a fake mgba host backed by a 397312-byte savestate buffer.
 *  Returns the host + a `bufferRef` whose .buffer field always
 *  points at the LATEST committed savestate bytes (so tests can
 *  inspect post-write state). */
function makeFakeHost(): {
  host: EmulatorMemoryHost;
  bufferRef: { buffer: Uint8Array };
} {
  const state = { buffer: new Uint8Array(SAVESTATE_TOTAL_SIZE) };
  let staged: Uint8Array | null = null;
  const host: EmulatorMemoryHost = {
    forceAutoSaveState: () => true,
    getAutoSaveState: () => ({
      autoSaveStateName: '/data/autosave/fake.ssm',
      data: new Uint8Array(state.buffer),
    }),
    uploadAutoSaveState: async (_name, data) => {
      staged = new Uint8Array(data);
    },
    loadAutoSaveState: () => {
      if (staged) {
        state.buffer = staged;
        staged = null;
      }
      return true;
    },
  };
  return { host, bufferRef: state };
}

function plantU32LE(buf: Uint8Array, savestateOffset: number, val: number): void {
  buf[savestateOffset + 0] = val & 0xff;
  buf[savestateOffset + 1] = (val >>> 8) & 0xff;
  buf[savestateOffset + 2] = (val >>> 16) & 0xff;
  buf[savestateOffset + 3] = (val >>> 24) & 0xff;
}

/** Pre-seed the FRLG IWRAM SaveBlock pointers + return the SB bases. */
function seedFrlgSaveBlocks(buf: Uint8Array): { sb1Base: number; sb2Base: number } {
  const sb1Base = 0x02024284;
  const sb2Base = 0x02025838;
  // gSaveBlock1Ptr @ 0x03005008 in IWRAM
  plantU32LE(buf, SAVESTATE_IWRAM_OFFSET + 0x5008, sb1Base);
  // gSaveBlock2Ptr @ 0x0300500C in IWRAM
  plantU32LE(buf, SAVESTATE_IWRAM_OFFSET + 0x500c, sb2Base);
  return { sb1Base, sb2Base };
}

function ewramSavestateOffset(gbaAddr: number): number {
  return SAVESTATE_EWRAM_OFFSET + (gbaAddr - 0x02000000);
}

const FAKE_FRLG_SESSION: ProjectOpenResponse = {
  session: {
    id: 'sess-1',
    projectRoot: '/abs/test',
    openedAtUtc: '2026-05-26T00:00:00Z',
  },
  rootListing: { path: '', entries: [] },
  identity: {
    kind: 'patch',
    confidence: 1,
    displayName: 'FireRed',
    baseGame: 'pokefirered',
    fork: null,
    featureFlags: [],
    warnings: [],
    evidence: [],
  },
};

const FAKE_DECOMP_OF_UNKNOWN_FAMILY: ProjectOpenResponse = {
  session: { id: 'sess-x', projectRoot: '/abs/x', openedAtUtc: '2026-05-26T00:00:00Z' },
  rootListing: { path: '', entries: [] },
  identity: {
    kind: 'decomp',
    confidence: 1,
    displayName: 'custom rom',
    baseGame: null, // unsupported
    fork: null,
    featureFlags: [],
    warnings: [],
    evidence: [],
  },
};

describe('DebugMenu - gating', () => {
  beforeEach(() => {
    useEmulatorStore.setState({ state: { kind: 'idle' } });
    useProjectStore.setState({ load: { kind: 'empty' } } as never);
    useToastStore.setState({ toasts: [] });
  });
  afterEach(() => cleanup());

  it('renders the toggle button + nothing else when closed', () => {
    render(<DebugMenu />);
    expect(screen.getByTestId('debug-menu-toggle')).toBeInTheDocument();
    expect(screen.queryByTestId('debug-menu-panel')).not.toBeInTheDocument();
  });

  it('clicking the toggle opens the panel; clicking close hides it', () => {
    render(<DebugMenu />);
    fireEvent.click(screen.getByTestId('debug-menu-toggle'));
    expect(screen.getByTestId('debug-menu-panel')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('debug-menu-close'));
    expect(screen.queryByTestId('debug-menu-panel')).not.toBeInTheDocument();
  });

  it('F9 keypress toggles the panel open + closed', () => {
    render(<DebugMenu />);
    fireEvent.keyDown(window, { key: 'F9' });
    expect(screen.getByTestId('debug-menu-panel')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'F9' });
    expect(screen.queryByTestId('debug-menu-panel')).not.toBeInTheDocument();
  });

  it('Escape closes the open panel', () => {
    render(<DebugMenu />);
    fireEvent.click(screen.getByTestId('debug-menu-toggle'));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('debug-menu-panel')).not.toBeInTheDocument();
  });

  it('shows "Boot the game first" hint when the emulator is idle', () => {
    render(<DebugMenu />);
    fireEvent.click(screen.getByTestId('debug-menu-toggle'));
    expect(screen.getByTestId('debug-menu-hint-no-emulator')).toBeInTheDocument();
  });

  it('shows "unsupported family" hint when the project identity is not FRLG/Emerald', () => {
    const { host } = makeFakeHost();
    useEmulatorStore.setState({ state: { kind: 'running', module: host } });
    useProjectStore.setState({
      load: { kind: 'loaded', data: FAKE_DECOMP_OF_UNKNOWN_FAMILY },
    } as never);
    render(<DebugMenu />);
    fireEvent.click(screen.getByTestId('debug-menu-toggle'));
    expect(screen.getByTestId('debug-menu-hint-unsupported')).toBeInTheDocument();
  });
});

describe('DebugMenu - Field tab (flags + vars)', () => {
  beforeEach(() => {
    useEmulatorStore.setState({ state: { kind: 'idle' } });
    useProjectStore.setState({ load: { kind: 'empty' } } as never);
    useToastStore.setState({ toasts: [] });
  });
  afterEach(() => cleanup());

  it('"Set flag 0x820" writes bit 0 of FRLG SaveBlock1 flagsArray byte 0x104', async () => {
    const { host, bufferRef } = makeFakeHost();
    const { sb1Base } = seedFrlgSaveBlocks(bufferRef.buffer);
    useEmulatorStore.setState({ state: { kind: 'running', module: host } });
    useProjectStore.setState({
      load: { kind: 'loaded', data: FAKE_FRLG_SESSION },
    } as never);
    render(<DebugMenu />);
    fireEvent.click(screen.getByTestId('debug-menu-toggle'));
    fireEvent.click(screen.getByTestId('debug-menu-tab-field'));
    fireEvent.change(screen.getByTestId('debug-menu-flag-id'), {
      target: { value: '0x820' },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('debug-menu-flag-set'));
    });
    await waitFor(() => {
      // Flag 0x820 → byte 0x820/8 = 0x104, bit 0
      const flagByteOffset = ewramSavestateOffset(sb1Base + 0x0ee0 + 0x104);
      expect(bufferRef.buffer[flagByteOffset]).toBe(0x01);
    });
  });

  it('"Clear flag" zeros the bit', async () => {
    const { host, bufferRef } = makeFakeHost();
    const { sb1Base } = seedFrlgSaveBlocks(bufferRef.buffer);
    // Pre-set the bit so we can verify clear.
    const flagByteOffset = ewramSavestateOffset(sb1Base + 0x0ee0 + 0x104);
    bufferRef.buffer[flagByteOffset] = 0x01;
    useEmulatorStore.setState({ state: { kind: 'running', module: host } });
    useProjectStore.setState({
      load: { kind: 'loaded', data: FAKE_FRLG_SESSION },
    } as never);
    render(<DebugMenu />);
    fireEvent.click(screen.getByTestId('debug-menu-toggle'));
    fireEvent.click(screen.getByTestId('debug-menu-tab-field'));
    fireEvent.change(screen.getByTestId('debug-menu-flag-id'), {
      target: { value: '0x820' },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('debug-menu-flag-clear'));
    });
    await waitFor(() => {
      expect(bufferRef.buffer[flagByteOffset]).toBe(0);
    });
  });

  it('"Set var 0x4002 → 0xABCD" writes LE bytes at SB1 0x1000 + 4', async () => {
    const { host, bufferRef } = makeFakeHost();
    const { sb1Base } = seedFrlgSaveBlocks(bufferRef.buffer);
    useEmulatorStore.setState({ state: { kind: 'running', module: host } });
    useProjectStore.setState({
      load: { kind: 'loaded', data: FAKE_FRLG_SESSION },
    } as never);
    render(<DebugMenu />);
    fireEvent.click(screen.getByTestId('debug-menu-toggle'));
    fireEvent.click(screen.getByTestId('debug-menu-tab-field'));
    fireEvent.change(screen.getByTestId('debug-menu-var-id'), {
      target: { value: '0x4002' },
    });
    fireEvent.change(screen.getByTestId('debug-menu-var-value'), {
      target: { value: '0xABCD' },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('debug-menu-var-set'));
    });
    await waitFor(() => {
      const varOff = ewramSavestateOffset(sb1Base + 0x1000 + 4);
      expect(bufferRef.buffer[varOff]).toBe(0xcd);
      expect(bufferRef.buffer[varOff + 1]).toBe(0xab);
    });
  });
});

describe('DebugMenu - Player tab (name + badges)', () => {
  beforeEach(() => {
    useEmulatorStore.setState({ state: { kind: 'idle' } });
    useProjectStore.setState({ load: { kind: 'empty' } } as never);
    useToastStore.setState({ toasts: [] });
  });
  afterEach(() => cleanup());

  it('clicking "Load current player data" reads from the savestate', async () => {
    const { host, bufferRef } = makeFakeHost();
    const { sb2Base } = seedFrlgSaveBlocks(bufferRef.buffer);
    // Plant gender=female at SB2 0x008.
    bufferRef.buffer[ewramSavestateOffset(sb2Base + 0x008)] = 1;
    useEmulatorStore.setState({ state: { kind: 'running', module: host } });
    useProjectStore.setState({
      load: { kind: 'loaded', data: FAKE_FRLG_SESSION },
    } as never);
    render(<DebugMenu />);
    fireEvent.click(screen.getByTestId('debug-menu-toggle'));
    fireEvent.click(screen.getByTestId('debug-menu-tab-player'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('debug-menu-player-load'));
    });
    await waitFor(() => {
      expect(screen.getByTestId('debug-menu-player-gender')).toHaveValue('female');
    });
  });

  it('changing badges + clicking Save writes the flag bits', async () => {
    const { host, bufferRef } = makeFakeHost();
    const { sb1Base } = seedFrlgSaveBlocks(bufferRef.buffer);
    useEmulatorStore.setState({ state: { kind: 'running', module: host } });
    useProjectStore.setState({
      load: { kind: 'loaded', data: FAKE_FRLG_SESSION },
    } as never);
    render(<DebugMenu />);
    fireEvent.click(screen.getByTestId('debug-menu-toggle'));
    fireEvent.click(screen.getByTestId('debug-menu-tab-player'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('debug-menu-player-load'));
    });
    await waitFor(() =>
      expect(screen.getByTestId('debug-menu-player-badge-0')).toBeInTheDocument(),
    );
    // Tick all 8 badges.
    for (let i = 0; i < 8; i++) {
      fireEvent.click(screen.getByTestId(`debug-menu-player-badge-${i}`));
    }
    await act(async () => {
      fireEvent.click(screen.getByTestId('debug-menu-player-save'));
    });
    await waitFor(() => {
      // FRLG badge flag ids are 0x820..0x827.
      // 0x820/8 = 0x104, all bits 0..7 set → 0xFF
      const badgesByteOffset = ewramSavestateOffset(sb1Base + 0x0ee0 + 0x104);
      expect(bufferRef.buffer[badgesByteOffset]).toBe(0xff);
    });
  });
});

describe('DebugMenu - Party tab', () => {
  beforeEach(() => {
    useEmulatorStore.setState({ state: { kind: 'idle' } });
    useProjectStore.setState({ load: { kind: 'empty' } } as never);
    useToastStore.setState({ toasts: [] });
  });
  afterEach(() => cleanup());

  it('"Heal party" sets HP=maxHP + status=0 on every occupied slot', async () => {
    const { host, bufferRef } = makeFakeHost();
    const { sb1Base } = seedFrlgSaveBlocks(bufferRef.buffer);
    // Seed slot 0 with PID=1, hp=5, maxHP=42, status=0x02
    const partyBase = ewramSavestateOffset(sb1Base + 0x038);
    bufferRef.buffer[partyBase + 0] = 1; // PID byte 0
    bufferRef.buffer[partyBase + 0x50] = 0x02; // status
    bufferRef.buffer[partyBase + 0x56] = 5; // hp
    bufferRef.buffer[partyBase + 0x58] = 42; // maxHP
    useEmulatorStore.setState({ state: { kind: 'running', module: host } });
    useProjectStore.setState({
      load: { kind: 'loaded', data: FAKE_FRLG_SESSION },
    } as never);
    render(<DebugMenu />);
    fireEvent.click(screen.getByTestId('debug-menu-toggle'));
    fireEvent.click(screen.getByTestId('debug-menu-tab-party'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('debug-menu-party-heal'));
    });
    await waitFor(() => {
      // After heal: status=0, hp=42 (=maxHP).
      expect(bufferRef.buffer[partyBase + 0x50]).toBe(0);
      expect(bufferRef.buffer[partyBase + 0x56]).toBe(42);
    });
  });
});

describe('DebugMenu - Help tab', () => {
  beforeEach(() => {
    useEmulatorStore.setState({ state: { kind: 'idle' } });
    useProjectStore.setState({ load: { kind: 'empty' } } as never);
    useToastStore.setState({ toasts: [] });
  });
  afterEach(() => cleanup());

  it('renders help text with the F9 + category descriptions', () => {
    const { host } = makeFakeHost();
    useEmulatorStore.setState({ state: { kind: 'running', module: host } });
    useProjectStore.setState({
      load: { kind: 'loaded', data: FAKE_FRLG_SESSION },
    } as never);
    render(<DebugMenu />);
    fireEvent.click(screen.getByTestId('debug-menu-toggle'));
    fireEvent.click(screen.getByTestId('debug-menu-tab-help'));
    const help = screen.getByTestId('debug-menu-help-form');
    expect(help.textContent).toMatch(/Field/);
    expect(help.textContent).toMatch(/Player/);
    expect(help.textContent).toMatch(/F9/);
  });
});

describe('DebugMenu - Live state tab (Phase 4.1D)', () => {
  beforeEach(() => {
    useEmulatorStore.setState({ state: { kind: 'idle' } });
    useProjectStore.setState({ load: { kind: 'empty' } } as never);
    useToastStore.setState({ toasts: [] });
    window.localStorage.clear();
  });
  afterEach(() => cleanup());

  it('renders the Live state tab button + its empty state', () => {
    const { host, bufferRef } = makeFakeHost();
    seedFrlgSaveBlocks(bufferRef.buffer);
    useEmulatorStore.setState({ state: { kind: 'running', module: host } });
    useProjectStore.setState({
      load: { kind: 'loaded', data: FAKE_FRLG_SESSION },
    } as never);
    render(<DebugMenu />);
    fireEvent.click(screen.getByTestId('debug-menu-toggle'));
    expect(screen.getByTestId('debug-menu-tab-live')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('debug-menu-tab-live'));
    expect(screen.getByTestId('debug-menu-live-form')).toBeInTheDocument();
    expect(screen.getByTestId('debug-menu-live-empty')).toBeInTheDocument();
  });

  it('adds a flag id to the watchlist + lists it in the watch panel', async () => {
    const { host, bufferRef } = makeFakeHost();
    seedFrlgSaveBlocks(bufferRef.buffer);
    useEmulatorStore.setState({ state: { kind: 'running', module: host } });
    useProjectStore.setState({
      load: { kind: 'loaded', data: FAKE_FRLG_SESSION },
    } as never);
    render(<DebugMenu />);
    fireEvent.click(screen.getByTestId('debug-menu-toggle'));
    fireEvent.click(screen.getByTestId('debug-menu-tab-live'));
    fireEvent.change(screen.getByTestId('debug-menu-live-add-id'), {
      target: { value: '0x820' },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('debug-menu-live-add-btn'));
    });
    await waitFor(() => {
      expect(screen.getByTestId('debug-menu-live-item-flag-2080')).toBeInTheDocument();
    });
  });

  it('persists the watchlist to localStorage', async () => {
    const { host, bufferRef } = makeFakeHost();
    seedFrlgSaveBlocks(bufferRef.buffer);
    useEmulatorStore.setState({ state: { kind: 'running', module: host } });
    useProjectStore.setState({
      load: { kind: 'loaded', data: FAKE_FRLG_SESSION },
    } as never);
    render(<DebugMenu />);
    fireEvent.click(screen.getByTestId('debug-menu-toggle'));
    fireEvent.click(screen.getByTestId('debug-menu-tab-live'));
    fireEvent.change(screen.getByTestId('debug-menu-live-add-id'), {
      target: { value: '0x100' },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('debug-menu-live-add-btn'));
    });
    await waitFor(() => {
      const stored = window.localStorage.getItem('rom-editor:debug-menu:watchlist');
      expect(stored).toBeTruthy();
      const parsed = JSON.parse(stored!) as Array<{ kind: string; id: number }>;
      expect(parsed).toContainEqual({ kind: 'flag', id: 0x100 });
    });
  });

  it('Pause polling toggles the button label', () => {
    const { host, bufferRef } = makeFakeHost();
    seedFrlgSaveBlocks(bufferRef.buffer);
    useEmulatorStore.setState({ state: { kind: 'running', module: host } });
    useProjectStore.setState({
      load: { kind: 'loaded', data: FAKE_FRLG_SESSION },
    } as never);
    render(<DebugMenu />);
    fireEvent.click(screen.getByTestId('debug-menu-toggle'));
    fireEvent.click(screen.getByTestId('debug-menu-tab-live'));
    const toggle = screen.getByTestId('debug-menu-live-toggle-poll');
    expect(toggle.textContent).toMatch(/Pause/);
    fireEvent.click(toggle);
    expect(toggle.textContent).toMatch(/Resume/);
  });
});
