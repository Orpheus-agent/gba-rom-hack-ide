/**
 * Phase 9A - Headless emulator API contract.
 *
 * `EmulatorHandle` is the surface the rest of the codebase speaks to
 * - Phase 9D (move animation preview), Phase 8J-1's future smoke-boot
 * upgrade, and any future tool that wants to drive an mGBA core
 * headlessly all go through this interface.
 *
 * The underlying implementation today is built on `@thenick775/mgba-wasm`
 * which is an Emscripten-built mGBA core. The native target is the
 * browser; we run it in Node by providing a small set of DOM + Worker
 * shims (see `dom-shims.ts`).
 *
 * The contract intentionally hides the mGBA module entirely so that
 * if the upstream package changes shape - or we swap in a different
 * core (e.g. a vendored single-threaded mGBA build) - only this file
 * + `mgba-node.ts` are affected.
 */

export type GbaButton =
  | 'A'
  | 'B'
  | 'Up'
  | 'Down'
  | 'Left'
  | 'Right'
  | 'Start'
  | 'Select'
  | 'L'
  | 'R';

export interface EmulatorHandle {
  /**
   * Load a ROM into the emulator. Bytes are written to the emulator's
   * virtual filesystem and then the core is told to boot from them.
   * Resolves once the core is in the running state.
   */
  loadRom(bytes: Uint8Array): Promise<void>;

  /**
   * Advance the emulation by exactly `count` frames. Used by smoke-boot
   * harnesses, move-animation capture, and any deterministic step-by-step
   * inspection. Frame pacing is driven by mGBA's `videoFrameEndedCallback`.
   */
  runFrames(count: number): Promise<void>;

  /**
   * Capture the current framebuffer as a 240×160 RGBA buffer
   * (`Uint8ClampedArray`, length = 240 × 160 × 4 = 153 600).
   *
   * The implementation is intentionally async because the framebuffer
   * may need to be roundtripped through the emulator's virtual FS
   * (via the core's `screenshot()` method) before it's accessible.
   */
  getFramebuffer(): Promise<Uint8ClampedArray>;

  /**
   * Read `length` bytes from the emulated GBA's address space starting
   * at `addr`. Addresses must be valid GBA addresses (e.g. 0x02000000
   * for EWRAM, 0x03000000 for IWRAM, 0x08000000 for cartridge ROM).
   *
   * Errors when the address range escapes the GBA's memory map.
   * Implemented via direct `HEAPU8` access using offsets reverse-
   * engineered from the cart-header search at boot time.
   */
  readMemory(addr: number, length: number): Uint8Array;

  /**
   * Press a GBA button. Mirrors mGBA's `buttonPress(name)` mapping
   * - the button stays pressed until `releaseButton` is called or
   * until enough frames advance that the core's input system reads
   * a release transition.
   */
  pressButton(name: GbaButton): void;

  /** Release a previously-pressed GBA button. */
  releaseButton(name: GbaButton): void;

  /**
   * Capture a full emulator save-state suitable for `restoreState`.
   * Used by the Phase 4.1A save-state library + Phase 4.1B scene-boot
   * orchestrator to pre-seed scenes before driving them.
   */
  captureState(): Promise<Uint8Array>;

  /**
   * Restore from a previously-captured save state. The bytes must be
   * the same format produced by `captureState()` (mGBA-WASM auto-save
   * state format).
   */
  restoreState(bytes: Uint8Array): Promise<void>;

  /**
   * Tear down the emulator instance: stop the main loop, terminate
   * any worker threads, release the WASM module. Must be called when
   * the consumer is done with the handle to avoid leaking memory
   * across long autonomous runs.
   */
  dispose(): void;
}

/**
 * The error thrown by `createEmulator()` when the live boot can't
 * proceed. The most common cause is the threading/Worker shim hitting
 * an unsupported edge case (Node version too old, no `worker_threads`
 * permission, etc.).
 *
 * Code that wants to use the emulator opportunistically - e.g. the
 * Phase 8J-1 smoke-boot harness, the Phase 9D move-animation captor
 * - should catch this and degrade to whichever fallback strategy
 * makes sense (byte-level invariants for 8J-1; pre-captured clips
 * for 9D Route B).
 */
export class EmulatorUnavailableError extends Error {
  public readonly code:
    | 'no_worker'
    | 'no_wasm'
    | 'boot_timeout'
    | 'shim_init_failed'
    | 'rom_load_failed'
    | 'unknown';
  public readonly hint: string;
  constructor(
    code:
      | 'no_worker'
      | 'no_wasm'
      | 'boot_timeout'
      | 'shim_init_failed'
      | 'rom_load_failed'
      | 'unknown',
    message: string,
    hint: string,
  ) {
    super(message);
    this.name = 'EmulatorUnavailableError';
    this.code = code;
    this.hint = hint;
  }
}
