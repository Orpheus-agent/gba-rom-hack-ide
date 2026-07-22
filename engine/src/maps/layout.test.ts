import { describe, expect, it } from 'vitest';
import { GBA_ROM_BASE_ADDRESS } from '../pointers/index.js';
import {
  MAP_LAYOUT_MAX_DIMENSION,
  MAP_LAYOUT_STRUCT_SIZE_BYTES,
  parseMapLayout,
} from './layout.js';

function plantLayout(args: {
  bufferSize: number;
  layoutAt: number;
  width: number;
  height: number;
  borderBlocksOffset?: number | null;
  primaryBlocksOffset?: number | null;
  primaryTilesetOffset?: number | null;
  secondaryTilesetOffset?: number | null;
  bogusPointer?: { field: 0 | 1 | 2 | 3; value: number };
}): Buffer {
  const buf = Buffer.alloc(args.bufferSize);
  buf.writeInt32LE(args.width, args.layoutAt + 0x00);
  buf.writeInt32LE(args.height, args.layoutAt + 0x04);
  const writePtr = (slot: 0 | 1 | 2 | 3, off: number | null | undefined) => {
    const slotOffset = args.layoutAt + 0x08 + slot * 4;
    if (args.bogusPointer?.field === slot) {
      buf.writeUInt32LE(args.bogusPointer.value, slotOffset);
      return;
    }
    if (off === null || off === undefined) {
      buf.writeUInt32LE(0, slotOffset);
    } else {
      buf.writeUInt32LE((GBA_ROM_BASE_ADDRESS + off) >>> 0, slotOffset);
    }
  };
  writePtr(0, args.borderBlocksOffset);
  writePtr(1, args.primaryBlocksOffset);
  writePtr(2, args.primaryTilesetOffset);
  writePtr(3, args.secondaryTilesetOffset);
  return buf;
}

describe('parseMapLayout - happy paths', () => {
  it('parses a minimal layout (dimensions + NULL pointers)', () => {
    const buf = plantLayout({ bufferSize: 1024, layoutAt: 0x100, width: 20, height: 20 });
    const r = parseMapLayout(buf, 0x100);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.layout.width).toBe(20);
      expect(r.layout.height).toBe(20);
      expect(r.layout.borderBlocksOffset).toBeNull();
      expect(r.layout.primaryBlocksOffset).toBeNull();
      expect(r.layout.primaryTilesetOffset).toBeNull();
      expect(r.layout.secondaryTilesetOffset).toBeNull();
      expect(r.layout.fileOffset).toBe(0x100);
    }
  });

  it('parses layout with all 4 pointers populated', () => {
    const buf = plantLayout({
      bufferSize: 4096,
      layoutAt: 0x100,
      width: 32,
      height: 24,
      borderBlocksOffset: 0x500,
      primaryBlocksOffset: 0x600,
      primaryTilesetOffset: 0x700,
      secondaryTilesetOffset: 0x800,
    });
    const r = parseMapLayout(buf, 0x100);
    if (r.ok) {
      expect(r.layout.borderBlocksOffset).toBe(0x500);
      expect(r.layout.primaryBlocksOffset).toBe(0x600);
      expect(r.layout.primaryTilesetOffset).toBe(0x700);
      expect(r.layout.secondaryTilesetOffset).toBe(0x800);
    } else {
      throw new Error('expected ok');
    }
  });

  it('freezes the returned layout', () => {
    const buf = plantLayout({ bufferSize: 1024, layoutAt: 0, width: 10, height: 10 });
    const r = parseMapLayout(buf, 0);
    if (r.ok) expect(Object.isFrozen(r.layout)).toBe(true);
  });
});

describe('parseMapLayout - failure modes', () => {
  it('fails too_short when fewer than 24 bytes available', () => {
    const r = parseMapLayout(new Uint8Array(20), 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('too_short');
  });

  it('fails implausible_dimensions when width = 0', () => {
    const buf = plantLayout({ bufferSize: 1024, layoutAt: 0, width: 0, height: 10 });
    const r = parseMapLayout(buf, 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('implausible_dimensions');
  });

  it('fails implausible_dimensions when height > MAX', () => {
    const buf = plantLayout({
      bufferSize: 1024,
      layoutAt: 0,
      width: 10,
      height: MAP_LAYOUT_MAX_DIMENSION + 1,
    });
    const r = parseMapLayout(buf, 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('implausible_dimensions');
  });

  it('fails implausible_dimensions when width is negative (s32)', () => {
    const buf = Buffer.alloc(MAP_LAYOUT_STRUCT_SIZE_BYTES);
    buf.writeInt32LE(-1, 0);
    buf.writeInt32LE(10, 4);
    const r = parseMapLayout(buf, 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('implausible_dimensions');
  });

  it('fails invalid_pointer when a pointer is not in GBA ROM region', () => {
    const buf = plantLayout({
      bufferSize: 1024,
      layoutAt: 0,
      width: 10,
      height: 10,
      bogusPointer: { field: 2, value: 0x02000000 }, // EWRAM
    });
    const r = parseMapLayout(buf, 0);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failure.kind).toBe('invalid_pointer');
      if (r.failure.kind === 'invalid_pointer') {
        expect(r.failure.field).toBe('primaryTileset');
      }
    }
  });

  it('fails invalid_pointer when pointer target is past buffer end', () => {
    const buf = plantLayout({
      bufferSize: 1024,
      layoutAt: 0,
      width: 10,
      height: 10,
      borderBlocksOffset: 0x10000,
    });
    const r = parseMapLayout(buf, 0);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failure.kind).toBe('invalid_pointer');
      if (r.failure.kind === 'invalid_pointer') {
        expect(r.failure.field).toBe('borderBlocks');
      }
    }
  });
});

describe('parseMapLayout - boundary', () => {
  it('accepts MAX_DIMENSION × MAX_DIMENSION', () => {
    const buf = plantLayout({
      bufferSize: 1024,
      layoutAt: 0,
      width: MAP_LAYOUT_MAX_DIMENSION,
      height: MAP_LAYOUT_MAX_DIMENSION,
    });
    const r = parseMapLayout(buf, 0);
    expect(r.ok).toBe(true);
  });

  it('MAP_LAYOUT_STRUCT_SIZE_BYTES is 24', () => {
    expect(MAP_LAYOUT_STRUCT_SIZE_BYTES).toBe(24);
  });
});
