import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ProjectManifest } from '@rom-editor/shared';
import { writeManifest } from '../../scan/manifest-io.js';
import { proposeScriptEdit } from './propose-script-edit.js';

/** Minimal manifest helper - only the fields the tool reads. */
function manifest(
  scriptSteps: ProjectManifest['scriptSteps'],
  over: Partial<ProjectManifest> = {},
): ProjectManifest {
  return {
    schemaVersion: 1,
    generatedAtUtc: '2026-05-25T00:00:00.000Z',
    projectRoot: '/x',
    identity: {
      kind: 'patch',
      confidence: 1,
      displayName: 'fake binary rom',
      baseGame: 'firered',
      fork: null,
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
    variables: [],
    encounterTables: [],
    trainers: [],
    scriptSteps,
    assets: [],
    ...over,
  };
}

function fakeProposalFetch(): {
  fetchFn: typeof fetch;
  captured: () => { description: string; edits: unknown[] } | null;
} {
  let body: { description: string; edits: unknown[] } | null = null;
  const fetchFn = vi.fn().mockImplementation(async (_url: unknown, init: { body: string }) => {
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
        createdAtUtc: '2026-05-25T00:00:00.000Z',
      }),
      text: async () => '',
    };
  }) as unknown as typeof fetch;
  return { fetchFn, captured: () => body };
}

/** Build a ROM with a small script at `scriptOffset`. The script is
 *  `lock; release; end` (4 bytes total). Allows tests to verify
 *  decode→mutate→encode round-trips. */
function buildFakeRom(scriptOffset: number, totalSize = 0x4000): Buffer {
  const buf = Buffer.alloc(totalSize, 0xff);
  buf[scriptOffset + 0] = 0x6a; // lock
  buf[scriptOffset + 1] = 0x6c; // release
  buf[scriptOffset + 2] = 0x02; // end
  return buf;
}

describe('proposeScriptEdit', () => {
  let root: string;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(tmpdir(), 'propose-script-edit-'));
  });
  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  it('rejects unparseable scriptId', async () => {
    const result = await proposeScriptEdit(
      { projectRoot: root, baseUrl: 'http://x' },
      { scriptId: 'not_a_script_id', op: 'deleteStep', stepIndex: 0 },
    );
    expect(result.proposal).toBeNull();
    expect(result.message).toMatch(/doesn't match the script_0x/);
  });

  it('rejects insertStep without newStep', async () => {
    const result = await proposeScriptEdit(
      { projectRoot: root, baseUrl: 'http://x' },
      { scriptId: 'script_0x100', op: 'insertStep', stepIndex: 0 },
    );
    expect(result.proposal).toBeNull();
    expect(result.message).toMatch(/requires newStep/);
  });

  it('handles missing manifest with a friendly message', async () => {
    const result = await proposeScriptEdit(
      { projectRoot: root, baseUrl: 'http://x' },
      { scriptId: 'script_0x100', op: 'deleteStep', stepIndex: 0 },
    );
    expect(result.proposal).toBeNull();
    expect(result.message).toMatch(/No manifest/);
  });

  it('handles missing ROM with a friendly message', async () => {
    await writeManifest(root, manifest([]));
    const result = await proposeScriptEdit(
      { projectRoot: root, baseUrl: 'http://x' },
      { scriptId: 'script_0x100', op: 'deleteStep', stepIndex: 0 },
    );
    expect(result.proposal).toBeNull();
    expect(result.message).toMatch(/No \.gba/);
  });

  it('handles a script with no decodable steps (offset out of bounds)', async () => {
    await writeManifest(root, manifest([]));
    // ROM too small - offset 0x100 beyond ROM end → invalid_offset.
    const buf = Buffer.alloc(0x80, 0xff);
    await fsp.writeFile(path.join(root, 'test.gba'), buf);
    const result = await proposeScriptEdit(
      { projectRoot: root, baseUrl: 'http://x' },
      { scriptId: 'script_0x100', op: 'deleteStep', stepIndex: 0 },
    );
    expect(result.proposal).toBeNull();
    expect(result.message).toMatch(/No steps decoded/);
  });

  it('deleteStep on an in-place script emits binary_write_bytes with 0xFF padding', async () => {
    await writeManifest(root, manifest([]));
    await fsp.writeFile(path.join(root, 'test.gba'), buildFakeRom(0x100));
    const { fetchFn, captured } = fakeProposalFetch();
    // Original script = lock(0x6a) + release(0x6c) + end(0x02) = 3 bytes
    // Delete the release → lock + end = 2 bytes. Trailing byte padded 0xFF.
    const result = await proposeScriptEdit(
      { projectRoot: root, baseUrl: 'http://127.0.0.1:8717' },
      { scriptId: 'script_0x100', op: 'deleteStep', stepIndex: 1 },
      { fetchFn },
    );
    expect(result.proposal).not.toBeNull();
    expect(result.scriptOffset).toBe(0x100);
    expect(result.wasRelocated).toBe(false);
    expect(result.oldByteLength).toBe(3);
    expect(result.newByteLength).toBe(2);
    const body = captured();
    expect(body).not.toBeNull();
    expect(body!.edits).toHaveLength(1);
    const edit = body!.edits[0] as { kind: string; offset: number; afterBytes: string };
    expect(edit.kind).toBe('binary_write_bytes');
    expect(edit.offset).toBe(0x100);
    // After bytes: 0x6a 0x02 (lock + end) padded to 3 with 0xff
    expect(edit.afterBytes).toBe('6a02ff');
  });

  it('insertStep that grows the script triggers relocation + emits 0xFF clear of old slot', async () => {
    await writeManifest(root, manifest([]));
    await fsp.writeFile(path.join(root, 'test.gba'), buildFakeRom(0x100));
    const { fetchFn, captured } = fakeProposalFetch();
    // Insert a setflag step between lock and release. Original = 3 bytes
    // (lock, release, end). New = 6 bytes (lock, setflag 0x828, release,
    // end). Must relocate.
    const result = await proposeScriptEdit(
      { projectRoot: root, baseUrl: 'http://127.0.0.1:8717' },
      {
        scriptId: 'script_0x100',
        op: 'insertStep',
        stepIndex: 1,
        newStep: { kind: 'set_flag', params: { flagId: 0x828 } },
      },
      { fetchFn },
    );
    expect(result.proposal).not.toBeNull();
    expect(result.wasRelocated).toBe(true);
    expect(result.oldByteLength).toBe(3);
    expect(result.newByteLength).toBe(6);
    const body = captured();
    expect(body).not.toBeNull();
    // Edits: 1 write-bytes for relocated script + 1 clear-old-slot + 0 pointer rewrites (no NPCs reference it in this manifest)
    expect(body!.edits.length).toBeGreaterThanOrEqual(2);
    const writeEdits = body!.edits.filter((e) => (e as { kind: string }).kind === 'binary_write_bytes');
    // One of the write edits clears 0x100..0x102 with 0xFF
    const clearEdit = writeEdits.find((e) => {
      const ed = e as { offset: number; afterBytes: string };
      return ed.offset === 0x100 && ed.afterBytes === 'ffffff';
    });
    expect(clearEdit).toBeDefined();
  });

  it('insertStep with cross-references emits binary_rewrite_pointer per NPC', async () => {
    // ObjectEvent at struct offset 0x500 has scriptPointer at 0x510
    // (struct + 0x10). It points at script 0x100.
    const objectEvent = {
      id: 'obj_test',
      name: 'Test NPC',
      mapId: 'map_1',
      coord: { x: 0, y: 0 },
      elevation: 0,
      kind: 'npc' as const,
      graphicsId: 'gfx_5',
      movementType: null,
      scriptId: 'script_0x100',
      flagId: null,
      trainerType: null,
      metadata: {
        binaryRomStructFileOffset: 0x500,
      },
    };
    await writeManifest(root, manifest([], { objectEvents: [objectEvent] }));
    await fsp.writeFile(path.join(root, 'test.gba'), buildFakeRom(0x100));
    const { fetchFn, captured } = fakeProposalFetch();
    const result = await proposeScriptEdit(
      { projectRoot: root, baseUrl: 'http://127.0.0.1:8717' },
      {
        scriptId: 'script_0x100',
        op: 'insertStep',
        stepIndex: 1,
        newStep: { kind: 'set_flag', params: { flagId: 0x828 } },
      },
      { fetchFn },
    );
    expect(result.wasRelocated).toBe(true);
    expect(result.pointerRewrites).toBe(1);
    const body = captured();
    expect(body).not.toBeNull();
    const pointerRewrites = body!.edits.filter(
      (e) => (e as { kind: string }).kind === 'binary_rewrite_pointer',
    );
    expect(pointerRewrites).toHaveLength(1);
    const pr = pointerRewrites[0] as { pointerOffset: number; beforeTargetOffset: number };
    expect(pr.pointerOffset).toBe(0x510);
    expect(pr.beforeTargetOffset).toBe(0x100);
  });

  it('reports stepIndex-out-of-range errors clearly', async () => {
    await writeManifest(root, manifest([]));
    await fsp.writeFile(path.join(root, 'test.gba'), buildFakeRom(0x100));
    const { fetchFn } = fakeProposalFetch();
    const result = await proposeScriptEdit(
      { projectRoot: root, baseUrl: 'http://x' },
      { scriptId: 'script_0x100', op: 'deleteStep', stepIndex: 99 },
      { fetchFn },
    );
    expect(result.proposal).toBeNull();
    expect(result.message).toMatch(/out of range/);
  });

  it('editStep replaces the targeted step', async () => {
    await writeManifest(root, manifest([]));
    await fsp.writeFile(path.join(root, 'test.gba'), buildFakeRom(0x100));
    const { fetchFn, captured } = fakeProposalFetch();
    // Replace release(0x6c) with setflag 0x828 - same byte budget?
    // release = 1 byte, setflag = 3 bytes. New total = 5, original = 3 → relocate.
    const result = await proposeScriptEdit(
      { projectRoot: root, baseUrl: 'http://x' },
      {
        scriptId: 'script_0x100',
        op: 'editStep',
        stepIndex: 1,
        newStep: { kind: 'set_flag', params: { flagId: 0x828 } },
      },
      { fetchFn },
    );
    expect(result.proposal).not.toBeNull();
    // Old: lock(1) + release(1) + end(1) = 3
    // New: lock(1) + setflag(3) + end(1) = 5
    expect(result.oldByteLength).toBe(3);
    expect(result.newByteLength).toBe(5);
    expect(result.wasRelocated).toBe(true);
    const body = captured();
    expect(body).not.toBeNull();
  });

  it('cross-ref pass picks up ObjectEvents lifted with the production binaryFileOffset key', async () => {
    // Regression for the metadata-key mismatch: the binary-rom lifter
    // writes `binaryFileOffset` (see binary-rom-registry.ts → metadata
    // block) but collectScriptReferences originally looked up the legacy
    // `binaryRomStructFileOffset`. The fix reads the production key
    // first and falls back to the legacy one. This test uses ONLY the
    // production key, so it fails before the fix and passes after.
    const objectEvent = {
      id: 'obj_prod',
      name: 'Production NPC',
      mapId: 'map_1',
      coord: { x: 0, y: 0 },
      elevation: 0,
      kind: 'npc' as const,
      graphicsId: 'gfx_5',
      movementType: null,
      scriptId: 'script_0x100',
      flagId: null,
      trainerType: null,
      metadata: {
        // Production lifter key - no `binaryRomStructFileOffset`.
        binaryFileOffset: 0x500,
      },
    };
    await writeManifest(root, manifest([], { objectEvents: [objectEvent] }));
    await fsp.writeFile(path.join(root, 'test.gba'), buildFakeRom(0x100));
    const { fetchFn, captured } = fakeProposalFetch();
    const result = await proposeScriptEdit(
      { projectRoot: root, baseUrl: 'http://127.0.0.1:8717' },
      {
        scriptId: 'script_0x100',
        op: 'insertStep',
        stepIndex: 1,
        newStep: { kind: 'set_flag', params: { flagId: 0x828 } },
      },
      { fetchFn },
    );
    expect(result.wasRelocated).toBe(true);
    expect(result.pointerRewrites).toBe(1);
    const body = captured();
    expect(body).not.toBeNull();
    const pointerRewrites = body!.edits.filter(
      (e) => (e as { kind: string }).kind === 'binary_rewrite_pointer',
    );
    expect(pointerRewrites).toHaveLength(1);
    const pr = pointerRewrites[0] as { pointerOffset: number; beforeTargetOffset: number };
    expect(pr.pointerOffset).toBe(0x510);
    expect(pr.beforeTargetOffset).toBe(0x100);
  });

  it('accepts the binary_script_0x prefix variant', async () => {
    await writeManifest(root, manifest([]));
    await fsp.writeFile(path.join(root, 'test.gba'), buildFakeRom(0x100));
    const { fetchFn } = fakeProposalFetch();
    const result = await proposeScriptEdit(
      { projectRoot: root, baseUrl: 'http://x' },
      { scriptId: 'binary_script_0x100', op: 'deleteStep', stepIndex: 1 },
      { fetchFn },
    );
    expect(result.proposal).not.toBeNull();
    expect(result.scriptOffset).toBe(0x100);
  });
});
