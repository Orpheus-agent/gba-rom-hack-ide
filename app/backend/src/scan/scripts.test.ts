import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseScriptSource, parseScripts } from './scripts.js';

const SAMPLE_INC = `
LittlerootTown_Boy::
\tlock
\tfaceplayer
\tmsgbox LittlerootTown_Text_BoyGreeting, MSGBOX_NPC
\tsetflag FLAG_MET_LITTLEROOT_BOY
\trelease
\tend

LittlerootTown_Mom::
\tlock
\tgoto_if_set FLAG_VISITED_LITTLEROOT, LittlerootTown_Mom_Greeting
\tmsgbox LittlerootTown_Text_FirstMeeting, MSGBOX_DEFAULT
\tsetflag FLAG_VISITED_LITTLEROOT
\tgiveitem ITEM_POTION, 1
\trelease
\tend

LittlerootTown_Warp::
\twarp MAP_LITTLEROOT_TOWN_BRENDANS_HOUSE_1F, 0, 0
\twaitstate
\tend
`;

describe('parseScriptSource', () => {
  it('emits one ScriptStep per macro line in declaration order', () => {
    const result = parseScriptSource(SAMPLE_INC);
    expect(result.steps.length).toBeGreaterThan(10);
    const boySteps = result.labelToStepIds.get('LittlerootTown_Boy');
    expect(boySteps).toBeDefined();
    expect(boySteps?.length).toBe(6); // lock, faceplayer, msgbox, setflag, release, end
    expect(boySteps?.[0]).toBe('LittlerootTown_Boy__0');
    expect(boySteps?.[2]).toBe('LittlerootTown_Boy__2'); // msgbox
  });

  it('classifies msgbox as dialogue with named text param', () => {
    const result = parseScriptSource(SAMPLE_INC);
    const msgbox = result.steps.find((s) => s.id === 'LittlerootTown_Boy__2');
    expect(msgbox?.kind).toBe('dialogue');
    expect(msgbox?.params['macro']).toBe('msgbox');
    expect(msgbox?.params['text']).toBe('LittlerootTown_Text_BoyGreeting');
    expect(msgbox?.params['msgboxType']).toBe('MSGBOX_NPC');
  });

  it('classifies setflag/clearflag with named flag param', () => {
    const result = parseScriptSource(SAMPLE_INC);
    const setflag = result.steps.find((s) => s.id === 'LittlerootTown_Boy__3');
    expect(setflag?.kind).toBe('set_flag');
    expect(setflag?.params['flag']).toBe('FLAG_MET_LITTLEROOT_BOY');
  });

  it('classifies goto_if_set as branch with named flag + label params', () => {
    const result = parseScriptSource(SAMPLE_INC);
    const goto = result.steps.find((s) => s.id === 'LittlerootTown_Mom__1');
    expect(goto?.kind).toBe('branch');
    expect(goto?.params['flag']).toBe('FLAG_VISITED_LITTLEROOT');
    expect(goto?.params['label']).toBe('LittlerootTown_Mom_Greeting');
  });

  it('classifies giveitem with item + count', () => {
    const result = parseScriptSource(SAMPLE_INC);
    const give = result.steps.find(
      (s) => s.kind === 'give_item' && s.params['macro'] === 'giveitem',
    );
    expect(give?.params['item']).toBe('ITEM_POTION');
    expect(give?.params['count']).toBe('1');
  });

  it('classifies warp with mapId + warpId', () => {
    const result = parseScriptSource(SAMPLE_INC);
    const warp = result.steps.find((s) => s.kind === 'warp_player');
    expect(warp?.params['mapId']).toBe('MAP_LITTLEROOT_TOWN_BRENDANS_HOUSE_1F');
    expect(warp?.params['warpId']).toBe('0');
  });

  it('falls back to kind=raw for unknown macros without dropping the line', () => {
    const result = parseScriptSource(SAMPLE_INC);
    const lock = result.steps.find((s) => s.params['macro'] === 'lock');
    expect(lock?.kind).toBe('raw');
    const waitstate = result.steps.find((s) => s.params['macro'] === 'waitstate');
    expect(waitstate?.kind).toBe('raw');
  });

  it('strips @ line comments without breaking string args', () => {
    const src = `
LABEL::
\tmsgbox SomeText, MSGBOX_NPC  @ trailing comment
\tend
`;
    const result = parseScriptSource(src);
    const msgbox = result.steps[0];
    expect(msgbox?.params['text']).toBe('SomeText');
  });

  it('ignores macro lines that appear before any label', () => {
    const src = `
\tmsgbox OrphanText
LABEL::
\tend
`;
    const result = parseScriptSource(src);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]?.params['macro']).toBe('end');
  });

  it('ignores assembler directives (.string/.byte/.global)', () => {
    const src = `
LABEL::
\t.global something
\t.byte 0x1, 0x2
\tlock
\tend
`;
    const result = parseScriptSource(src);
    expect(result.steps).toHaveLength(2);
    const macros = result.steps.map((s) => s.params['macro']);
    expect(macros).toEqual(['lock', 'end']);
  });

  it('returns step ids in stable, sorted order', () => {
    const result = parseScriptSource(SAMPLE_INC);
    const ids = result.steps.map((s) => s.id);
    expect(ids).toEqual([...ids].sort());
  });
});

describe('parseScripts (on-disk)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'rom-editor-scripts-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('walks data/maps/*/scripts.inc and produces ScriptStep entries', async () => {
    mkdirSync(path.join(dir, 'data', 'maps', 'LittlerootTown'), { recursive: true });
    writeFileSync(path.join(dir, 'data', 'maps', 'LittlerootTown', 'scripts.inc'), SAMPLE_INC);
    const result = await parseScripts(dir);
    expect(result.steps.length).toBeGreaterThan(10);
    expect(result.labelToStepIds.get('LittlerootTown_Boy')?.length).toBe(6);
  });

  it('also picks up data/event_scripts.s when present', async () => {
    mkdirSync(path.join(dir, 'data'), { recursive: true });
    writeFileSync(
      path.join(dir, 'data', 'event_scripts.s'),
      `GlobalScript_Test::\n\tmsgbox SomeText, MSGBOX_DEFAULT\n\tend\n`,
    );
    const result = await parseScripts(dir);
    expect(result.labelToStepIds.has('GlobalScript_Test')).toBe(true);
    expect(result.labelToStepIds.get('GlobalScript_Test')?.length).toBe(2);
  });

  it('returns an empty result for a project with no scripts', async () => {
    const result = await parseScripts(dir);
    expect(result.steps).toHaveLength(0);
    expect(result.labelToStepIds.size).toBe(0);
  });

  it('scans central data/scripts/*.inc (e.g. Pokémon Center nurse)', async () => {
    mkdirSync(path.join(dir, 'data', 'scripts'), { recursive: true });
    writeFileSync(
      path.join(dir, 'data', 'scripts', 'pkmn_center_nurse.inc'),
      `EventScript_PkmnCenterNurse::\n\tlock\n\tmsgbox Text_Welcome, MSGBOX_DEFAULT\n\trelease\n\tend\n`,
    );
    const result = await parseScripts(dir);
    // Maps reference this label; before central-script scanning it resolved to
    // "No decoded steps". Now it produces steps with `<label>__<n>` ids.
    expect(result.labelToStepIds.get('EventScript_PkmnCenterNurse')?.length).toBe(4);
    expect(result.steps.some((s) => s.id === 'EventScript_PkmnCenterNurse__1')).toBe(true);
  });

  it('does not double-ingest a label that appears in two sources', async () => {
    // A label present in both a map script and a central script (or included
    // twice) must yield exactly one set of step ids - never duplicates.
    mkdirSync(path.join(dir, 'data', 'maps', 'TownA'), { recursive: true });
    writeFileSync(
      path.join(dir, 'data', 'maps', 'TownA', 'scripts.inc'),
      `Shared_EventScript_Dup::\n\tlock\n\tend\n`,
    );
    mkdirSync(path.join(dir, 'data', 'scripts'), { recursive: true });
    writeFileSync(
      path.join(dir, 'data', 'scripts', 'dup.inc'),
      `Shared_EventScript_Dup::\n\tlock\n\tmsgbox X\n\trelease\n\tend\n`,
    );
    const result = await parseScripts(dir);
    // First-wins (map scanned first): exactly 2 steps, no id collisions.
    expect(result.labelToStepIds.get('Shared_EventScript_Dup')?.length).toBe(2);
    const ids = result.steps.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
