import { promises as fsp } from 'node:fs';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import type { DirectoryEntry, DirectoryEntryKind, DirectoryListing } from '@rom-editor/shared';

export class PathEscapeError extends Error {
  constructor(public readonly attempted: string) {
    super(`Path '${attempted}' escapes the project root`);
    this.name = 'PathEscapeError';
  }
}

export class NotFoundError extends Error {
  constructor(public readonly attempted: string) {
    super(`Path '${attempted}' was not found`);
    this.name = 'NotFoundError';
  }
}

export class NotADirectoryError extends Error {
  constructor(public readonly attempted: string) {
    super(`Path '${attempted}' is not a directory`);
    this.name = 'NotADirectoryError';
  }
}

/**
 * Resolves a project-relative path to an absolute path on disk. Throws
 * PathEscapeError if the resolved path is not within the project root
 * (path-traversal protection).
 */
export function resolveProjectPath(projectRoot: string, relativePath: string): string {
  const normalizedRel = relativePath.replace(/\\/g, '/');
  if (path.isAbsolute(normalizedRel)) {
    throw new PathEscapeError(relativePath);
  }
  const joined = path.resolve(projectRoot, normalizedRel);
  const rootWithSep = projectRoot.endsWith(path.sep) ? projectRoot : projectRoot + path.sep;
  if (joined !== projectRoot && !joined.startsWith(rootWithSep)) {
    throw new PathEscapeError(relativePath);
  }
  return joined;
}

function direntKind(d: Dirent): DirectoryEntryKind {
  if (d.isDirectory()) return 'directory';
  if (d.isFile()) return 'file';
  if (d.isSymbolicLink()) return 'symlink';
  return 'other';
}

function isNodeErrnoException(e: unknown): e is NodeJS.ErrnoException {
  return typeof e === 'object' && e !== null && 'code' in e;
}

export async function listDirectory(
  projectRoot: string,
  relativePath: string,
): Promise<DirectoryListing> {
  const absPath = resolveProjectPath(projectRoot, relativePath);
  let stat;
  try {
    stat = await fsp.stat(absPath);
  } catch (e: unknown) {
    if (isNodeErrnoException(e) && e.code === 'ENOENT') {
      throw new NotFoundError(relativePath);
    }
    throw e;
  }
  if (!stat.isDirectory()) {
    throw new NotADirectoryError(relativePath);
  }
  const dirents = await fsp.readdir(absPath, { withFileTypes: true });
  const normalizedRel = relativePath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const entries: DirectoryEntry[] = await Promise.all(
    dirents.map(async (d) => {
      const childRel = normalizedRel === '' ? d.name : `${normalizedRel}/${d.name}`;
      const kind = direntKind(d);
      let sizeBytes: number | null = null;
      if (kind === 'file') {
        try {
          const fstat = await fsp.stat(path.join(absPath, d.name));
          sizeBytes = fstat.size;
        } catch {
          sizeBytes = null;
        }
      }
      return { name: d.name, kind, relativePath: childRel, sizeBytes };
    }),
  );
  entries.sort((a, b) => {
    if (a.kind !== b.kind) {
      if (a.kind === 'directory') return -1;
      if (b.kind === 'directory') return 1;
    }
    return a.name.localeCompare(b.name);
  });
  return {
    path: normalizedRel,
    entries,
  };
}
