import { describe, it, expect } from 'vitest';
import { parseMapConnections } from './connections.js';
import {
  encodeMapConnection,
  encodeMapConnectionsArray,
  encodeMapConnectionsHeader,
  MapConnectionEncodeError,
} from './connections-writer.js';

describe('encodeMapConnection', () => {
  it('encodes a single 12-byte struct', () => {
    const bytes = encodeMapConnection({
      direction: 1, // DOWN
      offset: 7,
      destMapGroup: 3,
      destMapNum: 12,
    });
    expect(bytes.length).toBe(12);
    // direction byte at 0x00, offset 7 at 0x04 (LE), group 3 + num 12 at 0x08/0x09
    expect(bytes[0x00]).toBe(0x01);
    expect(bytes[0x04]).toBe(0x07);
    expect(bytes[0x08]).toBe(0x03);
    expect(bytes[0x09]).toBe(0x0c);
  });

  it('encodes a negative offset as s32 LE', () => {
    const bytes = encodeMapConnection({
      direction: 2,
      offset: -1,
      destMapGroup: 0,
      destMapNum: 0,
    });
    // -1 as s32 LE = FF FF FF FF
    expect(bytes[0x04]).toBe(0xff);
    expect(bytes[0x05]).toBe(0xff);
    expect(bytes[0x06]).toBe(0xff);
    expect(bytes[0x07]).toBe(0xff);
  });

  it('rejects invalid direction', () => {
    expect(() =>
      encodeMapConnection({ direction: 0, offset: 0, destMapGroup: 0, destMapNum: 0 }),
    ).toThrow(MapConnectionEncodeError);
    expect(() =>
      encodeMapConnection({ direction: 16, offset: 0, destMapGroup: 0, destMapNum: 0 }),
    ).toThrow(MapConnectionEncodeError);
  });
});

describe('encodeMapConnectionsArray + Header', () => {
  it('round-trips the parser end-to-end', () => {
    const connections = [
      { direction: 1, offset: 0, destMapGroup: 3, destMapNum: 4 },
      { direction: 2, offset: -5, destMapGroup: 3, destMapNum: 5 },
    ] as const;
    const array = encodeMapConnectionsArray(connections);
    expect(array.length).toBe(24);
    // Place the array somewhere in a fake ROM, point the header at it.
    const buf = new Uint8Array(0x200000);
    const arrayOffset = 0x100100;
    buf.set(array, arrayOffset);
    const header = encodeMapConnectionsHeader(connections.length, arrayOffset);
    expect(header.length).toBe(8);
    const headerOffset = 0x100000;
    buf.set(header, headerOffset);
    const parsed = parseMapConnections(buf, headerOffset);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.connections.count).toBe(2);
      expect(parsed.connections.connections[0]!.direction).toBe(1);
      expect(parsed.connections.connections[0]!.offset).toBe(0);
      expect(parsed.connections.connections[1]!.offset).toBe(-5);
      expect(parsed.connections.connections[1]!.destMapGroup).toBe(3);
      expect(parsed.connections.connections[1]!.destMapNum).toBe(5);
    }
  });

  it('encodes the empty case (count=0, NULL ptr)', () => {
    const header = encodeMapConnectionsHeader(0, null);
    expect(Array.from(header)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('rejects count > 0 with null arrayFileOffset', () => {
    expect(() => encodeMapConnectionsHeader(2, null)).toThrow(/array must have a real ROM home/);
  });
});
