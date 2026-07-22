import { randomUUID } from 'node:crypto';
import type { ProjectSession } from '@rom-editor/shared';

export class ProjectSessionStore {
  private readonly sessions = new Map<string, ProjectSession>();

  create(projectRoot: string): ProjectSession {
    const session: ProjectSession = {
      id: randomUUID(),
      projectRoot,
      openedAtUtc: new Date().toISOString(),
    };
    this.sessions.set(session.id, session);
    return session;
  }

  get(id: string): ProjectSession | undefined {
    return this.sessions.get(id);
  }

  list(): ReadonlyArray<ProjectSession> {
    return Array.from(this.sessions.values());
  }

  delete(id: string): boolean {
    return this.sessions.delete(id);
  }

  size(): number {
    return this.sessions.size;
  }
}
