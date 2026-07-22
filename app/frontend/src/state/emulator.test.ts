import { beforeEach, describe, expect, it } from 'vitest';
import { useEmulatorStore } from './emulator';
import type { EmulatorMemoryHost } from '../lib/emulatorMemory';

const fakeHost: EmulatorMemoryHost = {
  forceAutoSaveState: () => true,
  getAutoSaveState: () => null,
  uploadAutoSaveState: async () => {},
  loadAutoSaveState: () => true,
};

describe('useEmulatorStore', () => {
  beforeEach(() => {
    useEmulatorStore.setState({ state: { kind: 'idle' } });
  });

  it('starts in the idle state', () => {
    expect(useEmulatorStore.getState().state.kind).toBe('idle');
  });

  it('setRunning(module) transitions to running and exposes the module', () => {
    useEmulatorStore.getState().setRunning(fakeHost);
    const s = useEmulatorStore.getState().state;
    expect(s.kind).toBe('running');
    if (s.kind === 'running') expect(s.module).toBe(fakeHost);
  });

  it('setPaused(module) transitions to paused', () => {
    useEmulatorStore.getState().setPaused(fakeHost);
    const s = useEmulatorStore.getState().state;
    expect(s.kind).toBe('paused');
    if (s.kind === 'paused') expect(s.module).toBe(fakeHost);
  });

  it('setIdle() transitions back to idle (module no longer reachable)', () => {
    useEmulatorStore.getState().setRunning(fakeHost);
    useEmulatorStore.getState().setIdle();
    expect(useEmulatorStore.getState().state.kind).toBe('idle');
  });

  it('running → paused → running cycle preserves the module reference', () => {
    useEmulatorStore.getState().setRunning(fakeHost);
    useEmulatorStore.getState().setPaused(fakeHost);
    useEmulatorStore.getState().setRunning(fakeHost);
    const s = useEmulatorStore.getState().state;
    if (s.kind === 'running') expect(s.module).toBe(fakeHost);
    else throw new Error('expected running');
  });
});
