/**
 * Phase 9A - Headless mGBA-WASM in Node.
 *
 * `createEmulator()` is the engine-facing factory that produces an
 * `EmulatorHandle`. Under the hood it loads `@thenick775/mgba-wasm`
 * and wires it through the Node-compatible shims in `dom-shims.ts`.
 *
 * **Current status (Phase 9A initial commit).** The mGBA-WASM build
 * shipped by `@thenick775/mgba-wasm` v2.4.1 uses Emscripten's PThread
 * support - it spawns 5 web workers at init to host parallel
 * pthreads. Bridging this to Node's `worker_threads` requires:
 *
 *   1. A `Worker` global that wraps `worker_threads.Worker` and
 *      adapts the browser EventTarget shape to Node's EventEmitter.
 *   2. A worker-side boot script that installs browser globals
 *      (`self`, `postMessage`, `addEventListener`, `WorkerGlobalScope`)
 *      INSIDE each spawned worker before `mgba.js` runs again.
 *
 * Both pieces are tracked as a follow-up sub-phase. For now,
 * `createEmulator()` attempts the boot, and on the inevitable
 * `Worker is not defined` ReferenceError throws a typed
 * `EmulatorUnavailableError` so callers can gracefully degrade.
 *
 * Why land the scaffold anyway: the `EmulatorHandle` contract is what
 * Phase 9D (move-animation preview) and the Phase 8J-1 mGBA-WASM
 * smoke-boot upgrade speak to. Shipping the contract now means those
 * features can be coded against a stable interface even before the
 * live boot is wired.
 */

import {
  EmulatorUnavailableError,
  type EmulatorHandle,
  type GbaButton,
} from './types.js';
import { installGlobals, type InstalledGlobals } from './dom-shims.js';
import { installWorkerShim } from './worker-shim.js';
import {
  buildOffsetTable,
  findRomBaseInHeap,
  readGbaMemory,
  type HeapOffsets,
} from './heap-readers.js';
import {
  GBA_FRAMEBUFFER_RGBA_LENGTH,
  decodeMgbaScreenshotToRgba,
} from './framebuffer-readers.js';

// We type the mGBA module loosely here to avoid taking a hard
// compile-time dependency on a dom-only `.d.ts` file. The real type
// shape is documented in `@thenick775/mgba-wasm/dist/mgba.d.ts` and
// the methods accessed below are stable across the 2.x line.
type MgbaModule = {
  FS: {
    writeFile(path: string, data: Uint8Array | string): void;
    readFile(path: string, opts?: { encoding?: 'utf8' | 'binary' }): Uint8Array;
    unlink?(path: string): void;
    readdir?(path: string): string[];
    mkdir?(path: string): void;
    stat?(path: string): { mode: number; size: number };
  };
  HEAPU8: Uint8Array;
  FSInit: () => Promise<void>;
  filePaths: () => {
    root: string;
    gamePath: string;
    savePath: string;
    saveStatePath: string;
    screenshotsPath: string;
    autosave: string;
  };
  loadGame: (romPath: string, savePathOverride?: string) => boolean;
  buttonPress: (name: string) => void;
  buttonUnpress: (name: string) => void;
  pauseGame: () => void;
  resumeGame: () => void;
  quitGame: () => void;
  quitMgba: () => void;
  screenshot: (fileName?: string) => boolean;
  forceAutoSaveState: () => boolean;
  getAutoSaveState: () => { autoSaveStateName: string; data: Uint8Array } | null;
  uploadAutoSaveState: (name: string, data: Uint8Array) => Promise<void>;
  addCoreCallbacks: (cbs: { videoFrameEndedCallback?: () => void }) => void;
  setMainLoopTiming: (mode: number, value: number) => void;
  version: { projectName: string; projectVersion: string };
};

type MgbaFactory = (opts: { canvas: unknown }) => Promise<MgbaModule>;

/**
 * Options for `createEmulator()`. All optional; the defaults are
 * what we expect for the Phase 9D + 8J-1 use cases.
 */
export interface CreateEmulatorOptions {
  /** Maximum milliseconds to wait for the module to finish init.
   *  Default 30 000 (matches the README's "first load is ~30s"
   *  guidance - most of that is the WASM module download). */
  readonly bootTimeoutMs?: number;
}

/**
 * Probe whether the host environment can run the mGBA-WASM core
 * headlessly. Returns a result object describing the verdict - 
 * callers can use this to decide whether to attempt
 * `createEmulator()` at all.
 *
 * Today's verdict is always `{ available: false, reason: 'no_worker' }`
 * because the threading bridge isn't wired (see module-level
 * comment). Once the Worker shim lands, this returns
 * `{ available: true }` on Node 20+.
 */
export function probeEmulatorAvailability(): {
  available: boolean;
  reason?: 'no_worker' | 'no_wasm' | 'unknown';
  hint?: string;
} {
  // After Phase 9A-2 the Worker shim self-installs on
  // createEmulator(). The probe is now just "is Worker reachable
  // or can we install it?" - we don't actually install during
  // probe (idempotent + minimal side effects). If neither the
  // browser-native Worker nor node:worker_threads is available,
  // surface a no_worker verdict.
  if (typeof (globalThis as Record<string, unknown>).Worker !== 'undefined') {
    return { available: true };
  }
  // node:worker_threads exists in Node 16+; we check by requiring it
  // would work at runtime. Cheap probe via the Node version env.
  if (typeof process !== 'undefined' && process.versions?.node) {
    return { available: true };
  }
  return {
    available: false,
    reason: 'no_worker',
    hint:
      'No Worker global is available and node:worker_threads is not present. ' +
      'createEmulator() requires either a browser environment or a Node 16+ runtime.',
  };
}

/**
 * Create a headless emulator instance. Resolves to a fully-booted
 * `EmulatorHandle` ready for `loadRom()`.
 *
 * Throws `EmulatorUnavailableError` when the live boot can't proceed
 * - most commonly because the Worker shim isn't wired yet (see
 * `probeEmulatorAvailability()` above).
 */
export async function createEmulator(
  options: CreateEmulatorOptions = {},
): Promise<EmulatorHandle> {
  const probe = probeEmulatorAvailability();
  if (!probe.available) {
    throw new EmulatorUnavailableError(
      probe.reason ?? 'unknown',
      'mGBA-WASM headless boot is not available in this environment.',
      probe.hint ?? '',
    );
  }

  const bootTimeoutMs = options.bootTimeoutMs ?? 30_000;

  let installed: InstalledGlobals;
  let restoreWorkerShim: () => void = () => undefined;
  try {
    installed = installGlobals();
    restoreWorkerShim = installWorkerShim();
  } catch (e) {
    restoreWorkerShim();
    throw new EmulatorUnavailableError(
      'shim_init_failed',
      `failed to install DOM/worker shims: ${(e as Error).message}`,
      'Phase 9A DOM shims need globalThis to be writable.',
    );
  }

  let factory: MgbaFactory;
  try {
    // The npm package's main is `dist/mgba.js`. The default export
    // is the factory; we dynamic-import to keep this engine package
    // requirement-optional (Phase 9A consumers without
    // @thenick775/mgba-wasm installed get an `EmulatorUnavailableError`
    // instead of an import-time crash).
    const mod = (await import('@thenick775/mgba-wasm')) as unknown as {
      default: MgbaFactory;
    };
    factory = mod.default;
  } catch (e) {
    installed.restore();
    restoreWorkerShim();
    throw new EmulatorUnavailableError(
      'no_wasm',
      `@thenick775/mgba-wasm is not installed or failed to load: ${(e as Error).message}`,
      'Install via `npm install @thenick775/mgba-wasm` in the engine workspace.',
    );
  }

  // Pre-load the WASM binary from disk. Emscripten tries `fetch()`
  // by default which doesn't work in Node - passing the bytes via
  // `wasmBinary` bypasses the fetch entirely.
  let wasmBinary: Uint8Array | undefined;
  try {
    const { readFile } = await import('node:fs/promises');
    const { dirname, join } = await import('node:path');
    // Resolve the .wasm file's path via node:module's createRequire.
    // The Node type defs surface createRequire under `node:module`'s
    // default-export namespace; using a typed cast keeps strict mode
    // happy without making the runtime less safe.
    const nodeModule = (await import('node:module')) as unknown as {
      createRequire: (url: string) => {
        resolve: (id: string) => string;
      };
    };
    const req = nodeModule.createRequire(import.meta.url);
    const mgbaJsPath = req.resolve('@thenick775/mgba-wasm');
    const wasmPath = join(dirname(mgbaJsPath), 'mgba.wasm');
    wasmBinary = new Uint8Array(await readFile(wasmPath));
  } catch (e) {
    installed.restore();
    restoreWorkerShim();
    throw new EmulatorUnavailableError(
      'no_wasm',
      `couldn't read mgba.wasm: ${(e as Error).message}`,
      'Confirm @thenick775/mgba-wasm is fully installed.',
    );
  }

  let module: MgbaModule;
  try {
    const bootPromise = factory({
      canvas: installed.canvas,
      // Cast: the published .d.ts only mentions { canvas } but
      // Emscripten modules accept arbitrary moduleArg fields.
      // wasmBinary is a documented Emscripten field.
      wasmBinary,
    } as unknown as { canvas: unknown });
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      setTimeout(() => {
        reject(
          new EmulatorUnavailableError(
            'boot_timeout',
            `mGBA-WASM init didn't resolve within ${String(bootTimeoutMs)}ms`,
            'Try increasing bootTimeoutMs, or check that the WASM file finished downloading.',
          ),
        );
      }, bootTimeoutMs);
    });
    module = await Promise.race([bootPromise, timeoutPromise]);
    if (typeof module.FSInit === 'function') {
      await module.FSInit();
    }
  } catch (e) {
    installed.restore();
    restoreWorkerShim();
    if (e instanceof EmulatorUnavailableError) throw e;
    const msg = (e as Error).message;
    if (msg.includes('Worker is not defined')) {
      throw new EmulatorUnavailableError(
        'no_worker',
        msg,
        'The worker shim failed to install. Check that node:worker_threads is reachable.',
      );
    }
    throw new EmulatorUnavailableError(
      'shim_init_failed',
      `mGBA-WASM init threw: ${msg}`,
      'Check the dom-shims for the missing global.',
    );
  }

  return makeHandle(module, installed);
}

/* -------------------------------------------------------------------------- *
 * Internal: wrap a booted MgbaModule into the EmulatorHandle shape.
 * -------------------------------------------------------------------------- */

function makeHandle(module: MgbaModule, installed: InstalledGlobals): EmulatorHandle {
  let offsets: HeapOffsets = {
    rom: null,
    ewram: null,
    iwram: null,
    vram: null,
    oam: null,
    paletteRam: null,
  };
  let disposed = false;
  // Used by runFrames() - `videoFrameEndedCallback` increments this.
  let frameCounter = 0;
  module.addCoreCallbacks({
    videoFrameEndedCallback: () => {
      frameCounter++;
    },
  });

  return {
    async loadRom(bytes: Uint8Array): Promise<void> {
      if (disposed) {
        throw new Error('emulator has been disposed');
      }
      const paths = module.filePaths();
      const romPath = `${paths.gamePath}/rom.gba`;
      // Best-effort directory create.
      try {
        module.FS.mkdir?.(paths.gamePath);
      } catch {
        /* already exists */
      }
      module.FS.writeFile(romPath, bytes);
      const ok = module.loadGame(romPath);
      if (!ok) {
        throw new EmulatorUnavailableError(
          'rom_load_failed',
          `mGBA loadGame('${romPath}') returned false`,
          "Confirm the ROM bytes are a valid GBA cart (Nintendo header + correct CRC).",
        );
      }
      // Refresh heap offsets - the cart is now loaded so the
      // Nintendo logo is visible in HEAPU8.
      const romBase = findRomBaseInHeap(module.HEAPU8);
      offsets = buildOffsetTable(romBase);
    },

    async runFrames(count: number): Promise<void> {
      if (disposed) throw new Error('emulator has been disposed');
      if (count <= 0) return;
      const target = frameCounter + count;
      // Wait by polling - mGBA drives its own main loop via
      // requestAnimationFrame which we shimmed onto setTimeout.
      // Polling at ~16ms cadence matches the GBA's native 60 fps.
      while (frameCounter < target) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    },

    async getFramebuffer(): Promise<Uint8ClampedArray> {
      if (disposed) throw new Error('emulator has been disposed');
      const paths = module.filePaths();
      const fileName = `phase9a-${String(Date.now())}-${String(Math.floor(Math.random() * 1e9))}.png`;
      const screenshotPath = `${paths.screenshotsPath}/${fileName}`;
      const ok = module.screenshot(fileName);
      if (!ok) {
        throw new Error('mGBA screenshot() returned false');
      }
      const pngBytes = module.FS.readFile(screenshotPath);
      try {
        module.FS.unlink?.(screenshotPath);
      } catch {
        /* best-effort cleanup */
      }
      const rgba = decodeMgbaScreenshotToRgba(pngBytes);
      if (rgba.length !== GBA_FRAMEBUFFER_RGBA_LENGTH) {
        throw new Error(`framebuffer length ${String(rgba.length)} != expected`);
      }
      return rgba;
    },

    readMemory(addr: number, length: number): Uint8Array {
      if (disposed) throw new Error('emulator has been disposed');
      return readGbaMemory(module.HEAPU8, offsets, addr, length);
    },

    pressButton(name: GbaButton): void {
      if (disposed) throw new Error('emulator has been disposed');
      module.buttonPress(name);
    },

    releaseButton(name: GbaButton): void {
      if (disposed) throw new Error('emulator has been disposed');
      module.buttonUnpress(name);
    },

    async captureState(): Promise<Uint8Array> {
      if (disposed) throw new Error('emulator has been disposed');
      const ok = module.forceAutoSaveState();
      if (!ok) throw new Error('mGBA forceAutoSaveState() returned false');
      const captured = module.getAutoSaveState();
      if (!captured) throw new Error('mGBA getAutoSaveState() returned null');
      return captured.data;
    },

    async restoreState(bytes: Uint8Array): Promise<void> {
      if (disposed) throw new Error('emulator has been disposed');
      const paths = module.filePaths();
      const name = `${paths.autosave}/restore.state`;
      await module.uploadAutoSaveState(name, bytes);
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      try {
        module.pauseGame();
      } catch {
        /* already paused */
      }
      try {
        module.quitGame();
      } catch {
        /* already quit */
      }
      try {
        module.quitMgba();
      } catch {
        /* already torn down */
      }
      installed.restore();
    },
  };
}
