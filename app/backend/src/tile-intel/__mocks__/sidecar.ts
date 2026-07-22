/**
 * Phase 8A-4 - In-process mock of the Python sidecar's HTTP surface.
 *
 * Tests construct `MockSidecarFetch` and pass it as the `fetchFn`
 * injection point to `TileIntelClient` or `TileIntelSupervisor`.
 * Adding new endpoints is just registering a handler.
 */

import type { FetchLike } from '../client.js';
import { EXPECTED_SIDECAR_API_VERSION } from '../types.js';

export interface MockSidecarOptions {
  readonly apiVersion?: number;
  readonly schemaVersion?: number;
  readonly testMode?: boolean;
  readonly packageVersion?: string;
  readonly healthOk?: boolean;
}

/** Returns a `FetchLike` whose responses come from in-memory handlers
 *  registered for each path. Default handlers cover /health and
 *  /v1/version with happy-path responses. */
export function createMockSidecarFetch(opts: MockSidecarOptions = {}): FetchLike {
  const apiVersion = opts.apiVersion ?? EXPECTED_SIDECAR_API_VERSION;
  const schemaVersion = opts.schemaVersion ?? 1;
  const testMode = opts.testMode ?? false;
  const packageVersion = opts.packageVersion ?? '0.1.0';
  const healthOk = opts.healthOk ?? true;

  const handlers: Record<string, () => { status: number; body: unknown }> = {
    '/health': () => ({
      status: 200,
      body: { ok: healthOk, schema_version: schemaVersion, api_version: apiVersion },
    }),
    '/v1/version': () => ({
      status: 200,
      body: {
        package_version: packageVersion,
        schema_version: schemaVersion,
        api_version: apiVersion,
        test_mode: testMode,
      },
    }),
  };

  return async (input, init) => {
    const url = typeof input === 'string' ? input : String(input);
    const path = new URL(url).pathname;
    const handler = handlers[path];
    if (!handler) {
      return {
        ok: false,
        status: 404,
        async json() {
          return { detail: `unhandled path ${path}` };
        },
        async text() {
          return `unhandled path ${path}`;
        },
      };
    }
    const { status, body } = handler();
    // Honour `init.method` only to the extent that unsupported
    // methods 405 - keeps the mock honest about GETs vs POSTs once
    // 8B-2 starts wiring those.
    if (init?.method && init.method !== 'GET') {
      return {
        ok: false,
        status: 405,
        async json() {
          return { detail: `method ${init.method} not allowed in mock` };
        },
        async text() {
          return `method ${init.method} not allowed in mock`;
        },
      };
    }
    return {
      ok: status >= 200 && status < 300,
      status,
      async json() {
        return body;
      },
      async text() {
        return JSON.stringify(body);
      },
    };
  };
}

/** Returns a fetch that ALWAYS errors out, mimicking a sidecar
 *  that isn't running on the expected port. */
export function createUnreachableFetch(): FetchLike {
  return async () => {
    throw new Error('ECONNREFUSED 127.0.0.1:58080');
  };
}
