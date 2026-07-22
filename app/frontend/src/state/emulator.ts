/**
 * WP-B v2.3 - Reactive emulator state slice.
 *
 * Lifts the EmulatorHost's local "is the emulator running, and what's
 * its module handle" state into a Zustand store so sibling components
 * (notably the DebugMenu overlay) can SUBSCRIBE to it instead of
 * polling getActiveEmulatorModule() on every render.
 *
 * Coexists with the existing getActiveEmulatorModule() singleton from
 * EmulatorHost.tsx - the singleton is the source of truth for callers
 * who need direct access; this slice is the reactive mirror that lets
 * React components re-render when the emulator boots / pauses / quits.
 */

import { create } from 'zustand';
import type { EmulatorMemoryHost } from '../lib/emulatorMemory';

/** Public emulator state. Discriminated by `kind` so DebugMenu can
 *  show "Boot the game first" vs "Press Start to reach the title
 *  screen" vs the live form panel without ad-hoc null checks. */
export type EmulatorPublicState =
  | { readonly kind: 'idle' }
  | {
      readonly kind: 'running';
      /** The mgba-wasm Module handle. EmulatorMemoryHost is a subset
       *  of the full EmulatorInstance - covers the four savestate
       *  methods the memory bridge needs. */
      readonly module: EmulatorMemoryHost;
    }
  | { readonly kind: 'paused'; readonly module: EmulatorMemoryHost };

interface EmulatorStoreState {
  readonly state: EmulatorPublicState;
  /** Called by EmulatorHost when the emulator boots successfully. */
  setRunning: (module: EmulatorMemoryHost) => void;
  /** Called by EmulatorHost when the user pauses the emulator. The
   *  module stays available so debug actions can still write while
   *  paused (in fact that's the SAFER write window - no race with
   *  the running frame). */
  setPaused: (module: EmulatorMemoryHost) => void;
  /** Called by EmulatorHost when the emulator quits / errors / the
   *  Play button toggles off. */
  setIdle: () => void;
  /** One-shot request to Build & Play, set by the top-level header
   *  button. EmulatorHost consumes it on mount/update so the action
   *  works even when the preview view wasn't mounted at click time. */
  readonly pendingBuildPlay: boolean;
  requestBuildPlay: () => void;
  consumeBuildPlay: () => void;
}

export const useEmulatorStore = create<EmulatorStoreState>((set) => ({
  state: { kind: 'idle' },
  setRunning(module) {
    set({ state: { kind: 'running', module } });
  },
  setPaused(module) {
    set({ state: { kind: 'paused', module } });
  },
  setIdle() {
    set({ state: { kind: 'idle' } });
  },
  pendingBuildPlay: false,
  requestBuildPlay() {
    set({ pendingBuildPlay: true });
  },
  consumeBuildPlay() {
    set({ pendingBuildPlay: false });
  },
}));
