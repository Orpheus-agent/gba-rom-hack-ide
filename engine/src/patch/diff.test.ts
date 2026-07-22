import { describe, expect, it } from 'vitest';
import { IpsFormatError, applyIps, encodeIps, decodeIps } from './ips.js';
import { produceIpsRecords } from './diff.js';

describe('produceIpsRecords - happy paths', () => {
  it('emits empty record list when original === modified', () => {
    const buf = new Uint8Array([1, 2, 3, 4, 5]);
    const records = produceIpsRecords(buf, buf);
    expect(records.length).toBe(0);
  });

  it('emits a single literal record for a short differing run', () => {
    const original = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0]);
    const modified = new Uint8Array([0, 0, 0xaa, 0xbb, 0xcc, 0, 0, 0]);
    const records = produceIpsRecords(original, modified);
    expect(records.length).toBe(1);
    if (records[0]?.kind === 'literal') {
      expect(records[0].offset).toBe(2);
      expect(records[0].data).toEqual(new Uint8Array([0xaa, 0xbb, 0xcc]));
    }
  });

  it('emits an RLE record for a long run of the same byte', () => {
    const original = new Uint8Array(32);
    const modified = new Uint8Array(32);
    for (let i = 4; i < 20; i++) modified[i] = 0xff;
    const records = produceIpsRecords(modified, modified); // identity = 0
    expect(records.length).toBe(0);
    const records2 = produceIpsRecords(original, modified);
    expect(records2.length).toBe(1);
    if (records2[0]?.kind === 'rle') {
      expect(records2[0].offset).toBe(4);
      expect(records2[0].rleLength).toBe(16);
      expect(records2[0].byte).toBe(0xff);
    }
  });

  it('emits multiple records for non-adjacent diffs', () => {
    const original = new Uint8Array(100);
    const modified = new Uint8Array(100);
    modified[10] = 0xaa;
    modified[11] = 0xab;
    modified[50] = 0xcc;
    const records = produceIpsRecords(original, modified);
    expect(records.length).toBe(2);
    expect(records[0]?.offset).toBe(10);
    expect(records[1]?.offset).toBe(50);
  });

  it('full diff → encode → decode → apply roundtrip', () => {
    const original = new Uint8Array(256);
    for (let i = 0; i < 256; i++) original[i] = i;
    const modified = new Uint8Array(original);
    modified[5] = 0xff;
    modified[6] = 0xfe;
    modified[7] = 0xfd;
    // RLE-worthy: 16 consecutive 0x77 bytes
    for (let i = 100; i < 116; i++) modified[i] = 0x77;
    modified[200] = 0xee;
    const records = produceIpsRecords(original, modified);
    const ips = encodeIps(records);
    const decoded = decodeIps(ips);
    const restored = applyIps(original, decoded);
    expect(restored).toEqual(modified);
  });
});

describe('produceIpsRecords - failure modes', () => {
  it('throws when modified shrinks below original (IPS has no erase record)', () => {
    expect(() =>
      produceIpsRecords(new Uint8Array(10), new Uint8Array(5)),
    ).toThrow(IpsFormatError);
  });
});

describe('produceIpsRecords - growing patches (modified > original)', () => {
  it('treats trailing bytes of modified beyond original as diff records', () => {
    const original = new Uint8Array([1, 2, 3, 4]);
    const modified = new Uint8Array([1, 2, 3, 4, 0xaa, 0xbb, 0xcc]);
    const records = produceIpsRecords(original, modified);
    expect(records.length).toBe(1);
    if (records[0]?.kind === 'literal') {
      expect(records[0].offset).toBe(4);
      expect(records[0].data).toEqual(new Uint8Array([0xaa, 0xbb, 0xcc]));
    }
  });

  it('roundtrip - growing patch encode → decode → apply restores modified exactly', () => {
    const original = new Uint8Array([1, 2, 3, 4]);
    const modified = new Uint8Array([1, 2, 3, 4, 0xaa, 0xbb, 0xcc, 0xdd]);
    const records = produceIpsRecords(original, modified);
    const encoded = encodeIps(records);
    const decoded = decodeIps(encoded);
    const restored = applyIps(original, decoded);
    expect(Array.from(restored)).toEqual(Array.from(modified));
  });

  it('combines middle-of-buffer diff with trailing growth into 2 records', () => {
    const original = new Uint8Array(16);
    const modified = new Uint8Array(20);
    modified[5] = 0xaa;
    modified[16] = 0xbb;
    modified[17] = 0xcc;
    modified[18] = 0xdd;
    modified[19] = 0xee;
    const records = produceIpsRecords(original, modified);
    // record 1: literal @ offset 5, [0xaa]
    // record 2: literal @ offset 16, [0xbb, 0xcc, 0xdd, 0xee] (the trailing growth)
    expect(records.length).toBe(2);
    expect(records[0]?.offset).toBe(5);
    expect(records[1]?.offset).toBe(16);

    // Roundtrip
    const encoded = encodeIps(records);
    const decoded = decodeIps(encoded);
    const restored = applyIps(original, decoded);
    expect(restored.length).toBe(20);
    expect(Array.from(restored)).toEqual(Array.from(modified));
  });

  it('equal-length still works (regression - no behavior change for equal lengths)', () => {
    const original = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0]);
    const modified = new Uint8Array([0, 0, 0xaa, 0xbb, 0xcc, 0, 0, 0]);
    const records = produceIpsRecords(original, modified);
    expect(records.length).toBe(1);
  });
});

describe('produceIpsRecords - RLE threshold', () => {
  it('emits literal for short runs (below threshold)', () => {
    const original = new Uint8Array(16);
    const modified = new Uint8Array(16);
    // 3 bytes of 0xab - below default rleThreshold=8 → emit as literal
    modified[2] = 0xab;
    modified[3] = 0xab;
    modified[4] = 0xab;
    const records = produceIpsRecords(original, modified);
    expect(records.length).toBe(1);
    expect(records[0]?.kind).toBe('literal');
  });

  it('honors custom rleThreshold', () => {
    const original = new Uint8Array(16);
    const modified = new Uint8Array(16);
    // 4 bytes of 0xab - above custom rleThreshold=4 → emit as RLE
    modified[2] = 0xab;
    modified[3] = 0xab;
    modified[4] = 0xab;
    modified[5] = 0xab;
    const records = produceIpsRecords(original, modified, { rleThreshold: 4 });
    expect(records.length).toBe(1);
    expect(records[0]?.kind).toBe('rle');
  });
});
