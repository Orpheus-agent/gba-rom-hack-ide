import { promises as fsp } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { patch as enginePatch } from '@rom-introspection/engine';
import {
  ModernizeError,
  VANILLA_FRLG_USA_REV0_SHA1,
  modernizeRom,
} from './modernize.js';

/** Build a tiny "vanilla FRLG-ish" stub. We don't need a real 16 MiB
 *  ROM for the test - modernizeRom() doesn't inspect anything beyond
 *  the SHA-1. Returns the bytes + their SHA-1 hex. */
function makeVanillaStub(seed: number): { bytes: Uint8Array; sha1: string } {
  const bytes = new Uint8Array(256);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (seed + i) & 0xff;
  const sha1 = createHash('sha1').update(bytes).digest('hex');
  return { bytes, sha1 };
}

/** Build a synthetic bundled-patch fixture: a vanilla ROM, a target
 *  ROM, the corresponding BPS, and a cfru.json that declares the
 *  expected hashes. The bundle is written to a fresh tmp dir; the
 *  vanilla bytes + tmpAssetsRoot are returned so the test can wire
 *  them into modernizeRom via the test-DI fields. */
async function buildSyntheticBundle(opts: {
  built: boolean;
  vanillaSeed?: number;
  targetTrailerByte?: number;
}): Promise<{
  assetsRoot: string;
  vanillaBytes: Uint8Array;
  vanillaSha1: string;
  targetBytes: Uint8Array;
  producesSha1: string;
}> {
  const { bytes: vanillaBytes, sha1: vanillaSha1 } = makeVanillaStub(opts.vanillaSeed ?? 0);
  // Target = vanilla + one differing trailer byte. produceBpsActions
  // will emit a single source_read covering the matching prefix and
  // a single target_read for the changed byte.
  const targetBytes = new Uint8Array(vanillaBytes);
  const trailerByte = opts.targetTrailerByte ?? 0xab;
  targetBytes[targetBytes.length - 1] = trailerByte;
  const producesSha1 = createHash('sha1').update(targetBytes).digest('hex');
  const actions = enginePatch.produceBpsActions(vanillaBytes, targetBytes);
  const patchBytes = enginePatch.encodeBps(actions, vanillaBytes, targetBytes);

  const assetsRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'modernize-test-'));
  await fsp.writeFile(path.join(assetsRoot, 'cfru.bps'), patchBytes);
  await fsp.writeFile(
    path.join(assetsRoot, 'cfru.json'),
    JSON.stringify(
      {
        vanillaSha1,
        producesSha1,
        cfruVersion: 'test-bundle',
        cfruCommitShortSha: 'deadbee',
        buildOffset: 0x900000,
        built: opts.built,
      },
      null,
      2,
    ),
  );
  return { assetsRoot, vanillaBytes, vanillaSha1, targetBytes, producesSha1 };
}

/** Create a project root tmp dir with a single .gba file containing
 *  the supplied bytes. Returns the project root + romPath. */
async function setupProject(romBytes: Uint8Array): Promise<{
  projectRoot: string;
  romPath: string;
}> {
  const projectRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'modernize-proj-'));
  const romPath = path.join(projectRoot, 'firered.gba');
  await fsp.writeFile(romPath, romBytes);
  return { projectRoot, romPath };
}

const tmpDirs: string[] = [];
beforeEach(() => {
  tmpDirs.length = 0;
});
afterEach(async () => {
  for (const d of tmpDirs) {
    await fsp.rm(d, { recursive: true, force: true });
  }
});

describe('modernizeRom', () => {
  it('rejects when no .gba is present in the project', async () => {
    const projectRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'modernize-empty-'));
    tmpDirs.push(projectRoot);
    const { assetsRoot } = await buildSyntheticBundle({ built: true });
    tmpDirs.push(assetsRoot);
    await expect(
      modernizeRom({ projectRoot, sessionId: 's', _assetsRoot: assetsRoot }),
    ).rejects.toMatchObject({ code: 'rom_not_found' });
  });

  it('rejects when the ROM SHA-1 does not match vanilla FRLG', async () => {
    const bundle = await buildSyntheticBundle({ built: true });
    tmpDirs.push(bundle.assetsRoot);
    // Different seed → different SHA-1 than what _allowedVanillaSha1 expects.
    const wrong = makeVanillaStub(99);
    const { projectRoot } = await setupProject(wrong.bytes);
    tmpDirs.push(projectRoot);
    await expect(
      modernizeRom({
        projectRoot,
        sessionId: 's',
        _assetsRoot: bundle.assetsRoot,
        _allowedVanillaSha1: bundle.vanillaSha1,
      }),
    ).rejects.toMatchObject({ code: 'rom_hash_mismatch' });
  });

  it('rejects when the ROM already matches producesSha1 ("already modernized")', async () => {
    const bundle = await buildSyntheticBundle({ built: true });
    tmpDirs.push(bundle.assetsRoot);
    // Set the project's ROM to the target bytes (post-modernize state).
    const { projectRoot } = await setupProject(bundle.targetBytes);
    tmpDirs.push(projectRoot);
    await expect(
      modernizeRom({
        projectRoot,
        sessionId: 's',
        _assetsRoot: bundle.assetsRoot,
        _allowedVanillaSha1: bundle.vanillaSha1,
      }),
    ).rejects.toMatchObject({ code: 'already_modernized' });
  });

  it('rejects when the bundle is the slice-4 placeholder (built: false)', async () => {
    const bundle = await buildSyntheticBundle({ built: false });
    tmpDirs.push(bundle.assetsRoot);
    const { projectRoot } = await setupProject(bundle.vanillaBytes);
    tmpDirs.push(projectRoot);
    await expect(
      modernizeRom({
        projectRoot,
        sessionId: 's',
        _assetsRoot: bundle.assetsRoot,
        _allowedVanillaSha1: bundle.vanillaSha1,
      }),
    ).rejects.toMatchObject({ code: 'patch_artifact_missing' });
  });

  it('rejects when the bundle assets are missing entirely', async () => {
    const missingAssetsRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'modernize-no-assets-'));
    tmpDirs.push(missingAssetsRoot);
    const stub = makeVanillaStub(0);
    const { projectRoot } = await setupProject(stub.bytes);
    tmpDirs.push(projectRoot);
    await expect(
      modernizeRom({
        projectRoot,
        sessionId: 's',
        _assetsRoot: missingAssetsRoot,
        _allowedVanillaSha1: stub.sha1,
      }),
    ).rejects.toMatchObject({ code: 'patch_artifact_missing' });
  });

  it('rejects when producesSha1 in cfru.json disagrees with what the patch actually produces', async () => {
    const bundle = await buildSyntheticBundle({ built: true });
    tmpDirs.push(bundle.assetsRoot);
    // Tamper with cfru.json's producesSha1 - the patch is fine but the
    // metadata lies about what it produces. modernizeRom checks the
    // post-apply hash against the declared one.
    const jsonPath = path.join(bundle.assetsRoot, 'cfru.json');
    const raw = JSON.parse(await fsp.readFile(jsonPath, 'utf-8')) as Record<string, unknown>;
    raw['producesSha1'] = '1111111111111111111111111111111111111111';
    await fsp.writeFile(jsonPath, JSON.stringify(raw, null, 2));
    const { projectRoot } = await setupProject(bundle.vanillaBytes);
    tmpDirs.push(projectRoot);
    await expect(
      modernizeRom({
        projectRoot,
        sessionId: 's',
        _assetsRoot: bundle.assetsRoot,
        _allowedVanillaSha1: bundle.vanillaSha1,
      }),
    ).rejects.toMatchObject({ code: 'patch_verification_failed' });
  });

  it('happy path: applies the bundle, writes a backup, and reports the metadata', async () => {
    const bundle = await buildSyntheticBundle({ built: true });
    tmpDirs.push(bundle.assetsRoot);
    const { projectRoot, romPath } = await setupProject(bundle.vanillaBytes);
    tmpDirs.push(projectRoot);

    const result = await modernizeRom({
      projectRoot,
      sessionId: 's',
      _assetsRoot: bundle.assetsRoot,
      _allowedVanillaSha1: bundle.vanillaSha1,
    });

    expect(result.previousSha1).toBe(bundle.vanillaSha1);
    expect(result.newSha1).toBe(bundle.producesSha1);
    expect(result.cfruVersion).toBe('test-bundle');
    expect(result.cfruCommitShortSha).toBe('deadbee');
    expect(result.buildOffset).toBe(0x900000);
    expect(result.bytesWritten).toBe(bundle.targetBytes.length);
    expect(result.previousRomBackupPath).toBe(`${romPath}.pre-modernize.bak`);

    // ROM on disk is now the target bytes.
    const onDiskAfter = await fsp.readFile(romPath);
    expect(new Uint8Array(onDiskAfter)).toEqual(bundle.targetBytes);

    // Backup file matches the pre-modernize bytes.
    const backupBytes = await fsp.readFile(result.previousRomBackupPath);
    expect(new Uint8Array(backupBytes)).toEqual(bundle.vanillaBytes);

    // bundledPatchSha1 is consistent - re-derive it and compare.
    const patchOnDisk = await fsp.readFile(path.join(bundle.assetsRoot, 'cfru.bps'));
    const expectedPatchSha1 = createHash('sha1').update(patchOnDisk).digest('hex');
    expect(result.bundledPatchSha1).toBe(expectedPatchSha1);
  });

  it('exposes the canonical vanilla SHA-1 constant', () => {
    expect(VANILLA_FRLG_USA_REV0_SHA1).toBe(
      '41cb23d8dccc8ebd7c649cd8fbb58eeace6e2fdc',
    );
  });

  it('throws ModernizeError instances (not bare Error) on failure paths', async () => {
    const bundle = await buildSyntheticBundle({ built: true });
    tmpDirs.push(bundle.assetsRoot);
    const wrong = makeVanillaStub(99);
    const { projectRoot } = await setupProject(wrong.bytes);
    tmpDirs.push(projectRoot);
    let caught: unknown = null;
    try {
      await modernizeRom({
        projectRoot,
        sessionId: 's',
        _assetsRoot: bundle.assetsRoot,
        _allowedVanillaSha1: bundle.vanillaSha1,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ModernizeError);
  });
});
