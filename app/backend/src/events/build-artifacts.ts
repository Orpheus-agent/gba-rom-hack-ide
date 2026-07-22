// Build artifact probe - given the manifest's detected outputPaths, returns a
// typed list of what's actually on disk: existence, size, mtime, and a flag
// for patch-format files. Pure read; no mutation. Used by the Build tab to
// answer "did the last build actually produce the .gba ROM?" without the
// operator opening a file manager.

import { promises as fsp } from 'node:fs';
import path from 'node:path';

const PATCH_EXTENSIONS: ReadonlySet<string> = new Set(['.ips', '.bps', '.ups']);

export interface BuildArtifactInfo {
  readonly relativePath: string;
  readonly exists: boolean;
  readonly sizeBytes: number | null;
  readonly mtimeUtc: string | null;
  readonly isPatchFormat: boolean;
}

export async function probeBuildArtifacts(
  projectRoot: string,
  outputPaths: ReadonlyArray<string>,
): Promise<ReadonlyArray<BuildArtifactInfo>> {
  const out: BuildArtifactInfo[] = [];
  for (const rel of outputPaths) {
    const ext = path.extname(rel).toLowerCase();
    const isPatchFormat = PATCH_EXTENSIONS.has(ext);
    const abs = path.join(projectRoot, rel);
    try {
      const stat = await fsp.stat(abs);
      out.push({
        relativePath: rel,
        exists: true,
        sizeBytes: stat.size,
        mtimeUtc: stat.mtime.toISOString(),
        isPatchFormat,
      });
    } catch {
      out.push({
        relativePath: rel,
        exists: false,
        sizeBytes: null,
        mtimeUtc: null,
        isPatchFormat,
      });
    }
  }
  return out;
}
