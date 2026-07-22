export interface BuildRunRequest {
  /** If true, run the testCommand from BuildProfile instead of buildCommand. */
  readonly useTestCommand?: boolean;
  /** Override the command entirely (e.g. operator chose a custom target). */
  readonly commandOverride?: string;
  /** Argv-form override - bypasses whitespace splitting. Use when the binary
   *  path contains spaces or arguments contain shell-special characters. */
  readonly argvOverride?: ReadonlyArray<string>;
  /** Per-request timeout in milliseconds; clamped server-side. */
  readonly timeoutMs?: number;
}

export interface BuildRunResponse {
  readonly sessionId: string;
  readonly command: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly spawnError: string | null;
}

export interface BuildArtifactInfo {
  readonly relativePath: string;
  readonly exists: boolean;
  readonly sizeBytes: number | null;
  readonly mtimeUtc: string | null;
  readonly isPatchFormat: boolean;
}

export interface BuildArtifactsResponse {
  readonly sessionId: string;
  readonly buildProfileDetected: boolean;
  readonly outputPaths: ReadonlyArray<BuildArtifactInfo>;
}

/** Modernize-and-Ship slice 8 - patch export format. Defaults to 'ips'
 *  for backwards compatibility. Use 'bps' for CFRU-modernized ROMs
 *  whose edits exceed IPS's 16 MiB addressable window. */
export type PatchFormat = 'ips' | 'bps';

export interface PatchGenerationRequest {
  /** Absolute or project-relative path to the unmodified base ROM. */
  readonly baseRomPath: string;
  /** Project-relative path to the modified (built) ROM. */
  readonly modifiedRomPath: string;
  /** Project-relative path where the patch should land. */
  readonly outputPath: string;
  /** Patch format. Defaults to 'ips'. */
  readonly patchFormat?: PatchFormat;
}

export interface PatchGenerationResponse {
  readonly sessionId: string;
  readonly outputPath: string;
  readonly recordCount: number;
  readonly totalPatchedBytes: number;
  readonly patchBytes: number;
  readonly baseSizeBytes: number;
  readonly modifiedSizeBytes: number;
  readonly patchFormat: PatchFormat;
}

export interface SharePackageMeta {
  readonly modName: string;
  readonly version: string;
  readonly author: string;
  readonly description: string;
}

export interface SharePackageRequest {
  /** Project-relative path to the .ips patch to ship. */
  readonly patchPath: string;
  /** Absolute or project-relative path to the base ROM (for SHA-256 only - not copied). */
  readonly baseRomPath: string;
  /** Project-relative path to the directory where the package materializes. */
  readonly outputDir: string;
  readonly meta: SharePackageMeta;
}

export interface SharePackageFile {
  readonly relativePath: string;
  readonly sizeBytes: number;
}

export interface SharePackageResponse {
  readonly sessionId: string;
  readonly outputDir: string;
  readonly files: ReadonlyArray<SharePackageFile>;
  readonly totalSize: number;
  readonly baseRomSha256: string;
}

// Modernize-and-Ship slice 4 - one-click "Modernize" upgrade of a
// vanilla FRLG ROM to a CFRU-modernized ROM. The request has no body
// (the bundled patch is shipped with the editor); the response carries
// the previous/new SHA-1s + CFRU version metadata so the frontend can
// render the post-success confirmation copy without re-fetching.

export interface ModernizeResponse {
  readonly sessionId: string;
  readonly previousSha1: string;
  readonly newSha1: string;
  readonly cfruVersion: string;
  readonly cfruCommitShortSha: string;
  readonly buildOffset: number;
  readonly bytesWritten: number;
}

export type ModernizeErrorCode =
  | 'rom_not_found'
  | 'rom_hash_mismatch'
  | 'already_modernized'
  | 'patch_artifact_missing'
  | 'patch_verification_failed'
  | 'apply_failed'
  | 'write_failed';

export interface ModernizeAttribution {
  readonly cfruVersion: string;
  readonly cfruCommitShortSha: string;
  readonly built: boolean;
  /** Plain-English credits + license summary, materialized from
   *  ATTRIBUTION.md shipped with the bundle. */
  readonly attribution: string;
}
