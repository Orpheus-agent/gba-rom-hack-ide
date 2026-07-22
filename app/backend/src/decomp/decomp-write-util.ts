/**
 * Shared helpers for the decomp-native writers (layouts / maps / tilesets /
 * trainers). All writes are atomic (tmp → rename) and match the decomp's
 * formatting conventions (2-space JSON + trailing newline). Read-modify-write
 * of the big index JSONs (layouts.json, map_groups.json) preserves the rest of
 * the file verbatim by round-tripping through JSON.
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';

/** Atomic write of text or binary content (creates parent dirs). */
export async function writeFileAtomic(absPath: string, data: string | Uint8Array): Promise<void> {
  await fsp.mkdir(path.dirname(absPath), { recursive: true });
  const tmp = `${absPath}.tmp`;
  await fsp.writeFile(tmp, data);
  await fsp.rename(tmp, absPath);
}

export async function readJsonFile<T>(absPath: string): Promise<T> {
  return JSON.parse(await fsp.readFile(absPath, 'utf8')) as T;
}

/** Serialize as the decomp does: 2-space indent + trailing newline. */
export function stringifyDecompJson(value: unknown): string {
  return JSON.stringify(value, null, 2) + '\n';
}

export async function fileExists(absPath: string): Promise<boolean> {
  try {
    await fsp.access(absPath);
    return true;
  } catch {
    return false;
  }
}

/** Append a line to a text file if not already present. Returns true if added. */
export async function appendLineIfMissing(absPath: string, line: string): Promise<boolean> {
  let cur = '';
  try {
    cur = await fsp.readFile(absPath, 'utf8');
  } catch {
    cur = '';
  }
  if (cur.includes(line.trim())) return false;
  const sep = cur.length === 0 || cur.endsWith('\n') ? '' : '\n';
  await fsp.writeFile(absPath, cur + sep + line + '\n', 'utf8');
  return true;
}
