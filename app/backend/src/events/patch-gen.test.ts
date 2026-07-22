import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PatchGenerationError, generatePatch } from './patch-gen.js';
// PD 13 (UW-0-T8): IPS roundtrip-verify routes through the engine.
import { patch as enginePatch } from '@rom-introspection/engine';

describe('generatePatch', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(path.join(tmpdir(), 'rom-editor-patch-'));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('atomically writes a real IPS patch that roundtrips back to the modified ROM', async () => {
    const base = Buffer.alloc(64, 0x00);
    const modified = Buffer.from(base);
    modified[10] = 0xff;
    modified[20] = 0xee;
    writeFileSync(path.join(projectRoot, 'base.gba'), base);
    writeFileSync(path.join(projectRoot, 'pokeemerald.gba'), modified);

    const r = await generatePatch({
      projectRoot,
      baseRomPath: 'base.gba',
      modifiedRomPath: 'pokeemerald.gba',
      outputPath: 'patches/my-mod.ips',
    });

    expect(r.recordCount).toBe(2);
    expect(r.totalPatchedBytes).toBe(2);
    expect(r.baseSizeBytes).toBe(64);
    expect(r.modifiedSizeBytes).toBe(64);

    const onDisk = readFileSync(path.join(projectRoot, 'patches/my-mod.ips'));
    expect(onDisk.length).toBe(r.patchBytes);
    expect(onDisk.subarray(0, 5).toString('ascii')).toBe('PATCH');
    expect(onDisk.subarray(-3).toString('ascii')).toBe('EOF');

    // Roundtrip: decode the on-disk patch + base → expect modified.
    // Uses engine's decodeIps + applyIps (legacy lib/ips-patch.ts deleted
    // in UW-0-T8 after engine became sole-source per PD 13).
    const records = enginePatch.decodeIps(onDisk);
    const restored = Buffer.from(enginePatch.applyIps(base, records));
    expect(restored.equals(modified)).toBe(true);
  });

  it('rejects output path that escapes the project root', async () => {
    writeFileSync(path.join(projectRoot, 'base.gba'), Buffer.alloc(8, 0x00));
    writeFileSync(path.join(projectRoot, 'mod.gba'), Buffer.alloc(8, 0x01));
    await expect(
      generatePatch({
        projectRoot,
        baseRomPath: 'base.gba',
        modifiedRomPath: 'mod.gba',
        outputPath: '../escaped.ips',
      }),
    ).rejects.toMatchObject({
      name: 'PatchGenerationError',
      code: 'output_path_escapes_project_root',
    });
  });

  it('rejects when base ROM does not exist', async () => {
    writeFileSync(path.join(projectRoot, 'mod.gba'), Buffer.alloc(8));
    await expect(
      generatePatch({
        projectRoot,
        baseRomPath: 'missing.gba',
        modifiedRomPath: 'mod.gba',
        outputPath: 'p.ips',
      }),
    ).rejects.toMatchObject({ code: 'base_rom_not_found' });
  });

  it('rejects when modified ROM does not exist', async () => {
    writeFileSync(path.join(projectRoot, 'base.gba'), Buffer.alloc(8));
    await expect(
      generatePatch({
        projectRoot,
        baseRomPath: 'base.gba',
        modifiedRomPath: 'mod.gba',
        outputPath: 'p.ips',
      }),
    ).rejects.toMatchObject({ code: 'modified_rom_not_found' });
  });

  it('rejects an empty ROM file with rom_empty', async () => {
    writeFileSync(path.join(projectRoot, 'base.gba'), Buffer.alloc(0));
    writeFileSync(path.join(projectRoot, 'mod.gba'), Buffer.alloc(8));
    await expect(
      generatePatch({
        projectRoot,
        baseRomPath: 'base.gba',
        modifiedRomPath: 'mod.gba',
        outputPath: 'p.ips',
      }),
    ).rejects.toMatchObject({ code: 'rom_empty' });
  });

  it('produces a patch even when base and modified are identical (empty patch body)', async () => {
    const buf = Buffer.alloc(32, 0xaa);
    writeFileSync(path.join(projectRoot, 'base.gba'), buf);
    writeFileSync(path.join(projectRoot, 'mod.gba'), buf);
    const r = await generatePatch({
      projectRoot,
      baseRomPath: 'base.gba',
      modifiedRomPath: 'mod.gba',
      outputPath: 'p.ips',
    });
    expect(r.recordCount).toBe(0);
    expect(r.totalPatchedBytes).toBe(0);
    expect(existsSync(path.join(projectRoot, 'p.ips'))).toBe(true);
  });

  // Modernize-and-Ship slice 8 - BPS export path.
  it('atomically writes a real BPS patch that roundtrips back to the modified ROM', async () => {
    const base = Buffer.alloc(128, 0x00);
    const modified = Buffer.from(base);
    modified[42] = 0xab;
    modified[100] = 0xcd;
    writeFileSync(path.join(projectRoot, 'base.gba'), base);
    writeFileSync(path.join(projectRoot, 'mod.gba'), modified);

    const r = await generatePatch({
      projectRoot,
      baseRomPath: 'base.gba',
      modifiedRomPath: 'mod.gba',
      outputPath: 'patches/my-mod.bps',
      patchFormat: 'bps',
    });

    expect(r.patchFormat).toBe('bps');
    expect(r.baseSizeBytes).toBe(128);
    expect(r.modifiedSizeBytes).toBe(128);

    const onDisk = readFileSync(path.join(projectRoot, 'patches/my-mod.bps'));
    expect(onDisk.length).toBe(r.patchBytes);
    expect(onDisk.subarray(0, 4).toString('ascii')).toBe('BPS1');

    // Roundtrip: applyBps on the patch + base → expect modified bytes.
    const restored = Buffer.from(
      enginePatch.applyBps(new Uint8Array(base), new Uint8Array(onDisk)),
    );
    expect(restored.equals(modified)).toBe(true);
  });

  it('reports patchFormat: "ips" in the result by default (no patchFormat arg)', async () => {
    const base = Buffer.alloc(16, 0x00);
    const modified = Buffer.from(base);
    modified[0] = 0xff;
    writeFileSync(path.join(projectRoot, 'base.gba'), base);
    writeFileSync(path.join(projectRoot, 'mod.gba'), modified);
    const r = await generatePatch({
      projectRoot,
      baseRomPath: 'base.gba',
      modifiedRomPath: 'mod.gba',
      outputPath: 'p.ips',
    });
    expect(r.patchFormat).toBe('ips');
  });

  it('BPS supports shrinking ROMs (modified < base), which IPS does not', async () => {
    const base = Buffer.alloc(64, 0x55);
    const modified = Buffer.alloc(32, 0x55);
    writeFileSync(path.join(projectRoot, 'base.gba'), base);
    writeFileSync(path.join(projectRoot, 'mod.gba'), modified);
    const r = await generatePatch({
      projectRoot,
      baseRomPath: 'base.gba',
      modifiedRomPath: 'mod.gba',
      outputPath: 'shrink.bps',
      patchFormat: 'bps',
    });
    expect(r.modifiedSizeBytes).toBe(32);
    expect(r.patchFormat).toBe('bps');
    const onDisk = readFileSync(path.join(projectRoot, 'shrink.bps'));
    const restored = Buffer.from(
      enginePatch.applyBps(new Uint8Array(base), new Uint8Array(onDisk)),
    );
    expect(restored.length).toBe(32);
    expect(restored.equals(modified)).toBe(true);
  });
});
