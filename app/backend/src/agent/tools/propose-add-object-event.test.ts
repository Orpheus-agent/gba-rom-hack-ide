/**
 * Smoke tests for propose_add_object_event - verify the input-validation
 * branches (no manifest, no map, no ROM, no events struct) and a happy-
 * path append that decodes back to a parseable MapEvents struct + array.
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ProjectManifest, MapNode } from '@rom-editor/shared';
import { maps as mapsApi } from '@rom-introspection/engine';
import { writeManifest } from '../../scan/manifest-io.js';
import { proposeAddObjectEvent, resolveMovementType } from './propose-add-object-event.js';

const GBA_ROM_BASE = 0x08000000;

function manifestWith(maps: MapNode[]): ProjectManifest {
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
    maps,
    warps: [],
    triggers: [],
    objectEvents: [],
    dialogue: [],
    flags: [],
    variables: [],
    encounterTables: [],
    trainers: [],
    scriptSteps: [],
    assets: [],
  };
}

/** Build a fake 64 KB ROM with a MapEvents struct + one ObjectEvent.
 *  Returns the file offsets so the test can pass them as manifest metadata. */
function buildFakeRom(): {
  bytes: Buffer;
  eventsStructOffset: number;
  arrayOffset: number;
} {
  const buf = Buffer.alloc(0x10000, 0xff);
  const eventsStructOffset = 0x100;
  const arrayOffset = 0x200;
  // MapEvents struct @ 0x100:
  // +0x00: objectEventCount = 1
  buf[eventsStructOffset + 0x00] = 0x01;
  // +0x01: warpCount = 0
  buf[eventsStructOffset + 0x01] = 0x00;
  // +0x02: coordEventCount = 0
  buf[eventsStructOffset + 0x02] = 0x00;
  // +0x03: bgEventCount = 0
  buf[eventsStructOffset + 0x03] = 0x00;
  // +0x04: objectEventsPointer (LE u32) = arrayOffset + GBA base
  const ptr = (arrayOffset + GBA_ROM_BASE) >>> 0;
  buf.writeUInt32LE(ptr, eventsStructOffset + 0x04);
  // +0x08, +0x0C, +0x10: warps/coord/bg pointers = 0 (NULL)
  // ObjectEvent #0 @ 0x200 - minimal valid record (localId=1).
  buf[arrayOffset + 0x00] = 0x01; // localId
  buf[arrayOffset + 0x01] = 0x05; // graphicsId
  buf[arrayOffset + 0x02] = 0;
  buf[arrayOffset + 0x03] = 0;
  buf.writeInt16LE(10, arrayOffset + 0x04); // x
  buf.writeInt16LE(15, arrayOffset + 0x06); // y
  buf[arrayOffset + 0x08] = 3; // elevation
  // movementType=0, ranges=0, trainerType=0, sight=0, scriptPtr=NULL, flagId=0
  return { bytes: buf, eventsStructOffset, arrayOffset };
}

function mapWith(metadata: Record<string, string | number | boolean>): MapNode {
  return {
    id: 'binary_map_3_19',
    name: 'Route 1',
    group: 'route',
    dimensions: { width: 20, height: 40 },
    tilesetIds: [],
    warpIds: [],
    scriptIds: [],
    objectEventIds: [],
    encounterTableIds: [],
    musicId: null,
    metadata,
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

describe('proposeAddObjectEvent', () => {
  let root: string;
  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(tmpdir(), 'propose-add-obj-'));
  });
  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  it('reports a friendly error when no manifest is present', async () => {
    const result = await proposeAddObjectEvent(
      { projectRoot: root, baseUrl: 'http://x' },
      { mapId: 'binary_map_3_19', x: 6, y: 31, graphicsId: 5 },
    );
    expect(result.proposal).toBeNull();
    expect(result.message).toMatch(/No manifest/);
  });

  it('reports a friendly error when the map id is unknown', async () => {
    await writeManifest(root, manifestWith([]));
    const result = await proposeAddObjectEvent(
      { projectRoot: root, baseUrl: 'http://x' },
      { mapId: 'binary_map_999_99', x: 0, y: 0, graphicsId: 0 },
    );
    expect(result.proposal).toBeNull();
    expect(result.message).toMatch(/not in manifest\.maps/);
  });

  it('reports a friendly error when the map has no MapEvents struct offset', async () => {
    await writeManifest(
      root,
      manifestWith([mapWith({ source: 'BinaryRomScanner' })]),
    );
    const result = await proposeAddObjectEvent(
      { projectRoot: root, baseUrl: 'http://x' },
      { mapId: 'binary_map_3_19', x: 6, y: 31, graphicsId: 5 },
    );
    expect(result.proposal).toBeNull();
    expect(result.message).toMatch(/no binary-rom MapEvents struct offset/);
  });

  it('reports a friendly error when the .gba file is missing', async () => {
    await writeManifest(
      root,
      manifestWith([
        mapWith({
          source: 'BinaryRomScanner',
          binaryRomMapEventsStructOffset: 0x100,
        }),
      ]),
    );
    const result = await proposeAddObjectEvent(
      { projectRoot: root, baseUrl: 'http://x' },
      { mapId: 'binary_map_3_19', x: 6, y: 31, graphicsId: 5 },
    );
    expect(result.proposal).toBeNull();
    expect(result.message).toMatch(/No \.gba ROM found/);
  });

  it('appends a new ObjectEvent and the result decodes via the engine parser', async () => {
    const { bytes, eventsStructOffset, arrayOffset } = buildFakeRom();
    await fsp.writeFile(path.join(root, 'fake.gba'), bytes);
    await writeManifest(
      root,
      manifestWith([
        mapWith({
          source: 'BinaryRomScanner',
          binaryRomMapEventsStructOffset: eventsStructOffset,
          binaryRomObjectEventsArrayOffset: arrayOffset,
        }),
      ]),
    );
    const { fetchFn, captured } = fakeProposalFetch();
    const result = await proposeAddObjectEvent(
      { projectRoot: root, baseUrl: 'http://x' },
      { mapId: 'binary_map_3_19', x: 6, y: 31, graphicsId: 5, trainerType: 1, trainerSightRange: 5 },
      { fetchFn },
    );
    expect(result.proposal).not.toBeNull();
    expect(result.oldCount).toBe(1);
    expect(result.newCount).toBe(2);
    expect(result.newLocalId).toBe(2); // localId 1 was taken; next free is 2.
    expect(result.newArrayOffset).not.toBeNull();
    expect(result.newObjectEventOffset).not.toBeNull();

    // The proposal should carry: 1× allocate (new array), 1× count bump,
    // 1× pointer rewrite, 1× clear-old-slot. Four edits total.
    const body = captured();
    expect(body).not.toBeNull();
    expect(body!.edits).toHaveLength(4);

    // Apply the edits ourselves to a working copy + verify the engine
    // parser recognises 2 ObjectEvents at the new array offset.
    const working = Buffer.from(bytes);
    for (const e of body!.edits as Array<{
      kind: string;
      offset?: number;
      pointerOffset?: number;
      afterBytes?: string;
      afterTargetOffset?: number;
    }>) {
      if (e.kind === 'binary_write_bytes' && e.afterBytes !== undefined && e.offset !== undefined) {
        const bytesToWrite = Buffer.from(e.afterBytes, 'hex');
        bytesToWrite.copy(working, e.offset);
      } else if (
        e.kind === 'binary_rewrite_pointer' &&
        e.pointerOffset !== undefined &&
        e.afterTargetOffset !== undefined
      ) {
        const ptr = (e.afterTargetOffset + GBA_ROM_BASE) >>> 0;
        working.writeUInt32LE(ptr, e.pointerOffset);
      }
    }
    const parsed = mapsApi.parseMapEvents(working, eventsStructOffset);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.events.objectEventCount).toBe(2);
      expect(parsed.events.objectEvents).toHaveLength(2);
      // Original event still there.
      expect(parsed.events.objectEvents[0]!.localId).toBe(1);
      expect(parsed.events.objectEvents[0]!.graphicsId).toBe(5);
      // New event at the requested coords + graphics.
      expect(parsed.events.objectEvents[1]!.localId).toBe(2);
      expect(parsed.events.objectEvents[1]!.graphicsId).toBe(5);
      expect(parsed.events.objectEvents[1]!.x).toBe(6);
      expect(parsed.events.objectEvents[1]!.y).toBe(31);
      expect(parsed.events.objectEvents[1]!.trainerType).toBe(1);
      expect(parsed.events.objectEvents[1]!.trainerSightOrBerryTreeId).toBe(5);
    }
  });
});

// Phase 2A-1 - symbolic movement-type resolution. The original agent
// session wrote `0x0A` thinking it meant FACE_RIGHT; the canonical pret
// value for FACE_RIGHT is `0x0C` (0x0A is FACE_UP). The new resolver
// accepts symbolic names so the agent can pass strings instead of
// guessing numbers.
describe('resolveMovementType', () => {
  it('returns 0 when input is undefined (legacy default)', () => {
    expect(resolveMovementType(undefined)).toEqual({ value: 0 });
  });

  it('passes through valid numeric input', () => {
    expect(resolveMovementType(12)).toEqual({ value: 12 });
    expect(resolveMovementType(0)).toEqual({ value: 0 });
    expect(resolveMovementType(0xff)).toEqual({ value: 0xff });
  });

  it('rejects out-of-range numeric input with a helpful error', () => {
    const result = resolveMovementType(256);
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toMatch(/out of range/i);
    }
  });

  it('rejects non-integer numeric input', () => {
    const result = resolveMovementType(3.5);
    expect('error' in result).toBe(true);
  });

  it('resolves the canonical FACE_* set to pret/pokefirered byte values', () => {
    // The whole reason this resolver exists. 0x0A == FACE_UP (not RIGHT).
    expect(resolveMovementType('MOVEMENT_TYPE_FACE_DOWN')).toEqual({ value: 9 });
    expect(resolveMovementType('MOVEMENT_TYPE_FACE_UP')).toEqual({ value: 10 });
    expect(resolveMovementType('MOVEMENT_TYPE_FACE_LEFT')).toEqual({ value: 11 });
    expect(resolveMovementType('MOVEMENT_TYPE_FACE_RIGHT')).toEqual({ value: 12 });
  });

  it('accepts symbolic names without the MOVEMENT_TYPE_ prefix', () => {
    expect(resolveMovementType('FACE_RIGHT')).toEqual({ value: 12 });
    expect(resolveMovementType('NONE')).toEqual({ value: 0 });
    expect(resolveMovementType('LOOK_AROUND')).toEqual({ value: 1 });
    expect(resolveMovementType('WANDER_AROUND')).toEqual({ value: 2 });
  });

  it('is case-insensitive and normalizes whitespace/hyphens to underscores', () => {
    expect(resolveMovementType('movement_type_face_right')).toEqual({ value: 12 });
    expect(resolveMovementType('Face Right')).toEqual({ value: 12 });
    expect(resolveMovementType('face-right')).toEqual({ value: 12 });
    expect(resolveMovementType('  MOVEMENT_TYPE_FACE_RIGHT  ')).toEqual({ value: 12 });
  });

  it('returns an error with a list of common values for unknown names', () => {
    const result = resolveMovementType('MOVEMENT_TYPE_GO_DIAGONAL');
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toMatch(/Unknown movement type/);
      expect(result.error).toMatch(/MOVEMENT_TYPE_FACE_RIGHT \(12\)/);
    }
  });

  it('covers extended types up to 60 (per pret canonical range)', () => {
    expect(resolveMovementType('MOVEMENT_TYPE_HIDDEN')).toEqual({ value: 51 });
    expect(resolveMovementType('MOVEMENT_TYPE_BURIED')).toEqual({ value: 60 });
    expect(resolveMovementType('MOVEMENT_TYPE_RUN_IN_PLACE_RIGHT')).toEqual({ value: 42 });
  });
});
