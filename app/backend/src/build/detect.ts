import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { BuildProfile, ProjectIdentity } from '@rom-editor/shared';

async function exists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

async function listFiles(dir: string): Promise<string[]> {
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isFile()).map((e) => e.name);
  } catch {
    return [];
  }
}

function pickFirstByExt(files: ReadonlyArray<string>, exts: ReadonlyArray<string>): string | null {
  for (const f of files) {
    const ext = path.extname(f).toLowerCase();
    if (exts.includes(ext)) return f;
  }
  return null;
}

const PATCH_EXTS = ['.ips', '.ups', '.bps'];
const ROM_EXTS = ['.gba'];

export interface DetectBuildOptions {
  readonly identity?: ProjectIdentity;
}

export async function detectBuildProfile(
  projectRoot: string,
  options: DetectBuildOptions = {},
): Promise<BuildProfile | null> {
  const hasMakefile = await exists(path.join(projectRoot, 'Makefile'));
  const hasAgbcc = await exists(path.join(projectRoot, 'tools', 'agbcc'));
  const hasDevkitARM = await exists(path.join(projectRoot, 'tools', 'devkitARM'));

  // Decomp pipeline: Makefile + a known toolchain marker. The buildCommand is
  // `make` (canonical for pokeemerald-class). Some forks expose extra targets
  // like `make modern` or `make compare` - these are surfaced via testCommand
  // when present rather than guessed.
  if (hasMakefile) {
    let toolchain = 'make';
    if (hasAgbcc) toolchain = 'agbcc+make';
    else if (hasDevkitARM) toolchain = 'devkitARM+make';

    const outputPaths: string[] = [];
    // Common pokeemerald-class outputs land at the root: <project>.gba and the
    // .elf intermediate. Detect by reading what `.ld` files are present, since
    // they're already used by detectProject.
    for (const baseGame of ['pokeemerald', 'pokefirered', 'pokeruby']) {
      if (await exists(path.join(projectRoot, `${baseGame}.ld`))) {
        outputPaths.push(`${baseGame}.gba`);
        outputPaths.push(`${baseGame}.elf`);
        break;
      }
    }
    if (outputPaths.length === 0) outputPaths.push('*.gba');

    const hasCompareTarget = await makefileMentions(
      path.join(projectRoot, 'Makefile'),
      /^compare\b|^compare:/m,
    );

    return {
      toolchain,
      buildCommand: 'make',
      outputPaths,
      testCommand: hasCompareTarget ? 'make compare' : null,
    };
  }

  // Patch pipeline: a single patch file (or one in patches/) + a base ROM in the
  // workspace root. Buildable via `flips` (or an equivalent IPS/UPS/BPS tool).
  const rootFiles = await listFiles(projectRoot);
  let patchFile = pickFirstByExt(rootFiles, PATCH_EXTS);
  let patchSubdir: string | null = null;
  if (!patchFile) {
    for (const sub of ['patches', 'patch']) {
      const subFiles = await listFiles(path.join(projectRoot, sub));
      patchFile = pickFirstByExt(subFiles, PATCH_EXTS);
      if (patchFile) {
        patchSubdir = sub;
        break;
      }
    }
  }
  const romFile = pickFirstByExt(rootFiles, ROM_EXTS);
  if (patchFile && romFile) {
    const patchRel = patchSubdir ? `${patchSubdir}/${patchFile}` : patchFile;
    const outName = `${path.basename(romFile, '.gba')}.patched.gba`;
    return {
      toolchain: 'flips',
      buildCommand: `flips --apply ${patchRel} ${romFile} ${outName}`,
      outputPaths: [outName],
      testCommand: null,
    };
  }

  void options;
  return null;
}

async function makefileMentions(makefilePath: string, pattern: RegExp): Promise<boolean> {
  try {
    const content = await fsp.readFile(makefilePath, 'utf8');
    return pattern.test(content);
  } catch {
    return false;
  }
}
