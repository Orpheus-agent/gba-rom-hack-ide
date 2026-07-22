import { describe, expect, it, vi } from 'vitest';
import { applySceneBoot, summarizeSceneBootResult, varSeedKey } from './sceneBoot';
import type { SceneBootRecipe } from '@rom-editor/shared';

// Mock the savedataResolver - applySceneBoot delegates to setFlag /
// setVar. The mocks track which (family, id, value) triples are
// written so we can assert ordering + count without running a real
// emulator.
const writes: Array<{ kind: 'flag' | 'var'; id: number; value: number }> = [];

vi.mock('./savedataResolver', () => ({
  setFlag: vi.fn(async (_mem: unknown, _family: string, flagId: number, value: boolean) => {
    writes.push({ kind: 'flag', id: flagId, value: value ? 1 : 0 });
  }),
  setVar: vi.fn(async (_mem: unknown, _family: string, varId: number, value: number) => {
    writes.push({ kind: 'var', id: varId, value });
  }),
}));

vi.mock('./emulatorMemory', () => ({
  EmulatorMemory: class {
    // Minimal stub - applySceneBoot just passes it through to the
    // mocked setFlag / setVar.
    constructor(public host: unknown) {}
  },
}));

function makeRecipe(partial: Partial<SceneBootRecipe> = {}): SceneBootRecipe {
  return {
    id: 'r1',
    name: 'test',
    notes: null,
    createdAt: new Date().toISOString(),
    startingMapId: 'pallet_town',
    startingPosition: null,
    initialFlags: [],
    initialVars: [],
    triggerScriptId: null,
    skipIntro: false,
    ...partial,
  };
}

describe('applySceneBoot (Phase 4.1B)', () => {
  it('sets every flag in the recipe via setFlag', async () => {
    writes.length = 0;
    const host = { pauseGame: vi.fn(), resumeGame: vi.fn() };
    const result = await applySceneBoot({
      recipe: makeRecipe({ initialFlags: [0x820, 0x821] }),
      host,
      family: 'firered-vanilla',
    });
    expect(result.flagsSet).toBe(2);
    const flagWrites = writes.filter((w) => w.kind === 'flag');
    expect(flagWrites.map((w) => w.id)).toEqual([0x820, 0x821]);
    expect(host.pauseGame).toHaveBeenCalled();
    expect(host.resumeGame).toHaveBeenCalled();
  });

  it('sets every var in the recipe via setVar', async () => {
    writes.length = 0;
    const host = {};
    const result = await applySceneBoot({
      recipe: makeRecipe({
        initialVars: [
          { varId: 0x40d0, value: 3 },
          { varId: 0x40d1, value: 5 },
        ],
      }),
      host,
      family: 'firered-vanilla',
    });
    expect(result.varsSet).toBe(2);
    const varWrites = writes.filter((w) => w.kind === 'var');
    expect(varWrites).toEqual([
      { kind: 'var', id: 0x40d0, value: 3 },
      { kind: 'var', id: 0x40d1, value: 5 },
    ]);
  });

  it('falls back to firered-vanilla family for unknown family ids', async () => {
    writes.length = 0;
    await applySceneBoot({
      recipe: makeRecipe({ initialFlags: [0x100] }),
      host: {},
      family: 'firered-cfru',
    });
    // No throw - the setFlag mock was still invoked (writes is non-empty).
    expect(writes).toHaveLength(1);
  });

  it('continues past setFlag errors and surfaces them as warnings', async () => {
    writes.length = 0;
    const mod = (await import('./savedataResolver')) as unknown as {
      setFlag: ReturnType<typeof vi.fn>;
    };
    let calls = 0;
    mod.setFlag.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) throw new Error('boom');
    });
    const result = await applySceneBoot({
      recipe: makeRecipe({ initialFlags: [0x100, 0x200] }),
      host: {},
      family: 'firered-vanilla',
    });
    expect(result.flagsSet).toBe(1);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/boom/);
  });

  it('surfaces guidance about warp + script trigger when present', async () => {
    writes.length = 0;
    // Reset the setFlag mock from the previous test.
    const mod = (await import('./savedataResolver')) as unknown as {
      setFlag: ReturnType<typeof vi.fn>;
    };
    mod.setFlag.mockImplementation(async () => {
      /* no-op */
    });
    const result = await applySceneBoot({
      recipe: makeRecipe({
        startingPosition: { x: 4, y: 5, facing: 'down' },
        triggerScriptId: 'cosmog_script',
      }),
      host: {},
      family: 'firered-vanilla',
    });
    expect(result.guidance.join(' ')).toContain('cosmog_script');
    expect(result.guidance.join(' ')).toContain('4');
  });
});

describe('summarizeSceneBootResult', () => {
  it('produces a readable one-liner', () => {
    const summary = summarizeSceneBootResult(
      makeRecipe({ initialFlags: [1, 2, 3], initialVars: [{ varId: 0x40d0, value: 3 }] }),
      { flagsSet: 3, varsSet: 1, guidance: [], warnings: [] },
    );
    expect(summary).toContain('Applied');
    expect(summary).toContain('3/3');
    expect(summary).toContain('1/1');
  });
});

describe('varSeedKey', () => {
  it('produces a stable key per (varId, value) pair', () => {
    expect(varSeedKey({ varId: 0x40d0, value: 3 })).toBe('40d0=3');
    expect(varSeedKey({ varId: 1, value: 0 })).toBe('1=0');
  });
});
