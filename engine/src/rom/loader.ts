/**
 * ROM byte-buffer intake.
 *
 * The engine NEVER mutates input ROM bytes (PD 11: patch-first / non-destructive).
 * This module loads bytes from a path or accepts pre-loaded bytes, validates
 * size bounds, computes a stable identity hash, and produces an immutable
 * RomImage that every downstream detector reads.
 *
 * Operator-supplied ROMs only (PD 12 / D-0011) - the loader never reaches
 * outside the supplied path / buffer to fetch additional bytes.
 */

import { promises as fsp } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

/**
 * GBA cart hardware caps. The smallest legal cartridge ROM is 192 bytes
 * (header-only, never seen in the wild but spec-legal); the largest is
 * 32 MiB. Anything outside that range is structurally not a GBA ROM.
 */
export const ROM_MIN_BYTES = 192;
export const ROM_MAX_BYTES = 32 * 1024 * 1024;

/**
 * Per-ROM identity. `sha1` is the content hash - stable across re-opens of
 * the same bytes regardless of file path or filename. `sourcePath` records
 * where the operator pointed us (informational, never re-read after load).
 */
export interface RomImage {
  readonly bytes: Uint8Array;
  readonly byteLength: number;
  readonly sha1: string;
  readonly sourcePath: string | null;
  /** Optional corpus class hint from the directory walker (e.g. "vanilla",
   * "heavyHack"). Null when loaded from a path with no recognized parent
   * directory or directly from a buffer. */
  readonly corpusClass: string | null;
  /** Marker for synthetic fixtures so reports + tests can distinguish them
   * from real operator-supplied content (B-0001). */
  readonly synthetic: boolean;
}

export type RomLoadFailure =
  | { kind: 'file_not_found'; path: string }
  | { kind: 'too_small'; bytesAvailable: number; bytesRequired: number; sourcePath: string | null }
  | { kind: 'too_large'; bytesAvailable: number; bytesAllowed: number; sourcePath: string | null }
  | { kind: 'read_error'; sourcePath: string; cause: string };

export class RomLoadError extends Error {
  constructor(message: string, readonly failure: RomLoadFailure) {
    super(message);
    this.name = 'RomLoadError';
  }
}

/**
 * Load a ROM from a filesystem path. Validates bounds + computes sha1 in one
 * pass. `corpusClass` is derived from the immediate parent directory name
 * when the path matches `/corpus/<class>/<file>` - that's the convention
 * the corpus walker writes. Pass `corpusClass: null` to skip the derivation
 * for ad-hoc paths.
 */
export async function loadRomFromPath(args: {
  filePath: string;
  corpusClass?: string | null;
}): Promise<RomImage> {
  const filePath = path.resolve(args.filePath);
  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    throw new RomLoadError(`ROM file not found: ${filePath}`, {
      kind: 'file_not_found',
      path: filePath,
    });
  }
  if (stat.size < ROM_MIN_BYTES) {
    throw new RomLoadError(
      `ROM ${filePath} is too small: ${String(stat.size)} bytes (need ≥ ${String(ROM_MIN_BYTES)})`,
      { kind: 'too_small', bytesAvailable: stat.size, bytesRequired: ROM_MIN_BYTES, sourcePath: filePath },
    );
  }
  if (stat.size > ROM_MAX_BYTES) {
    throw new RomLoadError(
      `ROM ${filePath} is too large: ${String(stat.size)} bytes (GBA cart limit ${String(ROM_MAX_BYTES)})`,
      { kind: 'too_large', bytesAvailable: stat.size, bytesAllowed: ROM_MAX_BYTES, sourcePath: filePath },
    );
  }
  let bytes: Buffer;
  try {
    bytes = await fsp.readFile(filePath);
  } catch (e) {
    throw new RomLoadError(`Could not read ${filePath}: ${(e as Error).message}`, {
      kind: 'read_error',
      sourcePath: filePath,
      cause: (e as Error).message,
    });
  }

  return loadRomFromBytesInternal({
    bytes,
    sourcePath: filePath,
    corpusClass: args.corpusClass ?? null,
    synthetic: false,
  });
}

/**
 * Load a ROM from a pre-existing byte buffer. Useful for synthetic fixtures
 * (B-0001), in-memory test inputs, and for upstream callers that already
 * hold ROM bytes (e.g. the editor's intake pipeline).
 */
export function loadRomFromBytes(args: {
  bytes: Uint8Array;
  sourcePath?: string | null;
  corpusClass?: string | null;
  synthetic?: boolean;
}): RomImage {
  if (args.bytes.length < ROM_MIN_BYTES) {
    throw new RomLoadError(
      `ROM buffer too small: ${String(args.bytes.length)} bytes (need ≥ ${String(ROM_MIN_BYTES)})`,
      {
        kind: 'too_small',
        bytesAvailable: args.bytes.length,
        bytesRequired: ROM_MIN_BYTES,
        sourcePath: args.sourcePath ?? null,
      },
    );
  }
  if (args.bytes.length > ROM_MAX_BYTES) {
    throw new RomLoadError(
      `ROM buffer too large: ${String(args.bytes.length)} bytes (GBA cart limit ${String(ROM_MAX_BYTES)})`,
      {
        kind: 'too_large',
        bytesAvailable: args.bytes.length,
        bytesAllowed: ROM_MAX_BYTES,
        sourcePath: args.sourcePath ?? null,
      },
    );
  }
  return loadRomFromBytesInternal({
    bytes: args.bytes,
    sourcePath: args.sourcePath ?? null,
    corpusClass: args.corpusClass ?? null,
    synthetic: args.synthetic ?? false,
  });
}

function loadRomFromBytesInternal(args: {
  bytes: Uint8Array;
  sourcePath: string | null;
  corpusClass: string | null;
  synthetic: boolean;
}): RomImage {
  const sha1 = createHash('sha1').update(args.bytes).digest('hex');
  // We DO NOT copy the bytes - the input is immutable from the caller's POV.
  // RomImage carries a reference; downstream code that needs to slice can
  // do so on demand. Copying 32 MB up front would be wasteful.
  return Object.freeze({
    bytes: args.bytes,
    byteLength: args.bytes.length,
    sha1,
    sourcePath: args.sourcePath,
    corpusClass: args.corpusClass,
    synthetic: args.synthetic,
  });
}
