/**
 * Phase 9A - DOM + browser-global shims for headless mGBA-WASM.
 *
 * The Emscripten-built mGBA module ships with a single entry point - 
 * `mGBA({ canvas: HTMLCanvasElement })` - that assumes a browser
 * environment. In Node, none of these globals exist (`window`,
 * `document`, `HTMLCanvasElement`, `requestAnimationFrame`, etc.).
 *
 * This module provides the minimum surface to make `mGBA(...)` not
 * crash during init. The strategy: shim only what's actually
 * referenced during the call paths we exercise. Nothing here renders
 * pixels or plays audio - the framebuffer is captured via mGBA's
 * `screenshot()` (writes a PNG to the virtual FS, we read it back),
 * and audio is silently discarded.
 *
 * The shims are EXPORTED (rather than installed on `globalThis` here)
 * so tests can exercise them in isolation. `mgba-node.ts::createEmulator`
 * is the one place that calls `installGlobals()`.
 */

/* eslint-disable @typescript-eslint/no-empty-function, @typescript-eslint/no-explicit-any */

/** The shape consumed by mGBA's canvas-resize call: see mgba.js line ~1242:
 *  `Module.canvas.width = $0; Module.canvas.height = $1;` */
export interface MinimalCanvas {
  width: number;
  height: number;
  style: Record<string, string>;
  getContext(type: string): MinimalCanvasContext | null;
  addEventListener(name: string, listener: (event: unknown) => void): void;
  removeEventListener(name: string, listener: (event: unknown) => void): void;
  dispatchEvent(event: unknown): boolean;
  getBoundingClientRect(): {
    x: number;
    y: number;
    width: number;
    height: number;
    top: number;
    left: number;
    right: number;
    bottom: number;
  };
}

/** Mostly stubbed - Emscripten's `Browser.createContext` path calls
 *  `canvas.getContext('2d')` for non-WebGL builds. Our build is GL but
 *  we never trigger an actual draw, so the methods just need to exist
 *  + not throw. */
export interface MinimalCanvasContext {
  canvas: MinimalCanvas | null;
  fillStyle: string;
  fillRect(x: number, y: number, w: number, h: number): void;
  clearRect(x: number, y: number, w: number, h: number): void;
  getImageData(
    x: number,
    y: number,
    w: number,
    h: number,
  ): { data: Uint8ClampedArray; width: number; height: number };
  putImageData(
    img: { data: Uint8ClampedArray; width: number; height: number },
    x: number,
    y: number,
  ): void;
  drawImage(...args: unknown[]): void;
  save(): void;
  restore(): void;
  scale(x: number, y: number): void;
  rotate(rad: number): void;
  translate(x: number, y: number): void;
  beginPath(): void;
  closePath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  fill(): void;
  stroke(): void;
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
}

export interface InstalledGlobals {
  readonly restore: () => void;
  readonly canvas: MinimalCanvas;
}

/** Make a fresh canvas shim. The GBA framebuffer is 240×160. */
export function makeCanvasShim(width: number = 240, height: number = 160): MinimalCanvas {
  const ctx2d: MinimalCanvasContext = {
    canvas: null,
    fillStyle: '#000',
    fillRect: () => {},
    clearRect: () => {},
    getImageData: (_x: number, _y: number, w: number, h: number) => ({
      data: new Uint8ClampedArray(w * h * 4),
      width: w,
      height: h,
    }),
    putImageData: () => {},
    drawImage: () => {},
    save: () => {},
    restore: () => {},
    scale: () => {},
    rotate: () => {},
    translate: () => {},
    beginPath: () => {},
    closePath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    fill: () => {},
    stroke: () => {},
    setTransform: () => {},
  };
  const canvas: MinimalCanvas = {
    width,
    height,
    style: {},
    getContext: () => ctx2d,
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
    getBoundingClientRect: () => ({
      x: 0,
      y: 0,
      width,
      height,
      top: 0,
      left: 0,
      right: width,
      bottom: height,
    }),
  };
  ctx2d.canvas = canvas;
  return canvas;
}

/**
 * Install the minimum browser-global shims onto `globalThis`. Returns
 * an `InstalledGlobals` whose `.restore()` reverts every install so
 * tests can clean up between runs.
 *
 * What we install (only what mGBA actually touches in the boot path):
 *   - window (alias to globalThis)
 *   - self (alias to globalThis; used by ENVIRONMENT_IS_WORKER detection)
 *   - requestAnimationFrame + cancelAnimationFrame (setTimeout-backed)
 *   - performance (Node already exposes this in 16+ but defensively
 *     check)
 *   - HTMLCanvasElement (a constructor returning a MinimalCanvas)
 *
 * What we DON'T install:
 *   - Worker - handled at a different boundary, see worker-shim.ts
 *   - AudioContext - Emscripten checks `typeof AudioContext` and
 *     gracefully no-ops when missing.
 *   - File / FileReader - used only by the `uploadRom(file)` API
 *     which we sidestep with direct `FS.writeFile`.
 */
export function installGlobals(): InstalledGlobals {
  const g = globalThis as unknown as Record<string, unknown>;
  const restorers: Array<() => void> = [];

  const setGlobal = (name: string, value: unknown): void => {
    if (!(name in g)) {
      g[name] = value;
      restorers.push(() => {
        delete g[name];
      });
    } else if (g[name] === undefined) {
      g[name] = value;
      restorers.push(() => {
        g[name] = undefined;
      });
    }
  };

  setGlobal('window', g);
  setGlobal('self', g);

  if (typeof g.requestAnimationFrame !== 'function') {
    const raf = (cb: (t: number) => void): ReturnType<typeof setTimeout> => {
      return setTimeout(() => {
        cb(typeof performance !== 'undefined' ? performance.now() : Date.now());
      }, 16);
    };
    const caf = (id: ReturnType<typeof setTimeout>): void => {
      clearTimeout(id);
    };
    setGlobal('requestAnimationFrame', raf);
    setGlobal('cancelAnimationFrame', caf);
  }

  if (typeof g.performance === 'undefined') {
    setGlobal('performance', {
      now: () => Number(process.hrtime.bigint() / 1_000_000n),
    });
  }

  // A constructor-shaped HTMLCanvasElement so any `instanceof
  // HTMLCanvasElement` runtime probe doesn't blow up. We don't expect
  // mGBA to do this, but Emscripten's getContext probe might.
  if (typeof g.HTMLCanvasElement === 'undefined') {
    class FakeHTMLCanvasElement {
      static [Symbol.hasInstance](instance: unknown): boolean {
        // Anything with width + height + getContext is "canvas-like".
        return (
          typeof instance === 'object' &&
          instance !== null &&
          'width' in (instance as object) &&
          'height' in (instance as object) &&
          'getContext' in (instance as object)
        );
      }
    }
    setGlobal('HTMLCanvasElement', FakeHTMLCanvasElement);
  }

  const canvas = makeCanvasShim();
  return {
    canvas,
    restore: () => {
      while (restorers.length > 0) {
        restorers.pop()?.();
      }
    },
  };
}
