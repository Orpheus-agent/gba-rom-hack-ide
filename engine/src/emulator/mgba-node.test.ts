/**
 * Phase 9A - mgba-node tests.
 *
 * We can't boot a real ROM here (Worker shim is a follow-up). What
 * we CAN verify: the public surface, the EmulatorUnavailableError
 * shape, and the probe behavior.
 */

import { describe, expect, it } from 'vitest';
import {
  EmulatorUnavailableError,
  createEmulator,
  probeEmulatorAvailability,
} from './index.js';

describe('emulator/mgba-node (Phase 9A scaffold)', () => {
  describe('probeEmulatorAvailability', () => {
    it('returns a structured verdict object', () => {
      const verdict = probeEmulatorAvailability();
      expect(typeof verdict.available).toBe('boolean');
      if (!verdict.available) {
        expect(typeof verdict.reason).toBe('string');
        expect(typeof verdict.hint).toBe('string');
      }
    });

    it('reports available=true on Node (post-9A-2 Worker shim makes this reachable)', () => {
      // Phase 9A-2: Worker shim makes Node a viable host. The probe
      // now returns { available: true } whenever we're on Node or a
      // browser, even if no global Worker exists yet (the shim
      // installs lazily inside createEmulator()).
      const verdict = probeEmulatorAvailability();
      expect(verdict.available).toBe(true);
    });
  });

  describe('createEmulator', () => {
    it('throws EmulatorUnavailableError with a typed code when the boot times out', async () => {
      // Phase 9A-2 ships the Worker shim + WASM-binary preload, so
      // the boot actually starts. The full PThread handshake is the
      // next follow-up; until it lands, the boot eventually times
      // out. We pin the boot-timeout behavior here so the typed
      // error path is exercised even when the live boot succeeds in
      // a future commit.
      try {
        await createEmulator({ bootTimeoutMs: 100 });
        // If the live boot completes within 100ms (it shouldn't - 
        // mGBA's PThread pool init takes >1s), the test fails
        // loudly so we know the contract drifted.
        expect.fail(
          'createEmulator() unexpectedly resolved within 100ms. ' +
            'Either the boot got dramatically faster (good!) or the ' +
            'timeout enforcement broke (bad).',
        );
      } catch (e) {
        expect(e).toBeInstanceOf(EmulatorUnavailableError);
        const err = e as EmulatorUnavailableError;
        // Either boot_timeout (PThread handshake never finishes) or
        // no_wasm (in environments without the npm package) or
        // shim_init_failed (DOM shims fail). All are valid typed
        // codes.
        expect(['boot_timeout', 'no_wasm', 'shim_init_failed', 'no_worker']).toContain(err.code);
        expect(err.message.length).toBeGreaterThan(0);
        expect(err.hint.length).toBeGreaterThan(0);
      }
    }, 30_000);

    it('has the EmulatorUnavailableError shape required by callers', () => {
      const err = new EmulatorUnavailableError('no_worker', 'test', 'test hint');
      expect(err.name).toBe('EmulatorUnavailableError');
      expect(err.code).toBe('no_worker');
      expect(err.hint).toBe('test hint');
      expect(err.message).toBe('test');
      expect(err instanceof Error).toBe(true);
    });
  });
});
