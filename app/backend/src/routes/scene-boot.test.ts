import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { createServer } from '../server.js';
import type {
  ProjectOpenResponse,
  SceneBootCreateResponse,
  SceneBootListResponse,
  SceneBootUpdateResponse,
} from '@rom-editor/shared';

describe('scene-boot routes (Phase 4.1B)', () => {
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
    projectDir = mkdtempSync(path.join(tmpdir(), 'rom-editor-sceneboot-route-'));
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

  it('GET returns an empty list initially', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${sessionId}/scene-boot-recipes`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as SceneBootListResponse;
    expect(body.recipes).toEqual([]);
  });

  it('POST creates a recipe + responds 201', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${sessionId}/scene-boot-recipes`,
      payload: {
        name: 'cosmog-handoff',
        notes: 'after the gift',
        startingMapId: 'pallet_town',
        startingPosition: { x: 4, y: 5, facing: 'down' },
        initialFlags: [0x820],
        initialVars: [{ varId: 0x40d0, value: 3 }],
        skipIntro: true,
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as SceneBootCreateResponse;
    expect(body.recipe.name).toBe('cosmog-handoff');
    expect(body.recipe.startingMapId).toBe('pallet_town');
    expect(body.recipe.initialFlags).toEqual([0x820]);
    expect(body.recipe.skipIntro).toBe(true);
  });

  it('POST rejects an empty name', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${sessionId}/scene-boot-recipes`,
      payload: { name: '', startingMapId: 'x' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST rejects a missing startingMapId', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${sessionId}/scene-boot-recipes`,
      payload: { name: 'x' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST + GET round-trips', async () => {
    await app.inject({
      method: 'POST',
      url: `/api/projects/${sessionId}/scene-boot-recipes`,
      payload: { name: 'A', startingMapId: 'pallet_town' },
    });
    const list = await app.inject({
      method: 'GET',
      url: `/api/projects/${sessionId}/scene-boot-recipes`,
    });
    const body = list.json() as SceneBootListResponse;
    expect(body.recipes).toHaveLength(1);
    expect(body.recipes[0]!.name).toBe('A');
  });

  it('PUT applies a partial update', async () => {
    const create = await app.inject({
      method: 'POST',
      url: `/api/projects/${sessionId}/scene-boot-recipes`,
      payload: { name: 'before', startingMapId: 'pallet_town' },
    });
    const created = create.json() as SceneBootCreateResponse;
    const put = await app.inject({
      method: 'PUT',
      url: `/api/projects/${sessionId}/scene-boot-recipes/${created.recipe.id}`,
      payload: { name: 'after', initialFlags: [0x100, 0x200] },
    });
    expect(put.statusCode).toBe(200);
    const body = put.json() as SceneBootUpdateResponse;
    expect(body.recipe.name).toBe('after');
    expect(body.recipe.initialFlags).toEqual([0x100, 0x200]);
    expect(body.recipe.startingMapId).toBe('pallet_town');
  });

  it('PUT with empty body returns 400', async () => {
    const create = await app.inject({
      method: 'POST',
      url: `/api/projects/${sessionId}/scene-boot-recipes`,
      payload: { name: 'x', startingMapId: 'y' },
    });
    const created = create.json() as SceneBootCreateResponse;
    const put = await app.inject({
      method: 'PUT',
      url: `/api/projects/${sessionId}/scene-boot-recipes/${created.recipe.id}`,
      payload: {},
    });
    expect(put.statusCode).toBe(400);
  });

  it('PUT for unknown id returns 404', async () => {
    const put = await app.inject({
      method: 'PUT',
      url: `/api/projects/${sessionId}/scene-boot-recipes/no-such-id`,
      payload: { name: 'x' },
    });
    expect(put.statusCode).toBe(404);
  });

  it('DELETE removes a recipe and responds 204', async () => {
    const create = await app.inject({
      method: 'POST',
      url: `/api/projects/${sessionId}/scene-boot-recipes`,
      payload: { name: 'temp', startingMapId: 'x' },
    });
    const created = create.json() as SceneBootCreateResponse;
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/projects/${sessionId}/scene-boot-recipes/${created.recipe.id}`,
    });
    expect(del.statusCode).toBe(204);
    const list = await app.inject({
      method: 'GET',
      url: `/api/projects/${sessionId}/scene-boot-recipes`,
    });
    expect((list.json() as SceneBootListResponse).recipes).toHaveLength(0);
  });

  it('GET for unknown session returns 404', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/no-such-session/scene-boot-recipes`,
    });
    expect(res.statusCode).toBe(404);
  });
});
