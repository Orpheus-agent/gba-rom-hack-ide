import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ProjectManifest, Variable } from '@rom-editor/shared';
import { writeManifest } from '../../scan/manifest-io.js';
import {
  normalizeOperator,
  proposeDialogueBranchOnVar,
  resolveVarId,
  scriptIdToRomPtr,
} from './propose-dialogue-branch-on-var.js';

/** Minimal manifest helper. */
function manifest(
  variables: ReadonlyArray<Variable>,
  scriptSteps: ProjectManifest['scriptSteps'] = [],
  over: Partial<ProjectManifest> = {},
): ProjectManifest {
  return {
    schemaVersion: 1,
    generatedAtUtc: '2026-05-27T00:00:00.000Z',
    projectRoot: '/x',
    identity: {
      kind: 'patch',
      confidence: 1,
      displayName: 'fake firered',
      baseGame: 'firered',
      fork: 'CFRU',
      featureFlags: [],
      warnings: [],
      evidence: [],
    },
    buildProfile: null,
    maps: [],
    warps: [],
    triggers: [],
    objectEvents: [],
    dialogue: [],
    flags: [],
    variables,
    encounterTables: [],
    trainers: [],
    scriptSteps,
    assets: [],
    ...over,
  };
}

const RA_EMO_LOG: Variable = {
  id: 'var_0x40d0',
  name: 'VAR_RA_EMO_LOG',
  scope: 'global',
  defaultValue: 0,
  description: null,
  engineValue: '0x40D0',
};

/** Build a ROM with a small script at `scriptOffset`. The script is
 *  `lock; release; end` (3 bytes). */
function buildFakeRom(scriptOffset: number, totalSize = 0x100000): Buffer {
  const buf = Buffer.alloc(totalSize, 0xff);
  buf[scriptOffset + 0] = 0x6a; // lock
  buf[scriptOffset + 1] = 0x6c; // release
  buf[scriptOffset + 2] = 0x02; // end
  return buf;
}

function fakeProposalFetch(): {
  fetchFn: typeof fetch;
  captured: () => { description: string; edits: unknown[] } | null;
} {
  let body: { description: string; edits: unknown[] } | null = null;
  const fetchFn = vi
    .fn()
    .mockImplementation(async (_url: unknown, init: { body: string }) => {
      body = JSON.parse(init.body) as { description: string; edits: unknown[] };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: 'patch_fake',
          projectId: 'p',
          description: body!.description,
          edits: body!.edits,
          status: 'pending',
          createdAtUtc: '2026-05-27T00:00:00.000Z',
        }),
        text: async () => '',
      };
    }) as unknown as typeof fetch;
  return { fetchFn, captured: () => body };
}

describe('normalizeOperator', () => {
  it('accepts the six canonical keywords', () => {
    expect(normalizeOperator('less')).toBe('less');
    expect(normalizeOperator('equal')).toBe('equal');
    expect(normalizeOperator('greater')).toBe('greater');
    expect(normalizeOperator('lessorequal')).toBe('lessorequal');
    expect(normalizeOperator('greaterorequal')).toBe('greaterorequal');
    expect(normalizeOperator('notequal')).toBe('notequal');
  });
  it('accepts ASCII symbol forms', () => {
    expect(normalizeOperator('<')).toBe('less');
    expect(normalizeOperator('=')).toBe('equal');
    expect(normalizeOperator('==')).toBe('equal');
    expect(normalizeOperator('>')).toBe('greater');
    expect(normalizeOperator('<=')).toBe('lessorequal');
    expect(normalizeOperator('>=')).toBe('greaterorequal');
    expect(normalizeOperator('!=')).toBe('notequal');
  });
  it('accepts Unicode symbol forms', () => {
    expect(normalizeOperator('≤')).toBe('lessorequal');
    expect(normalizeOperator('≥')).toBe('greaterorequal');
    expect(normalizeOperator('≠')).toBe('notequal');
  });
  it('returns null for unknown operators', () => {
    expect(normalizeOperator('roughly')).toBeNull();
    expect(normalizeOperator('')).toBeNull();
  });
});

describe('resolveVarId', () => {
  it('passes through valid numeric ids unchanged', () => {
    expect(resolveVarId(0x40d0, manifest([RA_EMO_LOG]))).toBe(0x40d0);
  });
  it('rejects out-of-range numeric ids', () => {
    expect(resolveVarId(-1, manifest([]))).toBeNull();
    expect(resolveVarId(0x10000, manifest([]))).toBeNull();
    expect(resolveVarId(1.5, manifest([]))).toBeNull();
  });
  it('resolves a symbolic name from the manifest', () => {
    expect(resolveVarId('VAR_RA_EMO_LOG', manifest([RA_EMO_LOG]))).toBe(0x40d0);
  });
  it('resolves a hex literal string fallback', () => {
    expect(resolveVarId('0x40D0', manifest([]))).toBe(0x40d0);
  });
  it('returns null for unknown symbolic names', () => {
    expect(resolveVarId('VAR_DOES_NOT_EXIST', manifest([RA_EMO_LOG]))).toBeNull();
  });
});

describe('scriptIdToRomPtr', () => {
  it('parses script_0x<hex> to GBA pointer', () => {
    expect(scriptIdToRomPtr('script_0x1a3c5f')).toBe((0x1a3c5f + 0x08000000) >>> 0);
  });
  it('parses binary_script_0x<hex> too', () => {
    expect(scriptIdToRomPtr('binary_script_0x100')).toBe(0x08000100);
  });
  it('returns null on bad input', () => {
    expect(scriptIdToRomPtr('not a script')).toBeNull();
    expect(scriptIdToRomPtr('script_xyz')).toBeNull();
  });
});

describe('proposeDialogueBranchOnVar', () => {
  let root: string;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(tmpdir(), 'propose-branch-on-var-'));
  });
  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  it('rejects unknown operator with a useful message', async () => {
    await writeManifest(root, manifest([RA_EMO_LOG]));
    await fsp.writeFile(path.join(root, 'test.gba'), buildFakeRom(0x100));
    const result = await proposeDialogueBranchOnVar(
      { projectRoot: root, baseUrl: 'http://x' },
      {
        scriptId: 'script_0x100',
        varId: 'VAR_RA_EMO_LOG',
        operator: 'roughly',
        value: 3,
        targetScriptId: 'script_0x200',
      },
    );
    expect(result.proposal).toBeNull();
    expect(result.message).toMatch(/Unknown operator "roughly"/);
  });

  it('rejects CFRU daily-reserved var 0x40F1', async () => {
    await writeManifest(root, manifest([RA_EMO_LOG]));
    await fsp.writeFile(path.join(root, 'test.gba'), buildFakeRom(0x100));
    const result = await proposeDialogueBranchOnVar(
      { projectRoot: root, baseUrl: 'http://x' },
      {
        scriptId: 'script_0x100',
        varId: 0x40f1,
        operator: 'equal',
        value: 0,
        targetScriptId: 'script_0x200',
      },
    );
    expect(result.proposal).toBeNull();
    expect(result.message).toMatch(/reserved daily-mechanic band/);
  });

  it('rejects varId outside the editable bands', async () => {
    await writeManifest(root, manifest([RA_EMO_LOG]));
    await fsp.writeFile(path.join(root, 'test.gba'), buildFakeRom(0x100));
    const result = await proposeDialogueBranchOnVar(
      { projectRoot: root, baseUrl: 'http://x' },
      {
        scriptId: 'script_0x100',
        varId: 0x1234,
        operator: 'equal',
        value: 0,
        targetScriptId: 'script_0x200',
      },
    );
    expect(result.proposal).toBeNull();
    expect(result.message).toMatch(/outside the editable bands/);
  });

  it('rejects passing both targetScriptId and targetRomPtr', async () => {
    await writeManifest(root, manifest([RA_EMO_LOG]));
    await fsp.writeFile(path.join(root, 'test.gba'), buildFakeRom(0x100));
    const result = await proposeDialogueBranchOnVar(
      { projectRoot: root, baseUrl: 'http://x' },
      {
        scriptId: 'script_0x100',
        varId: 'VAR_RA_EMO_LOG',
        operator: 'equal',
        value: 0,
        targetScriptId: 'script_0x200',
        targetRomPtr: 0x08000300,
      },
    );
    expect(result.proposal).toBeNull();
    expect(result.message).toMatch(/exactly one/);
  });

  it('rejects targetRomPtr below the GBA ROM base', async () => {
    await writeManifest(root, manifest([RA_EMO_LOG]));
    await fsp.writeFile(path.join(root, 'test.gba'), buildFakeRom(0x100));
    const result = await proposeDialogueBranchOnVar(
      { projectRoot: root, baseUrl: 'http://x' },
      {
        scriptId: 'script_0x100',
        varId: 'VAR_RA_EMO_LOG',
        operator: 'equal',
        value: 0,
        targetRomPtr: 0x00000100,
      },
    );
    expect(result.proposal).toBeNull();
    expect(result.message).toMatch(/below GBA_ROM_BASE/);
  });

  it('inserts a branch_on_var step with relocation (script grows past in-place)', async () => {
    await writeManifest(root, manifest([RA_EMO_LOG]));
    await fsp.writeFile(path.join(root, 'test.gba'), buildFakeRom(0x100));
    const { fetchFn, captured } = fakeProposalFetch();
    // Original = lock + release + end (3 bytes). Insert branch_on_var
    // adds 11 bytes → new = 14 bytes. Must relocate.
    const result = await proposeDialogueBranchOnVar(
      { projectRoot: root, baseUrl: 'http://127.0.0.1:8717' },
      {
        scriptId: 'script_0x100',
        varId: 'VAR_RA_EMO_LOG',
        operator: 'greaterorequal',
        value: 3,
        targetScriptId: 'script_0x300',
        insertAtIndex: 1, // between lock and release
      },
      { fetchFn },
    );
    expect(result.proposal).not.toBeNull();
    expect(result.resolvedVarId).toBe(0x40d0);
    expect(result.resolvedOperator).toBe('greaterorequal');
    expect(result.resolvedTargetRomPtr).toBe(0x08000300);
    expect(result.oldByteLength).toBe(3);
    expect(result.newByteLength).toBe(14);
    expect(result.wasRelocated).toBe(true);
    const body = captured();
    expect(body).not.toBeNull();
    // Edits include at least the relocated-script write + the clear-old-slot.
    expect(body!.edits.length).toBeGreaterThanOrEqual(2);
    // Search for the relocated script bytes - must contain the compare+goto_if
    // pattern for var 0x40D0, value 3, operator ≥ (cond=4), target 0x08000300.
    const writeEdits = body!.edits.filter((e) => (e as { kind: string }).kind === 'binary_write_bytes') as Array<{ afterBytes: string }>;
    const expectedHex =
      '6a' + // lock
      '21d04003000604' + '00030008' + // compare 0x40D0,3 + goto_if 4, 0x08000300 (LE: 00 03 00 08)
      '6c' + // release
      '02';  // end
    const relocated = writeEdits.find((e) => e.afterBytes === expectedHex);
    expect(relocated, `Expected ${expectedHex} in one of the write edits; got ${writeEdits.map((w) => w.afterBytes).join(', ')}`).toBeDefined();
  });

  it('accepts symbolic-name varId resolved from the manifest', async () => {
    await writeManifest(root, manifest([RA_EMO_LOG]));
    await fsp.writeFile(path.join(root, 'test.gba'), buildFakeRom(0x100));
    const { fetchFn } = fakeProposalFetch();
    const result = await proposeDialogueBranchOnVar(
      { projectRoot: root, baseUrl: 'http://127.0.0.1:8717' },
      {
        scriptId: 'script_0x100',
        varId: 'VAR_RA_EMO_LOG',
        operator: '≥',
        value: 1,
        targetScriptId: 'script_0x200',
        insertAtIndex: 0,
      },
      { fetchFn },
    );
    expect(result.resolvedVarId).toBe(0x40d0);
    expect(result.resolvedOperator).toBe('greaterorequal');
  });

  it('rejects unknown symbolic varId', async () => {
    await writeManifest(root, manifest([]));
    await fsp.writeFile(path.join(root, 'test.gba'), buildFakeRom(0x100));
    const result = await proposeDialogueBranchOnVar(
      { projectRoot: root, baseUrl: 'http://x' },
      {
        scriptId: 'script_0x100',
        varId: 'VAR_RA_EMO_LOG_BOGUS',
        operator: 'equal',
        value: 0,
        targetScriptId: 'script_0x200',
      },
    );
    expect(result.proposal).toBeNull();
    expect(result.message).toMatch(/Unknown varId/);
  });

  it('rejects when both target inputs are missing', async () => {
    await writeManifest(root, manifest([RA_EMO_LOG]));
    await fsp.writeFile(path.join(root, 'test.gba'), buildFakeRom(0x100));
    const result = await proposeDialogueBranchOnVar(
      { projectRoot: root, baseUrl: 'http://x' },
      {
        scriptId: 'script_0x100',
        varId: 'VAR_RA_EMO_LOG',
        operator: 'equal',
        value: 0,
      },
    );
    expect(result.proposal).toBeNull();
    expect(result.message).toMatch(/Provide either/);
  });
});
