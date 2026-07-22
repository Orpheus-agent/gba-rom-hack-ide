import { describe, expect, it } from 'vitest';
import { encodeString } from '../text/codec.js';
import {
  MENU_PROMPT_MIN_MATCHES,
  MENU_PROMPT_STRINGS,
  scanMenuPromptStrings,
} from './menu-strings.js';

describe('MENU_PROMPT_STRINGS', () => {
  it('is a non-empty frozen list of canonical menu prompt strings', () => {
    expect(MENU_PROMPT_STRINGS.length).toBeGreaterThanOrEqual(5);
    expect(Object.isFrozen(MENU_PROMPT_STRINGS)).toBe(true);
    expect(MENU_PROMPT_STRINGS).toContain('CONTINUE');
    expect(MENU_PROMPT_STRINGS).toContain('NEW GAME');
    expect(MENU_PROMPT_STRINGS).toContain('OPTION');
    expect(MENU_PROMPT_STRINGS).toContain('EXIT');
  });

  it('every entry is at least 4 chars to avoid coincidental matches', () => {
    for (const s of MENU_PROMPT_STRINGS) {
      expect(s.length).toBeGreaterThanOrEqual(4);
    }
  });
});

describe('MENU_PROMPT_MIN_MATCHES', () => {
  it('is at least 3 to enforce strong-match detection threshold', () => {
    expect(MENU_PROMPT_MIN_MATCHES).toBeGreaterThanOrEqual(3);
  });
});

describe('scanMenuPromptStrings', () => {
  it('returns empty array on garbage-filled ROM', () => {
    const buf = new Uint8Array(8 * 1024);
    for (let i = 0; i < buf.length; i++) buf[i] = (i * 13 + 7) % 256;
    // No need to scrub - encoded prompt strings are very unlikely to
    // appear in random byte sequences.
    const matches = scanMenuPromptStrings(buf);
    expect(matches.length).toBeLessThan(MENU_PROMPT_MIN_MATCHES);
  });

  it('finds CONTINUE + NEW GAME + OPTION when planted past the header', () => {
    const buf = new Uint8Array(16 * 1024);
    const cont = encodeString('CONTINUE');
    const newGame = encodeString('NEW GAME');
    const opt = encodeString('OPTION');
    buf.set(cont, 0x800);
    buf.set(newGame, 0x900);
    buf.set(opt, 0xa00);
    const matches = scanMenuPromptStrings(buf);
    const texts = matches.map((m) => m.text);
    expect(texts).toContain('CONTINUE');
    expect(texts).toContain('NEW GAME');
    expect(texts).toContain('OPTION');
  });

  it('ignores prompts planted INSIDE the cartridge header (0..0xBF)', () => {
    const buf = new Uint8Array(8 * 1024);
    const cont = encodeString('CONTINUE');
    buf.set(cont, 0x40); // inside header - should be ignored
    const matches = scanMenuPromptStrings(buf);
    expect(matches.find((m) => m.text === 'CONTINUE')).toBeUndefined();
  });

  it('reports occurrence count when the same prompt appears multiple times', () => {
    const buf = new Uint8Array(8 * 1024);
    const opt = encodeString('OPTION');
    buf.set(opt, 0x800);
    buf.set(opt, 0x1000);
    buf.set(opt, 0x1800);
    const matches = scanMenuPromptStrings(buf);
    const optionMatch = matches.find((m) => m.text === 'OPTION');
    expect(optionMatch).toBeDefined();
    if (optionMatch) {
      expect(optionMatch.occurrenceCount).toBe(3);
      expect(optionMatch.firstOffset).toBe(0x800);
    }
  });

  it('returns matches in the same order as MENU_PROMPT_STRINGS', () => {
    const buf = new Uint8Array(8 * 1024);
    // Plant in REVERSE order (by MENU_PROMPT_STRINGS) - scanner should
    // still return them in canonical order.
    const opt = encodeString('OPTION');
    const cont = encodeString('CONTINUE');
    const newGame = encodeString('NEW GAME');
    buf.set(opt, 0x600);
    buf.set(newGame, 0x800);
    buf.set(cont, 0xa00);
    const matches = scanMenuPromptStrings(buf);
    const texts = matches.map((m) => m.text);
    // CONTINUE first in the canonical list, then NEW GAME, then OPTION.
    const continueIdx = texts.indexOf('CONTINUE');
    const newGameIdx = texts.indexOf('NEW GAME');
    const optionIdx = texts.indexOf('OPTION');
    expect(continueIdx).toBeLessThan(newGameIdx);
    expect(newGameIdx).toBeLessThan(optionIdx);
  });
});
