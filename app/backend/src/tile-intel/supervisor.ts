/**
 * Phase 8A-4 - Tile-intel sidecar supervisor.
 *
 * Owns the Python sidecar's lifecycle on behalf of the Node
 * backend.  Mirrors the patterns in `app/backend/src/agent/spawner.ts`:
 * lazy-spawn, killProcessTree-on-shutdown, structured error
 * surfacing.
 *
 *  - First `ensureReady()` call spawns the Python process via
 *    `uv run uvicorn`, polls /health until it 200s or the budget
 *    expires, and caches the resulting client.
 *  - Subsequent calls return the cached client (or the cached
 *    unavailable status, regenerated for transient reasons).
 *  - Every 30 s while ready, a background heartbeat refreshes the
 *    cache so the sidecar doesn't idle out during autonomous
 *    overnight runs.
 *  - `shutdown()` kills the process tree (the `cmd.exe` Windows
 *    shell wrapper that hosts uvicorn on Windows AND its child
 *    Python process).
 *
 * Windows AppContainer note: when bash is running under Claude's
 * sandbox, uv's auto-downloaded Python install lands in a
 * virtualized AppData path that uv can't re-find on subsequent
 * runs. The supervisor sets `UV_PYTHON_INSTALL_DIR` to a non-
 * sandboxed path before spawning, mirroring the workaround
 * documented in `tile-intel-svc/README.md`.
 */

import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { killProcessTree, spawnCompat } from '../agent/spawn-compat.js';
import { TileIntelClient, type FetchLike } from './client.js';
import {
  EXPECTED_SIDECAR_API_VERSION,
  type TileIntelReady,
  type TileIntelStatus,
  type TileIntelUnavailable,
} from './types.js';

const DEFAULT_PORT = 58080;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

export interface TileIntelSupervisorOptions {
  /** Path to `tile-intel-svc/` (the uv-managed Python project root). */
  readonly sidecarRoot: string;
  /** Override host (default 127.0.0.1). */
  readonly host?: string;
  /** Override port (default 58080). */
  readonly port?: number;
  /** Maximum wall time to wait for the first /health 200 (ms).
   *  Default 30000. */
  readonly startupTimeoutMs?: number;
  /** Heartbeat interval (ms) - once started, the supervisor pings
   *  /health every N ms to keep the process warm. 0 disables.
   *  Default 30000. */
  readonly heartbeatIntervalMs?: number;
  /** Inject a custom spawn function (for tests). */
  readonly spawnFn?: typeof spawnCompat;
  /** Inject a custom fetch function (for tests). Uses the same
   *  structural `FetchLike` shape as `TileIntelClient` so the mock
   *  in `__mocks__/sidecar.ts` satisfies both injection points. */
  readonly fetchFn?: FetchLike;
  /** When true, never spawn - used by tools at module load to check
   *  whether the sidecar is already running externally. */
  readonly attachOnly?: boolean;
}

type SpawnState =
  | { kind: 'idle' }
  | { kind: 'starting'; startedAtMs: number; child: ChildProcessWithoutNullStreams | null }
  | { kind: 'ready'; ready: TileIntelReady; child: ChildProcessWithoutNullStreams | null }
  | { kind: 'failed'; failure: TileIntelUnavailable; child: ChildProcessWithoutNullStreams | null };

export class TileIntelSupervisor {
  private readonly host: string;
  private readonly port: number;
  private readonly startupTimeoutMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly spawnFn: typeof spawnCompat;
  private readonly fetchFn: FetchLike;
  private readonly attachOnly: boolean;
  private state: SpawnState = { kind: 'idle' };
  private pending: Promise<TileIntelStatus> | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: TileIntelSupervisorOptions) {
    this.host = opts.host ?? DEFAULT_HOST;
    this.port = opts.port ?? DEFAULT_PORT;
    this.startupTimeoutMs = opts.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.spawnFn = opts.spawnFn ?? spawnCompat;
    // Default to the global fetch, narrowed to FetchLike. The global
    // fetch's `Response` is structurally compatible with FetchLike's
    // {ok,status,json,text} response shape.
    this.fetchFn =
      opts.fetchFn ??
      (((input, init) => fetch(input, init)) as FetchLike);
    this.attachOnly = opts.attachOnly ?? false;
  }

  /** Path the supervisor talks to. Useful for tests + logging. */
  get baseUrl(): string {
    return `http://${this.host}:${String(this.port)}`;
  }

  /** Build a TileIntelClient configured with this supervisor's
   *  fetchFn. Tests inject a stub fetchFn at construction; routes
   *  use this getter so the same stub flows into every HTTP call
   *  without each call site re-constructing the client. */
  client(): TileIntelClient {
    return new TileIntelClient(this.baseUrl, this.fetchFn);
  }

  /** Returns the current sidecar status. Starts the sidecar if not
   *  already started; reuses cached state for concurrent callers. */
  async ensureReady(): Promise<TileIntelStatus> {
    if (this.state.kind === 'ready') return this.state.ready;
    if (this.pending) return this.pending;
    this.pending = (async () => {
      try {
        return await this.startOrAttach();
      } finally {
        this.pending = null;
      }
    })();
    return this.pending;
  }

  /** Stop the sidecar + clear caches. Idempotent. */
  async shutdown(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.state.kind === 'starting' || this.state.kind === 'ready' || this.state.kind === 'failed') {
      const child = this.state.child;
      if (child) await killProcessTree(child);
    }
    this.state = { kind: 'idle' };
  }

  /** First, try to attach to an already-running sidecar on this
   *  port (covers the case where the user started one manually).
   *  Otherwise, spawn one ourselves - unless attachOnly was set. */
  private async startOrAttach(): Promise<TileIntelStatus> {
    const attached = await this.probeOnce();
    if (attached.kind === 'ok') {
      const ready = await this.consolidateReady(null, attached.health);
      this.installHeartbeat();
      return ready;
    }
    if (this.attachOnly) {
      const failure: TileIntelUnavailable = {
        available: false,
        reason: 'sidecar_offline',
        details: `attachOnly=true and no sidecar reachable at ${this.baseUrl}`,
      };
      this.state = { kind: 'failed', failure, child: null };
      return failure;
    }
    return this.spawnAndWait();
  }

  /** Issue ONE GET /health attempt, with a short timeout. Returns a
   *  small tagged result instead of throwing so callers can branch
   *  cleanly. */
  private async probeOnce(): Promise<
    | { kind: 'ok'; health: { ok: boolean; schema_version: number; api_version: number } }
    | { kind: 'unreachable' }
  > {
    // FetchLike's init type doesn't carry an AbortSignal slot (the
    // mock doesn't need it), so we just rely on FastAPI's quick
    // response time for /health. If startup becomes a flake source
    // we'll switch to a timed-out Promise.race here.
    try {
      const response = await this.fetchFn(`${this.baseUrl}/health`, {
        method: 'GET',
      });
      if (!response.ok) return { kind: 'unreachable' };
      const body = (await response.json()) as {
        ok: boolean;
        schema_version: number;
        api_version: number;
      };
      if (!body.ok) return { kind: 'unreachable' };
      return { kind: 'ok', health: body };
    } catch {
      return { kind: 'unreachable' };
    }
  }

  /** Validate api_version + fetch /v1/version + cache as `ready`. */
  private async consolidateReady(
    child: ChildProcessWithoutNullStreams | null,
    health: { ok: boolean; schema_version: number; api_version: number },
  ): Promise<TileIntelStatus> {
    if (health.api_version !== EXPECTED_SIDECAR_API_VERSION) {
      const failure: TileIntelUnavailable = {
        available: false,
        reason: 'version_mismatch',
        expected: EXPECTED_SIDECAR_API_VERSION,
        observed: health.api_version,
      };
      this.state = { kind: 'failed', failure, child };
      return failure;
    }
    const client = new TileIntelClient(this.baseUrl, this.fetchFn);
    let version;
    try {
      version = await client.version();
    } catch (e) {
      const failure: TileIntelUnavailable = {
        available: false,
        reason: 'sidecar_offline',
        details: `fetched /v1/version after /health 200: ${e instanceof Error ? e.message : String(e)}`,
      };
      this.state = { kind: 'failed', failure, child };
      return failure;
    }
    const ready: TileIntelReady = {
      available: true,
      baseUrl: this.baseUrl,
      health,
      version,
    };
    this.state = { kind: 'ready', ready, child };
    return ready;
  }

  /** Spawn the Python process via uv + uvicorn, then poll /health
   *  until ready or budget expires. */
  private async spawnAndWait(): Promise<TileIntelStatus> {
    if (!existsSync(this.opts.sidecarRoot)) {
      const failure: TileIntelUnavailable = {
        available: false,
        reason: 'sidecar_offline',
        details: `sidecar root does not exist: ${this.opts.sidecarRoot}`,
      };
      this.state = { kind: 'failed', failure, child: null };
      return failure;
    }

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      // Documented workaround for Windows AppContainer path
      // virtualization (see tile-intel-svc/README.md).
      UV_PYTHON_INSTALL_DIR:
        process.env.UV_PYTHON_INSTALL_DIR ?? join(homedir(), '.uv', 'python'),
      TILE_INTEL_HOST: this.host,
      TILE_INTEL_PORT: String(this.port),
    };

    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.spawnFn(
        'uv',
        [
          'run',
          'uvicorn',
          'tile_intel.app:app',
          '--host',
          this.host,
          '--port',
          String(this.port),
          '--log-level',
          process.env.TILE_INTEL_LOG_LEVEL ?? 'warning',
        ],
        {
          cwd: this.opts.sidecarRoot,
          env,
        },
      );
    } catch (e) {
      const failure: TileIntelUnavailable = {
        available: false,
        reason: 'sidecar_offline',
        details: `spawn failed: ${e instanceof Error ? e.message : String(e)}`,
      };
      this.state = { kind: 'failed', failure, child: null };
      return failure;
    }

    child.on('exit', (code) => {
      // If we observed an exit while still in 'starting' or 'ready',
      // mark failed so the next ensureReady() retries.
      if (this.state.kind === 'starting' || this.state.kind === 'ready') {
        this.state = {
          kind: 'failed',
          failure: {
            available: false,
            reason: 'sidecar_crashed',
            details: `sidecar process exited with code ${String(code)}`,
          },
          child: null,
        };
        if (this.heartbeatTimer) {
          clearInterval(this.heartbeatTimer);
          this.heartbeatTimer = null;
        }
      }
    });

    this.state = { kind: 'starting', startedAtMs: Date.now(), child };

    const deadline = Date.now() + this.startupTimeoutMs;
    while (Date.now() < deadline) {
      // Bail out early if the process already died.
      if (child.exitCode !== null) {
        const failure: TileIntelUnavailable = {
          available: false,
          reason: 'sidecar_crashed',
          details: `sidecar exited during startup with code ${String(child.exitCode)}`,
        };
        this.state = { kind: 'failed', failure, child: null };
        return failure;
      }
      const probe = await this.probeOnce();
      if (probe.kind === 'ok') {
        const ready = await this.consolidateReady(child, probe.health);
        this.installHeartbeat();
        return ready;
      }
      await new Promise((r) => setTimeout(r, 500));
    }

    // Budget exceeded - kill the process tree and surface a warming-up
    // status so callers know retrying might help.
    await killProcessTree(child);
    const failure: TileIntelUnavailable = {
      available: false,
      reason: 'warming_up',
      etaSeconds: Math.round(this.startupTimeoutMs / 1000),
    };
    this.state = { kind: 'failed', failure, child: null };
    return failure;
  }

  /** Keep the sidecar warm so autonomous overnight runs don't pay
   *  the cold-start cost on every tool call. */
  private installHeartbeat(): void {
    if (this.heartbeatIntervalMs <= 0) return;
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      this.probeOnce().catch(() => undefined);
    }, this.heartbeatIntervalMs);
    // Don't keep the event loop alive for the heartbeat alone.
    this.heartbeatTimer.unref?.();
  }
}

/** Default supervisor singleton - Phase 8A-4 wires this into the
 *  backend's startup so a single sidecar process serves the whole
 *  Node session. */
let defaultSupervisor: TileIntelSupervisor | null = null;
export function getDefaultTileIntelSupervisor(
  sidecarRoot: string = resolve(process.cwd(), '../../tile-intel-svc'),
  opts: Omit<TileIntelSupervisorOptions, 'sidecarRoot'> = {},
): TileIntelSupervisor {
  if (!defaultSupervisor) {
    defaultSupervisor = new TileIntelSupervisor({ sidecarRoot, ...opts });
  }
  return defaultSupervisor;
}
export function resetDefaultTileIntelSupervisor(): void {
  defaultSupervisor = null;
}
