import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { SharePackageError, materializeSharePackage } from './share-package.js';

describe('materializeSharePackage', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(path.join(tmpdir(), 'rom-editor-share-'));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('materializes a clean share dir with patch + README and reports both files', async () => {
    const patchBytes = Buffer.from('PATCH some bytes here EOF', 'ascii');
    const baseBytes = Buffer.alloc(64, 0xab);
    mkdirSync(path.join(projectRoot, 'patches'), { recursive: true });
    writeFileSync(path.join(projectRoot, 'patches/my-mod.ips'), patchBytes);
    writeFileSync(path.join(projectRoot, 'base.gba'), baseBytes);

    const r = await materializeSharePackage({
      projectRoot,
      patchPath: 'patches/my-mod.ips',
      baseRomPath: 'base.gba',
      meta: {
        modName: 'My Mod',
        version: '1.0.0',
        author: 'Alice',
        description: 'A test mod that does very cool things.',
      },
      outputDir: 'dist/share',
    });

    expect(r.outputDir).toBe('dist/share');
    expect(r.files).toHaveLength(2);
    expect(r.files.map((f) => f.relativePath).sort()).toEqual(['README.md', 'my-mod.ips']);
    expect(r.totalSize).toBe(r.files.reduce((a, f) => a + f.sizeBytes, 0));

    // Files exist on disk and match input
    expect(existsSync(path.join(projectRoot, 'dist/share/my-mod.ips'))).toBe(true);
    expect(existsSync(path.join(projectRoot, 'dist/share/README.md'))).toBe(true);
    const onDiskPatch = readFileSync(path.join(projectRoot, 'dist/share/my-mod.ips'));
    expect(onDiskPatch.equals(patchBytes)).toBe(true);
  });

  it('computes the correct SHA-256 of the base ROM and embeds it in the README', async () => {
    const baseBytes = Buffer.alloc(128, 0xcd);
    const expectedHash = createHash('sha256').update(baseBytes).digest('hex');
    mkdirSync(path.join(projectRoot, 'patches'), { recursive: true });
    writeFileSync(path.join(projectRoot, 'patches/my-mod.ips'), Buffer.from('PATCHabcEOF'));
    writeFileSync(path.join(projectRoot, 'base.gba'), baseBytes);

    const r = await materializeSharePackage({
      projectRoot,
      patchPath: 'patches/my-mod.ips',
      baseRomPath: 'base.gba',
      meta: { modName: 'Mod', version: '', author: '', description: '' },
      outputDir: 'share',
    });

    expect(r.baseRomSha256).toBe(expectedHash);
    const readme = readFileSync(path.join(projectRoot, 'share/README.md'), 'utf8');
    expect(readme).toContain(`SHA-256: ${expectedHash}`);
    expect(readme).toContain('# Mod');
    expect(readme).toContain('flips --apply my-mod.ips');
  });

  it('rejects an output directory that escapes the project root', async () => {
    mkdirSync(path.join(projectRoot, 'patches'), { recursive: true });
    writeFileSync(path.join(projectRoot, 'patches/p.ips'), Buffer.from('PATCHabcEOF'));
    writeFileSync(path.join(projectRoot, 'base.gba'), Buffer.alloc(8));

    await expect(
      materializeSharePackage({
        projectRoot,
        patchPath: 'patches/p.ips',
        baseRomPath: 'base.gba',
        meta: { modName: 'm', version: '', author: '', description: '' },
        outputDir: '../escaped',
      }),
    ).rejects.toMatchObject({
      name: 'SharePackageError',
      code: 'output_dir_escapes_project_root',
    });
  });

  it('throws patch_not_found when the patch path does not exist', async () => {
    writeFileSync(path.join(projectRoot, 'base.gba'), Buffer.alloc(8));
    await expect(
      materializeSharePackage({
        projectRoot,
        patchPath: 'missing.ips',
        baseRomPath: 'base.gba',
        meta: { modName: 'm', version: '', author: '', description: '' },
        outputDir: 'share',
      }),
    ).rejects.toMatchObject({ code: 'patch_not_found' });
  });

  it('throws base_rom_not_found when the base ROM path does not exist', async () => {
    mkdirSync(path.join(projectRoot, 'patches'), { recursive: true });
    writeFileSync(path.join(projectRoot, 'patches/p.ips'), Buffer.from('PATCHabcEOF'));
    await expect(
      materializeSharePackage({
        projectRoot,
        patchPath: 'patches/p.ips',
        baseRomPath: 'missing.gba',
        meta: { modName: 'm', version: '', author: '', description: '' },
        outputDir: 'share',
      }),
    ).rejects.toMatchObject({ code: 'base_rom_not_found' });
  });

  it('rejects invalid meta (empty modName)', async () => {
    mkdirSync(path.join(projectRoot, 'patches'), { recursive: true });
    writeFileSync(path.join(projectRoot, 'patches/p.ips'), Buffer.from('PATCHabcEOF'));
    writeFileSync(path.join(projectRoot, 'base.gba'), Buffer.alloc(8));
    await expect(
      materializeSharePackage({
        projectRoot,
        patchPath: 'patches/p.ips',
        baseRomPath: 'base.gba',
        meta: { modName: '   ', version: '', author: '', description: '' },
        outputDir: 'share',
      }),
    ).rejects.toBeInstanceOf(SharePackageError);
  });
});
