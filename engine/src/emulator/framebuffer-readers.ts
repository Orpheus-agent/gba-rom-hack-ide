/**
 * Phase 9A - Framebuffer capture helpers.
 *
 * mGBA's WASM build exposes a `screenshot(fileName?)` method that
 * writes a PNG of the current frame to the emulator's virtual FS at
 * `/screenshots/<fileName>`. We read it back via `FS.readFile()` and
 * decode it through the engine's existing PNG decoder, returning a
 * standard 240×160 RGBA buffer.
 *
 * This is the slow path - every framebuffer capture involves an
 * encode + decode round-trip (~5-10ms each). It's fine for the
 * one-shot smoke-boot (8J-1 follow-up) and the per-move animation
 * capture (9D Route A). It's not fine for live overlay rendering,
 * which would need direct typed-array access to mGBA's frame buffer
 * (a future polish opportunity).
 */

import { decodePng } from '../graphics/png-decoder.js';

/** GBA framebuffer dimensions - fixed by the hardware. */
export const GBA_FRAMEBUFFER_WIDTH = 240;
export const GBA_FRAMEBUFFER_HEIGHT = 160;
export const GBA_FRAMEBUFFER_RGBA_LENGTH =
  GBA_FRAMEBUFFER_WIDTH * GBA_FRAMEBUFFER_HEIGHT * 4;

/**
 * Decode mGBA-WASM's screenshot PNG bytes into a 240×160 RGBA buffer.
 * Validates the output dimensions and throws on mismatch.
 */
export function decodeMgbaScreenshotToRgba(pngBytes: Uint8Array): Uint8ClampedArray {
  const decoded = decodePng(pngBytes);
  if (decoded.width !== GBA_FRAMEBUFFER_WIDTH || decoded.height !== GBA_FRAMEBUFFER_HEIGHT) {
    throw new Error(
      `screenshot dimensions ${String(decoded.width)}×${String(decoded.height)} ` +
        `don't match GBA framebuffer (${String(GBA_FRAMEBUFFER_WIDTH)}×${String(GBA_FRAMEBUFFER_HEIGHT)})`,
    );
  }
  // The engine PNG decoder returns RGBA already, but it's a
  // Uint8Array; wrap as Uint8ClampedArray for canvas/ImageData
  // compatibility downstream.
  if (decoded.pixels.length !== GBA_FRAMEBUFFER_RGBA_LENGTH) {
    throw new Error(
      `decoded RGBA length ${String(decoded.pixels.length)} ` +
        `!= expected ${String(GBA_FRAMEBUFFER_RGBA_LENGTH)}`,
    );
  }
  return new Uint8ClampedArray(
    decoded.pixels.buffer,
    decoded.pixels.byteOffset,
    decoded.pixels.byteLength,
  );
}

/**
 * Compute a stable hash of a framebuffer for regression baselines.
 * Uses a 32-bit FNV-1a so two identical frames produce identical
 * hashes across machines (no Node crypto dependency).
 */
export function framebufferHash(rgba: Uint8ClampedArray): string {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < rgba.length; i++) {
    h ^= rgba[i]!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
