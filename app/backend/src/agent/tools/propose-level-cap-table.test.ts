import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  parseObedienceBlock,
  proposeLevelCapTable,
  rewriteObedienceBlock,
} from './propose-level-cap-table.js';

const SAMPLE_CONFIG = `// Some other stuff at the top
#define MAP_PLAYER_HOME ((4 << 8) | 0)

/*===== Expanded Coins Options =====*/
#define MAX_COINS_DIGITS 9

/*===== Badge Obedience Options =====*/
#define BASE_OBEDIENCE_LEVEL	10
#define BADGE_1_OBEDIENCE_LEVEL	10
#define BADGE_2_OBEDIENCE_LEVEL 30
#define BADGE_3_OBEDIENCE_LEVEL 30
#define BADGE_4_OBEDIENCE_LEVEL 50
#define BADGE_5_OBEDIENCE_LEVEL 50
#define BADGE_6_OBEDIENCE_LEVEL 70
#define BADGE_7_OBEDIENCE_LEVEL 70

/*===== Other Battle Options =====*/
//#define OBEDIENCE_CHECK_FOR_PLAYER_ORIGINAL_POKEMON //Uncommenting line line will open up the possibility that the Player's Pokemon can disobey them (not just traded mons)
#define EXP_AFFECTION_BOOST
`;

describe('parseObedienceBlock', () => {
  it('reads all 8 defines plus the commented-out OBEDIENCE_CHECK toggle', () => {
    const parsed = parseObedienceBlock(SAMPLE_CONFIG);
    expect(parsed).not.toBeNull();
    expect(parsed!.base).toBe(10);
    expect(parsed!.badges).toEqual([10, 30, 30, 50, 50, 70, 70]);
    expect(parsed!.originalOtObedienceCheck).toBe(false);
  });

  it('detects an uncommented OBEDIENCE_CHECK as true', () => {
    const src = SAMPLE_CONFIG.replace(
      '//#define OBEDIENCE_CHECK_FOR_PLAYER_ORIGINAL_POKEMON',
      '#define OBEDIENCE_CHECK_FOR_PLAYER_ORIGINAL_POKEMON',
    );
    const parsed = parseObedienceBlock(src);
    expect(parsed).not.toBeNull();
    expect(parsed!.originalOtObedienceCheck).toBe(true);
  });

  it('returns null when a BADGE_N define is missing', () => {
    const src = SAMPLE_CONFIG.replace('#define BADGE_4_OBEDIENCE_LEVEL 50', '');
    const parsed = parseObedienceBlock(src);
    expect(parsed).toBeNull();
  });
});

describe('rewriteObedienceBlock', () => {
  it('overwrites the eight values', () => {
    const next = rewriteObedienceBlock(SAMPLE_CONFIG, {
      base: 15,
      badges: [20, 30, 40, 50, 60, 70, 80],
      originalOtObedienceCheck: false,
    });
    expect(next).toContain('#define BASE_OBEDIENCE_LEVEL\t15');
    expect(next).toContain('#define BADGE_1_OBEDIENCE_LEVEL\t20');
    expect(next).toContain('#define BADGE_2_OBEDIENCE_LEVEL 30');
    expect(next).toContain('#define BADGE_7_OBEDIENCE_LEVEL 80');
  });

  it('toggles the OBEDIENCE_CHECK macro on', () => {
    const next = rewriteObedienceBlock(SAMPLE_CONFIG, {
      base: 10,
      badges: [10, 30, 30, 50, 50, 70, 70],
      originalOtObedienceCheck: true,
    });
    expect(next).not.toMatch(/^\s*\/\/#define OBEDIENCE_CHECK_FOR_PLAYER_ORIGINAL_POKEMON/m);
    expect(next).toMatch(/^#define OBEDIENCE_CHECK_FOR_PLAYER_ORIGINAL_POKEMON/m);
  });

  it('toggles the OBEDIENCE_CHECK macro back off', () => {
    const src = SAMPLE_CONFIG.replace(
      '//#define OBEDIENCE_CHECK_FOR_PLAYER_ORIGINAL_POKEMON',
      '#define OBEDIENCE_CHECK_FOR_PLAYER_ORIGINAL_POKEMON',
    );
    const next = rewriteObedienceBlock(src, {
      base: 10,
      badges: [10, 30, 30, 50, 50, 70, 70],
      originalOtObedienceCheck: false,
    });
    expect(next).toMatch(/^\/\/#define OBEDIENCE_CHECK_FOR_PLAYER_ORIGINAL_POKEMON/m);
  });

  it('preserves surrounding text', () => {
    const next = rewriteObedienceBlock(SAMPLE_CONFIG, {
      base: 99,
      badges: [99, 99, 99, 99, 99, 99, 99],
      originalOtObedienceCheck: false,
    });
    expect(next).toContain('#define MAP_PLAYER_HOME');
    expect(next).toContain('#define MAX_COINS_DIGITS 9');
    expect(next).toContain('/*===== Other Battle Options =====*/');
    expect(next).toContain('#define EXP_AFFECTION_BOOST');
  });
});

describe('proposeLevelCapTable', () => {
  let root: string;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(tmpdir(), 'level-cap-test-'));
    await fsp.mkdir(path.join(root, 'src'), { recursive: true });
    await fsp.writeFile(path.join(root, 'src', 'config.h'), SAMPLE_CONFIG, 'utf8');
  });
  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  it('writes the new values + backup, returns the diff preview', async () => {
    const result = await proposeLevelCapTable(
      { projectRoot: root, baseUrl: 'http://x' },
      {
        cfruSourcePath: root,
        base: 15,
        badges: [20, 30, 40, 50, 60, 70, 80],
      },
    );
    expect(result.ok).toBe(true);
    expect(result.configFilePath).toBe(path.join(root, 'src', 'config.h'));
    expect(result.backupFilePath).toBe(
      path.join(root, 'src', 'config.h.pre-level-caps.bak'),
    );
    expect(result.previousValues!.base).toBe(10);
    expect(result.newValues!.base).toBe(15);
    expect(result.diffPreview).toContain('15');
    const onDisk = await fsp.readFile(result.configFilePath!, 'utf8');
    expect(onDisk).toContain('#define BASE_OBEDIENCE_LEVEL\t15');
    expect(onDisk).toContain('#define BADGE_7_OBEDIENCE_LEVEL 80');
    const backup = await fsp.readFile(result.backupFilePath!, 'utf8');
    expect(backup).toBe(SAMPLE_CONFIG);
  });

  it('refuses non-monotonic badge sequences', async () => {
    const result = await proposeLevelCapTable(
      { projectRoot: root, baseUrl: 'http://x' },
      {
        cfruSourcePath: root,
        base: 10,
        badges: [20, 30, 25, 40, 50, 60, 70], // 25 < 30
      },
    );
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/must not decrease/);
  });

  it('refuses base > badges[0]', async () => {
    const result = await proposeLevelCapTable(
      { projectRoot: root, baseUrl: 'http://x' },
      {
        cfruSourcePath: root,
        base: 30,
        badges: [20, 30, 40, 50, 60, 70, 80],
      },
    );
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/base \(30\) is higher than badges\[0\]/);
  });

  it('reports no-op when called with the existing values', async () => {
    const result = await proposeLevelCapTable(
      { projectRoot: root, baseUrl: 'http://x' },
      {
        cfruSourcePath: root,
        base: 10,
        badges: [10, 30, 30, 50, 50, 70, 70],
      },
    );
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/already set/);
    expect(result.backupFilePath).toBeNull();
  });

  it('refuses when config.h is missing the obedience block', async () => {
    await fsp.writeFile(path.join(root, 'src', 'config.h'), '// just some other defines\n', 'utf8');
    const result = await proposeLevelCapTable(
      { projectRoot: root, baseUrl: 'http://x' },
      {
        cfruSourcePath: root,
        base: 10,
        badges: [20, 30, 40, 50, 60, 70, 80],
      },
    );
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/couldn't find the BASE_OBEDIENCE_LEVEL/);
  });

  it('refuses when config.h does not exist', async () => {
    const result = await proposeLevelCapTable(
      { projectRoot: root, baseUrl: 'http://x' },
      {
        cfruSourcePath: path.join(root, 'definitely-not-here'),
        base: 10,
        badges: [20, 30, 40, 50, 60, 70, 80],
      },
    );
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Could not read CFRU config.h/);
  });

  it('writes the originalOtObedienceCheck toggle on', async () => {
    const result = await proposeLevelCapTable(
      { projectRoot: root, baseUrl: 'http://x' },
      {
        cfruSourcePath: root,
        base: 10,
        badges: [10, 30, 30, 50, 50, 70, 70],
        originalOtObedienceCheck: true,
      },
    );
    expect(result.ok).toBe(true);
    const onDisk = await fsp.readFile(result.configFilePath!, 'utf8');
    expect(onDisk).toMatch(/^#define OBEDIENCE_CHECK_FOR_PLAYER_ORIGINAL_POKEMON/m);
    expect(onDisk).not.toMatch(/^\/\/#define OBEDIENCE_CHECK_FOR_PLAYER_ORIGINAL_POKEMON/m);
  });
});
