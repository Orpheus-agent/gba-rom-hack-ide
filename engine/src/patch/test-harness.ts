/**
 * Patch testing harness (Phase 3.7).
 *
 * Applies a BPS patch to a vanilla ROM in-memory + verifies byte-level
 * integrity (SHA-1 of the result, byte length, header invariants).
 *
 * Out of scope (deferred): mGBA-WASM smoke-boot for "does the patched
 * ROM actually start?". That's heavier (in-process WASM emulator)
 * than the overnight scope. The byte-level harness still catches:
 *   - the patch corrupting the cartridge header (game won't load)
 *   - the patch producing a ROM smaller than 16 MiB (cart size invariant)
 *   - the patch yielding a SHA-1 the bundle metadata says is wrong
 *
 * For full boot verification, the user runs the patched ROM in mGBA
 * (or any GBA emulator) - that's a one-click test.
 */

import { createHash } from 'node:crypto';
import { applyBps } from './bps.js';

export class PatchTestError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`PatchTestError[${code}]: ${message}`);
    this.name = 'PatchTestError';
    this.code = code;
  }
}

export interface PatchTestResult {
  readonly applied: boolean;
  readonly postBytes: Uint8Array | null;
  readonly postSha1: string | null;
  readonly postLength: number | null;
  readonly headerInvariantsOk: boolean;
  readonly issues: ReadonlyArray<string>;
}

/** Apply `bps` to `vanilla` and verify integrity. The function does
 *  NOT compare against an expected SHA - the caller (which has the
 *  bundle metadata) does that. We return the result for the caller
 *  to inspect. */
export function testPatch(
  vanilla: Uint8Array,
  bps: Uint8Array,
): PatchTestResult {
  const issues: string[] = [];
  let postBytes: Uint8Array | null = null;
  try {
    postBytes = applyBps(vanilla, bps);
  } catch (e) {
    return Object.freeze({
      applied: false,
      postBytes: null,
      postSha1: null,
      postLength: null,
      headerInvariantsOk: false,
      issues: [`BPS apply failed: ${e instanceof Error ? e.message : String(e)}`],
    });
  }

  // SHA-1 of the post-patch bytes.
  const sha = createHash('sha1').update(postBytes).digest('hex');

  // Header invariants - GBA cartridge header at offset 0x000:
  //   - 0xA0..0xAB: ASCII game title (12 chars; e.g. "POKEMON FIRE")
  //   - 0xAC..0xAF: ASCII 4-char game code (e.g. "BPRE")
  //   - 0xB0..0xB1: ASCII 2-char maker code ("01" = Nintendo)
  //   - 0xB2: fixed byte 0x96
  //   - 0xB3: main unit code (usually 0x00)
  //   - 0xB4: device type (usually 0x00)
  //   - 0xB5..0xBB: reserved (usually all zero)
  //   - 0xBC: software version
  //   - 0xBD: header checksum (computed against 0xA0..0xBC)
  //   - 0xBE..0xBF: reserved (zero)
  // We verify the magic byte at 0xB2 (= 0x96) - if that's wrong, the
  // cartridge will refuse to boot on real hardware (most emulators
  // tolerate it but the warning's worth surfacing).
  let headerInvariantsOk = true;
  if (postBytes.length < 0xc0) {
    issues.push(`post-patch ROM too short for GBA cartridge header (${String(postBytes.length)} bytes; need ≥ 192)`);
    headerInvariantsOk = false;
  } else {
    if (postBytes[0xb2] !== 0x96) {
      issues.push(`cartridge magic byte at 0xB2 is 0x${postBytes[0xb2]!.toString(16)} (expected 0x96 - ROM won\'t boot on real hardware)`);
      headerInvariantsOk = false;
    }
    // Verify the header checksum at 0xBD.
    let sum = 0;
    for (let i = 0xa0; i <= 0xbc; i++) sum = (sum - postBytes[i]!) & 0xff;
    sum = (sum - 0x19) & 0xff;
    if (postBytes[0xbd] !== sum) {
      issues.push(`cartridge header checksum mismatch at 0xBD (got 0x${postBytes[0xbd]!.toString(16)}, expected 0x${sum.toString(16)})`);
      headerInvariantsOk = false;
    }
  }
  // Cart size invariant: GBA ROMs are typically 16 MiB or 32 MiB.
  if (postBytes.length !== 16 * 1024 * 1024 && postBytes.length !== 32 * 1024 * 1024) {
    issues.push(`unusual post-patch ROM size: ${String(postBytes.length)} bytes (expected 16 MiB or 32 MiB)`);
  }

  return Object.freeze({
    applied: true,
    postBytes,
    postSha1: sha,
    postLength: postBytes.length,
    headerInvariantsOk,
    issues: Object.freeze(issues),
  });
}
