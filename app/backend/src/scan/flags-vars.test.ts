import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  extractFlags,
  extractVariables,
  parseFlagsAndVariables,
} from './flags-vars.js';

describe('extractFlags', () => {
  it('extracts FLAG_* defines with literal hex values', () => {
    const src = `
#define FLAG_BADGE01_GET 0x807
#define FLAG_VISITED_LITTLEROOT 0x800
#define FLAG_HIDE_LITTLEROOT_INTRO_BOY 0x4F0
`;
    const flags = extractFlags(src);
    expect(flags).toHaveLength(3);
    const badge = flags.find((f) => f.id === 'FLAG_BADGE01_GET');
    expect(badge?.engineValue).toBe('0x807');
    expect(badge?.scope).toBe('global');
    expect(badge?.defaultValue).toBe(false);
  });

  it('classifies sub-0x100 flags as temporary', () => {
    const src = `
#define FLAG_TEMP_3 0x3
#define FLAG_TEMP_HIGHER 0xFF
#define FLAG_GLOBAL_RANGE 0x100
`;
    const flags = extractFlags(src);
    expect(flags.find((f) => f.id === 'FLAG_TEMP_3')?.scope).toBe('temporary');
    expect(flags.find((f) => f.id === 'FLAG_TEMP_HIGHER')?.scope).toBe('temporary');
    expect(flags.find((f) => f.id === 'FLAG_GLOBAL_RANGE')?.scope).toBe('global');
  });

  it('classifies TEMP-named flags as temporary regardless of value', () => {
    const src = `#define FLAG_TEMP_BOULDER_MOVED 0x123`;
    const flags = extractFlags(src);
    expect(flags[0]?.scope).toBe('temporary');
  });

  it('captures trailing comments as descriptions', () => {
    const src = `#define FLAG_BADGE01_GET 0x807  // Stone Badge from Roxanne`;
    const flags = extractFlags(src);
    expect(flags[0]?.description).toBe('Stone Badge from Roxanne');
  });

  it('preserves unresolved macro values verbatim in engineValue', () => {
    const src = `
#define TRAINER_FLAGS_START 0x500
#define FLAG_DEFEATED_SOMEONE (TRAINER_FLAGS_START + 0x4)
`;
    const flags = extractFlags(src);
    const defeated = flags.find((f) => f.id === 'FLAG_DEFEATED_SOMEONE');
    expect(defeated?.engineValue).toBe('(TRAINER_FLAGS_START + 0x4)');
    expect(defeated?.scope).toBe('global');
  });

  it('skips range markers that do not start with FLAG_', () => {
    const src = `
#define TRAINER_FLAGS_START 0x500
#define TRAINER_FLAGS_END   0x5FF
#define FLAGS_COUNT         0x900
#define FLAG_VISITED_HOENN  0x800
`;
    const flags = extractFlags(src);
    expect(flags.map((f) => f.id)).toEqual(['FLAG_VISITED_HOENN']);
  });

  it('strips C block comments (single-line and multi-line)', () => {
    const src = `
/* This is a block
   comment that should be removed */
#define FLAG_A 0x100
/* inline block */ #define FLAG_B 0x101
`;
    const flags = extractFlags(src);
    expect(flags.map((f) => f.id).sort()).toEqual(['FLAG_A', 'FLAG_B']);
  });

  it('does not match identifiers that merely contain "flag"', () => {
    const src = `
#define MY_FLAG_THING 0x100
#define IS_FLAG_SET 0x101
#define FLAG_REAL 0x800
`;
    const flags = extractFlags(src);
    expect(flags.map((f) => f.id)).toEqual(['FLAG_REAL']);
  });
});

describe('extractVariables', () => {
  it('extracts VAR_* defines with literal values', () => {
    const src = `
#define VAR_TEMP_0 0x0
#define VAR_TEMP_F 0x3F
#define VAR_LITTLEROOT_INTRO_STATE 0x4080
`;
    const vars = extractVariables(src);
    expect(vars).toHaveLength(3);
    expect(vars.find((v) => v.id === 'VAR_TEMP_0')?.scope).toBe('temporary');
    expect(vars.find((v) => v.id === 'VAR_TEMP_F')?.scope).toBe('temporary');
    expect(vars.find((v) => v.id === 'VAR_LITTLEROOT_INTRO_STATE')?.scope).toBe('global');
    expect(vars.find((v) => v.id === 'VAR_LITTLEROOT_INTRO_STATE')?.engineValue).toBe('0x4080');
  });

  it('classifies TEMP_VARS-named variables as temporary', () => {
    const src = `#define VAR_TEMP_VARS_BREAK 0x4000`;
    const vars = extractVariables(src);
    expect(vars[0]?.scope).toBe('temporary');
  });

  it('skips range markers like VARS_COUNT', () => {
    const src = `
#define VARS_START 0x4000
#define VARS_COUNT 0x100
#define VAR_REAL_VAR 0x4080
`;
    const vars = extractVariables(src);
    expect(vars.map((v) => v.id)).toEqual(['VAR_REAL_VAR']);
  });
});

describe('parseFlagsAndVariables', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'rom-editor-fv-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads include/constants/flags.h and include/constants/vars.h from a project', async () => {
    mkdirSync(path.join(dir, 'include', 'constants'), { recursive: true });
    writeFileSync(
      path.join(dir, 'include', 'constants', 'flags.h'),
      `#define FLAG_VISITED_LITTLEROOT 0x800  // First town visited\n#define FLAG_BADGE01_GET 0x807\n`,
    );
    writeFileSync(
      path.join(dir, 'include', 'constants', 'vars.h'),
      `#define VAR_LITTLEROOT_INTRO_STATE 0x4080\n`,
    );

    const result = await parseFlagsAndVariables(dir);
    expect(result.flags).toHaveLength(2);
    expect(result.variables).toHaveLength(1);
    expect(result.warnings).toHaveLength(0);

    const visited = result.flags.find((f) => f.id === 'FLAG_VISITED_LITTLEROOT');
    expect(visited?.description).toBe('First town visited');
    expect(visited?.engineValue).toBe('0x800');
    expect(visited?.scope).toBe('global');
  });

  it('warns when flags.h or vars.h is missing', async () => {
    const result = await parseFlagsAndVariables(dir);
    expect(result.warnings.some((w) => /flags\.h/.test(w))).toBe(true);
    expect(result.warnings.some((w) => /vars\.h/.test(w))).toBe(true);
    expect(result.flags).toHaveLength(0);
    expect(result.variables).toHaveLength(0);
  });

  it('sorts output by id for stable serialization', async () => {
    mkdirSync(path.join(dir, 'include', 'constants'), { recursive: true });
    writeFileSync(
      path.join(dir, 'include', 'constants', 'flags.h'),
      `#define FLAG_ZEBRA 0x801\n#define FLAG_APPLE 0x800\n#define FLAG_MIDDLE 0x802\n`,
    );
    writeFileSync(path.join(dir, 'include', 'constants', 'vars.h'), '');
    const result = await parseFlagsAndVariables(dir);
    expect(result.flags.map((f) => f.id)).toEqual(['FLAG_APPLE', 'FLAG_MIDDLE', 'FLAG_ZEBRA']);
  });
});
