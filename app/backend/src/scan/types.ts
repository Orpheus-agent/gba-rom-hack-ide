import type { ProjectIdentity, ProjectManifest } from '@rom-editor/shared';

export interface ScanResult {
  readonly manifest: ProjectManifest;
  readonly scannerName: string;
  readonly warnings: ReadonlyArray<string>;
}

export interface ProjectScanner {
  readonly name: string;
  /** True if this scanner can handle a project of the given detected identity. */
  supports(identity: ProjectIdentity): boolean;
  scan(projectRoot: string, identity: ProjectIdentity): Promise<ScanResult>;
}
