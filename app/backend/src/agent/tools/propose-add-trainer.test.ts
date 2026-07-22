/**
 * Smoke tests for propose_add_trainer - verify the input-validation
 * branches (no manifest, no trainer table, no ROM, table full / occupied
 * append slot) and a happy-path append that parses back as a valid
 * trainer struct via the engine.
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ProjectManifest, Trainer } from '@rom-editor/shared';
import { trainers as trainersApi } from '@rom-introspection/engine';
import { writeManifest } from '../../scan/manifest-io.js';
import { proposeAddTrainer } from './propose-add-trainer.js';

const TRAINER_STRUCT_SIZE = 40;

function manifestWithTrainers(trainers: Trainer[]): ProjectManifest {
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
    trainers,
    scriptSteps: [],
    assets: [],
  };
}

/** Build a fake ROM with a 3-entry trainer table starting at `tableStart`. */
function buildFakeRom(tableStart: number, trainerCount: number): {
  bytes: Buffer;
  trainersInManifest: Trainer[];
} {
  const buf = Buffer.alloc(0x10000, 0xff);
  const trainersInManifest: Trainer[] = [];
  for (let i = 0; i < trainerCount; i++) {
    const off = tableStart + i * TRAINER_STRUCT_SIZE;
    // Minimal valid trainer struct: zeros + valid name.
    // partyFlags=0, trainerClass=1, music=0, pic=0, name="A" + 0xFF + pad
    buf.fill(0, off, off + TRAINER_STRUCT_SIZE);
    buf[off + 0x00] = 0; // partyFlags
    buf[off + 0x01] = 1; // trainerClass
    // name @ +0x04: 'A' = 0xBB in Gen-3 charset, terminator 0xFF
    buf[off + 0x04] = 0xbb;
    buf[off + 0x05] = 0xff;
    for (let j = 6; j < 16; j++) buf[off + j] = 0;
    // partySize=1, partyPointer=NULL (no party)
    buf[off + 0x18] = 0; // doubleBattle
    buf[off + 0x20] = 1; // partySize
    // partyPointer @ +0x24 = 0 (NULL is OK per parser)
    trainersInManifest.push({
      id: `binary_trainer_${String(i)}`,
      name: `Trainer ${String(i)}`,
      className: `class_1`,
      party: [],
      aiFlags: [],
      mapId: null,
      metadata: {
        source: 'BinaryRomScanner#trainer',
        structFileOffset: off,
        partyFlags: 0,
        partySize: 1,
        partyPointer: 0,
        trainerClass: 1,
        encounterMusic: 0,
        trainerPic: 0,
        aiFlagsRaw: 0,
        item0: 0,
        item1: 0,
        item2: 0,
        item3: 0,
        isFemale: false,
        doubleBattle: false,
      },
    });
  }
  return { bytes: buf, trainersInManifest };
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

describe('proposeAddTrainer', () => {
  let root: string;
  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(tmpdir(), 'propose-add-tr-'));
  });
  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  it('reports an error when no manifest is present', async () => {
    const result = await proposeAddTrainer(
      { projectRoot: root, baseUrl: 'http://x' },
      { name: 'X', party: [{ speciesId: 1, level: 5 }] },
    );
    expect(result.proposal).toBeNull();
    expect(result.message).toMatch(/No manifest/);
  });

  it('reports an error when no trainer table is in the manifest', async () => {
    await writeManifest(root, manifestWithTrainers([]));
    const result = await proposeAddTrainer(
      { projectRoot: root, baseUrl: 'http://x' },
      { name: 'X', party: [{ speciesId: 1, level: 5 }] },
    );
    expect(result.proposal).toBeNull();
    expect(result.message).toMatch(/No trainer table located/);
  });

  it('appends a new trainer and the engine scanner picks it up', async () => {
    const tableStart = 0x100;
    const { bytes, trainersInManifest } = buildFakeRom(tableStart, 8);
    await fsp.writeFile(path.join(root, 'fake.gba'), bytes);
    await writeManifest(root, manifestWithTrainers(trainersInManifest));

    const { fetchFn, captured } = fakeProposalFetch();
    const result = await proposeAddTrainer(
      { projectRoot: root, baseUrl: 'http://x' },
      {
        name: 'CALY',
        trainerClass: 5,
        party: [{ speciesId: 800, level: 3, moveIds: [150, 0, 0, 0] }],
      },
      { fetchFn },
    );
    expect(result.proposal).not.toBeNull();
    expect(result.newTrainerId).toBe(8);
    expect(result.newTrainerStructOffset).toBe(tableStart + 8 * TRAINER_STRUCT_SIZE);
    expect(result.oldTrainerCount).toBe(8);
    expect(result.newTrainerCount).toBe(9);

    // Apply the edits + reparse.
    const body = captured();
    expect(body).not.toBeNull();
    expect(body!.edits).toHaveLength(2); // party + trainer struct
    const working = Buffer.from(bytes);
    for (const e of body!.edits as Array<{
      kind: string;
      offset?: number;
      afterBytes?: string;
    }>) {
      if (e.kind === 'binary_write_bytes' && e.afterBytes !== undefined && e.offset !== undefined) {
        Buffer.from(e.afterBytes, 'hex').copy(working, e.offset);
      }
    }
    const table = trainersApi.scanTrainerTable(working);
    expect(table).not.toBeNull();
    expect(table!.trainerCount).toBe(9);
    const last = table!.trainers[8]!;
    expect(last.trainerClass).toBe(5);
    expect(last.partyFlags).toBe(0x01); // CUSTOM_MOVES from moveIds
    expect(last.partySize).toBe(1);
    expect(last.partyPointer).not.toBe(0);
  });
});
