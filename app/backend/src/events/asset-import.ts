import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { Asset } from '@rom-editor/shared';
import { parsePngHeader } from '../scan/png-header.js';
import { classifyAsset } from '../scan/assets.js';

export class AssetImportError extends Error {
  constructor(
    public readonly code:
      | 'asset_not_found'
      | 'invalid_png'
      | 'dimensions_out_of_range'
      | 'mutation_failed'
      | 'path_escapes_project_root'
      | 'path_not_under_graphics_or_sound'
      | 'path_already_exists'
      | 'unclassifiable_path',
    message: string,
  ) {
    super(message);
    this.name = 'AssetImportError';
  }
}

const MAX_DIMENSION = 2048;

export interface ReplaceAssetPngOptions {
  readonly projectRoot: string;
  readonly asset: Asset;
  readonly pngBase64: string;
}

export interface ReplaceAssetPngResult {
  readonly assetId: string;
  readonly relativePath: string;
  readonly width: number;
  readonly height: number;
  readonly bitDepth: number;
  readonly bytesWritten: number;
}

/**
 * Atomically replace the PNG file behind an existing indexed asset with the
 * caller's base64-encoded PNG bytes. Validates the magic + IHDR + reasonable
 * dimension bounds BEFORE touching the destination, so a failed validation
 * leaves the source file untouched.
 */
export async function replaceAssetPng(
  options: ReplaceAssetPngOptions,
): Promise<ReplaceAssetPngResult> {
  const { projectRoot, asset, pngBase64 } = options;

  let buf: Buffer;
  try {
    buf = Buffer.from(pngBase64, 'base64');
  } catch {
    throw new AssetImportError('invalid_png', 'pngBase64 is not decodable base64');
  }
  if (buf.length === 0) {
    throw new AssetImportError('invalid_png', 'PNG body is empty');
  }

  const header = parsePngHeader(buf);
  if (!header) {
    throw new AssetImportError(
      'invalid_png',
      'PNG signature or IHDR could not be parsed - not a valid PNG',
    );
  }
  if (header.width > MAX_DIMENSION || header.height > MAX_DIMENSION) {
    throw new AssetImportError(
      'dimensions_out_of_range',
      `Dimensions ${header.width}×${header.height} exceed max ${MAX_DIMENSION}`,
    );
  }

  const targetAbs = path.join(projectRoot, asset.relativePath);

  // Confirm the existing file is present so we don't accidentally create a
  // brand-new asset at this path - replacement only, per D-0016.
  try {
    await fsp.access(targetAbs);
  } catch {
    throw new AssetImportError(
      'asset_not_found',
      `Asset file not found at '${asset.relativePath}'`,
    );
  }

  // Make sure the parent directory exists (it always should, but a freshly
  // imported project might race a delete). Idempotent.
  try {
    await fsp.mkdir(path.dirname(targetAbs), { recursive: true });
  } catch (e) {
    throw new AssetImportError(
      'mutation_failed',
      `Could not ensure target directory: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const tmpPath = targetAbs + '.tmp';
  try {
    await fsp.writeFile(tmpPath, buf);
    await fsp.rename(tmpPath, targetAbs);
  } catch (e) {
    try {
      await fsp.unlink(tmpPath);
    } catch {
      /* ignore */
    }
    throw new AssetImportError(
      'mutation_failed',
      `Atomic write failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  return {
    assetId: asset.id,
    relativePath: asset.relativePath,
    width: header.width,
    height: header.height,
    bitDepth: header.bitDepth,
    bytesWritten: buf.length,
  };
}

export interface ImportAssetPngOptions {
  readonly projectRoot: string;
  /** Project-relative path the new asset should land at, e.g.
   *  "graphics/object_events/pics/new_npc.png". Must be under graphics/. */
  readonly relativePath: string;
  readonly pngBase64: string;
}

export interface ImportAssetPngResult {
  readonly relativePath: string;
  readonly width: number;
  readonly height: number;
  readonly bitDepth: number;
  readonly bytesWritten: number;
}

/**
 * Atomically write a NEW PNG asset under the project tree. Validates: path
 * stays inside the project root, path lives under graphics/ or sound/ (so the
 * scanner will index it), basename ends in .png, file does NOT exist yet, AND
 * the body is a valid PNG within the supported dimension range.
 */
export async function importAssetPng(
  options: ImportAssetPngOptions,
): Promise<ImportAssetPngResult> {
  const { projectRoot, relativePath, pngBase64 } = options;

  if (!relativePath || typeof relativePath !== 'string') {
    throw new AssetImportError('unclassifiable_path', 'relativePath must be a non-empty string');
  }
  if (!relativePath.toLowerCase().endsWith('.png')) {
    throw new AssetImportError('unclassifiable_path', 'relativePath must end in .png');
  }

  // Normalize and confirm the resolved path stays inside the project root.
  const targetAbs = path.resolve(projectRoot, relativePath);
  const projectAbs = path.resolve(projectRoot);
  if (
    targetAbs !== projectAbs &&
    !targetAbs.startsWith(projectAbs + path.sep)
  ) {
    throw new AssetImportError(
      'path_escapes_project_root',
      `Path '${relativePath}' resolves outside the project root`,
    );
  }

  // Normalize for kind-classification (the scanner uses forward slashes).
  const relForward = relativePath.replace(/\\/g, '/');
  if (!relForward.startsWith('graphics/') && !relForward.startsWith('sound/')) {
    throw new AssetImportError(
      'path_not_under_graphics_or_sound',
      `Path '${relativePath}' must live under graphics/ or sound/ to be indexed`,
    );
  }

  // Asset kind must classify to something the manifest knows about.
  if (classifyAsset(relForward) === null) {
    throw new AssetImportError(
      'unclassifiable_path',
      `Path '${relativePath}' does not match any indexable asset kind`,
    );
  }

  // Refuse to silently clobber an existing asset - that's what
  // PUT /api/projects/:id/assets/:assetId is for. Honest separation.
  try {
    await fsp.access(targetAbs);
    throw new AssetImportError(
      'path_already_exists',
      `Path '${relativePath}' already exists - use the replace endpoint to overwrite`,
    );
  } catch (e) {
    if (e instanceof AssetImportError) throw e;
    // ENOENT is the success case (file does not exist yet).
  }

  let buf: Buffer;
  try {
    buf = Buffer.from(pngBase64, 'base64');
  } catch {
    throw new AssetImportError('invalid_png', 'pngBase64 is not decodable base64');
  }
  if (buf.length === 0) {
    throw new AssetImportError('invalid_png', 'PNG body is empty');
  }

  const header = parsePngHeader(buf);
  if (!header) {
    throw new AssetImportError(
      'invalid_png',
      'PNG signature or IHDR could not be parsed - not a valid PNG',
    );
  }
  const MAX = 2048;
  if (header.width > MAX || header.height > MAX) {
    throw new AssetImportError(
      'dimensions_out_of_range',
      `Dimensions ${header.width}×${header.height} exceed max ${MAX}`,
    );
  }

  // Ensure the parent directory exists.
  try {
    await fsp.mkdir(path.dirname(targetAbs), { recursive: true });
  } catch (e) {
    throw new AssetImportError(
      'mutation_failed',
      `Could not create parent directory: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const tmpPath = targetAbs + '.tmp';
  try {
    await fsp.writeFile(tmpPath, buf);
    await fsp.rename(tmpPath, targetAbs);
  } catch (e) {
    try {
      await fsp.unlink(tmpPath);
    } catch {
      /* ignore */
    }
    throw new AssetImportError(
      'mutation_failed',
      `Atomic write failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  return {
    relativePath: relForward,
    width: header.width,
    height: header.height,
    bitDepth: header.bitDepth,
    bytesWritten: buf.length,
  };
}
