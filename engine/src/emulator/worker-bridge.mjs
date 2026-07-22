/**
 * Phase 9A-2 - Worker bridge script.
 *
 * This file runs INSIDE each Node worker_threads worker spawned by
 * the Worker shim. Its job: install the browser globals Emscripten
 * expects (`self`, `WorkerGlobalScope`, `postMessage`,
 * `addEventListener`, `close`, `location`, and a minimal canvas
 * shim) BEFORE the worker-side mgba.js code runs.
 *
 * The original `scriptURL` (the mgba.js URL the main thread asked
 * Worker to load) is passed via `workerData.scriptURL`. We
 * dynamic-import it after the browser shims are in place.
 *
 * The `name` field that Emscripten checks for `em-pthread` is
 * forwarded via `workerData.workerName`.
 *
 * Why a separate file (not eval'd inline): Node Worker's
 * `{ eval: true }` mode runs the string as CommonJS by default
 * and ESM top-level-await doesn't work cleanly there. A real .mjs
 * bridge file gives us proper ESM semantics + dynamic import.
 */

import { parentPort, workerData } from 'node:worker_threads';

const DEBUG = process.env.MGBA_NODE_DEBUG === '1';
const log = (msg) => {
  if (DEBUG) process.stderr.write(`[bridge:${workerData?.workerName ?? '?'}] ${msg}\n`);
};

log(`bridge starting; scriptURL=${workerData?.scriptURL}`);

// ---- Browser-global installation ----

globalThis.self = globalThis;

// WorkerGlobalScope is what Emscripten checks via
// `typeof WorkerGlobalScope != 'undefined'` to detect worker
// environments. The constructor doesn't need to do anything.
class WorkerGlobalScope {}
globalThis.WorkerGlobalScope = WorkerGlobalScope;

// `self.name === 'em-pthread'` is what Emscripten checks for
// ENVIRONMENT_IS_PTHREAD. Use defineProperty so the assignment
// in `mgba.js`'s init-thread code can't silently overwrite it.
Object.defineProperty(globalThis.self, 'name', {
  value: workerData?.workerName ?? '',
  writable: true,
  configurable: true,
  enumerable: true,
});

// postMessage / addEventListener / removeEventListener bridge to
// parentPort. The Emscripten worker code reads input messages via
// addEventListener('message', ...) and posts output via
// postMessage(...).
const messageListeners = new Set();
globalThis.postMessage = (msg, transfer) => {
  if (parentPort) {
    parentPort.postMessage(msg, transfer);
  }
};
globalThis.addEventListener = (name, listener) => {
  if (name === 'message') {
    messageListeners.add(listener);
  }
  // Other event types (error, unhandledrejection, etc.) are no-ops.
};
globalThis.removeEventListener = (name, listener) => {
  if (name === 'message') {
    messageListeners.delete(listener);
  }
};
if (parentPort) {
  parentPort.on('message', (data) => {
    for (const l of messageListeners) {
      try {
        l({ data });
      } catch (e) {
        // Don't let one listener kill the others.
        // eslint-disable-next-line no-console
        console.error('[mgba-worker] listener threw:', e);
      }
    }
  });
}

// `close()` exits the worker. Emscripten calls this on cleanup.
globalThis.close = () => {
  process.exit(0);
};

// `location` is sometimes read for URL resolution.
try {
  globalThis.location = new URL(workerData?.scriptURL ?? 'file:///');
} catch {
  // Best effort - Emscripten doesn't depend on this strictly.
}

// requestAnimationFrame for the worker's main loop polyfill.
if (typeof globalThis.requestAnimationFrame !== 'function') {
  globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 16);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
}

// Minimal HTMLCanvasElement so any `instanceof` probe doesn't blow up
// inside the worker. The worker doesn't actually render; it runs
// pthread emulation work.
if (typeof globalThis.HTMLCanvasElement === 'undefined') {
  class FakeHTMLCanvasElement {}
  globalThis.HTMLCanvasElement = FakeHTMLCanvasElement;
}

// ---- Now load the actual script ----

log('globals installed; importing scriptURL');
try {
  await import(workerData.scriptURL);
  log('scriptURL imported OK');
} catch (e) {
  // Surface the failure so the main-thread Worker constructor sees
  // an 'error' event instead of a hung worker.
  if (parentPort) {
    parentPort.postMessage({ __workerBridgeError: String(e?.stack ?? e) });
  }
  throw e;
}
