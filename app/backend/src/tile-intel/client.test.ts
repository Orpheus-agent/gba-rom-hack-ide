/**
 * Phase 8A-4 - Tile-intel client unit tests.
 */

import { describe, expect, it } from 'vitest';
import { TileIntelClient, TileIntelHttpError } from './client.js';
import { createMockSidecarFetch } from './__mocks__/sidecar.js';

describe('TileIntelClient', () => {
  it('GET /health returns the parsed JSON body', async () => {
    const client = new TileIntelClient('http://127.0.0.1:58080', createMockSidecarFetch());
    const body = await client.health();
    expect(body.ok).toBe(true);
    expect(body.schema_version).toBe(1);
    expect(body.api_version).toBe(1);
  });

  it('GET /v1/version surfaces test_mode + package_version', async () => {
    const client = new TileIntelClient(
      'http://127.0.0.1:58080',
      createMockSidecarFetch({ testMode: true, packageVersion: '0.42.0' }),
    );
    const body = await client.version();
    expect(body.api_version).toBe(1);
    expect(body.schema_version).toBe(1);
    expect(body.test_mode).toBe(true);
    expect(body.package_version).toBe('0.42.0');
  });

  it('non-2xx throws TileIntelHttpError with status + body', async () => {
    const fetchFn = createMockSidecarFetch();
    // Hit an unhandled path → 404
    const client = new TileIntelClient('http://127.0.0.1:58080', fetchFn);
    // Reach into the private helper via a known-bad shape - use the
    // public surface instead by calling an endpoint the mock doesn't
    // know about. Direct call via type-erasure:
    await expect(
      (client as unknown as { get: <T>(path: string) => Promise<T> }).get('/v1/unknown'),
    ).rejects.toBeInstanceOf(TileIntelHttpError);
  });

  it('trims trailing slash on baseUrl', async () => {
    const client = new TileIntelClient(
      'http://127.0.0.1:58080/',
      createMockSidecarFetch(),
    );
    // Should not error out due to a double-slash forming a different path.
    const body = await client.health();
    expect(body.ok).toBe(true);
  });
});
