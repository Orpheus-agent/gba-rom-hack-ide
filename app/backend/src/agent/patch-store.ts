import { randomUUID } from 'node:crypto';
import type {
  AgentPatchEdit,
  AgentPatchProposal,
  AgentPatchStatus,
} from '@rom-editor/shared';

export interface CreateProposalInput {
  readonly projectId: string;
  readonly description: string;
  readonly edits: ReadonlyArray<AgentPatchEdit>;
}

/**
 * In-memory per-project pending-patch index. Lives in the Fastify
 * backend process; the MCP server's `propose_patch` tool POSTs to
 * Fastify's internal route, which writes here and broadcasts a
 * `patch_proposed` WS frame.
 */
export class PatchStore {
  private readonly proposals = new Map<string, AgentPatchProposal>();
  private readonly byProject = new Map<string, Set<string>>();

  create(input: CreateProposalInput): AgentPatchProposal {
    const proposal: AgentPatchProposal = {
      id: `patch_${randomUUID()}`,
      projectId: input.projectId,
      description: input.description,
      edits: input.edits,
      status: 'pending',
      createdAtUtc: new Date().toISOString(),
    };
    this.proposals.set(proposal.id, proposal);
    this.indexFor(input.projectId).add(proposal.id);
    return proposal;
  }

  get(id: string): AgentPatchProposal | undefined {
    return this.proposals.get(id);
  }

  listByProject(projectId: string): ReadonlyArray<AgentPatchProposal> {
    const ids = this.byProject.get(projectId);
    if (!ids) return [];
    const out: AgentPatchProposal[] = [];
    for (const id of ids) {
      const p = this.proposals.get(id);
      if (p) out.push(p);
    }
    return out.sort((a, b) => a.createdAtUtc.localeCompare(b.createdAtUtc));
  }

  setStatus(id: string, status: AgentPatchStatus): AgentPatchProposal | null {
    const existing = this.proposals.get(id);
    if (!existing) return null;
    if (existing.status !== 'pending') return existing; // applied/rejected are terminal
    const now = new Date().toISOString();
    const updated: AgentPatchProposal = {
      ...existing,
      status,
      ...(status === 'applied' ? { appliedAtUtc: now } : {}),
      ...(status === 'rejected' ? { rejectedAtUtc: now } : {}),
    };
    this.proposals.set(id, updated);
    return updated;
  }

  /** Drop all proposals for a project (used when the project closes). */
  clearProject(projectId: string): void {
    const ids = this.byProject.get(projectId);
    if (!ids) return;
    for (const id of ids) this.proposals.delete(id);
    this.byProject.delete(projectId);
  }

  size(): number {
    return this.proposals.size;
  }

  private indexFor(projectId: string): Set<string> {
    let set = this.byProject.get(projectId);
    if (!set) {
      set = new Set();
      this.byProject.set(projectId, set);
    }
    return set;
  }
}
