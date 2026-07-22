import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { createServer } from '../server.js';
import type {
  ProjectOpenResponse,
  SaveStateCreateResponse,
  SaveStateListResponse,
  SaveStateUpdateResponse,
} from '@rom-editor/shared';

/**
 * Phase 4.1A - Smoke test the save-state CRUD route family on an
 * empty project root. The route is project-agnostic - it persists to
 * <projectRoot>/.editor/save-states/ regardless of detection kind.
 */
describe('save-states routes (Phase 4.1A)', () => {
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
    projectDir = mkdtempSync(path.join(tmpdir(), 'rom-editor-savestate-route-'));
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

  function bytesB64(length: number, fill = 0x42): string {
    const b = Buffer.alloc(length, fill);
    return b.toString('base64');
  }

  it('GET returns an empty list when no states have been captured', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${sessionId}/save-states`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as SaveStateListResponse;
    expect(body.states).toEqual([]);
  });

  it('POST creates a record + persists to disk', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${sessionId}/save-states`,
      payload: { name: 'after-cosmog', notes: 'just received Cosmog', dataBase64: bytesB64(64) },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as SaveStateCreateResponse;
    expect(body.state.name).toBe('after-cosmog');
    expect(body.state.notes).toBe('just received Cosmog');
    expect(body.state.byteLength).toBe(64);
    expect(body.state.lastLoaded).toBe(false);
  });

  it('POST + GET round-trips through the index', async () => {
    const create = await app.inject({
      method: 'POST',
      url: `/api/projects/${sessionId}/save-states`,
      payload: { name: 'A', dataBase64: bytesB64(16) },
    });
    expect(create.statusCode).toBe(201);
    const list = await app.inject({
      method: 'GET',
      url: `/api/projects/${sessionId}/save-states`,
    });
    expect(list.statusCode).toBe(200);
    const body = list.json() as SaveStateListResponse;
    expect(body.states).toHaveLength(1);
    expect(body.states[0]!.name).toBe('A');
  });

  it('POST rejects empty name', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${sessionId}/save-states`,
      payload: { name: '', dataBase64: bytesB64(16) },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST rejects zero-byte data', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${sessionId}/save-states`,
      payload: { name: 'x', dataBase64: '' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('PUT renames an existing record', async () => {
    const create = await app.inject({
      method: 'POST',
      url: `/api/projects/${sessionId}/save-states`,
      payload: { name: 'before', dataBase64: bytesB64(16) },
    });
    const created = create.json() as SaveStateCreateResponse;
    const put = await app.inject({
      method: 'PUT',
      url: `/api/projects/${sessionId}/save-states/${created.state.id}`,
      payload: { name: 'after', notes: 'updated' },
    });
    expect(put.statusCode).toBe(200);
    const updated = put.json() as SaveStateUpdateResponse;
    expect(updated.state.name).toBe('after');
    expect(updated.state.notes).toBe('updated');
  });

  it('PUT markLastLoaded flips the flag', async () => {
    const create = await app.inject({
      method: 'POST',
      url: `/api/projects/${sessionId}/save-states`,
      payload: { name: 'x', dataBase64: bytesB64(16) },
    });
    const created = create.json() as SaveStateCreateResponse;
    const put = await app.inject({
      method: 'PUT',
      url: `/api/projects/${sessionId}/save-states/${created.state.id}`,
      payload: { markLastLoaded: true },
    });
    expect(put.statusCode).toBe(200);
    const updated = put.json() as SaveStateUpdateResponse;
    expect(updated.state.lastLoaded).toBe(true);
  });

  it('PUT with no fields returns 400', async () => {
    const create = await app.inject({
      method: 'POST',
      url: `/api/projects/${sessionId}/save-states`,
      payload: { name: 'x', dataBase64: bytesB64(16) },
    });
    const created = create.json() as SaveStateCreateResponse;
    const put = await app.inject({
      method: 'PUT',
      url: `/api/projects/${sessionId}/save-states/${created.state.id}`,
      payload: {},
    });
    expect(put.statusCode).toBe(400);
  });

  it('PUT to an unknown id returns 404', async () => {
    const put = await app.inject({
      method: 'PUT',
      url: `/api/projects/${sessionId}/save-states/no-such-id`,
      payload: { name: 'x' },
    });
    expect(put.statusCode).toBe(404);
  });

  it('GET /bytes streams the raw bytes', async () => {
    const create = await app.inject({
      method: 'POST',
      url: `/api/projects/${sessionId}/save-states`,
      payload: { name: 'x', dataBase64: bytesB64(32, 0x55) },
    });
    const created = create.json() as SaveStateCreateResponse;
    const bytes = await app.inject({
      method: 'GET',
      url: `/api/projects/${sessionId}/save-states/${created.state.id}/bytes`,
    });
    expect(bytes.statusCode).toBe(200);
    expect(bytes.headers['content-type']).toBe('application/octet-stream');
    const buf = bytes.rawPayload;
    expect(buf.byteLength).toBe(32);
    expect(buf[0]).toBe(0x55);
  });

  it('GET /bytes for unknown id returns 404', async () => {
    const bytes = await app.inject({
      method: 'GET',
      url: `/api/projects/${sessionId}/save-states/no-such-id/bytes`,
    });
    expect(bytes.statusCode).toBe(404);
  });

  it('DELETE removes a record + returns 204', async () => {
    const create = await app.inject({
      method: 'POST',
      url: `/api/projects/${sessionId}/save-states`,
      payload: { name: 'x', dataBase64: bytesB64(16) },
    });
    const created = create.json() as SaveStateCreateResponse;
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/projects/${sessionId}/save-states/${created.state.id}`,
    });
    expect(del.statusCode).toBe(204);
    const list = await app.inject({
      method: 'GET',
      url: `/api/projects/${sessionId}/save-states`,
    });
    const body = list.json() as SaveStateListResponse;
    expect(body.states).toHaveLength(0);
  });

  it('GET /save-states for an unknown session returns 404', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/no-such-session/save-states`,
    });
    expect(res.statusCode).toBe(404);
  });
});
