/**
 * WP-C3 - User annotation side-car I/O.
 *
 * Annotations are user-authored ("Rename FLAG_BADGE01_GET to 'Got
 * Boulder Badge', describe it as 'Player has beaten Pewter Gym'").
 * They live in two places:
 *
 *   1. The browser's localStorage - fast, available offline, the
 *      authoritative source for the current session.
 *   2. <projectRoot>/.editor/annotations.json - slow, persistent,
 *      portable. Survives clean checkouts + lets teammates share
 *      names + lets a different machine pick up where you left off.
 *
 * This module is the backend half of (2). The frontend's
 * useAnnotationsStore mirrors writes to BOTH layers (debounced for
 * the disk one) and merges from BOTH on project open.
 *
 * Mirrors HexManiacAdvance's TOML side-car philosophy - the ROM is
 * never touched, semantic naming lives in a side-car. We use JSON
 * because the rest of our metadata is JSON.
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { EDITOR_DIR_NAME } from './manifest-io.js';

export const ANNOTATIONS_FILENAME = 'annotations.json';

/** One stored annotation. Both fields are optional but at least one
 *  must be present for the entry to survive normalisation. */
export interface StoredAnnotation {
  readonly name?: string;
  readonly description?: string;
}

/** On-disk shape. Keys are `<kind>:<id>` matching the frontend's
 *  makeKey() in lib/annotations.ts. */
export interface AnnotationsSidecar {
  readonly schemaVersion: 1;
  readonly updatedAtUtc: string;
  readonly annotations: Readonly<Record<string, StoredAnnotation>>;
}

export function annotationsPathFor(projectRoot: string): string {
  return path.join(projectRoot, EDITOR_DIR_NAME, ANNOTATIONS_FILENAME);
}

/** Read the side-car. Returns the empty side-car shape when the file
 *  doesn't exist or is unreadable - never throws for missing files
 *  because "no annotations yet" is the most common state. */
export async function readAnnotationsSidecar(
  projectRoot: string,
): Promise<AnnotationsSidecar> {
  try {
    const content = await fsp.readFile(annotationsPathFor(projectRoot), 'utf8');
    const parsed = JSON.parse(content) as Partial<AnnotationsSidecar>;
    if (parsed && parsed.schemaVersion === 1 && parsed.annotations && typeof parsed.annotations === 'object') {
      // Normalise: drop empty entries + trim strings + reject non-strings.
      const cleaned: Record<string, StoredAnnotation> = {};
      for (const [k, v] of Object.entries(parsed.annotations as Record<string, unknown>)) {
        const norm = normaliseEntry(v);
        if (norm) cleaned[k] = norm;
      }
      return {
        schemaVersion: 1,
        updatedAtUtc: parsed.updatedAtUtc ?? new Date().toISOString(),
        annotations: cleaned,
      };
    }
  } catch {
    // file missing / unreadable / malformed → empty side-car
  }
  return {
    schemaVersion: 1,
    updatedAtUtc: new Date().toISOString(),
    annotations: {},
  };
}

/** Write the side-car. Creates .editor/ if missing. Returns the path
 *  written. Pretty-printed JSON for diffability. */
export async function writeAnnotationsSidecar(
  projectRoot: string,
  annotations: Readonly<Record<string, StoredAnnotation>>,
): Promise<string> {
  const editorDir = path.join(projectRoot, EDITOR_DIR_NAME);
  await fsp.mkdir(editorDir, { recursive: true });
  const target = annotationsPathFor(projectRoot);
  // Normalise once more so callers can't accidentally write empty
  // entries that survive round-trips.
  const cleaned: Record<string, StoredAnnotation> = {};
  for (const [k, v] of Object.entries(annotations)) {
    const norm = normaliseEntry(v);
    if (norm) cleaned[k] = norm;
  }
  const payload: AnnotationsSidecar = {
    schemaVersion: 1,
    updatedAtUtc: new Date().toISOString(),
    annotations: cleaned,
  };
  await fsp.writeFile(target, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  return target;
}

function normaliseEntry(raw: unknown): StoredAnnotation | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as { name?: unknown; description?: unknown };
  const name = typeof obj.name === 'string' ? obj.name.trim() : '';
  const description = typeof obj.description === 'string' ? obj.description.trim() : '';
  if (name.length === 0 && description.length === 0) return null;
  const out: StoredAnnotation = {};
  if (name.length > 0) (out as { name?: string }).name = name;
  if (description.length > 0) (out as { description?: string }).description = description;
  return out;
}
