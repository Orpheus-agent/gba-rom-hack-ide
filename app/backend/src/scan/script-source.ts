import { promises as fsp } from 'node:fs';
import path from 'node:path';

export class ScriptSourceError extends Error {
  constructor(public readonly code: 'label_not_found' | 'read_failed', message: string) {
    super(message);
    this.name = 'ScriptSourceError';
  }
}

export interface ScriptSourceResult {
  readonly label: string;
  /** Project-relative path of the file where the label was found (POSIX). */
  readonly sourcePath: string;
  /** Body lines (the label line included), preserved verbatim. */
  readonly lines: ReadonlyArray<string>;
  /** Concatenated source text with \n separators. */
  readonly text: string;
}

const LABEL_RE = /^([A-Za-z_][A-Za-z0-9_]*)::\s*$/;

async function tryReadFile(p: string): Promise<string | null> {
  try {
    return await fsp.readFile(p, 'utf8');
  } catch {
    return null;
  }
}

/** Walks a single `.inc`/`.s` source for the named label and returns the lines
 *  from the label declaration up to (but not including) the next top-level
 *  label or end of file. Returns null when not found.
 */
function extractBlock(source: string, label: string): string[] | null {
  const lines = source.split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const m = LABEL_RE.exec(line.trim());
    if (m && m[1] === label) {
      start = i;
      break;
    }
  }
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const m = LABEL_RE.exec(line.trim());
    if (m) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end);
}

/** Searches every per-map `scripts.inc` + global `data/event_scripts.s` for a
 *  script block named `label`. Returns the first match (lines verbatim) or
 *  throws `ScriptSourceError('label_not_found')`.
 */
export async function fetchScriptSource(
  projectRoot: string,
  label: string,
): Promise<ScriptSourceResult> {
  // Per-map scripts.inc files first (most common).
  const mapsDir = path.join(projectRoot, 'data', 'maps');
  try {
    const dirents = await fsp.readdir(mapsDir, { withFileTypes: true });
    for (const d of dirents) {
      if (!d.isDirectory()) continue;
      const incRel = `data/maps/${d.name}/scripts.inc`;
      const src = await tryReadFile(path.join(projectRoot, incRel));
      if (!src) continue;
      const block = extractBlock(src, label);
      if (block) {
        return {
          label,
          sourcePath: incRel,
          lines: block,
          text: block.join('\n'),
        };
      }
    }
  } catch {
    // data/maps absent - fall through to globals.
  }

  // Global scripts.
  const globals = [
    'data/event_scripts.s',
    'data/scripts/event_scripts.s',
  ];
  for (const rel of globals) {
    const src = await tryReadFile(path.join(projectRoot, rel));
    if (!src) continue;
    const block = extractBlock(src, label);
    if (block) {
      return {
        label,
        sourcePath: rel,
        lines: block,
        text: block.join('\n'),
      };
    }
  }

  throw new ScriptSourceError(
    'label_not_found',
    `Script label '${label}' was not found in data/maps/*/scripts.inc or data/event_scripts.s`,
  );
}
