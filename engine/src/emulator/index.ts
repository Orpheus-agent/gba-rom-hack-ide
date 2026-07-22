/**
 * Phase 9A - Headless emulator API.
 *
 * Public surface for the rest of the codebase. See `mgba-node.ts`
 * for the implementation + the current status of the live-boot path.
 */

export {
  EmulatorUnavailableError,
  type EmulatorHandle,
  type GbaButton,
} from './types.js';
export {
  createEmulator,
  probeEmulatorAvailability,
  type CreateEmulatorOptions,
} from './mgba-node.js';
export {
  installGlobals,
  makeCanvasShim,
  type MinimalCanvas,
  type MinimalCanvasContext,
  type InstalledGlobals,
} from './dom-shims.js';
export {
  GBA_REGIONS,
  buildOffsetTable,
  findRegionForAddr,
  findRomBaseInHeap,
  readGbaMemory,
  MemoryUnavailableError,
  type GbaRegionName,
  type HeapOffsets,
} from './heap-readers.js';
export {
  GBA_FRAMEBUFFER_WIDTH,
  GBA_FRAMEBUFFER_HEIGHT,
  GBA_FRAMEBUFFER_RGBA_LENGTH,
  decodeMgbaScreenshotToRgba,
  framebufferHash,
} from './framebuffer-readers.js';
export { installWorkerShim } from './worker-shim.js';
