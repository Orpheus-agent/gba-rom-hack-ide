import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ScriptSourceError, fetchScriptSource } from './script-source.js';

describe('fetchScriptSource', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'rom-editor-source-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns the block lines from data/maps/<dir>/scripts.inc', async () => {
    mkdirSync(path.join(dir, 'data', 'maps', 'LittlerootTown'), { recursive: true });
    writeFileSync(
      path.join(dir, 'data', 'maps', 'LittlerootTown', 'scripts.inc'),
      `LittlerootTown_Boy::\n\tlock\n\tfaceplayer\n\tmsgbox Text_Hello, MSGBOX_NPC\n\trelease\n\tend\n\nLittlerootTown_Mom::\n\tlock\n\tend\n`,
    );
    const r = await fetchScriptSource(dir, 'LittlerootTown_Boy');
    expect(r.label).toBe('LittlerootTown_Boy');
    expect(r.sourcePath).toBe('data/maps/LittlerootTown/scripts.inc');
    expect(r.lines.length).toBeGreaterThanOrEqual(6);
    expect(r.lines[0]).toBe('LittlerootTown_Boy::');
    expect(r.lines.some((l) => l.includes('msgbox Text_Hello'))).toBe(true);
    // Should NOT include the next label
    expect(r.lines.some((l) => l.includes('LittlerootTown_Mom::'))).toBe(false);
  });

  it('finds labels in data/event_scripts.s when not in per-map files', async () => {
    mkdirSync(path.join(dir, 'data'), { recursive: true });
    writeFileSync(
      path.join(dir, 'data', 'event_scripts.s'),
      `EventScript_Global::\n\tmsgbox SomeText\n\tend\n`,
    );
    const r = await fetchScriptSource(dir, 'EventScript_Global');
    expect(r.sourcePath).toBe('data/event_scripts.s');
    expect(r.lines[0]).toBe('EventScript_Global::');
  });

  it('throws ScriptSourceError with code=label_not_found when missing', async () => {
    await expect(fetchScriptSource(dir, 'DoesNotExist')).rejects.toBeInstanceOf(
      ScriptSourceError,
    );
  });

  it('captures lines until the next label and stops there', async () => {
    mkdirSync(path.join(dir, 'data', 'maps', 'A'), { recursive: true });
    writeFileSync(
      path.join(dir, 'data', 'maps', 'A', 'scripts.inc'),
      `ScriptA::\n\tlock\n\tend\n\nScriptB::\n\tend\n`,
    );
    const r = await fetchScriptSource(dir, 'ScriptA');
    // 4 lines: label, lock, end, blank-before-ScriptB
    expect(r.lines).toEqual(['ScriptA::', '\tlock', '\tend', '']);
  });

  it('preserves indentation and comments verbatim', async () => {
    mkdirSync(path.join(dir, 'data', 'maps', 'A'), { recursive: true });
    writeFileSync(
      path.join(dir, 'data', 'maps', 'A', 'scripts.inc'),
      `ScriptA::\n\tlock @ this is a comment\n\tmsgbox SomeText, MSGBOX_NPC\n\tend\n`,
    );
    const r = await fetchScriptSource(dir, 'ScriptA');
    expect(r.lines[1]).toBe('\tlock @ this is a comment');
    expect(r.text).toContain('lock @ this is a comment');
  });
});
