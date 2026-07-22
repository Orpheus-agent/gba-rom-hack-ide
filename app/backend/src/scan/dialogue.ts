import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { DialogueNode, EntityId } from '@rom-editor/shared';

const LABEL_LINE = /^([A-Za-z_][A-Za-z0-9_]*)::\s*$/;
const STRING_LINE = /^\.string\s+"((?:[^"\\]|\\.)*)"/;

function stripLineComment(line: string): string {
  // ARM asm uses @ as line-comment; tolerate # and // too.
  const idx = findCommentIndex(line);
  return (idx >= 0 ? line.slice(0, idx) : line).trim();
}

function findCommentIndex(line: string): number {
  // Don't split inside a quoted string. Scan with state.
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"' && line[i - 1] !== '\\') inString = !inString;
    if (inString) continue;
    if (c === '@') return i;
    if (c === '#' && line.slice(i, i + 1) === '#') return i;
    if (c === '/' && line[i + 1] === '/') return i;
  }
  return -1;
}

function joinStrings(strs: ReadonlyArray<string>): string {
  // Drop trailing '$' terminator (and only that, only on the last string).
  if (strs.length === 0) return '';
  const last = strs[strs.length - 1] ?? '';
  const trimmedLast = last.endsWith('$') ? last.slice(0, -1) : last;
  return [...strs.slice(0, -1), trimmedLast].join('');
}

export function extractSpeakerFromLabel(label: string): string | null {
  // Pokemerald-style label: <Map>_<Speaker>_Text_<Topic> - token before "Text"
  // is the speaker. Falls back to null for labels that don't match.
  const parts = label.split('_');
  const textIdx = parts.findIndex((p) => p === 'Text');
  if (textIdx <= 0) return null;
  const speaker = parts[textIdx - 1];
  return speaker && speaker.length > 0 ? speaker : null;
}

interface ParsedBlock {
  readonly label: string;
  readonly text: string;
}

export function parseIncSource(source: string): ParsedBlock[] {
  const lines = source.split(/\r?\n/);
  const out: ParsedBlock[] = [];
  let currentLabel: string | null = null;
  let currentStrings: string[] = [];

  const flush = () => {
    if (currentLabel && currentStrings.length > 0) {
      out.push({ label: currentLabel, text: joinStrings(currentStrings) });
    }
    currentLabel = null;
    currentStrings = [];
  };

  for (const rawLine of lines) {
    const cleaned = stripLineComment(rawLine);
    if (cleaned === '') {
      flush();
      continue;
    }
    const labelMatch = LABEL_LINE.exec(cleaned);
    if (labelMatch && labelMatch[1]) {
      flush();
      currentLabel = labelMatch[1];
      continue;
    }
    const stringMatch = STRING_LINE.exec(cleaned);
    if (stringMatch && currentLabel && stringMatch[1] !== undefined) {
      currentStrings.push(stringMatch[1]);
    }
  }
  flush();
  return out;
}

function blockToDialogueNode(block: ParsedBlock): DialogueNode {
  return {
    id: block.label,
    name: block.label,
    speakerName: extractSpeakerFromLabel(block.label),
    portraitAssetId: null,
    text: block.text,
    choices: [],
  };
}

async function tryReadFile(p: string): Promise<string | null> {
  try {
    return await fsp.readFile(p, 'utf8');
  } catch {
    return null;
  }
}

export interface DialogueResult {
  readonly dialogue: ReadonlyArray<DialogueNode>;
  readonly warnings: ReadonlyArray<string>;
}

export async function parseDialogue(
  projectRoot: string,
  knownMapIds: ReadonlyArray<EntityId>,
): Promise<DialogueResult> {
  const warnings: string[] = [];
  const allBlocks: ParsedBlock[] = [];

  // Walk data/maps/<dir>/text.inc - the bulk of pokeemerald-class dialogue.
  const mapsDir = path.join(projectRoot, 'data', 'maps');
  try {
    const dirents = await fsp.readdir(mapsDir, { withFileTypes: true });
    for (const d of dirents) {
      if (!d.isDirectory()) continue;
      const textIncPath = path.join(mapsDir, d.name, 'text.inc');
      const src = await tryReadFile(textIncPath);
      if (!src) continue;
      const blocks = parseIncSource(src);
      allBlocks.push(...blocks);
    }
  } catch {
    // data/maps/ absent - already warned by the map scanner; skip silently.
  }

  // Also scan a flat data/text/ tree (one level) if it exists. Some forks
  // and FireRed-class projects keep shared/global text strings there.
  const textDir = path.join(projectRoot, 'data', 'text');
  try {
    const entries = await fsp.readdir(textDir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.inc')) continue;
      const src = await tryReadFile(path.join(textDir, e.name));
      if (!src) continue;
      allBlocks.push(...parseIncSource(src));
    }
  } catch {
    // No data/text/ directory - fine, not all projects have it.
  }

  // Dedupe by label (last definition wins - stable enough for our purposes).
  const byLabel = new Map<string, ParsedBlock>();
  for (const b of allBlocks) byLabel.set(b.label, b);

  const dialogue = Array.from(byLabel.values())
    .map((b) => blockToDialogueNode(b))
    .sort((a, b) => a.id.localeCompare(b.id));

  if (dialogue.length === 0 && knownMapIds.length > 0) {
    warnings.push(
      `No dialogue strings found under data/maps/*/text.inc - text indexing may need a fork-specific adapter for this project layout.`,
    );
  }

  return { dialogue, warnings };
}
