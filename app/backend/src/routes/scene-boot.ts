/**
 * Phase 4.1B - Scene-boot recipe CRUD routes.
 *
 *   GET    /api/projects/:id/scene-boot-recipes              list
 *   POST   /api/projects/:id/scene-boot-recipes              create
 *   PUT    /api/projects/:id/scene-boot-recipes/:recipeId    update (partial)
 *   DELETE /api/projects/:id/scene-boot-recipes/:recipeId    delete
 *
 * No GET-by-id route - the list returns full recipe objects so the
 * frontend doesn't need a separate fetch.
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  SceneBootError,
  createSceneBoot,
  deleteSceneBoot,
  listSceneBoots,
  updateSceneBoot,
} from '../scene-boot/store.js';
import type {
  SceneBootCreateRequest,
  SceneBootCreateResponse,
  SceneBootListResponse,
  SceneBootUpdateRequest,
  SceneBootUpdateResponse,
} from '@rom-editor/shared';

interface ProjectSession {
  readonly id: string;
  readonly projectRoot: string;
}

interface RegisterSceneBootRoutesArgs {
  readonly app: FastifyInstance;
  readonly sessionStore: { get(id: string): ProjectSession | null | undefined };
  readonly errorResponse: (
    reply: FastifyReply,
    status: number,
    code: string,
    message: string,
  ) => unknown;
}

function mapStatus(code: SceneBootError['code']): number {
  switch (code) {
    case 'recipe_not_found':
      return 404;
    case 'limit_exceeded':
      return 409;
    case 'index_corrupt':
      return 500;
    case 'invalid_name':
    case 'invalid_notes':
    case 'invalid_starting_map':
    case 'invalid_position':
    case 'invalid_flag':
    case 'invalid_var':
    case 'invalid_script_id':
      return 400;
  }
}

export function registerSceneBootRoutes({
  app,
  sessionStore,
  errorResponse,
}: RegisterSceneBootRoutesArgs): void {
  app.get<{ Params: { id: string } }>(
    '/api/projects/:id/scene-boot-recipes',
    async (req, reply) => {
      const session = sessionStore.get(req.params.id);
      if (!session) {
        return errorResponse(reply, 404, 'session_not_found', 'Session not found');
      }
      try {
        const recipes = await listSceneBoots(session.projectRoot);
        const response: SceneBootListResponse = { recipes };
        return response;
      } catch (e) {
        if (e instanceof SceneBootError) {
          return errorResponse(reply, mapStatus(e.code), 'internal_error', `${e.code}: ${e.message}`);
        }
        req.log.error(e);
        return errorResponse(reply, 500, 'internal_error', e instanceof Error ? e.message : 'unknown');
      }
    },
  );

  app.post<{ Params: { id: string }; Body: SceneBootCreateRequest }>(
    '/api/projects/:id/scene-boot-recipes',
    async (req, reply) => {
      const session = sessionStore.get(req.params.id);
      if (!session) {
        return errorResponse(reply, 404, 'session_not_found', 'Session not found');
      }
      const body = req.body;
      if (!body || typeof body.name !== 'string' || typeof body.startingMapId !== 'string') {
        return errorResponse(reply, 400, 'internal_error', 'expected { name, startingMapId, ... }');
      }
      try {
        const recipe = await createSceneBoot({
          projectRoot: session.projectRoot,
          name: body.name,
          notes: body.notes ?? null,
          startingMapId: body.startingMapId,
          ...(body.startingPosition !== undefined ? { startingPosition: body.startingPosition } : {}),
          ...(body.initialFlags !== undefined ? { initialFlags: body.initialFlags } : {}),
          ...(body.initialVars !== undefined ? { initialVars: body.initialVars } : {}),
          ...(body.triggerScriptId !== undefined ? { triggerScriptId: body.triggerScriptId } : {}),
          ...(body.skipIntro !== undefined ? { skipIntro: body.skipIntro } : {}),
        });
        const response: SceneBootCreateResponse = { recipe };
        void reply.code(201);
        return response;
      } catch (e) {
        if (e instanceof SceneBootError) {
          return errorResponse(reply, mapStatus(e.code), 'internal_error', `${e.code}: ${e.message}`);
        }
        req.log.error(e);
        return errorResponse(reply, 500, 'internal_error', e instanceof Error ? e.message : 'unknown');
      }
    },
  );

  app.put<{
    Params: { id: string; recipeId: string };
    Body: SceneBootUpdateRequest;
  }>('/api/projects/:id/scene-boot-recipes/:recipeId', async (req, reply) => {
    const session = sessionStore.get(req.params.id);
    if (!session) {
      return errorResponse(reply, 404, 'session_not_found', 'Session not found');
    }
    const body = req.body ?? {};
    if (Object.keys(body).length === 0) {
      return errorResponse(reply, 400, 'internal_error', 'PUT body must include at least one field');
    }
    try {
      const recipe = await updateSceneBoot({
        projectRoot: session.projectRoot,
        recipeId: req.params.recipeId,
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.notes !== undefined ? { notes: body.notes } : {}),
        ...(body.startingMapId !== undefined ? { startingMapId: body.startingMapId } : {}),
        ...(body.startingPosition !== undefined ? { startingPosition: body.startingPosition } : {}),
        ...(body.initialFlags !== undefined ? { initialFlags: body.initialFlags } : {}),
        ...(body.initialVars !== undefined ? { initialVars: body.initialVars } : {}),
        ...(body.triggerScriptId !== undefined ? { triggerScriptId: body.triggerScriptId } : {}),
        ...(body.skipIntro !== undefined ? { skipIntro: body.skipIntro } : {}),
      });
      const response: SceneBootUpdateResponse = { recipe };
      return response;
    } catch (e) {
      if (e instanceof SceneBootError) {
        return errorResponse(reply, mapStatus(e.code), 'internal_error', `${e.code}: ${e.message}`);
      }
      req.log.error(e);
      return errorResponse(reply, 500, 'internal_error', e instanceof Error ? e.message : 'unknown');
    }
  });

  app.delete<{ Params: { id: string; recipeId: string } }>(
    '/api/projects/:id/scene-boot-recipes/:recipeId',
    async (req, reply) => {
      const session = sessionStore.get(req.params.id);
      if (!session) {
        return errorResponse(reply, 404, 'session_not_found', 'Session not found');
      }
      try {
        await deleteSceneBoot(session.projectRoot, req.params.recipeId);
        void reply.code(204);
        return null;
      } catch (e) {
        if (e instanceof SceneBootError) {
          return errorResponse(reply, mapStatus(e.code), 'internal_error', `${e.code}: ${e.message}`);
        }
        req.log.error(e);
        return errorResponse(reply, 500, 'internal_error', e instanceof Error ? e.message : 'unknown');
      }
    },
  );
}
