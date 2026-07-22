/**
 * Phase 9A-2 - Worker shim tests.
 *
 * Verify the BrowserWorker class installed on globalThis adapts
 * Node worker_threads to the browser Worker API the Emscripten
 * runtime expects.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { installWorkerShim } from './worker-shim.js';

describe('emulator/worker-shim', () => {
  let restore: (() => void) | null = null;
  afterEach(() => {
    restore?.();
    restore = null;
  });

  it('installs a Worker constructor on globalThis when none exists', () => {
    const g = globalThis as unknown as Record<string, unknown>;
    const hadWorker = 'Worker' in g;
    if (hadWorker) {
      // Already exists (e.g. dom env) - shim should no-op.
      restore = installWorkerShim();
      expect(typeof g.Worker).toBe('function');
      return;
    }
    expect(g.Worker).toBeUndefined();
    restore = installWorkerShim();
    expect(typeof g.Worker).toBe('function');
  });

  it('no-ops when Worker is already a function (e.g. browser env)', () => {
    const g = globalThis as unknown as Record<string, unknown>;
    const hadWorker = 'Worker' in g;
    const prev = g.Worker;
    // Use a function sentinel - the shim only no-ops when the
    // existing Worker is callable (which a browser-native Worker is).
    function SentinelWorker(): void {
      /* no-op */
    }
    if (!hadWorker) {
      g.Worker = SentinelWorker;
    }
    try {
      restore = installWorkerShim();
      if (!hadWorker) {
        // The function sentinel should still be in place.
        expect(g.Worker).toBe(SentinelWorker);
      } else {
        expect(g.Worker).toBe(prev);
      }
    } finally {
      if (!hadWorker) delete g.Worker;
    }
  });

  it('restore() removes the shim when no Worker was present before', () => {
    const g = globalThis as unknown as Record<string, unknown>;
    if ('Worker' in g) {
      // Skip - pre-existing Worker means no install happened.
      return;
    }
    restore = installWorkerShim();
    expect('Worker' in g).toBe(true);
    restore();
    restore = null;
    expect('Worker' in g).toBe(false);
  });
});
