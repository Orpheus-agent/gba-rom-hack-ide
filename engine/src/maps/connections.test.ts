import { describe, expect, it } from 'vitest';
import { GBA_ROM_BASE_ADDRESS } from '../pointers/index.js';
import {
  MAP_CONNECTION_STRUCT_SIZE_BYTES,
  MAP_CONNECTIONS_HEADER_SIZE_BYTES,
  parseMapConnections,
} from './connections.js';

function plantConnections(args: {
  bufferSize: number;
  headerAt: number;
  count: number;
  arrayAt?: number | null;
  bogusArrayPointer?: number;
  connections?: Array<{
    direction?: number;
    offset?: number;
    destMapGroup: number;
    destMapNum: number;
  }>;
}): Buffer {
  const buf = Buffer.alloc(args.bufferSize);
  buf.writeInt32LE(args.count, args.headerAt + 0x00);
  const arrayPtr =
    args.bogusArrayPointer !== undefined
      ? args.bogusArrayPointer
      : args.arrayAt === null
        ? 0
        : (GBA_ROM_BASE_ADDRESS + (args.arrayAt ?? 0)) >>> 0;
  buf.writeUInt32LE(arrayPtr, args.headerAt + 0x04);
  if (args.arrayAt !== null && args.arrayAt !== undefined && args.connections) {
    for (let i = 0; i < args.connections.length; i++) {
      const off = args.arrayAt + i * MAP_CONNECTION_STRUCT_SIZE_BYTES;
      const c = args.connections[i]!;
      buf[off + 0x00] = c.direction ?? 1;
      buf.writeInt32LE(c.offset ?? 0, off + 0x04);
      buf[off + 0x08] = c.destMapGroup;
      buf[off + 0x09] = c.destMapNum;
    }
  }
  return buf;
}

describe('parseMapConnections - happy paths', () => {
  it('parses an empty (count=0) MapConnections envelope', () => {
    const buf = plantConnections({ bufferSize: 1024, headerAt: 0x100, count: 0 });
    const r = parseMapConnections(buf, 0x100);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.connections.count).toBe(0);
      expect(r.connections.connections).toEqual([]);
      expect(r.connections.connectionsArrayOffset).toBeNull();
    }
  });

  it('parses 2 connections', () => {
    const buf = plantConnections({
      bufferSize: 1024,
      headerAt: 0x100,
      count: 2,
      arrayAt: 0x200,
      connections: [
        { direction: 1, offset: 4, destMapGroup: 0, destMapNum: 5 },
        { direction: 2, offset: -3, destMapGroup: 1, destMapNum: 8 },
      ],
    });
    const r = parseMapConnections(buf, 0x100);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.connections.connections).toHaveLength(2);
      expect(r.connections.connections[0]?.direction).toBe(1);
      expect(r.connections.connections[0]?.offset).toBe(4);
      expect(r.connections.connections[1]?.offset).toBe(-3);
    }
  });

  it('freezes returned connections', () => {
    const buf = plantConnections({ bufferSize: 1024, headerAt: 0x100, count: 0 });
    const r = parseMapConnections(buf, 0x100);
    if (r.ok) expect(Object.isFrozen(r.connections)).toBe(true);
  });
});

describe('parseMapConnections - failure modes', () => {
  it('fails too_short when fewer than 8 bytes available', () => {
    const r = parseMapConnections(new Uint8Array(5), 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('too_short');
  });

  it('fails implausible_count when count > MAX_CONNECTIONS_PER_MAP', () => {
    const buf = plantConnections({ bufferSize: 1024, headerAt: 0x100, count: 1000 });
    const r = parseMapConnections(buf, 0x100);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('implausible_count');
  });

  it('fails implausible_count when count < 0', () => {
    const buf = plantConnections({ bufferSize: 1024, headerAt: 0x100, count: -1 });
    const r = parseMapConnections(buf, 0x100);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('implausible_count');
  });

  it('fails invalid_connections_pointer when count > 0 + pointer not GBA ROM', () => {
    const buf = plantConnections({
      bufferSize: 1024,
      headerAt: 0x100,
      count: 1,
      bogusArrayPointer: 0x02000000,
    });
    const r = parseMapConnections(buf, 0x100);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('invalid_connections_pointer');
  });

  it('fails connections_array_truncated when array end exceeds buffer', () => {
    const buf = plantConnections({
      bufferSize: 1024,
      headerAt: 0x100,
      count: 64,
      arrayAt: 0x300,
    });
    // 64 * 12 = 768; 0x300 = 768; 768 + 768 > 1024 → truncated.
    const r = parseMapConnections(buf, 0x100);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('connections_array_truncated');
  });

  it('fails implausible_direction for direction 0 or > 15', () => {
    const buf = plantConnections({
      bufferSize: 1024,
      headerAt: 0x100,
      count: 1,
      arrayAt: 0x200,
      connections: [{ direction: 0, destMapGroup: 0, destMapNum: 0 }],
    });
    const r = parseMapConnections(buf, 0x100);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('implausible_direction');
  });
});

describe('parseMapConnections - offsets exposed for coverage', () => {
  it('reports headerStructOffset + connectionsArrayOffset', () => {
    const buf = plantConnections({
      bufferSize: 1024,
      headerAt: 0x100,
      count: 1,
      arrayAt: 0x250,
      connections: [{ direction: 1, destMapGroup: 0, destMapNum: 1 }],
    });
    const r = parseMapConnections(buf, 0x100);
    if (r.ok) {
      expect(r.connections.headerStructOffset).toBe(0x100);
      expect(r.connections.connectionsArrayOffset).toBe(0x250);
      expect(r.connections.connectionsArrayByteLength).toBe(MAP_CONNECTION_STRUCT_SIZE_BYTES);
    }
  });

  it('reports null connectionsArrayOffset for count=0', () => {
    const buf = plantConnections({ bufferSize: 1024, headerAt: 0x100, count: 0 });
    const r = parseMapConnections(buf, 0x100);
    if (r.ok) expect(r.connections.connectionsArrayOffset).toBeNull();
  });
});

describe('MAP_CONNECTIONS_HEADER_SIZE_BYTES', () => {
  it('equals 8', () => {
    expect(MAP_CONNECTIONS_HEADER_SIZE_BYTES).toBe(8);
  });
});
