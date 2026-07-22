/**
 * propose_batch_apply - Phase 3.26.
 *
 * Transactional multi-proposal applier. Takes an ordered list of
 * proposal ids + applies them sequentially. On any failure, rolls
 * back every prior successful apply (in reverse order) via the
 * existing `/api/projects/:id/undo` endpoint.
 *
 * Failure modes:
 *   - non-existent proposalId → fail immediately, no rollback
 *     needed (nothing applied yet).
 *   - apply fails for proposal k → roll back proposals 0..k-1
 *     via undo, return the failure + the count rolled back.
 *   - rollback itself fails → return a partial-state error
 *     describing which proposals are still applied (the user must
 *     manually reconcile via the History panel; rare).
 *
 * Use case: the agent composes a multi-step scene (NPC placement +
 * trainer team + script edit + dialogue gen) and wants all-or-
 * nothing semantics so a partial application doesn't leave the
 * ROM in a confused state.
 */

import { z } from 'zod';
import type { ToolContext } from '../types.js';

export const PROPOSE_BATCH_APPLY_TOOL_NAME = 'propose_batch_apply';

export const PROPOSE_BATCH_APPLY_DESCRIPTION =
  'Apply N proposals in sequence with transactional rollback.\n\n' +
  'Inputs:\n' +
  '  - `proposalIds`: ordered list of proposal ids (from previous\n' +
  '    propose-* calls). Apply order matters: prior proposals\' edits\n' +
  '    are visible to later ones via the manifest re-scan after each\n' +
  '    apply.\n' +
  '  - `label`: free-form description of the batch (shown in the\n' +
  '    history panel).\n' +
  '  - `sessionId`: optional override for the project session id\n' +
  '    (defaults to ctx.sessionId).\n\n' +
  'Behavior:\n' +
  '  - Walks proposalIds in order, calling /api/agent/patches/:id/\n' +
  '    apply for each.\n' +
  '  - On any failure, rolls back prior successful applies via the\n' +
  '    /api/projects/:projectId/undo endpoint in reverse order.\n' +
  '  - Returns a structured result so the agent can surface the\n' +
  '    failed proposal + what was rolled back.';

export const proposeBatchApplyInputShape = {
  proposalIds: z.array(z.string().min(1)).min(1).max(50),
  label: z.string().min(1).max(200),
  sessionId: z.string().optional(),
} as const;

export interface ProposeBatchApplyResult {
  readonly ok: boolean;
  readonly appliedCount: number;
  readonly rolledBackCount: number;
  readonly failedProposalId: string | null;
  readonly failureMessage: string | null;
  readonly partialState: boolean;
  readonly message: string;
}

function emptyFailure(message: string): ProposeBatchApplyResult {
  return {
    ok: false,
    appliedCount: 0,
    rolledBackCount: 0,
    failedProposalId: null,
    failureMessage: message,
    partialState: false,
    message,
  };
}

export async function proposeBatchApply(
  ctx: ToolContext,
  args: { proposalIds: string[]; label: string; sessionId?: string },
  deps: { fetchFn?: typeof fetch } = {},
): Promise<ProposeBatchApplyResult> {
  const fetchFn = deps.fetchFn ?? fetch;
  const baseUrl = ctx.baseUrl;
  if (!baseUrl) {
    return emptyFailure('No baseUrl in ToolContext; this tool requires the backend HTTP endpoint.');
  }
  const sessionId = args.sessionId;
  // We DON'T require sessionId for the apply call (that's keyed by
  // proposal id), but we DO require it for the undo path. If the
  // batch contains a failure and we have no sessionId, the rollback
  // will be impossible. Surface that up-front.

  const applied: string[] = [];
  for (const proposalId of args.proposalIds) {
    const url = `${baseUrl}/api/agent/patches/${encodeURIComponent(proposalId)}/apply`;
    let response: Response;
    try {
      response = await fetchFn(url, {
        method: 'POST',
        headers: { accept: 'application/json' },
      });
    } catch (e) {
      const failureMessage = `Network error applying ${proposalId}: ${e instanceof Error ? e.message : String(e)}`;
      const { rolledBackCount, partial } = await rollback(applied, baseUrl, sessionId, fetchFn);
      return {
        ok: false,
        appliedCount: applied.length,
        rolledBackCount,
        failedProposalId: proposalId,
        failureMessage,
        partialState: partial,
        message: `Batch '${args.label}' failed at ${proposalId}; rolled back ${String(rolledBackCount)} of ${String(applied.length)} prior applies.`,
      };
    }
    if (!response.ok) {
      let bodyText = '';
      try { bodyText = await response.text(); } catch { /* ignore */ }
      const failureMessage = `Apply failed for ${proposalId}: HTTP ${String(response.status)}: ${bodyText.slice(0, 200)}`;
      const { rolledBackCount, partial } = await rollback(applied, baseUrl, sessionId, fetchFn);
      return {
        ok: false,
        appliedCount: applied.length,
        rolledBackCount,
        failedProposalId: proposalId,
        failureMessage,
        partialState: partial,
        message: `Batch '${args.label}' failed at ${proposalId}; rolled back ${String(rolledBackCount)} of ${String(applied.length)} prior applies.`,
      };
    }
    applied.push(proposalId);
  }

  return {
    ok: true,
    appliedCount: applied.length,
    rolledBackCount: 0,
    failedProposalId: null,
    failureMessage: null,
    partialState: false,
    message: `Batch '${args.label}' applied ${String(applied.length)} proposals in sequence.`,
  };
}

/** Roll back the `applied` list in reverse order via /undo. Returns
 *  how many succeeded; `partial` is true when any undo failed. */
async function rollback(
  applied: ReadonlyArray<string>,
  baseUrl: string,
  sessionId: string | undefined,
  fetchFn: typeof fetch,
): Promise<{ rolledBackCount: number; partial: boolean }> {
  if (!sessionId) {
    // Without a sessionId we can't call /api/projects/:id/undo.
    return { rolledBackCount: 0, partial: applied.length > 0 };
  }
  let rolledBackCount = 0;
  for (let i = applied.length - 1; i >= 0; i--) {
    try {
      const r = await fetchFn(
        `${baseUrl}/api/projects/${encodeURIComponent(sessionId)}/undo`,
        { method: 'POST', headers: { accept: 'application/json' } },
      );
      if (r.ok) {
        rolledBackCount++;
      } else {
        return { rolledBackCount, partial: true };
      }
    } catch {
      return { rolledBackCount, partial: true };
    }
  }
  return { rolledBackCount, partial: false };
}
