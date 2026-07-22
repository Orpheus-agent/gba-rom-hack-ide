import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DialogueEditError, editDialogueText } from './dialogue.js';

describe('editDialogueText', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'rom-editor-dialogue-edit-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('rewrites a single-string block atomically', async () => {
    mkdirSync(path.join(dir, 'data', 'maps', 'LittlerootTown'), { recursive: true });
    const textIncPath = path.join(dir, 'data', 'maps', 'LittlerootTown', 'text.inc');
    writeFileSync(
      textIncPath,
      `LittlerootTown_Mom_Text_WelcomeHome::\n\t.string "Hi, honey!$"\n\nLittlerootTown_Mom_Text_OtherLine::\n\t.string "Bye$"\n`,
    );
    const result = await editDialogueText(
      'LittlerootTown_Mom_Text_WelcomeHome',
      'New welcome text',
      { projectRoot: dir },
    );
    expect(result.label).toBe('LittlerootTown_Mom_Text_WelcomeHome');
    expect(result.sourcePath).toBe('data/maps/LittlerootTown/text.inc');
    const onDisk = readFileSync(textIncPath, 'utf8');
    expect(onDisk).toContain('LittlerootTown_Mom_Text_WelcomeHome::');
    expect(onDisk).toContain('\t.string "New welcome text$"');
    // The OTHER label stays untouched
    expect(onDisk).toContain('LittlerootTown_Mom_Text_OtherLine::');
    expect(onDisk).toContain('\t.string "Bye$"');
    // Old text gone
    expect(onDisk).not.toContain('Hi, honey!');
  });

  it('collapses a multi-string block into a single .string when rewriting', async () => {
    mkdirSync(path.join(dir, 'data', 'maps', 'LittlerootTown'), { recursive: true });
    const textIncPath = path.join(dir, 'data', 'maps', 'LittlerootTown', 'text.inc');
    writeFileSync(
      textIncPath,
      `LABEL_A::\n\t.string "Line 1\\p"\n\t.string "Line 2$"\n`,
    );
    await editDialogueText('LABEL_A', 'Single line', { projectRoot: dir });
    const onDisk = readFileSync(textIncPath, 'utf8');
    expect(onDisk).toContain('\t.string "Single line$"');
    expect(onDisk).not.toContain('Line 1');
    expect(onDisk).not.toContain('Line 2');
  });

  it('finds labels in data/text/*.inc when not in data/maps/*', async () => {
    mkdirSync(path.join(dir, 'data', 'text'), { recursive: true });
    const p = path.join(dir, 'data', 'text', 'globals.inc');
    writeFileSync(p, `GlobalText_PressStart::\n\t.string "PRESS START$"\n`);
    await editDialogueText('GlobalText_PressStart', 'Press any key', { projectRoot: dir });
    expect(readFileSync(p, 'utf8')).toContain('\t.string "Press any key$"');
  });

  it('escapes embedded quotes and backslashes', async () => {
    mkdirSync(path.join(dir, 'data', 'maps', 'X'), { recursive: true });
    const p = path.join(dir, 'data', 'maps', 'X', 'text.inc');
    writeFileSync(p, `Text_A::\n\t.string "old$"\n`);
    await editDialogueText('Text_A', 'Hello "world" \\back', { projectRoot: dir });
    const onDisk = readFileSync(p, 'utf8');
    expect(onDisk).toContain('\t.string "Hello \\"world\\" \\\\back$"');
  });

  it('throws dialogue_not_found when the label is not in any text.inc', async () => {
    await expect(
      editDialogueText('NoSuchLabel', 'anything', { projectRoot: dir }),
    ).rejects.toMatchObject({ code: 'dialogue_not_found' });
  });

  it('throws invalid_text for too-long input', async () => {
    mkdirSync(path.join(dir, 'data', 'maps', 'X'), { recursive: true });
    writeFileSync(
      path.join(dir, 'data', 'maps', 'X', 'text.inc'),
      `Text_A::\n\t.string "x$"\n`,
    );
    await expect(
      editDialogueText('Text_A', 'x'.repeat(5000), { projectRoot: dir }),
    ).rejects.toBeInstanceOf(DialogueEditError);
  });

  it('preserves the trailing blank line between this block and the next', async () => {
    mkdirSync(path.join(dir, 'data', 'maps', 'X'), { recursive: true });
    const p = path.join(dir, 'data', 'maps', 'X', 'text.inc');
    writeFileSync(p, `LABEL_A::\n\t.string "a$"\n\nLABEL_B::\n\t.string "b$"\n`);
    await editDialogueText('LABEL_A', 'new', { projectRoot: dir });
    const onDisk = readFileSync(p, 'utf8');
    // Blank line between LABEL_A and LABEL_B should still be present - 
    // the body line ends in \n and there's an extra blank \n before LABEL_B::.
    expect(onDisk).toMatch(/\n\nLABEL_B::/);
  });
});
