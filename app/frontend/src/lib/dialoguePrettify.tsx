/**
 * Gen-3 dialogue text contains literal control-code sentinels emitted
 * by `engine/src/text/codec.ts`:
 *
 *   - `\p`  paragraph break (force player to press A, then continue)
 *   - `\l`  line break (next line, no pause)
 *   - `\n`  line break (already a literal newline post-codec)
 *   - `{CC}` opaque control code (color/font/scroll - not player-visible)
 *   - `{VAR}` variable interpolation (player name, rival name, etc.)
 *
 * Rendering the raw sentinels makes the editor look broken to operators
 * who only want to read/edit the actual conversation text. This helper
 * walks the string and emits a sequence of React nodes that render
 * those sentinels as real visual breaks (or hides them for the opaque
 * ones).
 */

import { Fragment } from 'react';

interface DialogueTextProps {
  readonly raw: string | null | undefined;
  /** When true, control codes are surfaced as labeled chips for power-
   *  user diagnosis. Default false - normal rendering hides the chips. */
  readonly showControls?: boolean;
  /** When true, the empty-state placeholder ("(empty)") is rendered as
   *  an inline span; otherwise it's an em-dash. Used by inline previews. */
  readonly inlineEmpty?: boolean;
}

/** Lex a Gen-3 dialogue string into a token stream. Tokens are either
 *  plain text chunks or control-code markers. */
type DialogueToken =
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'paragraph' }
  | { readonly kind: 'line' }
  | { readonly kind: 'control'; readonly raw: string }
  | { readonly kind: 'var'; readonly raw: string };

export function tokenizeDialogue(raw: string): ReadonlyArray<DialogueToken> {
  const tokens: DialogueToken[] = [];
  let i = 0;
  let buf = '';
  const flush = (): void => {
    if (buf.length > 0) {
      tokens.push({ kind: 'text', value: buf });
      buf = '';
    }
  };
  while (i < raw.length) {
    const ch = raw[i]!;
    // Backslash escape sequences: \p, \l, \n.
    if (ch === '\\' && i + 1 < raw.length) {
      const next = raw[i + 1]!;
      if (next === 'p') {
        flush();
        tokens.push({ kind: 'paragraph' });
        i += 2;
        continue;
      }
      if (next === 'l') {
        flush();
        tokens.push({ kind: 'line' });
        i += 2;
        continue;
      }
      if (next === 'n') {
        flush();
        tokens.push({ kind: 'line' });
        i += 2;
        continue;
      }
    }
    // Curly control codes: {CC} {VAR} {VAR_NAME} etc.
    if (ch === '{') {
      const end = raw.indexOf('}', i + 1);
      if (end > i) {
        const inner = raw.slice(i + 1, end);
        flush();
        if (inner === 'CC' || /^CC[_:]/.test(inner)) {
          tokens.push({ kind: 'control', raw: inner });
        } else {
          tokens.push({ kind: 'var', raw: inner });
        }
        i = end + 1;
        continue;
      }
    }
    // Literal newline (post-codec).
    if (ch === '\n') {
      flush();
      tokens.push({ kind: 'line' });
      i += 1;
      continue;
    }
    buf += ch;
    i += 1;
  }
  flush();
  return tokens;
}

/**
 * Render a Gen-3 dialogue string as React nodes with real visual
 * line / paragraph breaks. Hides `{CC}` opaque control codes. Renders
 * `{VAR}` interpolations as labeled chips so the operator can see where
 * the game substitutes player / rival names without being confused by
 * the sentinel.
 */
export function DialogueText({ raw, showControls = false, inlineEmpty = false }: DialogueTextProps) {
  if (raw === null || raw === undefined || raw.length === 0) {
    return (
      <span className="dialogue-text dialogue-text--empty">
        {inlineEmpty ? '(empty)' : ' - '}
      </span>
    );
  }
  const tokens = tokenizeDialogue(raw);
  return (
    <span className="dialogue-text">
      {tokens.map((tok, i) => {
        if (tok.kind === 'text') {
          return <Fragment key={i}>{tok.value}</Fragment>;
        }
        if (tok.kind === 'paragraph') {
          return (
            <Fragment key={i}>
              <br />
              <br />
            </Fragment>
          );
        }
        if (tok.kind === 'line') {
          return <br key={i} />;
        }
        if (tok.kind === 'control') {
          if (!showControls) return null;
          return (
            <span key={i} className="dialogue-text__control" title="Formatting control code">
              [{tok.raw}]
            </span>
          );
        }
        // VAR - always show, since these substitute player-visible text.
        return (
          <span key={i} className="dialogue-text__var" title={`Variable interpolation: ${tok.raw}`}>
            {prettifyVarName(tok.raw)}
          </span>
        );
      })}
    </span>
  );
}

/** Map a Gen-3 string-buffer `{VAR}` payload to a friendly chip label.
 *  e.g. `STR_VAR_1` → `[name 1]`, `PLAYER` → `[player]`.
 *  Falls back to `[var: <raw>]` for unrecognized payloads so the operator
 *  still sees something honest. */
function prettifyVarName(raw: string): string {
  const upper = raw.toUpperCase();
  if (upper === 'PLAYER') return '[player]';
  if (upper === 'RIVAL') return '[rival]';
  if (/^STR_VAR_?(\d+)$/.test(upper)) {
    const m = /^STR_VAR_?(\d+)$/.exec(upper)!;
    return `[var ${m[1]!}]`;
  }
  if (/^VAR_(\d+)$/.test(upper)) {
    const m = /^VAR_(\d+)$/.exec(upper)!;
    return `[var ${m[1]!}]`;
  }
  return `[${raw}]`;
}

/**
 * Plain-text dialogue (no JSX). Used in tooltip / label contexts where
 * React nodes aren't accepted. Strips control codes; replaces breaks
 * with " / " for inline readability.
 */
export function dialogueToPlainText(raw: string | null | undefined): string {
  if (!raw) return '';
  const tokens = tokenizeDialogue(raw);
  return tokens
    .map((tok) => {
      if (tok.kind === 'text') return tok.value;
      if (tok.kind === 'paragraph') return ' / ';
      if (tok.kind === 'line') return ' ';
      if (tok.kind === 'control') return '';
      return prettifyVarName(tok.raw);
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}
