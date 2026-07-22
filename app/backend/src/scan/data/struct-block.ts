/**
 * Generic C struct-block engine for the decomp Game-Data editors.
 *
 * Many decomp data files are arrays of `[ID] = { .field = value, ... }` blocks
 * (species, moves, items, abilities, …). This module parses those blocks and
 * edits fields IN PLACE so everything unmodeled (other fields, macro lines,
 * comments, #if guards) is preserved verbatim. Extracted from the verified
 * species editor so every new editor (A2–A9) is just a schema on top of this.
 */

/** Find the matching close-char index for an open bracket at `open`. */
export function matchBracket(text: string, open: number, openCh: string, closeCh: string): number {
  let depth = 0;
  let inStr = false;
  for (let i = open; i < text.length; i++) {
    const c = text[i]!;
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === openCh) depth++;
    else if (c === closeCh) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Extract `.key = value` pairs from a struct body (value = up to top-level comma). */
export function parseFields(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i < body.length) {
    const dot = body.indexOf('.', i);
    if (dot === -1) break;
    const m = /^\.([A-Za-z_]\w*)\s*=/.exec(body.slice(dot));
    if (!m) {
      i = dot + 1;
      continue;
    }
    let j = dot + m[0].length;
    while (j < body.length && /\s/.test(body[j]!)) j++;
    const start = j;
    let depth = 0;
    let inStr = false;
    for (; j < body.length; j++) {
      const c = body[j]!;
      if (inStr) {
        if (c === '\\') j++;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') depth--;
      else if (c === ',' && depth === 0) break;
    }
    out[m[1]!] = body.slice(start, j).trim();
    i = j + 1;
  }
  return out;
}

/** Field value spans (absolute file offsets) within a block body. */
export function fieldSpans(body: string, bodyOffset: number): Map<string, [number, number]> {
  const spans = new Map<string, [number, number]>();
  let i = 0;
  while (i < body.length) {
    const dot = body.indexOf('.', i);
    if (dot === -1) break;
    const m = /^\.([A-Za-z_]\w*)\s*=/.exec(body.slice(dot));
    if (!m) {
      i = dot + 1;
      continue;
    }
    let j = dot + m[0].length;
    while (j < body.length && /\s/.test(body[j]!)) j++;
    const start = j;
    let depth = 0;
    let inStr = false;
    for (; j < body.length; j++) {
      const c = body[j]!;
      if (inStr) {
        if (c === '\\') j++;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') depth--;
      else if (c === ',' && depth === 0) break;
    }
    spans.set(m[1]!, [bodyOffset + start, bodyOffset + j]);
    i = j + 1;
  }
  return spans;
}

export interface ParsedBlock {
  readonly id: string;
  readonly fields: Record<string, string>;
}

/** Parse every `[<prefix>_X] = { ... }` block in `text`. */
export function parseBlocks(text: string, idPrefix: string): ParsedBlock[] {
  const re = new RegExp(`\\[(${idPrefix}[A-Za-z0-9_]+)\\]\\s*=\\s*\\{`, 'g');
  const out: ParsedBlock[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const openBrace = m.index + m[0].length - 1;
    const closeBrace = matchBracket(text, openBrace, '{', '}');
    if (closeBrace === -1) continue;
    out.push({ id: m[1]!, fields: parseFields(text.slice(openBrace + 1, closeBrace)) });
    re.lastIndex = closeBrace;
  }
  return out;
}

/** Replace field raw-values in a single block in place. Returns new text +
 *  before/after block text (for the op-log), or null if the block is missing. */
export function editBlockInPlace(
  text: string,
  blockId: string,
  rawEdits: Record<string, string>,
): { next: string; before: string; after: string } | null {
  const re = new RegExp(`\\[${blockId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]\\s*=\\s*\\{`);
  const m = re.exec(text);
  if (!m) return null;
  const openBrace = m.index + m[0].length - 1;
  const closeBrace = matchBracket(text, openBrace, '{', '}');
  if (closeBrace === -1) return null;
  const before = text.slice(m.index, closeBrace + 1);

  const spans = fieldSpans(text.slice(openBrace + 1, closeBrace), openBrace + 1);
  const applicable = Object.keys(rawEdits)
    .map((k) => ({ k, span: spans.get(k) }))
    .filter((x): x is { k: string; span: [number, number] } => !!x.span)
    .sort((a, b) => b.span[0] - a.span[0]); // last→first so offsets stay valid
  let next = text;
  for (const { k, span } of applicable) {
    next = next.slice(0, span[0]) + rawEdits[k] + next.slice(span[1]);
  }

  const re2 = new RegExp(`\\[${blockId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]\\s*=\\s*\\{`);
  const m2 = re2.exec(next)!;
  const close2 = matchBracket(next, m2.index + m2[0].length - 1, '{', '}');
  const after = next.slice(m2.index, close2 + 1);
  return { next, before, after };
}

/** `COMPOUND_STRING("a" "b")` / `_("x")` → "ab" / "x" (joined string literals). */
export function unquote(raw: string | undefined): string {
  if (!raw) return '';
  const parts = [...raw.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => x[1]!);
  return parts.join('').replace(/\\n/g, '\n');
}
