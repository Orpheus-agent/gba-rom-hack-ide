import type { ProjectManifest } from './manifest.js';

export interface ScanRequest {
  /** Optional: skip manifest read-from-disk and force a fresh scan. */
  readonly forceRescan?: boolean;
}

export interface ScanResponse {
  readonly sessionId: string;
  /** Absolute path to the persisted `<projectRoot>/.editor/manifest.json`. */
  readonly manifestPath: string;
  readonly manifest: ProjectManifest;
  readonly scannerName: string;
  readonly scanDurationMs: number;
  readonly warnings: ReadonlyArray<string>;
}

export type ScanErrorCode =
  | 'session_not_found'
  | 'project_kind_unsupported'
  | 'scan_failed'
  | 'manifest_write_failed';
