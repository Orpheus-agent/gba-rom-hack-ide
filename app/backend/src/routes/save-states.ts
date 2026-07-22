/**
 * Phase 4.1A - Save-state library routes.
 *
 *   GET    /api/projects/:id/save-states                    list (metadata only)
 *   POST   /api/projects/:id/save-states                    create (body: { name, notes, dataBase64 })
 *   PUT    /api/projects/:id/save-states/:stateId           update (rename / re-note / markLastLoaded)
 *   DELETE /api/projects/:id/save-states/:stateId           delete
 *   GET    /api/projects/:id/save-states/:stateId/bytes     stream the raw .state bytes
 *
 * The frontend captures bytes via mGBA-WASM's `forceAutoSaveState` +
 * `getAutoSaveState` pair, base64-encodes them, POSTs to /save-states;
 * loading reverses the sequence (GET /bytes → `uploadAutoSaveState` +
 * `loadAutoSaveState`).
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import {
  SaveStateError,
  createSaveState,
  deleteSaveState,
  getSaveState,
  listSaveStates,
  readSaveStateBytes,
  updateSaveState,
} from '../save-states/store.js';
import { findFirstGbaFile } from '../scan/binary-rom.js';
import type {
  SaveStateCreateRequest,
  SaveStateCreateResponse,
  SaveStateListResponse,
  SaveStateUpdateRequest,
  SaveStateUpdateResponse,
} from '@rom-editor/shared';

interface ProjectSession {
  readonly id: string;
  readonly projectRoot: string;
}

interface RegisterSaveStatesRoutesArgs {
  readonly app: FastifyInstance;
  readonly sessionStore: { get(id: string): ProjectSession | null | undefined };
  readonly errorResponse: (
    reply: FastifyReply,
    status: number,
    code: string,
    message: string,
  ) => unknown;
}

function mapSaveStateErrorStatus(code: SaveStateError['code']): number {
  switch (code) {
    case 'state_not_found':
      return 404;
    case 'limit_exceeded':
      return 409;
    case 'index_corrupt':
      return 500;
    case 'invalid_name':
    case 'invalid_notes':
    case 'invalid_bytes':
      return 400;
  }
}

async function sha1OfRom(projectRoot: string): Promise<string> {
  const romPath = await findFirstGbaFile(projectRoot);
  if (!romPath) return '';
  try {
    const bytes = await fsp.readFile(romPath);
    return createHash('sha1').update(bytes).digest('hex');
  } catch {
    return '';
  }
}

export function registerSaveStatesRoutes({
  app,
  sessionStore,
  errorResponse,
}: RegisterSaveStatesRoutesArgs): void {
  // GET - list save states for a project (metadata only, no bytes).
  app.get<{ Params: { id: string } }>(
    '/api/projects/:id/save-states',
    async (req, reply) => {
      const session = sessionStore.get(req.params.id);
      if (!session) {
        return errorResponse(reply, 404, 'session_not_found', 'Session not found');
      }
      try {
        const states = await listSaveStates(session.projectRoot);
        const response: SaveStateListResponse = { states };
        return response;
      } catch (e) {
        if (e instanceof SaveStateError) {
          return errorResponse(reply, mapSaveStateErrorStatus(e.code), 'internal_error', `${e.code}: ${e.message}`);
        }
        req.log.error(e);
        return errorResponse(reply, 500, 'internal_error', e instanceof Error ? e.message : 'unknown');
      }
    },
  );

  // POST - capture a new save state.
  app.post<{ Params: { id: string }; Body: SaveStateCreateRequest }>(
    '/api/projects/:id/save-states',
    async (req, reply) => {
      const session = sessionStore.get(req.params.id);
      if (!session) {
        return errorResponse(reply, 404, 'session_not_found', 'Session not found');
      }
      const body = req.body;
      if (!body || typeof body.name !== 'string' || typeof body.dataBase64 !== 'string') {
        return errorResponse(reply, 400, 'internal_error', 'expected { name, dataBase64, notes? }');
      }
      let bytes: Buffer;
      try {
        bytes = Buffer.from(body.dataBase64, 'base64');
      } catch {
        return errorResponse(reply, 400, 'internal_error', 'dataBase64 not valid base64');
      }
      if (bytes.byteLength === 0) {
        return errorResponse(reply, 400, 'internal_error', 'dataBase64 decoded to zero bytes');
      }
      try {
        const gameSha1 = await sha1OfRom(session.projectRoot);
        const state = await createSaveState({
          projectRoot: session.projectRoot,
          name: body.name,
          notes: body.notes ?? null,
          gameSha1,
          bytes: new Uint8Array(bytes),
        });
        const response: SaveStateCreateResponse = { state };
        void reply.code(201);
        return response;
      } catch (e) {
        if (e instanceof SaveStateError) {
          return errorResponse(reply, mapSaveStateErrorStatus(e.code), 'internal_error', `${e.code}: ${e.message}`);
        }
        req.log.error(e);
        return errorResponse(reply, 500, 'internal_error', e instanceof Error ? e.message : 'unknown');
      }
    },
  );

  // PUT - rename / re-note / mark-last-loaded.
  app.put<{
    Params: { id: string; stateId: string };
    Body: SaveStateUpdateRequest;
  }>('/api/projects/:id/save-states/:stateId', async (req, reply) => {
    const session = sessionStore.get(req.params.id);
    if (!session) {
      return errorResponse(reply, 404, 'session_not_found', 'Session not found');
    }
    const body = req.body ?? {};
    if (
      body.name === undefined &&
      body.notes === undefined &&
      body.markLastLoaded === undefined
    ) {
      return errorResponse(reply, 400, 'internal_error', 'expected at least one of { name, notes, markLastLoaded }');
    }
    try {
      const state = await updateSaveState({
        projectRoot: session.projectRoot,
        stateId: req.params.stateId,
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.notes !== undefined ? { notes: body.notes } : {}),
        ...(body.markLastLoaded !== undefined ? { markLastLoaded: body.markLastLoaded } : {}),
      });
      const response: SaveStateUpdateResponse = { state };
      return response;
    } catch (e) {
      if (e instanceof SaveStateError) {
        return errorResponse(reply, mapSaveStateErrorStatus(e.code), 'internal_error', `${e.code}: ${e.message}`);
      }
      req.log.error(e);
      return errorResponse(reply, 500, 'internal_error', e instanceof Error ? e.message : 'unknown');
    }
  });

  // DELETE - remove a state + its bytes file.
  app.delete<{ Params: { id: string; stateId: string } }>(
    '/api/projects/:id/save-states/:stateId',
    async (req, reply) => {
      const session = sessionStore.get(req.params.id);
      if (!session) {
        return errorResponse(reply, 404, 'session_not_found', 'Session not found');
      }
      try {
        await deleteSaveState(session.projectRoot, req.params.stateId);
        void reply.code(204);
        return null;
      } catch (e) {
        if (e instanceof SaveStateError) {
          return errorResponse(reply, mapSaveStateErrorStatus(e.code), 'internal_error', `${e.code}: ${e.message}`);
        }
        req.log.error(e);
        return errorResponse(reply, 500, 'internal_error', e instanceof Error ? e.message : 'unknown');
      }
    },
  );

  // GET /bytes - stream the raw .state bytes.
  app.get<{ Params: { id: string; stateId: string } }>(
    '/api/projects/:id/save-states/:stateId/bytes',
    async (req, reply) => {
      const session = sessionStore.get(req.params.id);
      if (!session) {
        return errorResponse(reply, 404, 'session_not_found', 'Session not found');
      }
      const record = await getSaveState(session.projectRoot, req.params.stateId);
      if (!record) {
        return errorResponse(reply, 404, 'path_not_found', 'save state not found');
      }
      try {
        const bytes = await readSaveStateBytes(session.projectRoot, req.params.stateId);
        return reply
          .header('Content-Type', 'application/octet-stream')
          .header('Content-Disposition', `attachment; filename="${record.id}.state"`)
          .header('X-Save-State-Name', encodeURIComponent(record.name))
          .send(Buffer.from(bytes));
      } catch (e) {
        if (e instanceof SaveStateError) {
          return errorResponse(reply, mapSaveStateErrorStatus(e.code), 'internal_error', `${e.code}: ${e.message}`);
        }
        req.log.error(e);
        return errorResponse(reply, 500, 'internal_error', e instanceof Error ? e.message : 'unknown');
      }
    },
  );
}
