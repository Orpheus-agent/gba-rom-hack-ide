// Project session + filesystem listing contracts shared between backend and
// frontend. The universal entity vocabulary lives in vocabulary.ts and
// nowhere else; these are session and IO envelopes around an opened project.

export interface ProjectOpenRequest {
  readonly projectRoot: string;
}

export interface ProjectSession {
  readonly id: string;
  readonly projectRoot: string;
  readonly openedAtUtc: string;
}

export type DirectoryEntryKind = 'file' | 'directory' | 'symlink' | 'other';

export interface DirectoryEntry {
  readonly name: string;
  readonly kind: DirectoryEntryKind;
  /** POSIX-style path relative to project root ('' = root). Always forward-slash. */
  readonly relativePath: string;
  /** File size in bytes; null for directories and other non-files. */
  readonly sizeBytes: number | null;
}

export interface DirectoryListing {
  /** POSIX-style relative path being listed ('' = project root). */
  readonly path: string;
  readonly entries: ReadonlyArray<DirectoryEntry>;
}

import type { ProjectIdentity } from './manifest.js';

export interface ProjectOpenResponse {
  readonly session: ProjectSession;
  readonly rootListing: DirectoryListing;
  readonly identity: ProjectIdentity;
}

export type ProjectErrorCode =
  | 'project_root_not_absolute'
  | 'project_root_not_found'
  | 'project_root_not_directory'
  | 'session_not_found'
  | 'path_escapes_project_root'
  | 'path_not_found'
  | 'path_not_directory'
  | 'build_unavailable'
  | 'job_not_found'
  | 'internal_error';

export interface ProjectErrorResponse {
  readonly error: {
    readonly code: ProjectErrorCode;
    readonly message: string;
  };
}
