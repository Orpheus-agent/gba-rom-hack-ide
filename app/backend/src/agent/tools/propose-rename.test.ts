import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ProjectManifest } from '@rom-editor/shared';
import { text } from '@rom-introspection/engine';
import { writeManifest } from '../../scan/manifest-io.js';
import { proposeRename } from './propose-rename.js';

const STRING_TERMINATOR = 0xff;
const GBA_MIRROR = 0x08000000;

function manifest(scriptSteps: ProjectManifest['scriptSteps']): ProjectManifest {
  return {
    schemaVersion: 1,
    generatedAtUtc: '2026-05-22T00:00:00.000Z',
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
        createdAtUtc: '2026-05-22T00:00:00.000Z',
      }),
      text: async () => '',
    };
  }) as unknown as typeof fetch;
  return { fetchFn, captured: () => body };
}

/** Seed a tiny .gba in `root` with the given strings + a msgbox opcode
 *  block per string so the pointer-at-fileOffset+2 convention holds. */
function buildFakeRomBuffer(
  strings: Array<{
    /** File offset of the encoded string. */
    textOffset: number;
    /** Decoded text (what gets encoded). */
    text: string;
    /** File offset of the msgbox loadword opcode block (the pointer
     *  to textOffset lives at fileOffset+2). */
    fileOffset: number;
  }>,
  totalSize = 0x4000,
): Buffer {
  // Pre-fill with 0xFF (the free-space sentinel). This makes the
  // tail of the buffer naturally allocatable by findFreeRomSpace.
  const buf = Buffer.alloc(totalSize, 0xff);
  for (const s of strings) {
    // Write the encoded string + terminator at textOffset.
    const encoded = text.encodeString(s.text);
    for (let i = 0; i < encoded.length; i++) buf[s.textOffset + i] = encoded[i]!;
    buf[s.textOffset + encoded.length] = STRING_TERMINATOR;
    // Write a msgbox-pattern opcode block: 0x0F 0x00 <ptr LE×4> 0x09 0x06
    buf[s.fileOffset + 0] = 0x0f; // loadword
    buf[s.fileOffset + 1] = 0x00; // register 0
    const ptr = (s.textOffset + GBA_MIRROR) >>> 0;
    buf[s.fileOffset + 2] = ptr & 0xff;
    buf[s.fileOffset + 3] = (ptr >>> 8) & 0xff;
    buf[s.fileOffset + 4] = (ptr >>> 16) & 0xff;
    buf[s.fileOffset + 5] = (ptr >>> 24) & 0xff;
    buf[s.fileOffset + 6] = 0x09; // callstd
    buf[s.fileOffset + 7] = 0x06; // stdType 6 (msgbox neutral)
  }
  return buf;
}

describe('proposeRename', () => {
  let root: string;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(tmpdir(), 'propose-rename-'));
  });
  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  it('reports no-op when before === after', async () => {
    const result = await proposeRename({ projectRoot: root }, { before: 'X', after: 'X' });
    expect(result.proposal).toBeNull();
    expect(result.message).toMatch(/No-op/i);
  });

  it('reports manifest_not_found via a friendly message', async () => {
    const result = await proposeRename({ projectRoot: root }, { before: 'X', after: 'Y' });
    expect(result.proposal).toBeNull();
    expect(result.message).toMatch(/No manifest/);
  });

  it('returns matchCount=0 with a helpful message when before-text not found', async () => {
    await writeManifest(root, manifest([
      { id: 'a__0', kind: 'dialogue', params: { dialogueText: 'PALLET TOWN', textFileOffset: 0x100, fileOffset: 0x800 } },
    ]));
    await fsp.writeFile(path.join(root, 'test.gba'), buildFakeRomBuffer([
      { textOffset: 0x100, text: 'PALLET TOWN', fileOffset: 0x800 },
    ]));
    const { fetchFn } = fakeProposalFetch();
    const result = await proposeRename(
      { projectRoot: root, baseUrl: 'http://127.0.0.1:8717' },
      { before: 'ROUTE 1', after: 'PATH A1' },
      { fetchFn },
    );
    expect(result.matchCount).toBe(0);
    expect(result.message).toMatch(/No dialogue slots match/);
  });

  it('builds one binary_replace_text edit per unique offset (same-length rename)', async () => {
    await writeManifest(root, manifest([
      // Two scriptSteps reference the same slot.
      { id: 'a__0', kind: 'dialogue', params: { dialogueText: 'ROUTE 1\nPALLET TOWN', textFileOffset: 0x100, fileOffset: 0x800 } },
      { id: 'b__0', kind: 'dialogue', params: { dialogueText: 'ROUTE 1\nPALLET TOWN', textFileOffset: 0x100, fileOffset: 0x900 } },
      // Different slot, also references "ROUTE 1".
      { id: 'c__0', kind: 'dialogue', params: { dialogueText: 'Welcome to ROUTE 1!', textFileOffset: 0x200, fileOffset: 0xa00 } },
      // Doesn't match - should not appear.
      { id: 'd__0', kind: 'dialogue', params: { dialogueText: 'PEWTER CITY', textFileOffset: 0x300, fileOffset: 0xb00 } },
    ]));
    await fsp.writeFile(path.join(root, 'test.gba'), buildFakeRomBuffer([
      { textOffset: 0x100, text: 'ROUTE 1\nPALLET TOWN', fileOffset: 0x800 },
      { textOffset: 0x200, text: 'Welcome to ROUTE 1!', fileOffset: 0xa00 },
      { textOffset: 0x300, text: 'PEWTER CITY', fileOffset: 0xb00 },
    ]));
    const { fetchFn, captured } = fakeProposalFetch();
    const result = await proposeRename(
      { projectRoot: root, baseUrl: 'http://127.0.0.1:8717' },
      { before: 'ROUTE 1', after: 'PATH A1' }, // same length: 7 chars
      { fetchFn },
    );
    expect(result.matchCount).toBe(2);
    expect(result.inPlaceCount).toBe(2);
    expect(result.repointedCount).toBe(0);
    expect(result.proposal).not.toBeNull();
    const body = captured();
    expect(body).not.toBeNull();
    expect(body!.edits).toHaveLength(2);
    for (const e of body!.edits as Array<{ kind: string }>) {
      expect(e.kind).toBe('binary_replace_text');
    }
  });

  it('emits a binary_write_text + binary_rewrite_pointer pair when after is longer (AI-1.4b)', async () => {
    await writeManifest(root, manifest([
      { id: 'a__0', kind: 'dialogue', params: { dialogueText: 'ROUTE 1', textFileOffset: 0x100, fileOffset: 0x800 } },
    ]));
    await fsp.writeFile(path.join(root, 'test.gba'), buildFakeRomBuffer([
      { textOffset: 0x100, text: 'ROUTE 1', fileOffset: 0x800 },
    ]));
    const { fetchFn, captured } = fakeProposalFetch();
    const result = await proposeRename(
      { projectRoot: root, baseUrl: 'http://127.0.0.1:8717' },
      { before: 'ROUTE 1', after: 'ELECTRIC AVENUE' }, // 7 → 15 chars, length-increasing
      { fetchFn },
    );
    expect(result.matchCount).toBe(1);
    expect(result.inPlaceCount).toBe(0);
    expect(result.repointedCount).toBe(1);
    const body = captured();
    expect(body).not.toBeNull();
    expect(body!.edits).toHaveLength(2);
    const kinds = (body!.edits as Array<{ kind: string }>).map((e) => e.kind);
    expect(kinds).toContain('binary_write_text');
    expect(kinds).toContain('binary_rewrite_pointer');
    const write = body!.edits.find((e) => (e as { kind: string }).kind === 'binary_write_text') as {
      offset: number;
      before: string;
      after: string;
      slotBytes: number;
    };
    expect(write.before).toBe('');
    expect(write.after).toBe('ELECTRIC AVENUE');
    expect(write.slotBytes).toBeGreaterThanOrEqual(16);
    const repoint = body!.edits.find((e) => (e as { kind: string }).kind === 'binary_rewrite_pointer') as {
      pointerOffset: number;
      beforeTargetOffset: number;
      afterTargetOffset: number;
    };
    expect(repoint.pointerOffset).toBe(0x800 + 2);
    expect(repoint.beforeTargetOffset).toBe(0x100);
    expect(repoint.afterTargetOffset).toBe(write.offset);
  });

  it('counts skippedNoOffset for dialogue matches that lack textFileOffset', async () => {
    await writeManifest(root, manifest([
      { id: 'a__0', kind: 'dialogue', params: { dialogueText: 'ROUTE 1' } },
      { id: 'b__0', kind: 'dialogue', params: { dialogueText: 'ROUTE 1!', textFileOffset: 0x100, fileOffset: 0x800 } },
    ]));
    await fsp.writeFile(path.join(root, 'test.gba'), buildFakeRomBuffer([
      { textOffset: 0x100, text: 'ROUTE 1!', fileOffset: 0x800 },
    ]));
    const { fetchFn } = fakeProposalFetch();
    const result = await proposeRename(
      { projectRoot: root, baseUrl: 'http://127.0.0.1:8717' },
      { before: 'ROUTE 1', after: 'PATH A1' },
      { fetchFn },
    );
    expect(result.skippedNoOffset).toBe(1);
    expect(result.matchCount).toBe(1);
  });
});
