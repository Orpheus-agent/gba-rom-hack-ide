import { describe, it, expect } from 'vitest';
import { AgentSessionStore } from './agent-session-store.js';

describe('AgentSessionStore', () => {
  it('creates a session with a fresh UUID on first call', () => {
    const store = new AgentSessionStore();
    const s = store.getOrCreate('proj-a', '/path/to/proj-a');
    expect(s.projectId).toBe('proj-a');
    expect(s.projectRoot).toBe('/path/to/proj-a');
    expect(s.claudeSessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(s.turnCount).toBe(0);
    expect(s.lastTurnAtUtc).toBeNull();
  });

  it('returns the same session on subsequent getOrCreate', () => {
    const store = new AgentSessionStore();
    const a = store.getOrCreate('proj-a', '/path/to/proj-a');
    const b = store.getOrCreate('proj-a', '/path/to/proj-a');
    expect(a).toBe(b);
    expect(a.claudeSessionId).toBe(b.claudeSessionId);
  });

  it('isolates sessions per projectId', () => {
    const store = new AgentSessionStore();
    const a = store.getOrCreate('proj-a', '/a');
    const b = store.getOrCreate('proj-b', '/b');
    expect(a.claudeSessionId).not.toBe(b.claudeSessionId);
    expect(store.size()).toBe(2);
  });

  it('markTurn bumps the turnCount + sets lastTurnAtUtc', () => {
    const store = new AgentSessionStore();
    store.getOrCreate('p', '/p');
    store.markTurn('p');
    store.markTurn('p');
    const s = store.get('p');
    expect(s?.turnCount).toBe(2);
    expect(s?.lastTurnAtUtc).not.toBeNull();
  });

  it('reset removes the session', () => {
    const store = new AgentSessionStore();
    const first = store.getOrCreate('p', '/p');
    expect(store.reset('p')).toBe(true);
    expect(store.get('p')).toBeUndefined();
    const second = store.getOrCreate('p', '/p');
    expect(second.claudeSessionId).not.toBe(first.claudeSessionId);
  });
});
