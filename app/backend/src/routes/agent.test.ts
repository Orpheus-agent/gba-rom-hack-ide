import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import websocketPlugin from '@fastify/websocket';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectSessionStore } from '../projects/session-store.js';
import { AgentSessionStore } from '../agent/agent-session-store.js';
import { registerAgentRoute } from './agent.js';
import type { RunTurnOptions, TurnResult } from '../agent/spawner.js';
import { TurnError } from '../agent/spawner.js';

interface BuildOptions {
  readonly claudeBinary?: string | null;
  readonly runTurn?: (opts: RunTurnOptions) => Promise<TurnResult>;
}

async function buildApp(opts: BuildOptions = {}): Promise<{
  app: FastifyInstance;
  sessionStore: ProjectSessionStore;
  agentStore: AgentSessionStore;
  tmpProjectRoot: string;
  projectId: string;
}> {
  const tmpProjectRoot = await fsp.mkdtemp(path.join(tmpdir(), 'agent-route-'));
  const sessionStore = new ProjectSessionStore();
  const session = sessionStore.create(tmpProjectRoot);
  const agentStore = new AgentSessionStore();
  const app = Fastify({ logger: false });
  await app.register(websocketPlugin);
  await app.register(registerAgentRoute, {
    sessionStore,
    agentSessionStore: agentStore,
    findClaudeImpl: async () => (opts.claudeBinary === undefined ? '/fake/claude' : opts.claudeBinary),
    runTurnImpl:
      opts.runTurn ??
      (async (turnOpts) => ({
        events: [
          { type: 'system', data: { subtype: 'init', session_id: turnOpts.claudeSessionId } },
          { type: 'assistant', data: { content: [{ type: 'text', text: turnOpts.prompt }] } },
          { type: 'result', data: { result: `echo: ${turnOpts.prompt}` } },
        ],
        finalText: `echo: ${turnOpts.prompt}`,
        exitCode: 0,
        durationMs: 5,
        stderr: '',
      })),
  });
  return { app, sessionStore, agentStore, tmpProjectRoot, projectId: session.id };
}

describe('POST /api/agent/turn', () => {
  let cleanup: Array<() => Promise<void>>;

  beforeEach(() => {
    cleanup = [];
  });

  afterEach(async () => {
    for (const fn of cleanup) await fn();
  });

  it('runs a turn end-to-end with a stubbed claude binary + spawner', async () => {
    const { app, tmpProjectRoot, projectId } = await buildApp();
    cleanup.push(async () => {
      await app.close();
      await fsp.rm(tmpProjectRoot, { recursive: true, force: true });
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/agent/turn',
      payload: { prompt: 'list trainers', projectId },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      sessionId: string;
      turnCount: number;
      finalText: string;
      events: { type: string }[];
    };
    expect(body.finalText).toBe('echo: list trainers');
    expect(body.events.map((e) => e.type)).toEqual(['system', 'assistant', 'result']);
    expect(body.turnCount).toBe(1);
    expect(body.sessionId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('reuses the same sessionId across multiple turns', async () => {
    const { app, tmpProjectRoot, projectId } = await buildApp();
    cleanup.push(async () => {
      await app.close();
      await fsp.rm(tmpProjectRoot, { recursive: true, force: true });
    });

    const first = await app.inject({
      method: 'POST',
      url: '/api/agent/turn',
      payload: { prompt: 'first', projectId },
    });
    const second = await app.inject({
      method: 'POST',
      url: '/api/agent/turn',
      payload: { prompt: 'second', projectId },
    });

    const a = first.json() as { sessionId: string; turnCount: number };
    const b = second.json() as { sessionId: string; turnCount: number };
    expect(a.sessionId).toBe(b.sessionId);
    expect(a.turnCount).toBe(1);
    expect(b.turnCount).toBe(2);
  });

  it('returns 400 when prompt is missing', async () => {
    const { app, tmpProjectRoot, projectId } = await buildApp();
    cleanup.push(async () => {
      await app.close();
      await fsp.rm(tmpProjectRoot, { recursive: true, force: true });
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/agent/turn',
      payload: { projectId },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'bad_request', message: expect.any(String) });
  });

  it('returns 404 when the projectId is not open', async () => {
    const { app, tmpProjectRoot } = await buildApp();
    cleanup.push(async () => {
      await app.close();
      await fsp.rm(tmpProjectRoot, { recursive: true, force: true });
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/agent/turn',
      payload: { prompt: 'hi', projectId: 'no-such-id' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'project_not_open' });
  });

  it('returns 503 when no claude binary is found', async () => {
    const { app, tmpProjectRoot, projectId } = await buildApp({ claudeBinary: null });
    cleanup.push(async () => {
      await app.close();
      await fsp.rm(tmpProjectRoot, { recursive: true, force: true });
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/agent/turn',
      payload: { prompt: 'hi', projectId },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: 'claude_cli_not_installed' });
  });

  it('surfaces TurnError as 500 with the typed code', async () => {
    const { app, tmpProjectRoot, projectId } = await buildApp({
      runTurn: async () => {
        throw new TurnError('nonzero_exit', 'claude exited with code 7', 'boom\n');
      },
    });
    cleanup.push(async () => {
      await app.close();
      await fsp.rm(tmpProjectRoot, { recursive: true, force: true });
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/agent/turn',
      payload: { prompt: 'hi', projectId },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ error: 'nonzero_exit', stderr: 'boom\n' });
  });
});

describe('WS /api/agent/ws', () => {
  let cleanup: Array<() => Promise<void>>;

  beforeEach(() => {
    cleanup = [];
  });

  afterEach(async () => {
    for (const fn of cleanup) await fn();
  });

  /** Accumulate messages by `kind`. Resolves with the first message whose
   *  `kind` matches `target`; ignores other messages until then. */
  function waitFor(ws: import('ws').WebSocket, target: string): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const onMsg = (data: import('ws').RawData) => {
        try {
          const parsed = JSON.parse(data.toString()) as Record<string, unknown>;
          if (parsed.kind === target) {
            ws.removeListener('message', onMsg);
            ws.removeListener('error', onErr);
            resolve(parsed);
          }
        } catch (e) {
          reject(e as Error);
        }
      };
      const onErr = (e: Error) => {
        ws.removeListener('message', onMsg);
        reject(e);
      };
      ws.on('message', onMsg);
      ws.on('error', onErr);
    });
  }

  function collectUntil(ws: import('ws').WebSocket, terminal: string): Promise<Record<string, unknown>[]> {
    return new Promise((resolve, reject) => {
      const out: Record<string, unknown>[] = [];
      const onMsg = (data: import('ws').RawData) => {
        try {
          const parsed = JSON.parse(data.toString()) as Record<string, unknown>;
          out.push(parsed);
          if (parsed.kind === terminal) {
            ws.removeListener('message', onMsg);
            ws.removeListener('error', onErr);
            resolve(out);
          }
        } catch (e) {
          reject(e as Error);
        }
      };
      const onErr = (e: Error) => {
        ws.removeListener('message', onMsg);
        reject(e);
      };
      ws.on('message', onMsg);
      ws.on('error', onErr);
    });
  }

  it('sends ready on connect with the current sessionId', async () => {
    const { app, tmpProjectRoot, projectId } = await buildApp();
    cleanup.push(async () => {
      await app.close();
      await fsp.rm(tmpProjectRoot, { recursive: true, force: true });
    });
    await app.ready();
    const ws = await app.injectWS(`/api/agent/ws?projectId=${projectId}`);
    try {
      const ready = await waitFor(ws, 'ready');
      expect(ready.kind).toBe('ready');
      expect(ready.sessionId).toMatch(/^[0-9a-f-]{36}$/);
      expect(ready.turnCount).toBe(0);
    } finally {
      ws.close();
    }
  });

  it('streams turn_event messages per spawner event then terminates with turn_done', async () => {
    const { app, tmpProjectRoot, projectId } = await buildApp({
      runTurn: async (opts) => {
        const events = [
          { type: 'system', data: { subtype: 'init' } },
          { type: 'assistant', data: { content: [{ type: 'text', text: 'Hi' }] } },
          { type: 'result', data: { result: 'done!' } },
        ];
        for (const e of events) {
          if (opts.onEvent) opts.onEvent(e);
        }
        return { events, finalText: 'done!', exitCode: 0, durationMs: 5, stderr: '' };
      },
    });
    cleanup.push(async () => {
      await app.close();
      await fsp.rm(tmpProjectRoot, { recursive: true, force: true });
    });
    await app.ready();
    const ws = await app.injectWS(`/api/agent/ws?projectId=${projectId}`);
    try {
      await waitFor(ws, 'ready');
      ws.send(JSON.stringify({ kind: 'turn_start', prompt: 'hi' }));
      const collected = await collectUntil(ws, 'turn_done');
      const kinds = collected.map((m) => m.kind);
      expect(kinds).toEqual(['turn_started', 'turn_event', 'turn_event', 'turn_event', 'turn_done']);
      const eventMessages = collected.filter((m) => m.kind === 'turn_event');
      const eventTypes = eventMessages.map((m) => (m.event as { type: string }).type);
      expect(eventTypes).toEqual(['system', 'assistant', 'result']);
      const done = collected[collected.length - 1]!;
      expect(done.finalText).toBe('done!');
      expect(done.turnCount).toBe(1);
    } finally {
      ws.close();
    }
  });

  it('rejects a second turn_start while one is in flight', async () => {
    let release: (() => void) | undefined;
    const blocker = new Promise<void>((r) => { release = r; });
    const { app, tmpProjectRoot, projectId } = await buildApp({
      runTurn: async (opts) => {
        if (opts.onEvent) opts.onEvent({ type: 'system', data: {} });
        await blocker;
        return { events: [], finalText: '', exitCode: 0, durationMs: 1, stderr: '' };
      },
    });
    cleanup.push(async () => {
      release?.();
      await app.close();
      await fsp.rm(tmpProjectRoot, { recursive: true, force: true });
    });
    await app.ready();
    const ws = await app.injectWS(`/api/agent/ws?projectId=${projectId}`);
    try {
      await waitFor(ws, 'ready');
      ws.send(JSON.stringify({ kind: 'turn_start', prompt: 'first' }));
      await waitFor(ws, 'turn_started');
      ws.send(JSON.stringify({ kind: 'turn_start', prompt: 'second' }));
      const err = await waitFor(ws, 'turn_error');
      expect(err.code).toBe('already_running');
      release?.();
    } finally {
      ws.close();
    }
  });

  it('handles ping → pong', async () => {
    const { app, tmpProjectRoot, projectId } = await buildApp();
    cleanup.push(async () => {
      await app.close();
      await fsp.rm(tmpProjectRoot, { recursive: true, force: true });
    });
    await app.ready();
    const ws = await app.injectWS(`/api/agent/ws?projectId=${projectId}`);
    try {
      await waitFor(ws, 'ready');
      ws.send(JSON.stringify({ kind: 'ping' }));
      const pong = await waitFor(ws, 'pong');
      expect(pong.kind).toBe('pong');
    } finally {
      ws.close();
    }
  });

  it('session_reset issues a new claudeSessionId for subsequent turns', async () => {
    const { app, tmpProjectRoot, projectId } = await buildApp();
    cleanup.push(async () => {
      await app.close();
      await fsp.rm(tmpProjectRoot, { recursive: true, force: true });
    });
    await app.ready();
    const ws = await app.injectWS(`/api/agent/ws?projectId=${projectId}`);
    try {
      const ready = await waitFor(ws, 'ready');
      const initialId = ready.sessionId as string;
      ws.send(JSON.stringify({ kind: 'session_reset' }));
      const reset = await waitFor(ws, 'session_reset');
      expect(reset.sessionId).not.toBe(initialId);
      expect(reset.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    } finally {
      ws.close();
    }
  });

  it('reports turn_error on malformed JSON frames', async () => {
    const { app, tmpProjectRoot, projectId } = await buildApp();
    cleanup.push(async () => {
      await app.close();
      await fsp.rm(tmpProjectRoot, { recursive: true, force: true });
    });
    await app.ready();
    const ws = await app.injectWS(`/api/agent/ws?projectId=${projectId}`);
    try {
      await waitFor(ws, 'ready');
      ws.send('not json {{{');
      const err = await waitFor(ws, 'turn_error');
      expect(err.code).toBe('malformed_message');
    } finally {
      ws.close();
    }
  });
});

describe('POST /api/agent/sessions/:projectId/reset', () => {
  it('resets the agent session so the next turn gets a fresh sessionId', async () => {
    const { app, tmpProjectRoot, projectId } = await buildApp();
    try {
      const a = await app.inject({
        method: 'POST',
        url: '/api/agent/turn',
        payload: { prompt: 'first', projectId },
      });
      const sessIdBefore = (a.json() as { sessionId: string }).sessionId;

      const reset = await app.inject({
        method: 'POST',
        url: `/api/agent/sessions/${projectId}/reset`,
        payload: {},
      });
      expect(reset.statusCode).toBe(200);
      expect(reset.json()).toEqual({ ok: true });

      const b = await app.inject({
        method: 'POST',
        url: '/api/agent/turn',
        payload: { prompt: 'fresh', projectId },
      });
      const sessIdAfter = (b.json() as { sessionId: string }).sessionId;
      expect(sessIdAfter).not.toBe(sessIdBefore);
    } finally {
      await app.close();
      await fsp.rm(tmpProjectRoot, { recursive: true, force: true });
    }
  });
});

describe('POST /api/agent/internal/patches', () => {
  it('creates a pending proposal + returns it as JSON', async () => {
    const { app, tmpProjectRoot, projectId } = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/agent/internal/patches',
        payload: {
          projectRoot: tmpProjectRoot,
          description: 'rename Route 1 to Electric Avenue',
          edits: [
            { kind: 'replace_in_file', filePath: 'data/region_map/sections.h', before: 'Route 1', after: 'Electric Avenue' },
          ],
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        id: string;
        projectId: string;
        status: string;
        edits: { filePath: string }[];
      };
      expect(body.id).toMatch(/^patch_[0-9a-f-]{36}$/);
      expect(body.projectId).toBe(projectId);
      expect(body.status).toBe('pending');
      expect(body.edits[0]?.filePath).toBe('data/region_map/sections.h');
    } finally {
      await app.close();
      await fsp.rm(tmpProjectRoot, { recursive: true, force: true });
    }
  });

  it('returns 404 when projectRoot does not match an open session', async () => {
    const { app, tmpProjectRoot } = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/agent/internal/patches',
        payload: {
          projectRoot: '/nonexistent/project',
          description: 'test',
          edits: [{ kind: 'replace_in_file', filePath: 'a', before: 'x', after: 'y' }],
        },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: 'project_not_open' });
    } finally {
      await app.close();
      await fsp.rm(tmpProjectRoot, { recursive: true, force: true });
    }
  });

  it('rejects edits with path traversal (..)', async () => {
    const { app, tmpProjectRoot } = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/agent/internal/patches',
        payload: {
          projectRoot: tmpProjectRoot,
          description: 'evil',
          edits: [{ kind: 'replace_in_file', filePath: '../../etc/passwd', before: 'x', after: 'y' }],
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'unsafe_edit_path' });
    } finally {
      await app.close();
      await fsp.rm(tmpProjectRoot, { recursive: true, force: true });
    }
  });

  it('rejects absolute paths', async () => {
    const { app, tmpProjectRoot } = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/agent/internal/patches',
        payload: {
          projectRoot: tmpProjectRoot,
          description: 'absolute',
          edits: [{ kind: 'replace_in_file', filePath: '/etc/passwd', before: 'x', after: 'y' }],
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'unsafe_edit_path' });
    } finally {
      await app.close();
      await fsp.rm(tmpProjectRoot, { recursive: true, force: true });
    }
  });

  it('rejects no-op edits where before === after', async () => {
    const { app, tmpProjectRoot } = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/agent/internal/patches',
        payload: {
          projectRoot: tmpProjectRoot,
          description: 'noop',
          edits: [{ kind: 'replace_in_file', filePath: 'a.txt', before: 'hi', after: 'hi' }],
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'noop_edit' });
    } finally {
      await app.close();
      await fsp.rm(tmpProjectRoot, { recursive: true, force: true });
    }
  });

  it('broadcasts patch_proposed to subscribed WS clients for that projectId', async () => {
    const { app, tmpProjectRoot, projectId } = await buildApp();
    try {
      await app.ready();
      const ws = await app.injectWS(`/api/agent/ws?projectId=${projectId}`);
      // Wait for ready to ensure the WS handler subscribed.
      await new Promise<void>((resolve) => {
        ws.on('message', (data: import('ws').RawData) => {
          const parsed = JSON.parse(data.toString()) as { kind: string };
          if (parsed.kind === 'ready') resolve();
        });
      });
      const received: Record<string, unknown>[] = [];
      ws.on('message', (data: import('ws').RawData) => {
        received.push(JSON.parse(data.toString()) as Record<string, unknown>);
      });
      const httpRes = await app.inject({
        method: 'POST',
        url: '/api/agent/internal/patches',
        payload: {
          projectRoot: tmpProjectRoot,
          description: 'rename',
          edits: [{ kind: 'replace_in_file', filePath: 'a.txt', before: 'x', after: 'y' }],
        },
      });
      expect(httpRes.statusCode).toBe(200);
      // Allow the broadcast to land.
      await new Promise((r) => setTimeout(r, 20));
      const proposed = received.find((m) => m.kind === 'patch_proposed');
      expect(proposed).toBeDefined();
      const proposal = (proposed as { proposal: { description: string } }).proposal;
      expect(proposal.description).toBe('rename');
      ws.close();
    } finally {
      await app.close();
      await fsp.rm(tmpProjectRoot, { recursive: true, force: true });
    }
  });
});

describe('POST /api/agent/patches/:proposalId/apply', () => {
  it('writes the edits to disk and marks the proposal applied', async () => {
    const { app, tmpProjectRoot } = await buildApp();
    try {
      await fsp.writeFile(path.join(tmpProjectRoot, 'region.h'), 'gMap = "Route 1";\n', 'utf8');

      const created = await app.inject({
        method: 'POST',
        url: '/api/agent/internal/patches',
        payload: {
          projectRoot: tmpProjectRoot,
          description: 'rename Route 1',
          edits: [{ kind: 'replace_in_file', filePath: 'region.h', before: 'Route 1', after: 'Electric Avenue' }],
        },
      });
      const proposalId = (created.json() as { id: string }).id;

      const applyRes = await app.inject({
        method: 'POST',
        url: `/api/agent/patches/${proposalId}/apply`,
      });
      expect(applyRes.statusCode).toBe(200);
      const applied = applyRes.json() as { status: string; appliedAtUtc: string };
      expect(applied.status).toBe('applied');
      expect(applied.appliedAtUtc).toBeDefined();

      const contents = await fsp.readFile(path.join(tmpProjectRoot, 'region.h'), 'utf8');
      expect(contents).toBe('gMap = "Electric Avenue";\n');

      const opLog = await fsp.readFile(path.join(tmpProjectRoot, '.editor', 'op-log.jsonl'), 'utf8');
      expect(opLog).toContain('"op":"agent_patch_apply"');
      expect(opLog).toContain('"reverseEdits"');
    } finally {
      await app.close();
      await fsp.rm(tmpProjectRoot, { recursive: true, force: true });
    }
  });

  it('returns 400 with editIndex when an edit\'s before-text is missing', async () => {
    const { app, tmpProjectRoot } = await buildApp();
    try {
      await fsp.writeFile(path.join(tmpProjectRoot, 'a.h'), 'has only this text\n', 'utf8');
      const created = await app.inject({
        method: 'POST',
        url: '/api/agent/internal/patches',
        payload: {
          projectRoot: tmpProjectRoot,
          description: 'doomed',
          edits: [{ kind: 'replace_in_file', filePath: 'a.h', before: 'not in file', after: 'x' }],
        },
      });
      const proposalId = (created.json() as { id: string }).id;

      const applyRes = await app.inject({
        method: 'POST',
        url: `/api/agent/patches/${proposalId}/apply`,
      });
      expect(applyRes.statusCode).toBe(400);
      expect(applyRes.json()).toMatchObject({
        error: 'before_not_found',
        editIndex: 0,
        filePath: 'a.h',
      });
    } finally {
      await app.close();
      await fsp.rm(tmpProjectRoot, { recursive: true, force: true });
    }
  });

  it('returns 404 for an unknown proposal id', async () => {
    const { app, tmpProjectRoot } = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/agent/patches/patch_no-such-id/apply',
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: 'proposal_not_found' });
    } finally {
      await app.close();
      await fsp.rm(tmpProjectRoot, { recursive: true, force: true });
    }
  });

  it('returns 409 when applying an already-applied proposal', async () => {
    const { app, tmpProjectRoot } = await buildApp();
    try {
      await fsp.writeFile(path.join(tmpProjectRoot, 'a.h'), 'foo\n', 'utf8');
      const created = await app.inject({
        method: 'POST',
        url: '/api/agent/internal/patches',
        payload: {
          projectRoot: tmpProjectRoot,
          description: 'd',
          edits: [{ kind: 'replace_in_file', filePath: 'a.h', before: 'foo', after: 'bar' }],
        },
      });
      const proposalId = (created.json() as { id: string }).id;
      await app.inject({ method: 'POST', url: `/api/agent/patches/${proposalId}/apply` });
      const second = await app.inject({ method: 'POST', url: `/api/agent/patches/${proposalId}/apply` });
      expect(second.statusCode).toBe(409);
      expect(second.json()).toMatchObject({ error: 'proposal_not_pending', status: 'applied' });
    } finally {
      await app.close();
      await fsp.rm(tmpProjectRoot, { recursive: true, force: true });
    }
  });

  it('broadcasts patch_applied to WS subscribers', async () => {
    const { app, tmpProjectRoot, projectId } = await buildApp();
    try {
      await fsp.writeFile(path.join(tmpProjectRoot, 'a.h'), 'foo\n', 'utf8');
      await app.ready();
      const ws = await app.injectWS(`/api/agent/ws?projectId=${projectId}`);
      await new Promise<void>((resolve) => {
        ws.on('message', (data: import('ws').RawData) => {
          if ((JSON.parse(data.toString()) as { kind: string }).kind === 'ready') resolve();
        });
      });
      const received: Record<string, unknown>[] = [];
      ws.on('message', (data: import('ws').RawData) => {
        received.push(JSON.parse(data.toString()) as Record<string, unknown>);
      });

      const created = await app.inject({
        method: 'POST',
        url: '/api/agent/internal/patches',
        payload: {
          projectRoot: tmpProjectRoot,
          description: 'd',
          edits: [{ kind: 'replace_in_file', filePath: 'a.h', before: 'foo', after: 'bar' }],
        },
      });
      const proposalId = (created.json() as { id: string }).id;
      await app.inject({ method: 'POST', url: `/api/agent/patches/${proposalId}/apply` });
      await new Promise((r) => setTimeout(r, 20));
      const appliedMsg = received.find((m) => m.kind === 'patch_applied');
      expect(appliedMsg).toBeDefined();
      expect(appliedMsg?.proposalId).toBe(proposalId);
      ws.close();
    } finally {
      await app.close();
      await fsp.rm(tmpProjectRoot, { recursive: true, force: true });
    }
  });

  it('rolls back partial writes when a later edit fails', async () => {
    const { app, tmpProjectRoot } = await buildApp();
    try {
      await fsp.writeFile(path.join(tmpProjectRoot, 'a.h'), 'good text\n', 'utf8');
      await fsp.writeFile(path.join(tmpProjectRoot, 'b.h'), 'this does not have the magic\n', 'utf8');

      const created = await app.inject({
        method: 'POST',
        url: '/api/agent/internal/patches',
        payload: {
          projectRoot: tmpProjectRoot,
          description: 'mixed',
          edits: [
            { kind: 'replace_in_file', filePath: 'a.h', before: 'good text', after: 'GREAT TEXT' },
            { kind: 'replace_in_file', filePath: 'b.h', before: 'NOT HERE', after: 'never written' },
          ],
        },
      });
      const proposalId = (created.json() as { id: string }).id;
      const res = await app.inject({
        method: 'POST',
        url: `/api/agent/patches/${proposalId}/apply`,
      });
      expect(res.statusCode).toBe(400);
      // a.h must be untouched after rollback.
      expect(await fsp.readFile(path.join(tmpProjectRoot, 'a.h'), 'utf8')).toBe('good text\n');
    } finally {
      await app.close();
      await fsp.rm(tmpProjectRoot, { recursive: true, force: true });
    }
  });
});

describe('binary_replace_text edit kind (AI-1.4)', () => {
  it('accepts a binary_replace_text proposal and applies it to the project .gba', async () => {
    const { app, tmpProjectRoot } = await buildApp();
    try {
      // Seed a tiny .gba inside the managed project root.
      const { text } = await import('@rom-introspection/engine');
      const buf = Buffer.alloc(2048, 0x00);
      const encoded = text.encodeString('ROUTE 1');
      for (let i = 0; i < encoded.length; i++) buf[0x100 + i] = encoded[i]!;
      buf[0x100 + encoded.length] = 0xff;
      await fsp.writeFile(path.join(tmpProjectRoot, 'test.gba'), buf);

      const created = await app.inject({
        method: 'POST',
        url: '/api/agent/internal/patches',
        payload: {
          projectRoot: tmpProjectRoot,
          description: 'rename ROUTE 1 to LANE 17 in the .gba',
          edits: [
            { kind: 'binary_replace_text', textOffset: 0x100, before: 'ROUTE 1', after: 'LANE 17' },
          ],
        },
      });
      expect(created.statusCode).toBe(200);
      const proposalId = (created.json() as { id: string }).id;

      const applyRes = await app.inject({
        method: 'POST',
        url: `/api/agent/patches/${proposalId}/apply`,
      });
      expect(applyRes.statusCode).toBe(200);

      // Verify the .gba bytes actually changed + decode to LANE 17.
      const finalBuf = await fsp.readFile(path.join(tmpProjectRoot, 'test.gba'));
      expect(text.decodeString(finalBuf, 0x100, 16)).toBe('LANE 17');

      // Op-log entry recorded with reverseEdits carrying slotBytes.
      const opLog = await fsp.readFile(path.join(tmpProjectRoot, '.editor', 'op-log.jsonl'), 'utf8');
      expect(opLog).toContain('"binary_replace_text"');
      expect(opLog).toContain('"slotBytes"');
    } finally {
      await app.close();
      await fsp.rm(tmpProjectRoot, { recursive: true, force: true });
    }
  });

  it('rejects binary edits whose after-text encodes longer than the slot', async () => {
    const { app, tmpProjectRoot } = await buildApp();
    try {
      const { text } = await import('@rom-introspection/engine');
      const buf = Buffer.alloc(2048, 0x00);
      const encoded = text.encodeString('ROUTE 1');
      for (let i = 0; i < encoded.length; i++) buf[0x200 + i] = encoded[i]!;
      buf[0x200 + encoded.length] = 0xff;
      await fsp.writeFile(path.join(tmpProjectRoot, 'test.gba'), buf);

      const created = await app.inject({
        method: 'POST',
        url: '/api/agent/internal/patches',
        payload: {
          projectRoot: tmpProjectRoot,
          description: 'rename ROUTE 1 to ELECTRIC AVENUE (too long)',
          edits: [
            { kind: 'binary_replace_text', textOffset: 0x200, before: 'ROUTE 1', after: 'ELECTRIC AVENUE' },
          ],
        },
      });
      const proposalId = (created.json() as { id: string }).id;

      const applyRes = await app.inject({
        method: 'POST',
        url: `/api/agent/patches/${proposalId}/apply`,
      });
      expect(applyRes.statusCode).toBe(400);
      expect(applyRes.json()).toMatchObject({ error: 'after_too_long' });

      // .gba untouched.
      const finalBuf = await fsp.readFile(path.join(tmpProjectRoot, 'test.gba'));
      expect(text.decodeString(finalBuf, 0x200, 16)).toBe('ROUTE 1');
    } finally {
      await app.close();
      await fsp.rm(tmpProjectRoot, { recursive: true, force: true });
    }
  });
});

describe('POST /api/agent/patches/:proposalId/reject', () => {
  it('marks the proposal rejected and broadcasts patch_rejected', async () => {
    const { app, tmpProjectRoot, projectId } = await buildApp();
    try {
      await app.ready();
      const ws = await app.injectWS(`/api/agent/ws?projectId=${projectId}`);
      await new Promise<void>((resolve) => {
        ws.on('message', (data: import('ws').RawData) => {
          if ((JSON.parse(data.toString()) as { kind: string }).kind === 'ready') resolve();
        });
      });
      const received: Record<string, unknown>[] = [];
      ws.on('message', (data: import('ws').RawData) => {
        received.push(JSON.parse(data.toString()) as Record<string, unknown>);
      });

      const created = await app.inject({
        method: 'POST',
        url: '/api/agent/internal/patches',
        payload: {
          projectRoot: tmpProjectRoot,
          description: 'd',
          edits: [{ kind: 'replace_in_file', filePath: 'a.h', before: 'x', after: 'y' }],
        },
      });
      const proposalId = (created.json() as { id: string }).id;

      const rejectRes = await app.inject({
        method: 'POST',
        url: `/api/agent/patches/${proposalId}/reject`,
      });
      expect(rejectRes.statusCode).toBe(200);
      expect(rejectRes.json()).toMatchObject({ status: 'rejected' });
      await new Promise((r) => setTimeout(r, 20));
      const rejectedMsg = received.find((m) => m.kind === 'patch_rejected');
      expect(rejectedMsg?.proposalId).toBe(proposalId);
      ws.close();
    } finally {
      await app.close();
      await fsp.rm(tmpProjectRoot, { recursive: true, force: true });
    }
  });

  it('returns 409 when rejecting a non-pending proposal', async () => {
    const { app, tmpProjectRoot } = await buildApp();
    try {
      const created = await app.inject({
        method: 'POST',
        url: '/api/agent/internal/patches',
        payload: {
          projectRoot: tmpProjectRoot,
          description: 'd',
          edits: [{ kind: 'replace_in_file', filePath: 'a.h', before: 'x', after: 'y' }],
        },
      });
      const proposalId = (created.json() as { id: string }).id;
      await app.inject({ method: 'POST', url: `/api/agent/patches/${proposalId}/reject` });
      const second = await app.inject({ method: 'POST', url: `/api/agent/patches/${proposalId}/reject` });
      expect(second.statusCode).toBe(409);
    } finally {
      await app.close();
      await fsp.rm(tmpProjectRoot, { recursive: true, force: true });
    }
  });
});

describe('GET /api/agent/projects/:projectId/patches', () => {
  it('returns the pending proposals for a project', async () => {
    const { app, tmpProjectRoot, projectId } = await buildApp();
    try {
      await app.inject({
        method: 'POST',
        url: '/api/agent/internal/patches',
        payload: {
          projectRoot: tmpProjectRoot,
          description: 'first',
          edits: [{ kind: 'replace_in_file', filePath: 'a.txt', before: 'x', after: 'y' }],
        },
      });
      const res = await app.inject({
        method: 'GET',
        url: `/api/agent/projects/${projectId}/patches`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { proposals: { description: string; status: string }[] };
      expect(body.proposals).toHaveLength(1);
      expect(body.proposals[0]?.description).toBe('first');
      expect(body.proposals[0]?.status).toBe('pending');
    } finally {
      await app.close();
      await fsp.rm(tmpProjectRoot, { recursive: true, force: true });
    }
  });
});

describe('GET /api/agent/health', () => {
  it('reports claudeBinary + mcpServerPath', async () => {
    const { app, tmpProjectRoot } = await buildApp({ claudeBinary: '/fake/claude' });
    try {
      const res = await app.inject({ method: 'GET', url: '/api/agent/health' });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { claudeBinary: string | null; mcpServerPath: string; mcpServerExists: boolean };
      expect(body.claudeBinary).toBe('/fake/claude');
      expect(body.mcpServerPath).toMatch(/mcp-server\.(?:ts|js)$/);
      expect(typeof body.mcpServerExists).toBe('boolean');
    } finally {
      await app.close();
      await fsp.rm(tmpProjectRoot, { recursive: true, force: true });
    }
  });
});
