import Fastify from 'fastify';
import type { FastifyInstance, FastifyServerOptions } from 'fastify';
import websocketPlugin from '@fastify/websocket';
import { registerHealthRoute } from './routes/health.js';
import { registerProjectsRoute } from './routes/projects.js';
import { registerAgentRoute } from './routes/agent.js';
import { registerTileIntelRoute } from './routes/tile-intel.js';
import { ProjectSessionStore } from './projects/session-store.js';

export interface CreateServerOptions {
  readonly logger?: FastifyServerOptions['logger'];
}

export async function createServer(options: CreateServerOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? { level: 'info' },
  });

  const sessionStore = new ProjectSessionStore();

  // websocketPlugin must be registered before any route that uses
  // `{ websocket: true }`, and must live on the top-level app so
  // app.injectWS works in tests.
  await app.register(websocketPlugin);
  await app.register(registerHealthRoute);
  await app.register(registerProjectsRoute, { sessionStore });
  await app.register(registerAgentRoute, { sessionStore });
  await app.register(registerTileIntelRoute, { sessionStore });

  return app;
}
