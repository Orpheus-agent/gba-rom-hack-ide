/**
 * Direct-apply route for the visual scripter's Add Step / Edit Step /
 * Delete Step buttons.
 *
 * Bypasses the agent-review proposal flow because clicking "+ Add step"
 * in the inspector is an explicit user action - the user IS the
 * reviewer. The route:
 *   1. Calls `computeScriptEdit()` (the pure half of proposeScriptEdit).
 *   2. If edits are returned, applies them atomically via `applyEdits()`.
 *   3. Logs an op-log entry for undo (same envelope shape the agent
 *      apply route uses, so undo "just works").
 *
 * This mirrors the pattern of every other binary-rom-edit route
 * (encounter-slot, dialogue, species-fields, etc.) - direct edits land
 * straight on the ROM; agent proposals go through the review path.
 */

import { computeScriptEdit, type ProposeScriptEditResult } from '../agent/tools/propose-script-edit.js';
import { applyEdits, PatchApplyError } from '../agent/patch-applier.js';
import { appendOpLogEntry } from '../events/op-log.js';
import type { scripts as scriptsApi } from '@rom-introspection/engine';
import type { FastifyInstance, FastifyReply } from 'fastify';

type ScriptStepKind = scriptsApi.ScriptStepKind;

interface ProjectSession {
  readonly id: string;
  readonly projectRoot: string;
}

interface RegisterBinaryRomScriptStepEditRouteArgs {
  readonly app: FastifyInstance;
  readonly sessionStore: { get(id: string): ProjectSession | null | undefined };
  readonly errorResponse: (
    reply: FastifyReply,
    status: number,
    code: string,
    message: string,
  ) => unknown;
}

export interface BinaryRomEditScriptStepRequest {
  readonly scriptId: string;
  readonly op: 'insertStep' | 'deleteStep' | 'editStep';
  readonly stepIndex: number;
  readonly newStep?: { readonly kind: ScriptStepKind; readonly params: Readonly<Record<string, unknown>> };
  readonly description?: string;
}

export interface BinaryRomEditScriptStepResponse {
  readonly scriptOffset: number;
  readonly oldByteLength: number;
  readonly newByteLength: number;
  readonly wasRelocated: boolean;
  readonly pointerRewrites: number;
  readonly editsApplied: number;
  readonly description: string;
}

export function registerBinaryRomScriptStepEditRoute({
  app,
  sessionStore,
  errorResponse,
}: RegisterBinaryRomScriptStepEditRouteArgs): void {
  app.post<{
    Params: { id: string };
    Body: BinaryRomEditScriptStepRequest;
  }>('/api/projects/:id/binary-rom-edit/script-step', async (req, reply) => {
    const session = sessionStore.get(req.params.id);
    if (!session) {
      return errorResponse(reply, 404, 'session_not_found', 'Session not found');
    }
    const body = req.body;
    if (
      !body ||
      typeof body.scriptId !== 'string' ||
      typeof body.op !== 'string' ||
      typeof body.stepIndex !== 'number'
    ) {
      return errorResponse(
        reply,
        400,
        'bad_request',
        'Body must include scriptId (string), op (insertStep/deleteStep/editStep), stepIndex (number).',
      );
    }
    if (body.op !== 'insertStep' && body.op !== 'deleteStep' && body.op !== 'editStep') {
      return errorResponse(reply, 400, 'bad_request', `Unknown op '${body.op}'`);
    }

    const computeArgs: Parameters<typeof computeScriptEdit>[1] = {
      scriptId: body.scriptId,
      op: body.op,
      stepIndex: body.stepIndex,
      ...(body.newStep ? { newStep: { kind: body.newStep.kind, params: { ...body.newStep.params } } } : {}),
      ...(body.description ? { description: body.description } : {}),
    };

    const computed = await computeScriptEdit(session.projectRoot, computeArgs);
    if (!computed.ok) {
      return errorResponse(reply, 400, 'compute_failed', computed.message);
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

    // Log for undo. Same envelope shape the agent apply route uses so
    // the existing undo dispatch handles it without changes.
    await appendOpLogEntry({
      projectRoot: session.projectRoot,
      sessionId: session.id,
      op: 'agent_patch_apply',
      payload: {
        proposalId: `direct-script-edit-${String(Date.now())}`,
        description: computed.result.description,
        edits: computed.result.edits,
        reverseEdits: result.reverseEdits,
      },
    });

    const response: BinaryRomEditScriptStepResponse = {
      scriptOffset: computed.result.scriptOffset,
      oldByteLength: computed.result.oldByteLength,
      newByteLength: computed.result.newByteLength,
      wasRelocated: computed.result.wasRelocated,
      pointerRewrites: computed.result.pointerRewrites,
      editsApplied: computed.result.edits.length,
      description: computed.result.description,
    };
    return response;
  });
}

// Re-export so the projects.ts wiring + frontend api can import alongside.
export { type ProposeScriptEditResult };
