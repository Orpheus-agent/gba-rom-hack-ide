import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { ProjectManifest } from '@rom-editor/shared';

export const EDITOR_DIR_NAME = '.editor';
export const MANIFEST_FILENAME = 'manifest.json';

export function manifestPathFor(projectRoot: string): string {
  return path.join(projectRoot, EDITOR_DIR_NAME, MANIFEST_FILENAME);
}

export async function writeManifest(
  projectRoot: string,
  manifest: ProjectManifest,
): Promise<string> {
  const editorDir = path.join(projectRoot, EDITOR_DIR_NAME);
  await fsp.mkdir(editorDir, { recursive: true });
  const manifestPath = path.join(editorDir, MANIFEST_FILENAME);
  await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  return manifestPath;
}

export async function readManifest(projectRoot: string): Promise<ProjectManifest | null> {
  try {
    const content = await fsp.readFile(manifestPathFor(projectRoot), 'utf8');
    const json = JSON.parse(content) as ProjectManifest;
    if (json.schemaVersion !== 1) return null;
    return json;
  } catch {
    return null;
  }
}
