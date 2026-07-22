// Local startup orchestrator for the ROM editor.
//
// Steps:
//   1. Verify Node 22.x
//   2. npm install (only if app/node_modules is missing)
//   3. Build app/shared once (backend + frontend resolve @rom-editor/shared via its dist)
//   4. Start backend in the background; wait until /api/health returns 200
//   5. Start frontend dev server; open http://localhost:5173 in the default browser
//   6. Stream both processes' stdout/stderr to this terminal, prefixed by source
//   7. On Ctrl+C, gracefully terminate both children before exiting
//
// Usage: `node scripts/start.mjs` from the project root.
//        (start.ps1 / start.bat at the project root are thin wrappers.)

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const APP_DIR = path.join(PROJECT_ROOT, 'app');

const BACKEND_PORT = Number(process.env.PORT ?? 8717);
const FRONTEND_URL = 'http://localhost:5173';
const HEALTH_URL = `http://127.0.0.1:${BACKEND_PORT}/api/health`;
const HEALTH_TIMEOUT_MS = 30_000;

// Phase 8A-2 - Tile-intel storage tier (Postgres + Qdrant).
//
// Brought up via docker-compose.yml at the repo root. The Python
// sidecar (8A-3) connects to these from outside the container. If
// Docker isn't present or compose-up fails, the orchestrator emits a
// warning and continues - the tile-intel tools degrade gracefully
// via the supervisor (8A-4).
const TILE_INTEL_PG_PORT = 15432;
const TILE_INTEL_QDRANT_PORT = 16333;
const TILE_INTEL_HEALTH_TIMEOUT_MS = 45_000;
const SKIP_TILE_INTEL = process.env.SKIP_TILE_INTEL === '1';

const COLORS = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
};

function log(prefix, color, msg) {
  process.stdout.write(`${color}[${prefix}]${COLORS.reset} ${msg}\n`);
}
function step(msg) { log('start', COLORS.cyan, msg); }
function warn(msg) { log('start', COLORS.yellow, msg); }
function fail(msg) { log('start', COLORS.red, msg); }
function ok(msg)   { log('start', COLORS.green, msg); }

function checkNodeVersion() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major !== 22) {
    fail(`Node 22 LTS required. You're on Node ${process.versions.node}. See app/package.json engines.`);
    fail(`Install Node 22 from https://nodejs.org or via nvm-windows: \`nvm install 22\` && \`nvm use 22\`.`);
    process.exit(1);
  }
  ok(`Node ${process.versions.node} (v22.x) - OK`);
}

function run(cmd, args, cwd, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      shell: process.platform === 'win32',
      stdio: opts.silent ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
    let out = '';
    let err = '';
    if (opts.silent) {
      child.stdout.on('data', (b) => { out += b.toString(); });
      child.stderr.on('data', (b) => { err += b.toString(); });
    }
    child.on('exit', (code) => {
      if (code === 0) resolve({ out, err });
      else {
        if (opts.silent && err.trim()) process.stderr.write(err);
        reject(new Error(`${cmd} ${args.join(' ')} exited with code ${code}`));
      }
    });
    child.on('error', reject);
  });
}

async function maybeInstall() {
  if (existsSync(path.join(APP_DIR, 'node_modules'))) {
    ok('app/node_modules present - skipping npm install');
    return;
  }
  step('app/node_modules missing - running `npm install` (this may take a minute or two)');
  await run('npm', ['install'], APP_DIR);
}

async function buildShared() {
  step('Building app/shared (so backend + frontend can resolve @rom-editor/shared dist)');
  await run('npm', ['run', 'build', '--workspace', '@rom-editor/shared'], APP_DIR);
  ok('Shared package built');
}

/** Best-effort detection that the `docker` CLI exists on PATH and
 *  responds. Returns true on a clean `docker --version`, false
 *  otherwise. Never throws - this is a probe. */
async function dockerAvailable() {
  try {
    const result = await run('docker', ['--version'], PROJECT_ROOT, { silent: true });
    return /^docker version/i.test(result.out.trim());
  } catch {
    return false;
  }
}

/** Poll TCP loopback on `port`; resolve once a connect succeeds.
 *  Used to wait on Postgres + Qdrant without depending on `pg_isready`
 *  or `curl` being installed on the host. The Docker healthchecks
 *  inside the containers do the deep check; this probe just confirms
 *  the published port is accepting connections. */
async function waitForTcp(port, timeoutMs, label) {
  const { createConnection } = await import('node:net');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const isUp = await new Promise((resolve) => {
      const socket = createConnection({ host: '127.0.0.1', port, timeout: 1500 }, () => {
        socket.end();
        resolve(true);
      });
      socket.on('error', () => resolve(false));
      socket.on('timeout', () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (isUp) {
      ok(`${label} on 127.0.0.1:${port} - ready`);
      return true;
    }
    await new Promise((r) => setTimeout(r, 750));
  }
  warn(`${label} on 127.0.0.1:${port} did not become ready within ${timeoutMs}ms.`);
  return false;
}

/** Optional Phase 8 storage tier. Runs `docker compose up -d` if
 *  Docker is available, then waits up to TILE_INTEL_HEALTH_TIMEOUT_MS
 *  for Postgres + Qdrant. NEVER blocks the rest of startup - failures
 *  here downgrade to a warning and tile-intel tools become
 *  unavailable gracefully. */
async function maybeStartTileIntelStack() {
  if (SKIP_TILE_INTEL) {
    warn('SKIP_TILE_INTEL=1 - skipping tile-intel storage tier.');
    return;
  }
  const composeFile = path.join(PROJECT_ROOT, 'docker-compose.yml');
  if (!existsSync(composeFile)) {
    warn(`docker-compose.yml not found at ${composeFile} - skipping tile-intel stack.`);
    return;
  }
  if (!(await dockerAvailable())) {
    warn(
      'Docker not available on PATH - skipping tile-intel storage tier. ' +
        'Install Docker Desktop + relaunch to enable tileset-intelligence tools.',
    );
    return;
  }
  step('Bringing up tile-intel storage tier (Postgres + Qdrant)…');
  try {
    await run('docker', ['compose', '-f', composeFile, 'up', '-d'], PROJECT_ROOT, { silent: true });
  } catch (e) {
    warn(
      `docker compose up failed (${e instanceof Error ? e.message : String(e)}). ` +
        'Tile-intelligence tools will be unavailable this session.',
    );
    return;
  }
  const [pgOk, qdrantOk] = await Promise.all([
    waitForTcp(TILE_INTEL_PG_PORT, TILE_INTEL_HEALTH_TIMEOUT_MS, 'Postgres'),
    waitForTcp(TILE_INTEL_QDRANT_PORT, TILE_INTEL_HEALTH_TIMEOUT_MS, 'Qdrant'),
  ]);
  if (pgOk && qdrantOk) {
    ok('Tile-intel storage tier is up.');
  } else {
    warn(
      'Tile-intel storage tier did not fully come up - tile-intelligence tools ' +
        'will degrade to unavailable. Inspect with: docker compose -f docker-compose.yml logs',
    );
  }
}

async function buildEngine() {
  // The backend imports `@rom-introspection/engine` via the package's
  // `main` field, which points at `engine/dist/index.js`. Source-only
  // changes in `engine/src/**` don't propagate to running backends
  // (tsx watches the BACKEND src, not the engine) - so we rebuild the
  // engine on every start. Fast incremental: tsc only recompiles files
  // whose inputs changed.
  step('Building engine (so backend resolves @rom-introspection/engine dist)');
  await run('npm', ['run', 'build'], path.join(PROJECT_ROOT, 'engine'));
  ok('Engine package built');
}

function pipeWithPrefix(child, prefix, color) {
  const tag = `${color}[${prefix}]${COLORS.reset}`;
  for (const stream of ['stdout', 'stderr']) {
    const rl = readline.createInterface({ input: child[stream] });
    rl.on('line', (line) => process.stdout.write(`${tag} ${line}\n`));
  }
}

async function waitForHealth() {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt++;
    try {
      const res = await fetch(HEALTH_URL);
      if (res.ok) {
        ok(`Backend healthy at ${HEALTH_URL} (after ${attempt} attempt${attempt === 1 ? '' : 's'})`);
        return;
      }
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Backend did not become healthy within ${HEALTH_TIMEOUT_MS}ms at ${HEALTH_URL}`);
}

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? 'start' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['', url] : [url];
  try {
    spawn(cmd, args, { shell: process.platform === 'win32', detached: true, stdio: 'ignore' }).unref();
    ok(`Opened ${url} in your default browser`);
  } catch {
    warn(`Could not auto-open browser. Open ${url} manually.`);
  }
}

let backendChild = null;
let frontendChild = null;
let shuttingDown = false;

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  step('Shutting down…');
  for (const c of [backendChild, frontendChild]) {
    if (c && !c.killed) {
      try {
        // SIGTERM lets the child exit cleanly; on Windows it maps to a hard kill,
        // which is fine because the dev servers don't hold persistent state.
        c.kill('SIGTERM');
      } catch {
        // ignore
      }
    }
  }
  // Give children a moment to flush their stdout, then exit.
  setTimeout(() => process.exit(code), 250);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

async function main() {
  step('ROM editor - local startup orchestrator');
  step(`Project root: ${PROJECT_ROOT}`);
  checkNodeVersion();
  await maybeInstall();
  await buildShared();
  await buildEngine();
  await maybeStartTileIntelStack();

  step(`Starting backend on http://127.0.0.1:${BACKEND_PORT}`);
  backendChild = spawn('npm', ['--workspace', '@rom-editor/backend', 'run', 'dev'], {
    cwd: APP_DIR,
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(BACKEND_PORT) },
  });
  pipeWithPrefix(backendChild, 'backend', COLORS.magenta);
  backendChild.on('exit', (code) => {
    if (!shuttingDown) {
      fail(`Backend exited unexpectedly (code ${code}). Stopping frontend too.`);
      shutdown(code ?? 1);
    }
  });

  try {
    await waitForHealth();
  } catch (e) {
    fail(e.message);
    shutdown(1);
    return;
  }

  step(`Starting frontend on ${FRONTEND_URL}`);
  frontendChild = spawn('npm', ['--workspace', '@rom-editor/frontend', 'run', 'dev'], {
    cwd: APP_DIR,
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, BACKEND_PORT: String(BACKEND_PORT) },
  });
  pipeWithPrefix(frontendChild, 'frontend', COLORS.cyan);
  frontendChild.on('exit', (code) => {
    if (!shuttingDown) {
      fail(`Frontend exited unexpectedly (code ${code}). Stopping backend too.`);
      shutdown(code ?? 1);
    }
  });

  // Vite logs "ready in Xms" then "Local: http://localhost:5173" on stdout.
  // Wait a short beat for the dev server to bind, then open the browser.
  setTimeout(() => openBrowser(FRONTEND_URL), 1_500);

  ok('Both services running. Press Ctrl+C to stop.');
  ok(`Frontend: ${FRONTEND_URL}`);
  ok(`Backend health: ${HEALTH_URL}`);
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
  shutdown(1);
});
