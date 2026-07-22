/**
 * Phase 9A-2 - Worker shim for headless mGBA-WASM in Node.
 *
 * `installWorkerShim()` installs a `Worker` global on `globalThis`
 * that wraps `node:worker_threads.Worker`. The shim adapts:
 *
 *   - Browser semantics (`new Worker(url, { type, name })`,
 *     `addEventListener('message', ...)`, `postMessage(...)`,
 *     `terminate()`) ⇄ Node worker_threads (filename + workerData
 *     + EventEmitter `on('message', ...)`).
 *   - Browser `URL` script targets become a workerData payload
 *     consumed by `worker-bridge.mjs`.
 *
 * The bridge file (`worker-bridge.mjs`) installs browser globals
 * (`self`, `WorkerGlobalScope`, `postMessage`, etc.) inside the
 * spawned worker before dynamic-importing the actual mgba.js
 * module URL.
 *
 * This is the second piece needed for headless mGBA-WASM boot in
 * Node. With this shim installed, `mGBA({ canvas })` should no
 * longer throw `ReferenceError: Worker is not defined`.
 *
 * Threading caveat: mGBA-WASM spawns 5 PThread workers at init.
 * Each worker reloads mgba.js. The bridge file is invoked once
 * per worker spawn; total bootstrap cost is ~1-3 seconds on
 * modern hardware.
 */

import { Worker as NodeWorker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/** Returns a restore function that uninstalls the shim. */
export function installWorkerShim(): () => void {
  const g = globalThis as unknown as Record<string, unknown>;
  if (typeof g.Worker === 'function') {
    // Already installed (or running in a real browser); no-op.
    return () => undefined;
  }

  // Resolve the bridge file's absolute path. In dev (TS source) this
  // points at engine/src/emulator/worker-bridge.mjs. In built dist
  // (engine/dist/emulator/worker-bridge.mjs), it's a sibling of
  // worker-shim.js.
  let bridgePath: string;
  try {
    const here = fileURLToPath(import.meta.url);
    bridgePath = join(dirname(here), 'worker-bridge.mjs');
  } catch {
    // Fallback when import.meta.url isn't available (shouldn't happen
    // in Node ESM but defensive).
    bridgePath = './worker-bridge.mjs';
  }

  /**
   * Browser-shaped Worker class. Extends NodeWorker to inherit
   * `postMessage` + `terminate` (which already match the browser
   * shape), and bridges `addEventListener('message', ...)` to
   * NodeWorker's EventEmitter `on('message', ...)`.
   */
  class BrowserWorker extends NodeWorker {
    public onmessage: ((event: { data: unknown }) => void) | null = null;
    public onerror: ((event: { message: string }) => void) | null = null;
    private readonly _listeners = new Map<string, Set<(event: unknown) => void>>();

    constructor(scriptURL: URL | string, options?: { type?: string; name?: string }) {
      const urlString = scriptURL instanceof URL ? scriptURL.href : String(scriptURL);
      super(bridgePath, {
        workerData: {
          scriptURL: urlString,
          workerName: options?.name ?? '',
        },
        // Surface worker stdout/stderr for diagnostics during Phase
        // 9A-2 bring-up. Once the live boot is stable we can quiet
        // these by setting them to false.
        stdout: false,
        stderr: false,
      });
      // Phase 9A-2 diagnostic: pipe worker stderr to main thread
      // stderr so we can see why workers fail without explicit error
      // events.
      if (process.env.MGBA_NODE_DEBUG === '1') {
        this.stderr.pipe(process.stderr);
        this.stdout.pipe(process.stdout);
      }

      // Bridge NodeWorker 'message' → BrowserWorker { data } shape.
      this.on('message', (data) => {
        const event = { data };
        this._dispatch('message', event);
        if (typeof this.onmessage === 'function') {
          try {
            this.onmessage(event);
          } catch (e) {
            // Don't let the user's onmessage throw kill the worker.
            // eslint-disable-next-line no-console
            console.error('[BrowserWorker] onmessage threw:', e);
          }
        }
      });

      this.on('error', (err) => {
        const event = { message: err?.message ?? String(err) };
        this._dispatch('error', event);
        if (typeof this.onerror === 'function') {
          try {
            this.onerror(event);
          } catch {
            /* swallow */
          }
        }
      });
    }

    addEventListener(name: string, listener: (event: unknown) => void): void {
      let arr = this._listeners.get(name);
      if (!arr) {
        arr = new Set();
        this._listeners.set(name, arr);
      }
      arr.add(listener);
    }

    removeEventListener(name: string, listener: (event: unknown) => void): void {
      this._listeners.get(name)?.delete(listener);
    }

    dispatchEvent(event: { type: string }): boolean {
      this._dispatch(event.type, event);
      return true;
    }

    private _dispatch(name: string, event: unknown): void {
      const arr = this._listeners.get(name);
      if (!arr) return;
      for (const l of arr) {
        try {
          l(event);
        } catch (e) {
          // eslint-disable-next-line no-console
          console.error(`[BrowserWorker] ${name} listener threw:`, e);
        }
      }
    }
  }

  g.Worker = BrowserWorker as unknown;

  return () => {
    if (g.Worker === BrowserWorker) {
      delete g.Worker;
    }
  };
}
