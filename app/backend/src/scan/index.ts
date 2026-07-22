import type { ProjectIdentity, ProjectManifest } from '@rom-editor/shared';
import { detectProject } from '../detect/index.js';
import { decompScanner } from './decomp.js';
import { binaryRomScanner } from './binary-rom.js';
import type { ProjectScanner, ScanResult } from './types.js';

export { decompScanner };
export { binaryRomScanner };
export type { ProjectScanner, ScanResult } from './types.js';
export { writeManifest, readManifest, manifestPathFor, EDITOR_DIR_NAME, MANIFEST_FILENAME } from './manifest-io.js';

/**
 * Default scanner registry - checked in order; first scanner whose
 * `supports(identity)` returns true wins. Order matters:
 *   1. decompScanner - handles 'decomp' + 'hybrid' (source-tree-driven)
 *   2. binaryRomScanner - handles 'patch' (bare-ROM, engine-pipeline-driven)
 *   3. (NoOpScanner fallback in `scanProject` below - only fires for
 *      'unknown' kind where neither scanner applies)
 *
 * GROWTH POINT: when a new ProjectKind lands (e.g. 'archive' for
 * extracted ZIPs that don't classify as decomp), add a scanner here
 * and ensure its `supports()` returns true for that kind.
 */
const DEFAULT_SCANNERS: ReadonlyArray<ProjectScanner> = [decompScanner, binaryRomScanner];

export class NoSupportedScannerError extends Error {
  constructor(public readonly kind: string) {
    super(`No project scanner supports kind '${kind}'`);
    this.name = 'NoSupportedScannerError';
  }
}

/**
 * Picks the first scanner that supports the given identity and runs it.
 * If no scanner applies (e.g. kind='unknown' or 'patch' alone), returns an
 * empty manifest carrying just the identity so callers still get a valid
 * canonical document to render.
 */
export async function scanProject(
  projectRoot: string,
  options: { identity?: ProjectIdentity; scanners?: ReadonlyArray<ProjectScanner> } = {},
): Promise<ScanResult> {
  const identity = options.identity ?? (await detectProject(projectRoot));
  const scanners = options.scanners ?? DEFAULT_SCANNERS;
  const scanner = scanners.find((s) => s.supports(identity));

  if (!scanner) {
    const empty: ProjectManifest = {
      schemaVersion: 1,
      generatedAtUtc: new Date().toISOString(),
      projectRoot,
      identity,
      buildProfile: null,
      maps: [],
      warps: [],
      triggers: [],
      objectEvents: [],
      dialogue: [],
      flags: [],
      variables: [],
      encounterTables: [],
      trainers: [],
      scriptSteps: [],
      assets: [],
    };
    return {
      manifest: empty,
      scannerName: 'NoOpScanner',
      warnings: [
        `No scanner supports project kind '${identity.kind}'. The canonical manifest was generated empty for this session; opening a decomp project will populate it.`,
      ],
    };
  }

  return scanner.scan(projectRoot, identity);
}
