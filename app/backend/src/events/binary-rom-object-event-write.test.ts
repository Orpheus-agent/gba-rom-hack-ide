import { afterEach, describe, expect, it } from 'vitest';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  applyBinaryRomObjectEventEdits,
  BinaryRomObjectEventWriteError,
  OBJECT_EVENT_TEMPLATE_SIZE,
} from './binary-rom-object-event-write.js';

// Phase G-RC5 (semantic-world plan §G.5) - verify the 24-byte
// ObjectEventTemplate struct writer encodes each field at the right
// offset + width + endianness, validates ranges, creates the .bak
// once per session, and respects field whitelisting.

interface ObjectEventBytes {
  localId: number;
  graphicsId: number;
  kind: number;
  x: number;
  y: number;
  elevation: number;
  movementType: number;
  rangeXY: number;
  trainerType: number;
  trainerSight: number;
  scriptPtr: number;
  flagId: number;
}

function makeTemplate(over: Partial<ObjectEventBytes> = {}): Uint8Array {
  const t: ObjectEventBytes = {
    localId: 1,
    graphicsId: 5,
    kind: 0,
    x: 10,
    y: 20,
    elevation: 3,
    movementType: 9,
    rangeXY: 0,
    trainerType: 0,
    trainerSight: 0,
    scriptPtr: 0,
    flagId: 0,
    ...over,
  };
  const buf = new Uint8Array(OBJECT_EVENT_TEMPLATE_SIZE);
  const view = new DataView(buf.buffer);
  view.setUint8(0x00, t.localId);
  view.setUint8(0x01, t.graphicsId);
  view.setUint8(0x02, t.kind);
  view.setUint8(0x03, 0); // padding
  view.setInt16(0x04, t.x, true);
  view.setInt16(0x06, t.y, true);
  view.setUint8(0x08, t.elevation);
  view.setUint8(0x09, t.movementType);
  view.setUint8(0x0a, t.rangeXY);
  view.setUint8(0x0b, 0); // padding2
  view.setUint16(0x0c, t.trainerType, true);
  view.setUint16(0x0e, t.trainerSight, true);
  view.setUint32(0x10, t.scriptPtr, true);
  view.setUint16(0x14, t.flagId, true);
  view.setUint16(0x16, 0, true); // padding3
  return buf;
}

const tmpFiles: string[] = [];

async function makeRom(template: Uint8Array, padBefore = 0): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rom-edit-test-'));
  const romPath = path.join(dir, 'test.gba');
  const buf = Buffer.alloc(padBefore + template.length + 1024);
  buf.set(template, padBefore);
  await fsp.writeFile(romPath, buf);
  tmpFiles.push(romPath);
  return romPath;
}

afterEach(async () => {
  for (const f of tmpFiles.splice(0)) {
    try {
      await fsp.rm(path.dirname(f), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe('applyBinaryRomObjectEventEdits', () => {
  it('patches graphics_id and movement_type at the right byte offsets', async () => {
    const romPath = await makeRom(makeTemplate({ graphicsId: 5, movementType: 9 }), 0x1000);
    const result = await applyBinaryRomObjectEventEdits(romPath, [
      {
        structFileOffset: 0x1000,
        fields: { graphics_id: 42, movement_type: 7 },
      },
    ]);
    expect(result.bytesChanged).toBe(2);
    expect(result.backupCreated).toBe(true);
    const buf = await fsp.readFile(romPath);
    expect(buf[0x1000 + 0x01]).toBe(42);
    expect(buf[0x1000 + 0x09]).toBe(7);
    // Other fields unchanged.
    expect(buf[0x1000 + 0x00]).toBe(1); // localId
    expect(buf[0x1000 + 0x08]).toBe(3); // elevation
  });

  it('packs movement_range_x + movement_range_y into the same byte 0x0A', async () => {
    const romPath = await makeRom(makeTemplate());
    await applyBinaryRomObjectEventEdits(romPath, [
      {
        structFileOffset: 0,
        fields: { movement_range_x: 5, movement_range_y: 3 },
      },
    ]);
    const buf = await fsp.readFile(romPath);
    // High nibble = X (5), low nibble = Y (3) → 0x53.
    expect(buf[0x0a]).toBe(0x53);
  });

  it('writes trainer_type as little-endian u16 at offset 0x0C', async () => {
    const romPath = await makeRom(makeTemplate());
    await applyBinaryRomObjectEventEdits(romPath, [
      { structFileOffset: 0, fields: { trainer_type: 0x1234 } },
    ]);
    const buf = await fsp.readFile(romPath);
    expect(buf[0x0c]).toBe(0x34); // low byte
    expect(buf[0x0d]).toBe(0x12); // high byte
  });

  it('writes flag as little-endian u16 at offset 0x14', async () => {
    const romPath = await makeRom(makeTemplate());
    await applyBinaryRomObjectEventEdits(romPath, [
      { structFileOffset: 0, fields: { flag: 0x0800 } },
    ]);
    const buf = await fsp.readFile(romPath);
    expect(buf[0x14]).toBe(0x00);
    expect(buf[0x15]).toBe(0x08);
  });

  it('writes script as little-endian u32 ROM pointer at offset 0x10', async () => {
    const romPath = await makeRom(makeTemplate());
    await applyBinaryRomObjectEventEdits(romPath, [
      { structFileOffset: 0, fields: { script: 0x081a2b3c } },
    ]);
    const buf = await fsp.readFile(romPath);
    expect(buf[0x10]).toBe(0x3c);
    expect(buf[0x11]).toBe(0x2b);
    expect(buf[0x12]).toBe(0x1a);
    expect(buf[0x13]).toBe(0x08);
  });

  it('rejects script pointers outside ROM space', async () => {
    const romPath = await makeRom(makeTemplate());
    await expect(
      applyBinaryRomObjectEventEdits(romPath, [
        { structFileOffset: 0, fields: { script: 0x01000000 } }, // not ROM-space
      ]),
    ).rejects.toThrow(BinaryRomObjectEventWriteError);
  });

  it('accepts script=0 (no script)', async () => {
    const romPath = await makeRom(makeTemplate({ scriptPtr: 0x08123456 }));
    await applyBinaryRomObjectEventEdits(romPath, [
      { structFileOffset: 0, fields: { script: 0 } },
    ]);
    const buf = await fsp.readFile(romPath);
    expect(buf.readUInt32LE(0x10)).toBe(0);
  });

  it('rejects u8 fields > 255', async () => {
    const romPath = await makeRom(makeTemplate());
    await expect(
      applyBinaryRomObjectEventEdits(romPath, [
        { structFileOffset: 0, fields: { graphics_id: 256 } },
      ]),
    ).rejects.toThrow(BinaryRomObjectEventWriteError);
  });

  it('rejects unknown field names', async () => {
    const romPath = await makeRom(makeTemplate());
    await expect(
      applyBinaryRomObjectEventEdits(romPath, [
        { structFileOffset: 0, fields: { not_a_field: 42 } },
      ]),
    ).rejects.toThrow(BinaryRomObjectEventWriteError);
  });

  it('skips null/undefined field values (leave-alone)', async () => {
    const romPath = await makeRom(makeTemplate({ graphicsId: 5 }));
    const result = await applyBinaryRomObjectEventEdits(romPath, [
      {
        structFileOffset: 0,
        fields: { graphics_id: 42, movement_type: null, flag: undefined },
      },
    ]);
    expect(result.bytesChanged).toBe(1);
    const buf = await fsp.readFile(romPath);
    expect(buf[0x01]).toBe(42);
  });

  it('returns previous + next field snapshots for the undo log', async () => {
    const romPath = await makeRom(makeTemplate({ graphicsId: 5, movementType: 9 }));
    const result = await applyBinaryRomObjectEventEdits(romPath, [
      {
        structFileOffset: 0,
        fields: { graphics_id: 42 },
      },
    ]);
    expect(result.results.length).toBe(1);
    expect(result.results[0]!.previous.graphics_id).toBe(5);
    expect(result.results[0]!.next.graphics_id).toBe(42);
    // Unchanged fields appear in both snapshots with same value.
    expect(result.results[0]!.previous.movement_type).toBe(9);
    expect(result.results[0]!.next.movement_type).toBe(9);
  });

  it('creates `.bak` once per session (idempotent)', async () => {
    const romPath = await makeRom(makeTemplate());
    const backup = `${romPath}.bak`;
    const r1 = await applyBinaryRomObjectEventEdits(romPath, [
      { structFileOffset: 0, fields: { graphics_id: 10 } },
    ]);
    expect(r1.backupCreated).toBe(true);
    await expect(fsp.access(backup)).resolves.toBeUndefined();
    const r2 = await applyBinaryRomObjectEventEdits(romPath, [
      { structFileOffset: 0, fields: { graphics_id: 11 } },
    ]);
    expect(r2.backupCreated).toBe(false);
  });

  it('rejects struct offset past EOF', async () => {
    const romPath = await makeRom(makeTemplate());
    await expect(
      applyBinaryRomObjectEventEdits(romPath, [
        { structFileOffset: 0x100000, fields: { graphics_id: 1 } },
      ]),
    ).rejects.toThrow(BinaryRomObjectEventWriteError);
  });
});
