import { randomUUID } from 'node:crypto';

export interface AgentSession {
  readonly projectId: string;
  readonly projectRoot: string;
  /** UUID we pass to `claude --session-id`; same id used across every
   *  turn for this project so claude resumes the same transcript. */
  readonly claudeSessionId: string;
  readonly createdAtUtc: string;
  lastTurnAtUtc: string | null;
  turnCount: number;
}

/**
 * One persistent agent session per open project. Per AI-0 plan:
 * "One persistent session per project" - frontend always hits the
 * same session id until the user explicitly resets.
 */
export class AgentSessionStore {
  private readonly sessions = new Map<string, AgentSession>();

  getOrCreate(projectId: string, projectRoot: string): AgentSession {
    const existing = this.sessions.get(projectId);
    if (existing) return existing;
    const session: AgentSession = {
      projectId,
      projectRoot,
      claudeSessionId: randomUUID(),
      createdAtUtc: new Date().toISOString(),
      lastTurnAtUtc: null,
      turnCount: 0,
    };
    this.sessions.set(projectId, session);
    return session;
  }

  markTurn(projectId: string): void {
    const s = this.sessions.get(projectId);
    if (!s) return;
    s.lastTurnAtUtc = new Date().toISOString();
    s.turnCount += 1;
  }

  reset(projectId: string): boolean {
    return this.sessions.delete(projectId);
  }

  get(projectId: string): AgentSession | undefined {
    return this.sessions.get(projectId);
  }

  size(): number {
    return this.sessions.size;
  }
}
