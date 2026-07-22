/**
 * Phase 9A - DOM-shim tests.
 *
 * These verify the shapes the Emscripten init path actually probes
 * for. We don't boot mGBA here - that's blocked on the Worker shim
 * follow-up - but every property the shim claims to provide gets
 * exercised so a regression breaks loudly.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { installGlobals, makeCanvasShim } from './dom-shims.js';

describe('emulator/dom-shims', () => {
  let installed: { restore: () => void } | null = null;
  afterEach(() => {
    installed?.restore();
    installed = null;
  });

  describe('makeCanvasShim', () => {
    it('returns a canvas with width=240 and height=160 by default', () => {
      const c = makeCanvasShim();
      expect(c.width).toBe(240);
      expect(c.height).toBe(160);
    });

    it('accepts custom dimensions', () => {
      const c = makeCanvasShim(320, 240);
      expect(c.width).toBe(320);
      expect(c.height).toBe(240);
    });

    it('exposes getContext that returns a 2d-shaped object', () => {
      const c = makeCanvasShim();
      const ctx = c.getContext('2d');
      expect(ctx).not.toBeNull();
      expect(typeof ctx?.fillRect).toBe('function');
      expect(typeof ctx?.getImageData).toBe('function');
    });

    it('round-trips canvas.style assignment without throwing', () => {
      const c = makeCanvasShim();
      c.style['display'] = 'block';
      expect(c.style['display']).toBe('block');
    });

    it('does not throw on addEventListener / removeEventListener', () => {
      const c = makeCanvasShim();
      const cb = (): void => undefined;
      expect(() => c.addEventListener('click', cb)).not.toThrow();
      expect(() => c.removeEventListener('click', cb)).not.toThrow();
    });

    it('returns a getBoundingClientRect with the canvas dimensions', () => {
      const c = makeCanvasShim(100, 50);
      const r = c.getBoundingClientRect();
      expect(r.width).toBe(100);
      expect(r.height).toBe(50);
      expect(r.right).toBe(100);
      expect(r.bottom).toBe(50);
    });

    it('getImageData returns a properly-sized Uint8ClampedArray', () => {
      const c = makeCanvasShim();
      const ctx = c.getContext('2d')!;
      const img = ctx.getImageData(0, 0, 240, 160);
      expect(img.width).toBe(240);
      expect(img.height).toBe(160);
      expect(img.data.length).toBe(240 * 160 * 4);
      expect(img.data).toBeInstanceOf(Uint8ClampedArray);
    });
  });

  describe('installGlobals', () => {
    it('installs window, self, requestAnimationFrame, and performance', () => {
      installed = installGlobals();
      const g = globalThis as unknown as Record<string, unknown>;
      // window + self should be aliases of globalThis.
      expect(g.window).toBe(globalThis);
      expect(g.self).toBe(globalThis);
      // RAF should be a function.
      expect(typeof g.requestAnimationFrame).toBe('function');
      // performance should have a now() method.
      const perf = g.performance as { now: () => number };
      expect(typeof perf.now).toBe('function');
      expect(typeof perf.now()).toBe('number');
    });

    it('restore() removes only the globals we installed', () => {
      // Pre-mark window-style globals as absent before the test.
      const g = globalThis as unknown as Record<string, unknown>;
      const hadWindowBefore = 'window' in g;
      installed = installGlobals();
      expect('window' in g).toBe(true);
      installed.restore();
      if (!hadWindowBefore) {
        expect('window' in g).toBe(false);
      }
      installed = null;
    });

    it('returns a canvas via .canvas', () => {
      installed = installGlobals();
      expect(installed).toBeDefined();
      const { canvas } = installed as unknown as { canvas: { width: number } };
      expect(canvas.width).toBe(240);
    });

    it('requestAnimationFrame eventually fires the callback', async () => {
      installed = installGlobals();
      const g = globalThis as unknown as Record<string, unknown>;
      const raf = g.requestAnimationFrame as (cb: (t: number) => void) => unknown;
      let fired = false;
      raf(() => {
        fired = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(fired).toBe(true);
    });
  });
});
