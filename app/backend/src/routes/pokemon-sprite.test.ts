/**
 * Phase 4.2C / 9B - pokemon-sprite route tests.
 *
 * Verifies the single-frame endpoint (default + ?frame=N), the
 * multi-frame strip endpoint, cache hits via ETag, and error
 * handling for invalid speciesIds / frame values.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { createServer } from '../server.js';
import type { ProjectOpenResponse } from '@rom-editor/shared';

describe('pokemon-sprite route (Phase 4.2C + 9B)', () => {
  let app: FastifyInstance;
  let projectDir: string;
  let sessionId: string;

  beforeAll(async () => {
    app = await createServer({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    projectDir = mkdtempSync(path.join(tmpdir(), 'rom-editor-sprite-route-'));
    const openRes = await app.inject({
      method: 'POST',
      url: '/api/projects/open',
      payload: { projectRoot: projectDir },
    });
    expect(openRes.statusCode).toBe(200);
    const opened = openRes.json() as ProjectOpenResponse;
    sessionId = opened.session.id;
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('returns a PNG for a valid speciesId', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${sessionId}/pokemon-sprite/25.png`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    // Sniff the PNG signature.
    const body = res.rawPayload;
    expect(body[0]).toBe(0x89);
    expect(body[1]).toBe(0x50); // P
    expect(body[2]).toBe(0x4e); // N
    expect(body[3]).toBe(0x47); // G
  });

  it('rejects non-integer speciesIds', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${sessionId}/pokemon-sprite/abc.png`,
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 for unknown session', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/projects/no-such-session/pokemon-sprite/25.png',
    });
    expect(res.statusCode).toBe(404);
  });

  // ---------------------------------------------------------------------------
  // Phase 9B - frame parameter
  // ---------------------------------------------------------------------------

  it('accepts ?frame=N for N in 0..3 and returns distinct bytes per frame', async () => {
    const frames: Buffer[] = [];
    for (let f = 0; f <= 3; f++) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/projects/${sessionId}/pokemon-sprite/25.png?frame=${String(f)}`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('image/png');
      frames.push(Buffer.from(res.rawPayload));
    }
    // Each frame's PNG body must differ from the others (different
    // gradient direction → different pixel bytes → different PNG).
    for (let i = 0; i < 4; i++) {
      for (let j = i + 1; j < 4; j++) {
        expect(frames[i]!.equals(frames[j]!)).toBe(false);
      }
    }
  });

  it('rejects ?frame=4 (out of range)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${sessionId}/pokemon-sprite/25.png?frame=4`,
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects ?frame=abc (non-integer)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${sessionId}/pokemon-sprite/25.png?frame=abc`,
    });
    expect(res.statusCode).toBe(400);
  });

  it('ETag changes per frame so caches do not collide', async () => {
    const f0 = await app.inject({
      method: 'GET',
      url: `/api/projects/${sessionId}/pokemon-sprite/25.png?frame=0`,
    });
    const f1 = await app.inject({
      method: 'GET',
      url: `/api/projects/${sessionId}/pokemon-sprite/25.png?frame=1`,
    });
    expect(f0.headers.etag).toBeTruthy();
    expect(f1.headers.etag).toBeTruthy();
    expect(f0.headers.etag).not.toBe(f1.headers.etag);
  });

  it('ETag round-trip returns 304 on If-None-Match', async () => {
    const first = await app.inject({
      method: 'GET',
      url: `/api/projects/${sessionId}/pokemon-sprite/25.png?frame=1`,
    });
    const etag = first.headers.etag as string;
    const second = await app.inject({
      method: 'GET',
      url: `/api/projects/${sessionId}/pokemon-sprite/25.png?frame=1`,
      headers: { 'if-none-match': etag },
    });
    expect(second.statusCode).toBe(304);
  });

  // ---------------------------------------------------------------------------
  // Phase 9B - strip endpoint
  // ---------------------------------------------------------------------------

  it('strip endpoint returns a 128×32 PNG', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${sessionId}/pokemon-sprite/25.png/strip`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    // PNG width is stored at offset 16 (big-endian u32).
    const body = res.rawPayload;
    const width = body.readUInt32BE(16);
    const height = body.readUInt32BE(20);
    expect(width).toBe(128);
    expect(height).toBe(32);
  });

  it('strip endpoint rejects bad speciesIds', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${sessionId}/pokemon-sprite/-5.png/strip`,
    });
    expect(res.statusCode).toBe(400);
  });
});
