import { promises as fsp } from 'node:fs';
import path from 'node:path';

export class DialogueEditError extends Error {
  constructor(
    public readonly code:
      | 'dialogue_not_found'
      | 'invalid_text'
      | 'mutation_failed',
    message: string,
  ) {
    super(message);
    this.name = 'DialogueEditError';
  }
}

const LABEL_RE = /^([A-Za-z_][A-Za-z0-9_]*)::\s*$/;

interface FoundBlock {
  readonly absPath: string;
  readonly relPath: string;
  readonly lines: string[];
  /** Inclusive start index of the label line. */
  readonly startIndex: number;
  /** Exclusive end index - the next label/EOF. */
  readonly endIndex: number;
}

async function readLines(p: string): Promise<string[] | null> {
  try {
    const raw = await fsp.readFile(p, 'utf8');
    return raw.split(/\r?\n/);
  } catch {
    return null;
  }
}

function findBlock(lines: string[], label: string): { start: number; end: number } | null {
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = LABEL_RE.exec((lines[i] ?? '').trim());
    if (m && m[1] === label) {
      start = i;
      break;
    }
  }
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = LABEL_RE.exec((lines[i] ?? '').trim());
    if (m) {
      end = i;
      break;
    }
  }
  return { start, end };
}

async function findDialogueBlock(
  projectRoot: string,
  label: string,
): Promise<FoundBlock | null> {
  const mapsDir = path.join(projectRoot, 'data', 'maps');
  try {
    const dirents = await fsp.readdir(mapsDir, { withFileTypes: true });
    for (const d of dirents) {
      if (!d.isDirectory()) continue;
      const relPath = `data/maps/${d.name}/text.inc`;
      const absPath = path.join(projectRoot, relPath);
      const lines = await readLines(absPath);
      if (!lines) continue;
      const found = findBlock(lines, label);
      if (found) {
        return { absPath, relPath, lines, startIndex: found.start, endIndex: found.end };
      }
    }
  } catch {
    // data/maps absent - fall through to flat text/.
  }
  // Flat data/text/*.inc fallback.
  const textDir = path.join(projectRoot, 'data', 'text');
  try {
    const entries = await fsp.readdir(textDir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.inc')) continue;
      const relPath = `data/text/${e.name}`;
      const absPath = path.join(textDir, e.name);
      const lines = await readLines(absPath);
      if (!lines) continue;
      const found = findBlock(lines, label);
      if (found) {
        return { absPath, relPath, lines, startIndex: found.start, endIndex: found.end };
      }
    }
  } catch {
    /* no flat text dir */
  }
  return null;
}

/** Escapes a quote-string for embedding inside a `.string "..."` directive.
 *  Backslashes and `"` are escaped; control sequences like `\n` are written
 *  literally (the operator is expected to type them as such). */
function escapeForStringDirective(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export interface EditDialogueResult {
  readonly label: string;
  readonly sourcePath: string;
  readonly previousLines: ReadonlyArray<string>;
  readonly nextLines: ReadonlyArray<string>;
}

export interface EditDialogueOptions {
  readonly projectRoot: string;
}

/**
 * Replaces the body of a dialogue block (everything between its label line and
 * the next label / EOF) with a single `.string "<newText>$"` line. Multi-line
 * sources are collapsed into one; the operator who needs control formatting
 * can edit the raw text.inc directly. Atomic write.
 */
export async function editDialogueText(
  label: string,
  newText: string,
  options: EditDialogueOptions,
): Promise<EditDialogueResult> {
  if (typeof newText !== 'string') {
    throw new DialogueEditError('invalid_text', 'newText must be a string');
  }
  if (newText.length > 4096) {
    throw new DialogueEditError('invalid_text', 'newText exceeds 4096 chars');
  }
  const block = await findDialogueBlock(options.projectRoot, label);
  if (!block) {
    throw new DialogueEditError('dialogue_not_found', `Label '${label}' not found in any text.inc`);
  }
  const previousLines = block.lines.slice(block.startIndex, block.endIndex);

  // Build the replacement: label line preserved, body replaced with one .string
  // followed by the original trailing blank line(s) (so the file's visual
  // separator between blocks isn't collapsed).
  const labelLine = block.lines[block.startIndex] ?? `${label}::`;
  const trailingBlanks: string[] = [];
  for (let i = block.endIndex - 1; i >= block.startIndex + 1; i--) {
    const line = block.lines[i] ?? '';
    if (line.trim() === '') trailingBlanks.unshift(line);
    else break;
  }
  const escaped = escapeForStringDirective(newText);
  const replacement = [labelLine, `\t.string "${escaped}$"`, ...trailingBlanks];

  const nextLines = [
    ...block.lines.slice(0, block.startIndex),
    ...replacement,
    ...block.lines.slice(block.endIndex),
  ];

  const tmpPath = block.absPath + '.tmp';
  try {
    await fsp.writeFile(tmpPath, nextLines.join('\n'), 'utf8');
    await fsp.rename(tmpPath, block.absPath);
  } catch (e) {
    try {
      await fsp.unlink(tmpPath);
    } catch {
      /* ignore */
    }
    throw new DialogueEditError(
      'mutation_failed',
      `Atomic write failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  return {
    label,
    sourcePath: block.relPath,
    previousLines,
    nextLines: replacement,
  };
}
