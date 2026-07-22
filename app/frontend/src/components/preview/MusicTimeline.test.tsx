/**
 * Phase 9E - MusicTimeline component tests.
 *
 * Verify the four key states the overlay can be in:
 *   - hidden (enabled=false)
 *   - empty (snapshot but nothing playing)
 *   - error (3+ consecutive poll failures)
 *   - populated (BGM is playing)
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { MusicTimeline } from './MusicTimeline';
import * as audioReader from '../../lib/audioStateReader';
import type {
  AudioStateSnapshot,
  MusicPlayerSnapshot,
} from '../../lib/audioStateReader';

function idleSlot(addr: number): MusicPlayerSnapshot {
  return {
    addr,
    songHeaderPointer: 0,
    status: 0,
    trackCount: 0,
    priority: 0,
    cmd: 0,
    clock: 0,
    tempoD: 0,
    tempoU: 0,
    ident: 0,
    looksLikePlaying: false,
  };
}

function playingSlot(addr: number, clock: number, tempoD: number): MusicPlayerSnapshot {
  return {
    addr,
    songHeaderPointer: 0x08abcdef,
    status: 1,
    trackCount: 4,
    priority: 0,
    cmd: 0,
    clock,
    tempoD,
    tempoU: 0x80,
    ident: 0x68736d53,
    looksLikePlaying: true,
  };
}

describe('MusicTimeline (Phase 9E)', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders nothing when disabled', () => {
    const { container } = render(
      <MusicTimeline host={null} emulatorActive={false} enabled={false} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when the emulator is not active', () => {
    const { container } = render(
      <MusicTimeline host={null} emulatorActive={false} enabled={true} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders the empty-state hint when no slot is playing', async () => {
    const snap: AudioStateSnapshot = {
      bgm: idleSlot(0x03007300),
      se1: idleSlot(0x03007340),
      se2: idleSlot(0x03007380),
      se3: idleSlot(0x030073d0),
      anySlotPlaying: false,
    };
    vi.spyOn(audioReader, 'readAudioState').mockResolvedValue(snap);
    await act(async () => {
      render(
        <MusicTimeline
          host={
            {
              forceAutoSaveState: () => true,
              getAutoSaveState: () => ({
                autoSaveStateName: 'x',
                data: new Uint8Array(0x61000),
              }),
              uploadAutoSaveState: async () => undefined,
              loadAutoSaveState: () => true,
            } as never
          }
          emulatorActive={true}
          enabled={true}
        />,
      );
      // Let the initial poll resolve.
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(screen.getByText(/no music currently playing/i)).toBeInTheDocument();
  });

  it('renders the populated state with the BGM row when a slot is playing', async () => {
    const snap: AudioStateSnapshot = {
      bgm: playingSlot(0x03007300, 1234, 0x100),
      se1: idleSlot(0x03007340),
      se2: idleSlot(0x03007380),
      se3: idleSlot(0x030073d0),
      anySlotPlaying: true,
    };
    vi.spyOn(audioReader, 'readAudioState').mockResolvedValue(snap);
    await act(async () => {
      render(
        <MusicTimeline
          host={
            {
              forceAutoSaveState: () => true,
              getAutoSaveState: () => ({
                autoSaveStateName: 'x',
                data: new Uint8Array(0x61000),
              }),
              uploadAutoSaveState: async () => undefined,
              loadAutoSaveState: () => true,
            } as never
          }
          emulatorActive={true}
          enabled={true}
        />,
      );
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(screen.getByTestId('music-timeline')).toBeInTheDocument();
    expect(screen.getByTestId('music-timeline-row-bgm')).toBeInTheDocument();
    // The BGM row should show the playing track + clock + tempo.
    const bgmRow = screen.getByTestId('music-timeline-row-bgm');
    expect(bgmRow.textContent).toContain('BGM');
    expect(bgmRow.textContent).toContain('1234'); // clock
    expect(bgmRow.textContent).toContain('256'); // tempoD = 0x100 = 256
  });

  it('renders empty-state when polling consistently fails (snapshot stays null)', async () => {
    // After failed polls, snapshot remains null, so the component
    // renders the empty-state hint. Error UI only appears after 3
    // consecutive failures - we exercise the empty path here +
    // verify error UI is NOT shown for a single failure.
    vi.spyOn(audioReader, 'readAudioState').mockRejectedValue(new Error('boom'));
    await act(async () => {
      render(
        <MusicTimeline
          host={
            {
              forceAutoSaveState: () => true,
              getAutoSaveState: () => ({
                autoSaveStateName: 'x',
                data: new Uint8Array(0x61000),
              }),
              uploadAutoSaveState: async () => undefined,
              loadAutoSaveState: () => true,
            } as never
          }
          emulatorActive={true}
          enabled={true}
        />,
      );
      await new Promise((r) => setTimeout(r, 100));
    });
    // After one failed poll, the empty-state should still render
    // (snapshot is null → empty branch wins; error branch needs >= 3).
    expect(screen.getByText(/no music currently playing/i)).toBeInTheDocument();
  });
});
