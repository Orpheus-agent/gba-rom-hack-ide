/**
 * WP-C1 - Direct-apply route for encounter table mutations beyond the
 * per-slot species/level edits handled by /binary-rom-edit/encounter-slot.
 *
 * Bypasses the agent-review proposal flow because clicking "Set rate"
 * or "↑/↓ reorder" or "Replace all" in the inspector is an explicit
 * user action - the user IS the reviewer. The route:
 *   1. Calls `computeEncounterTableEdit()` (the pure half of
 *      proposeEncounterTableEdit).
 *   2. Applies the returned edits atomically via `applyEdits()`.
 *   3. Logs an op-log entry for undo (same envelope shape the agent
 *      apply route uses).
 */

import {
  computeEncounterTableEdit,
  type ProposeEncounterTableEditArgs,
} from '../agent/tools/propose-encounter-table-edit.js';
import { applyEdits, PatchApplyError } from '../agent/patch-applier.js';
import { appendOpLogEntry } from '../events/op-log.js';
import type { FastifyInstance, FastifyReply } from 'fastify';

interface ProjectSession {
  readonly id: string;
  readonly projectRoot: string;
}

interface RegisterArgs {
  readonly app: FastifyInstance;
  readonly sessionStore: { get(id: string): ProjectSession | null | undefined };
  readonly errorResponse: (
    reply: FastifyReply,
    status: number,
    code: string,
    message: string,
  ) => unknown;
}

export interface BinaryRomEditEncounterTableRequest {
  readonly encounterTableId: string;
  readonly op: 'setRate' | 'reorder' | 'bulkReplaceSpecies';
  readonly encounterRate?: number;
  readonly slotOrder?: ReadonlyArray<number>;
  readonly speciesId?: number;
  readonly description?: string;
}

export interface BinaryRomEditEncounterTableResponse {
  readonly encounterTableId: string;
  readonly op: 'setRate' | 'reorder' | 'bulkReplaceSpecies';
  readonly editsApplied: number;
  readonly description: string;
}

function buildArgs(
  body: BinaryRomEditEncounterTableRequest,
): { ok: true; args: ProposeEncounterTableEditArgs } | { ok: false; message: string } {
  if (body.op === 'setRate') {
    if (typeof body.encounterRate !== 'number') {
      return { ok: false, message: 'op=setRate requires numeric encounterRate' };
    }
    return {
      ok: true,
      args: {
        encounterTableId: body.encounterTableId,
        op: 'setRate',
        encounterRate: body.encounterRate,
        ...(body.description ? { description: body.description } : {}),
      },
    };
  }
  if (body.op === 'reorder') {
    if (!Array.isArray(body.slotOrder)) {
      return { ok: false, message: 'op=reorder requires slotOrder array' };
    }
    return {
      ok: true,
      args: {
        encounterTableId: body.encounterTableId,
        op: 'reorder',
        slotOrder: body.slotOrder,
        ...(body.description ? { description: body.description } : {}),
      },
    };
  }
  if (body.op === 'bulkReplaceSpecies') {
    if (typeof body.speciesId !== 'number') {
      return { ok: false, message: 'op=bulkReplaceSpecies requires numeric speciesId' };
    }
    return {
      ok: true,
      args: {
        encounterTableId: body.encounterTableId,
        op: 'bulkReplaceSpecies',
        speciesId: body.speciesId,
        ...(body.description ? { description: body.description } : {}),
      },
    };
  }
  return { ok: false, message: `Unknown op '${body.op as string}'` };
}

export function registerBinaryRomEncounterTableEditRoute({
  app,
  sessionStore,
  errorResponse,
}: RegisterArgs): void {
  app.post<{
    Params: { id: string };
    Body: BinaryRomEditEncounterTableRequest;
  }>('/api/projects/:id/binary-rom-edit/encounter-table', async (req, reply) => {
    const session = sessionStore.get(req.params.id);
    if (!session) {
      return errorResponse(reply, 404, 'session_not_found', 'Session not found');
    }
    const body = req.body;
    if (!body || typeof body.encounterTableId !== 'string' || typeof body.op !== 'string') {
      return errorResponse(
        reply,
        400,
        'bad_request',
        'Body must include encounterTableId (string) + op (setRate / reorder / bulkReplaceSpecies).',
      );
    }
    const built = buildArgs(body);
    if (!built.ok) {
      return errorResponse(reply, 400, 'bad_request', built.message);
    }

    const computed = await computeEncounterTableEdit(session.projectRoot, built.args);
    if (!computed.ok) {
      return errorResponse(reply, 400, computed.code, computed.message);
    }

    let result: { reverseEdits: ReadonlyArray<unknown> };
    try {
      result = await applyEdits(session.projectRoot, computed.result.edits);
    } catch (e) {
      if (e instanceof PatchApplyError) {
        return errorResponse(
          reply,
          400,
          e.code,
          `${e.message}${e.editIndex !== undefined ? ` (edit #${String(e.editIndex)})` : ''}`,
        );
      }
      req.log.error(e);
      return errorResponse(
        reply,
        500,
        'internal_error',
        `Apply failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    await appendOpLogEntry({
      projectRoot: session.projectRoot,
      sessionId: session.id,
      op: 'agent_patch_apply',
      payload: {
        proposalId: `direct-encounter-table-${String(Date.now())}`,
        description: computed.result.description,
        edits: computed.result.edits,
        reverseEdits: result.reverseEdits,
      },
    });

    const response: BinaryRomEditEncounterTableResponse = {
      encounterTableId: computed.result.encounterTableId,
      op: computed.result.op,
      editsApplied: computed.result.edits.length,
      description: computed.result.description,
    };
    return response;
  });
}
