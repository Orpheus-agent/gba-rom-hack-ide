import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { extractSpeakerFromLabel, parseDialogue, parseIncSource } from './dialogue.js';

describe('extractSpeakerFromLabel', () => {
  it('extracts the token before "Text" as the speaker', () => {
    expect(extractSpeakerFromLabel('LittlerootTown_Mom_Text_WelcomeHome')).toBe('Mom');
    expect(extractSpeakerFromLabel('Route101_Boy_Text_Greeting')).toBe('Boy');
  });

  it('returns null when no _Text_ token is present', () => {
    expect(extractSpeakerFromLabel('EventScript_Generic')).toBeNull();
    expect(extractSpeakerFromLabel('MyLabel')).toBeNull();
  });

  it('returns null when the speaker token would be empty', () => {
    expect(extractSpeakerFromLabel('_Text_Foo')).toBeNull();
  });
});

describe('parseIncSource', () => {
  it('parses a single label with one .string', () => {
    const src = `
LittlerootTown_Mom_Text_WelcomeHome::
\t.string "Hi, honey! Welcome back!$"
`;
    const blocks = parseIncSource(src);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.label).toBe('LittlerootTown_Mom_Text_WelcomeHome');
    expect(blocks[0]?.text).toBe('Hi, honey! Welcome back!');
  });

  it('joins multiple .string lines under one label and strips only the trailing $', () => {
    const src = `
LABEL_A::
\t.string "Line 1\\p"
\t.string "Line 2\\n"
\t.string "Line 3$"
`;
    const blocks = parseIncSource(src);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.text).toBe('Line 1\\pLine 2\\nLine 3');
  });

  it('separates blocks on label change OR blank line', () => {
    const src = `
LABEL_A::
\t.string "A$"

LABEL_B::
\t.string "B$"
LABEL_C::
\t.string "C$"
`;
    const blocks = parseIncSource(src);
    expect(blocks).toHaveLength(3);
    expect(blocks.map((b) => b.label)).toEqual(['LABEL_A', 'LABEL_B', 'LABEL_C']);
    expect(blocks.map((b) => b.text)).toEqual(['A', 'B', 'C']);
  });

  it('ignores @-prefixed assembly comments without splitting strings', () => {
    const src = `
@ This is a comment line
LABEL_A:: @ trailing comment
\t.string "Hello @ not-a-comment$"  @ trailing
`;
    const blocks = parseIncSource(src);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.text).toBe('Hello @ not-a-comment');
  });

  it('ignores .string lines that appear before any label', () => {
    const src = `
\t.string "orphan$"
LABEL_A::
\t.string "real$"
`;
    const blocks = parseIncSource(src);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.label).toBe('LABEL_A');
    expect(blocks[0]?.text).toBe('real');
  });

  it('returns no blocks for empty input', () => {
    expect(parseIncSource('')).toEqual([]);
    expect(parseIncSource('   \n\t\n')).toEqual([]);
  });

  it('preserves embedded escape sequences exactly', () => {
    const src = `LABEL::\n\t.string "Quote: \\" and backslash: \\\\$"\n`;
    const blocks = parseIncSource(src);
    expect(blocks[0]?.text).toBe('Quote: \\" and backslash: \\\\');
  });
});

describe('parseDialogue (on-disk)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'rom-editor-dialogue-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('walks data/maps/*/text.inc files and produces DialogueNode entries', async () => {
    mkdirSync(path.join(dir, 'data', 'maps', 'LittlerootTown'), { recursive: true });
    writeFileSync(
      path.join(dir, 'data', 'maps', 'LittlerootTown', 'text.inc'),
      `LittlerootTown_Mom_Text_WelcomeHome::\n\t.string "Hi, honey! Welcome back!$"\n\nLittlerootTown_Mom_Text_ProfBirch::\n\t.string "Are you headed to Prof. Birch?$"\n`,
    );
    mkdirSync(path.join(dir, 'data', 'maps', 'Route101'), { recursive: true });
    writeFileSync(
      path.join(dir, 'data', 'maps', 'Route101', 'text.inc'),
      `Route101_Sign_Text_RouteSign::\n\t.string "ROUTE 101 ENTRANCE$"\n`,
    );
    const result = await parseDialogue(dir, ['MAP_LITTLEROOT_TOWN', 'MAP_ROUTE101']);
    expect(result.dialogue).toHaveLength(3);
    const ids = result.dialogue.map((d) => d.id);
    expect(ids).toContain('LittlerootTown_Mom_Text_WelcomeHome');
    expect(ids).toContain('LittlerootTown_Mom_Text_ProfBirch');
    expect(ids).toContain('Route101_Sign_Text_RouteSign');
    const welcome = result.dialogue.find((d) => d.id === 'LittlerootTown_Mom_Text_WelcomeHome');
    expect(welcome?.speakerName).toBe('Mom');
    expect(welcome?.text).toBe('Hi, honey! Welcome back!');
    expect(welcome?.choices).toEqual([]);
    expect(welcome?.portraitAssetId).toBeNull();
  });

  it('also reads data/text/*.inc as a secondary source', async () => {
    mkdirSync(path.join(dir, 'data', 'text'), { recursive: true });
    writeFileSync(
      path.join(dir, 'data', 'text', 'global.inc'),
      `GlobalText_PressStart::\n\t.string "PRESS START$"\n`,
    );
    const result = await parseDialogue(dir, []);
    expect(result.dialogue).toHaveLength(1);
    expect(result.dialogue[0]?.id).toBe('GlobalText_PressStart');
  });

  it('warns when no dialogue is found but the project DOES contain maps', async () => {
    const result = await parseDialogue(dir, ['MAP_FOO']);
    expect(result.dialogue).toHaveLength(0);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('does NOT warn when project has no maps either (avoids noise on bare fixtures)', async () => {
    const result = await parseDialogue(dir, []);
    expect(result.dialogue).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  it('sorts dialogue by id for stable serialization', async () => {
    mkdirSync(path.join(dir, 'data', 'maps', 'Map1'), { recursive: true });
    writeFileSync(
      path.join(dir, 'data', 'maps', 'Map1', 'text.inc'),
      `ZebraLabel::\n\t.string "z$"\n\nAppleLabel::\n\t.string "a$"\n`,
    );
    const result = await parseDialogue(dir, ['MAP_MAP1']);
    expect(result.dialogue.map((d) => d.id)).toEqual(['AppleLabel', 'ZebraLabel']);
  });
});
