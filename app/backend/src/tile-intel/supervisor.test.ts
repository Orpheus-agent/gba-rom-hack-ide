/**
 * Phase 8A-4 - Tile-intel supervisor unit tests.
 *
 * Uses the in-process mock fetch from __mocks__/sidecar.ts to test
 * the supervisor's state machine without touching real Python /
 * Postgres / Qdrant. The spawn function is also injected - for
 * "attach existing sidecar" tests, the spawn function should never
 * be invoked.
 */

import { describe, expect, it, vi } from 'vitest';
import { TileIntelSupervisor } from './supervisor.js';
import { createMockSidecarFetch, createUnreachableFetch } from './__mocks__/sidecar.js';

function fakeSpawn() {
  return vi.fn(() => {
    throw new Error(
      'spawn should not have been invoked when a sidecar is already reachable',
    );
  }) as never;
}

describe('TileIntelSupervisor', () => {
  it('attaches to a running sidecar without spawning anything', async () => {
    const spawnFn = fakeSpawn();
    const supervisor = new TileIntelSupervisor({
      sidecarRoot: 'C:/does/not/matter',
      spawnFn,
      fetchFn: createMockSidecarFetch(),
    });
    const status = await supervisor.ensureReady();
    expect(status.available).toBe(true);
    if (status.available) {
      expect(status.health.api_version).toBe(1);
      expect(status.version.test_mode).toBe(false);
    }
    expect(spawnFn).not.toHaveBeenCalled();
    await supervisor.shutdown();
  });

  it('caches ready state across concurrent callers', async () => {
    let healthCalls = 0;
    const fetchFn = (input: string) => {
      healthCalls += 1;
      return createMockSidecarFetch()(input, undefined);
    };
    const supervisor = new TileIntelSupervisor({
      sidecarRoot: 'C:/does/not/matter',
      spawnFn: fakeSpawn(),
      fetchFn,
    });
    const [a, b, c] = await Promise.all([
      supervisor.ensureReady(),
      supervisor.ensureReady(),
      supervisor.ensureReady(),
    ]);
    expect(a.available).toBe(true);
    expect(b.available).toBe(true);
    expect(c.available).toBe(true);
    // Only one /health + /v1/version cycle for three callers.
    // (Health call from probeOnce + version call from consolidateReady)
    expect(healthCalls).toBeLessThanOrEqual(2);
    await supervisor.shutdown();
  });

  it('attachOnly=true + unreachable sidecar surfaces sidecar_offline', async () => {
    const supervisor = new TileIntelSupervisor({
      sidecarRoot: 'C:/does/not/matter',
      attachOnly: true,
      spawnFn: fakeSpawn(),
      fetchFn: createUnreachableFetch(),
    });
    const status = await supervisor.ensureReady();
    expect(status.available).toBe(false);
    if (!status.available) {
      expect(status.reason).toBe('sidecar_offline');
    }
    await supervisor.shutdown();
  });

  it('detects api_version mismatch and refuses readiness', async () => {
    const supervisor = new TileIntelSupervisor({
      sidecarRoot: 'C:/does/not/matter',
      spawnFn: fakeSpawn(),
      fetchFn: createMockSidecarFetch({ apiVersion: 99 }),
    });
    const status = await supervisor.ensureReady();
    expect(status.available).toBe(false);
    if (!status.available && status.reason === 'version_mismatch') {
      expect(status.expected).toBe(1);
      expect(status.observed).toBe(99);
    } else {
      throw new Error(`expected version_mismatch, got ${JSON.stringify(status)}`);
    }
    await supervisor.shutdown();
  });

  it('honours a sidecar root that does not exist on disk', async () => {
    const supervisor = new TileIntelSupervisor({
      sidecarRoot: 'C:/definitely/not/a/path/here/at/all',
      spawnFn: fakeSpawn(),
      fetchFn: createUnreachableFetch(),
    });
    const status = await supervisor.ensureReady();
    expect(status.available).toBe(false);
    if (!status.available) {
      expect(status.reason).toBe('sidecar_offline');
    }
    await supervisor.shutdown();
  });

  it('shutdown is idempotent + clears state', async () => {
    const supervisor = new TileIntelSupervisor({
      sidecarRoot: 'C:/does/not/matter',
      spawnFn: fakeSpawn(),
      fetchFn: createMockSidecarFetch(),
    });
    await supervisor.ensureReady();
    await supervisor.shutdown();
    await supervisor.shutdown(); // shouldn't throw
    // After shutdown, ensureReady should run a fresh cycle.
    const status = await supervisor.ensureReady();
    expect(status.available).toBe(true);
    await supervisor.shutdown();
  });
});
