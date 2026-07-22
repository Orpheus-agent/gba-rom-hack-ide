/**
 * Modernize service - Modernize-and-Ship slice 4.
 *
 * One-click upgrade of a vanilla FireRed ROM to a CFRU-modernized
 * ROM. The bundled BPS patch lives at
 *   app/backend/src/assets/modernize/cfru.bps
 * alongside its metadata at
 *   app/backend/src/assets/modernize/cfru.json
 * which carries the expected vanilla SHA-1, the post-apply SHA-1, the
 * CFRU upstream commit short SHA, and any feature flags the build was
 * configured with.
 *
 * The service:
 *   1. Locates the project's `.gba` file.
 *   2. Verifies its SHA-1 matches the canonical vanilla FRLG USA rev-0
 *      hash (configurable via DI for tests).
 *   3. Refuses if the hash already matches the post-apply hash
 *      ("already modernized") so the operation is idempotent.
 *   4. Loads the bundled BPS + metadata, verifies the BPS's own CRC32.
 *   5. Applies the patch in memory.
 *   6. Verifies the post-apply SHA-1 matches what cfru.json declared.
 *   7. Writes the original ROM bytes to `<rom>.pre-modernize.bak`.
 *   8. Atomic-writes the new ROM bytes back to the same path
 *      (`.tmp` + rename).
 *
 * The caller (route handler) is responsible for appending the op-log
 * entry; modernize itself only mutates bytes. This keeps the service
 * focused and consistent with how `applyEdits` works in
 * `patch-applier.ts`.
 */

import { promises as fsp } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { patch as enginePatch } from '@rom-introspection/engine';

/** SHA-1 of the canonical Pokémon FireRed (USA, version 1.0). The
 *  modernize service refuses any other ROM as input. */
export const VANILLA_FRLG_USA_REV0_SHA1 =
  '41cb23d8dccc8ebd7c649cd8fbb58eeace6e2fdc';

/** Default assets root, computed relative to this module so it works
 *  in dev (tsx watch) and tests. Production deployments that compile
 *  to `dist/` should copy `src/assets/` alongside; until then the
 *  caller can override via opts._assetsRoot. */
function defaultAssetsRoot(): string {
  return path.resolve(
    fileURLToPath(import.meta.url),
    '..',
    '..',
    'assets',
    'modernize',
  );
}

export interface ModernizeBundleMetadata {
  /** Expected SHA-1 of the input ROM (vanilla FRLG USA rev 0). */
  readonly vanillaSha1: string;
  /** Expected SHA-1 of the ROM after applying cfru.bps. */
  readonly producesSha1: string;
  /** Human-readable version label surfaced in the UI. */
  readonly cfruVersion: string;
  /** Upstream Skeli789/Complete-Fire-Red-Upgrade commit short SHA. */
  readonly cfruCommitShortSha: string;
  /** OFFSET_TO_PUT value used by the build (typically 0x900000). */
  readonly buildOffset: number;
  /** True when the assets shipped with a real built patch (slice 7);
   *  false for the slice-4 placeholder shipped before the bundle
   *  script has been run. */
  readonly built: boolean;
}

export interface ModernizeOptions {
  readonly projectRoot: string;
  readonly sessionId: string;
  /** Test-only DI: override the expected vanilla SHA-1. Production
   *  callers omit this and the canonical FRLG-rev0 hash is used. */
  readonly _allowedVanillaSha1?: string;
  /** Test-only DI: override the bundled assets directory. Production
   *  callers omit this and the directory shipped with the backend is
   *  used. */
  readonly _assetsRoot?: string;
}

export interface ModernizeResult {
  readonly previousSha1: string;
  readonly newSha1: string;
  readonly cfruVersion: string;
  readonly cfruCommitShortSha: string;
  readonly buildOffset: number;
  readonly bytesWritten: number;
  readonly previousRomBackupPath: string;
  readonly bundledPatchSha1: string;
  /** Phase 6.2 - which bundle was applied (`'cfru'` for CFRU-only,
   *  `'dpe'` for CFRU + DPE Gen-9 expansion). Persisted into the
   *  `modernize_rom` op-log entry so the patch detector can derive
   *  `identity.modernizedBy` (and `overlaySafe`) at scan time. */
  readonly bundleId: 'cfru' | 'dpe';
}

export type ModernizeErrorCode =
  | 'rom_not_found'
  | 'rom_hash_mismatch'
  | 'already_modernized'
  | 'patch_artifact_missing'
  | 'patch_verification_failed'
  | 'apply_failed'
  | 'write_failed';

export class ModernizeError extends Error {
  constructor(
    public readonly code: ModernizeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ModernizeError';
  }
}

/** Compute SHA-1 hex of a byte buffer. */
function sha1Hex(bytes: Uint8Array): string {
  return createHash('sha1').update(bytes).digest('hex');
}

/** Shallow scan of the project root for a `.gba` file. Mirrors the
 *  helper in patch-applier.ts so the modernize service doesn't depend
 *  on the scan module. */
async function findFirstGbaFile(projectRoot: string): Promise<string | null> {
  try {
    const entries = await fsp.readdir(projectRoot, { withFileTypes: true });
    for (const e of entries) {
      if (e.isFile() && e.name.toLowerCase().endsWith('.gba')) {
        return path.join(projectRoot, e.name);
      }
    }
  } catch {
    return null;
  }
  return null;
}

async function loadBundle(
  assetsRoot: string,
): Promise<{ patch: Uint8Array; metadata: ModernizeBundleMetadata; bundleId: 'cfru' | 'dpe' }> {
  // Phase 5.8 - prefer dpe.bps (CFRU + DPE Gen-9 expansion) over the
  // plain cfru.bps when both exist. The user's intent when building
  // the DPE bundle is to use it; modernize defaults to "give me the
  // biggest available upgrade." When only cfru.bps exists we still
  // honor the original Phase 1 behaviour.
  let bundleId: 'cfru' | 'dpe' = 'cfru';
  let bpsPath = path.join(assetsRoot, 'cfru.bps');
  let jsonPath = path.join(assetsRoot, 'cfru.json');
  try {
    const dpeBps = path.join(assetsRoot, 'dpe.bps');
    const dpeJson = path.join(assetsRoot, 'dpe.json');
    await fsp.access(dpeBps);
    await fsp.access(dpeJson);
    bundleId = 'dpe';
    bpsPath = dpeBps;
    jsonPath = dpeJson;
  } catch {
    /* dpe.bps not present - fall through to cfru defaults set above */
  }
  let patchBuf: Buffer;
  let metaText: string;
  try {
    patchBuf = await fsp.readFile(bpsPath);
  } catch (e) {
    throw new ModernizeError(
      'patch_artifact_missing',
      `Bundled CFRU patch not found at ${bpsPath}: ${(e as Error).message}. ` +
        `Run scripts/build-cfru-bundle.mjs to generate it.`,
    );
  }
  try {
    metaText = await fsp.readFile(jsonPath, 'utf-8');
  } catch (e) {
    throw new ModernizeError(
      'patch_artifact_missing',
      `Bundled CFRU metadata not found at ${jsonPath}: ${(e as Error).message}. ` +
        `Run scripts/build-cfru-bundle.mjs to generate it.`,
    );
  }
  let metadata: ModernizeBundleMetadata;
  try {
    const raw = JSON.parse(metaText) as ModernizeBundleMetadata;
    // Light shape validation - the JSON is hand-edited (slice 4) or
    // generated by the bundle script (slice 7), either way we want to
    // catch obvious typos rather than crash deep in applyBps.
    if (typeof raw.vanillaSha1 !== 'string' || raw.vanillaSha1.length !== 40) {
      throw new Error('vanillaSha1 must be a 40-char hex string');
    }
    if (typeof raw.producesSha1 !== 'string' || raw.producesSha1.length !== 40) {
      throw new Error('producesSha1 must be a 40-char hex string');
    }
    if (typeof raw.built !== 'boolean') {
      throw new Error('built must be a boolean');
    }
    metadata = raw;
  } catch (e) {
    throw new ModernizeError(
      'patch_artifact_missing',
      `Bundled CFRU metadata at ${jsonPath} is malformed: ${(e as Error).message}`,
    );
  }
  return { patch: new Uint8Array(patchBuf), metadata, bundleId };
}

/** Apply the bundled CFRU modernization patch to the project's ROM,
 *  with full hash verification and backup. Throws ModernizeError on
 *  any failure; the ROM file is left bytes-identical to the input
 *  state on error (atomic write is gated on all checks passing). */
export async function modernizeRom(opts: ModernizeOptions): Promise<ModernizeResult> {
  const expectedVanillaSha1 = opts._allowedVanillaSha1 ?? VANILLA_FRLG_USA_REV0_SHA1;
  const assetsRoot = opts._assetsRoot ?? defaultAssetsRoot();

  // 1. Locate the project's .gba file.
  const romPath = await findFirstGbaFile(opts.projectRoot);
  if (!romPath) {
    throw new ModernizeError(
      'rom_not_found',
      `No .gba file found under '${opts.projectRoot}'. Modernize requires an opened ROM project.`,
    );
  }

  // 2. Load ROM bytes + compute SHA-1.
  const romBytes = new Uint8Array(await fsp.readFile(romPath));
  const previousSha1 = sha1Hex(romBytes);

  // 3. Load the bundled patch + metadata.
  const { patch, metadata, bundleId } = await loadBundle(assetsRoot);
  const bundledPatchSha1 = sha1Hex(patch);

  // 3a. The slice-4 placeholder ships with `built: false` so the
  //     editor refuses cleanly until slice 7's bundle script
  //     generates the real cfru.bps + cfru.json.
  if (!metadata.built) {
    throw new ModernizeError(
      'patch_artifact_missing',
      `The upgrade files aren't installed with this build of the editor. ` +
        `Run scripts/build-cfru-bundle.mjs against a CFRU clone to generate them.`,
    );
  }

  // 4. Check for "already modernized" BEFORE the vanilla hash check so
  //    users get the friendlier message when they accidentally try to
  //    re-modernize a modernized ROM.
  if (previousSha1 === metadata.producesSha1) {
    throw new ModernizeError(
      'already_modernized',
      `This ROM has already been modernized. No changes were made.`,
    );
  }

  // 5. Verify the input ROM is the expected vanilla FRLG.
  if (previousSha1 !== expectedVanillaSha1) {
    throw new ModernizeError(
      'rom_hash_mismatch',
      `Modernize only works on the original Pokémon FireRed (version 1.0, USA). ` +
        `Your ROM doesn't match (expected SHA-1 ${expectedVanillaSha1}, got ${previousSha1}). ` +
        `Please open a clean copy.`,
    );
  }

  // 6. Apply the patch in memory.
  let newBytes: Uint8Array;
  try {
    newBytes = enginePatch.applyBps(romBytes, patch);
  } catch (e) {
    throw new ModernizeError(
      'apply_failed',
      `Couldn't apply the modernize patch: ${(e as Error).message}`,
    );
  }

  // 7. Verify the post-apply hash matches what the bundle promised.
  const newSha1 = sha1Hex(newBytes);
  if (newSha1 !== metadata.producesSha1) {
    throw new ModernizeError(
      'patch_verification_failed',
      `The upgrade file produced an unexpected result (expected SHA-1 ${metadata.producesSha1}, ` +
        `got ${newSha1}). The bundled patch may be corrupted - reinstall the editor or ` +
        `re-run scripts/build-cfru-bundle.mjs.`,
    );
  }

  // 8. Write backup, then atomic-write the new ROM.
  const backupPath = `${romPath}.pre-modernize.bak`;
  try {
    await fsp.writeFile(backupPath, romBytes);
  } catch (e) {
    throw new ModernizeError(
      'write_failed',
      `Couldn't write the backup ROM to ${backupPath}: ${(e as Error).message}`,
    );
  }
  const tmpPath = `${romPath}.modernize.tmp`;
  try {
    await fsp.writeFile(tmpPath, newBytes);
    await fsp.rename(tmpPath, romPath);
  } catch (e) {
    // Best-effort cleanup of any partial tmp file.
    try {
      await fsp.unlink(tmpPath);
    } catch {
      /* ignore */
    }
    throw new ModernizeError(
      'write_failed',
      `Couldn't write the modernized ROM to ${romPath}: ${(e as Error).message}`,
    );
  }

  return Object.freeze({
    previousSha1,
    newSha1,
    cfruVersion: metadata.cfruVersion,
    cfruCommitShortSha: metadata.cfruCommitShortSha,
    buildOffset: metadata.buildOffset,
    bytesWritten: newBytes.length,
    previousRomBackupPath: backupPath,
    bundledPatchSha1,
    bundleId,
  });
}
