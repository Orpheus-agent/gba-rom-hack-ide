import { describe, expect, it } from 'vitest';
import {
  BPS_ACTION_SOURCE_COPY,
  BPS_ACTION_SOURCE_READ,
  BPS_ACTION_TARGET_COPY,
  BPS_ACTION_TARGET_READ,
  BPS_MAGIC,
  BPS_TRAILER_SIZE,
  BpsFormatError,
  applyBps,
  crc32,
  decodeBps,
  encodeBps,
  produceBpsActions,
  type BpsAction,
} from './bps.js';

// ─── CRC32 sanity ──────────────────────────────────────────────────

describe('crc32', () => {
  it('matches the canonical IEEE 802.3 test vector for "123456789"', () => {
    const bytes = new TextEncoder().encode('123456789');
    expect(crc32(bytes).toString(16)).toBe('cbf43926');
  });

  it('returns 0 for an empty buffer', () => {
    expect(crc32(new Uint8Array(0))).toBe(0);
  });

  it('returns a u32 (>= 0, fits in 32 bits) for arbitrary input', () => {
    const c = crc32(new Uint8Array([0xff, 0xff, 0xff, 0xff]));
    expect(c).toBeGreaterThanOrEqual(0);
    expect(c).toBeLessThanOrEqual(0xffffffff);
  });
});

// ─── End-to-end: produce → encode → decode → apply ─────────────────

describe('produceBpsActions → encodeBps → applyBps round trip', () => {
  it('handles identical source and target with a single source_read', () => {
    const source = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const target = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const actions = produceBpsActions(source, target);
    expect(actions.length).toBe(1);
    expect(actions[0]?.kind).toBe('source_read');
    if (actions[0]?.kind === 'source_read') {
      expect(actions[0].length).toBe(8);
    }
    const patch = encodeBps(actions, source, target);
    const recovered = applyBps(source, patch);
    expect(recovered).toEqual(target);
  });

  it('handles target larger than source (appended new bytes)', () => {
    const source = new Uint8Array([0x10, 0x20, 0x30]);
    const target = new Uint8Array([0x10, 0x20, 0x30, 0xaa, 0xbb, 0xcc, 0xdd]);
    const actions = produceBpsActions(source, target);
    expect(actions.length).toBe(2);
    expect(actions[0]?.kind).toBe('source_read');
    expect(actions[1]?.kind).toBe('target_read');
    const patch = encodeBps(actions, source, target);
    const recovered = applyBps(source, patch);
    expect(recovered).toEqual(target);
  });

  it('handles target smaller than source (truncated)', () => {
    const source = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const target = new Uint8Array([1, 2, 3, 4]);
    const actions = produceBpsActions(source, target);
    const patch = encodeBps(actions, source, target);
    const recovered = applyBps(source, patch);
    expect(recovered).toEqual(target);
  });

  it('handles interleaved differences', () => {
    const source = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const target = new Uint8Array([1, 2, 99, 4, 5, 88, 77, 8, 9, 66]);
    const actions = produceBpsActions(source, target);
    const patch = encodeBps(actions, source, target);
    const recovered = applyBps(source, patch);
    expect(recovered).toEqual(target);
  });

  it('handles entirely different bytes (one big target_read)', () => {
    const source = new Uint8Array([0xff, 0xff, 0xff, 0xff]);
    const target = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
    const actions = produceBpsActions(source, target);
    expect(actions.length).toBe(1);
    expect(actions[0]?.kind).toBe('target_read');
    const patch = encodeBps(actions, source, target);
    const recovered = applyBps(source, patch);
    expect(recovered).toEqual(target);
  });

  it('handles empty target (no actions)', () => {
    const source = new Uint8Array([1, 2, 3]);
    const target = new Uint8Array(0);
    const actions = produceBpsActions(source, target);
    expect(actions.length).toBe(0);
    const patch = encodeBps(actions, source, target);
    const recovered = applyBps(source, patch);
    expect(recovered).toEqual(target);
  });

  it('handles empty source (entire target is one target_read)', () => {
    const source = new Uint8Array(0);
    const target = new Uint8Array([1, 2, 3, 4, 5]);
    const actions = produceBpsActions(source, target);
    expect(actions.length).toBe(1);
    expect(actions[0]?.kind).toBe('target_read');
    const patch = encodeBps(actions, source, target);
    const recovered = applyBps(source, patch);
    expect(recovered).toEqual(target);
  });

  it('round trips a CFRU-shaped diff (first 9 MiB identical, then new code)', () => {
    // Mimic vanilla→CFRU: build a 16 KiB "vanilla" and a 32 KiB "modernized"
    // where the first half is byte-identical and the second half is new.
    const source = new Uint8Array(16 * 1024);
    for (let i = 0; i < source.length; i++) source[i] = (i * 7) & 0xff;
    const target = new Uint8Array(32 * 1024);
    target.set(source, 0);
    for (let i = source.length; i < target.length; i++) target[i] = (i * 13) & 0xff;

    const actions = produceBpsActions(source, target);
    // Best-case: exactly 2 actions - one source_read covering the shared
    // region, one target_read covering the new region.
    expect(actions.length).toBe(2);
    expect(actions[0]?.kind).toBe('source_read');
    expect(actions[1]?.kind).toBe('target_read');

    const patch = encodeBps(actions, source, target);
    // Patch overhead vs target should be tiny (just the new region + tiny header).
    expect(patch.length).toBeLessThan(target.length - source.length + 256);

    const recovered = applyBps(source, patch);
    expect(recovered).toEqual(target);
  });
});

// ─── Action-level encode/decode ────────────────────────────────────

describe('encodeBps / decodeBps', () => {
  it('encodes magic + sizes + empty actions + trailer for a minimal patch', () => {
    const source = new Uint8Array(0);
    const target = new Uint8Array(0);
    const patch = encodeBps([], source, target);
    // Magic(4) + sourceSize varint(1) + targetSize varint(1) + metadataSize varint(1) + trailer(12)
    expect(patch.length).toBe(4 + 1 + 1 + 1 + BPS_TRAILER_SIZE);
    for (let i = 0; i < BPS_MAGIC.length; i++) {
      expect(patch[i]).toBe(BPS_MAGIC[i]);
    }
  });

  it('decodes its own output (round trip with metadata)', () => {
    const source = new Uint8Array([1, 2, 3]);
    const target = new Uint8Array([1, 2, 3, 4]);
    const actions: BpsAction[] = [
      { kind: 'source_read', length: 3 },
      { kind: 'target_read', data: new Uint8Array([4]) },
    ];
    const patch = encodeBps(actions, source, target, 'hello world');
    const decoded = decodeBps(patch);
    expect(decoded.sourceSize).toBe(3);
    expect(decoded.targetSize).toBe(4);
    expect(decoded.metadata).toBe('hello world');
    expect(decoded.actions.length).toBe(2);
    expect(decoded.actions[0]?.kind).toBe('source_read');
    expect(decoded.actions[1]?.kind).toBe('target_read');
  });

  it('round trips a source_copy action', () => {
    // Source: 0x01 0x02 0x03 0x04
    // Target: 0x03 0x04 - a source_copy with delta +2 length 2
    const source = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
    const target = new Uint8Array([0x03, 0x04]);
    const actions: BpsAction[] = [
      { kind: 'source_copy', length: 2, sourceRelativeDelta: 2 },
    ];
    const patch = encodeBps(actions, source, target);
    const decoded = decodeBps(patch);
    expect(decoded.actions.length).toBe(1);
    if (decoded.actions[0]?.kind === 'source_copy') {
      expect(decoded.actions[0].length).toBe(2);
      expect(decoded.actions[0].sourceRelativeDelta).toBe(2);
    } else {
      throw new Error('expected source_copy');
    }
    const recovered = applyBps(source, patch);
    expect(recovered).toEqual(target);
  });

  it('round trips a target_copy action that overlaps (RLE-like)', () => {
    // Use target_copy with negative delta to repeat a byte.
    // Target: [0xAB, 0xAB, 0xAB, 0xAB] - target_read 1 byte then target_copy from
    // offset 0 length 3 (each copied byte may have just been written).
    const source = new Uint8Array(0);
    const target = new Uint8Array([0xab, 0xab, 0xab, 0xab]);
    const actions: BpsAction[] = [
      { kind: 'target_read', data: new Uint8Array([0xab]) },
      // After target_read of 1 byte, outputOffset=1, targetRelativeOffset=0
      // (initial). Delta of 0 keeps us at 0; copy 3 bytes from target[0..2]
      // (each freshly written byte is the byte 0xab).
      { kind: 'target_copy', length: 3, targetRelativeDelta: 0 },
    ];
    const patch = encodeBps(actions, source, target);
    const recovered = applyBps(source, patch);
    expect(recovered).toEqual(target);
  });

  it('round trips signed deltas of both signs', () => {
    const source = new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd]);
    const target = new Uint8Array([0xdd, 0xcc, 0xbb, 0xaa]);
    // Walk source backwards via source_copy with delta +3, then -2, then -2, then -2.
    const actions: BpsAction[] = [
      { kind: 'source_copy', length: 1, sourceRelativeDelta: 3 }, // src[3]=0xdd
      { kind: 'source_copy', length: 1, sourceRelativeDelta: -2 }, // src[2]=0xcc
      { kind: 'source_copy', length: 1, sourceRelativeDelta: -2 }, // src[1]=0xbb
      { kind: 'source_copy', length: 1, sourceRelativeDelta: -2 }, // src[0]=0xaa
    ];
    const patch = encodeBps(actions, source, target);
    const decoded = decodeBps(patch);
    expect(decoded.actions.length).toBe(4);
    for (let i = 0; i < 4; i++) {
      const a = decoded.actions[i];
      if (a?.kind === 'source_copy') {
        expect(a.sourceRelativeDelta).toBe(i === 0 ? 3 : -2);
      } else {
        throw new Error(`expected source_copy at index ${String(i)}`);
      }
    }
    const recovered = applyBps(source, patch);
    expect(recovered).toEqual(target);
  });
});

// ─── Error paths ───────────────────────────────────────────────────

describe('decodeBps errors', () => {
  it('rejects a patch missing the BPS1 magic', () => {
    const fake = new Uint8Array(16);
    fake[0] = 0x42; // 'B'
    fake[1] = 0x50; // 'P'
    fake[2] = 0x53; // 'S'
    fake[3] = 0x32; // '2' - wrong
    expect(() => decodeBps(fake)).toThrow(BpsFormatError);
  });

  it('rejects a patch too short for even magic + trailer', () => {
    expect(() => decodeBps(new Uint8Array(8))).toThrow(BpsFormatError);
  });

  it('rejects a patch with truncated action stream', () => {
    const source = new Uint8Array([1, 2, 3]);
    const target = new Uint8Array([1, 2, 3, 4]);
    const actions: BpsAction[] = [
      { kind: 'source_read', length: 3 },
      { kind: 'target_read', data: new Uint8Array([4]) },
    ];
    const patch = encodeBps(actions, source, target);
    // Slice off the trailing varint byte of the last action (one byte before
    // the trailer) - leaves a truncated action header.
    const broken = new Uint8Array(patch.length - 1);
    broken.set(patch.subarray(0, patch.length - BPS_TRAILER_SIZE - 1), 0);
    broken.set(patch.subarray(patch.length - BPS_TRAILER_SIZE), patch.length - BPS_TRAILER_SIZE - 1);
    expect(() => decodeBps(broken)).toThrow(BpsFormatError);
  });
});

describe('applyBps errors', () => {
  it('rejects when source size disagrees with patch metadata', () => {
    const source = new Uint8Array([1, 2, 3]);
    const target = new Uint8Array([1, 2, 3, 4]);
    const patch = encodeBps(
      [
        { kind: 'source_read', length: 3 },
        { kind: 'target_read', data: new Uint8Array([4]) },
      ],
      source,
      target,
    );
    const wrongSource = new Uint8Array([1, 2, 3, 4]); // length differs
    expect(() => applyBps(wrongSource, patch)).toThrow(BpsFormatError);
  });

  it('rejects when source CRC disagrees', () => {
    const source = new Uint8Array([1, 2, 3]);
    const target = new Uint8Array([1, 2, 3, 4]);
    const patch = encodeBps(
      [
        { kind: 'source_read', length: 3 },
        { kind: 'target_read', data: new Uint8Array([4]) },
      ],
      source,
      target,
    );
    const tamperedSource = new Uint8Array([9, 2, 3]); // same length, different bytes
    expect(() => applyBps(tamperedSource, patch)).toThrow(BpsFormatError);
  });

  it('rejects when patch CRC is corrupted', () => {
    const source = new Uint8Array([1, 2, 3]);
    const target = new Uint8Array([1, 2, 3, 4]);
    const patch = encodeBps(
      [
        { kind: 'source_read', length: 3 },
        { kind: 'target_read', data: new Uint8Array([4]) },
      ],
      source,
      target,
    );
    const corrupted = new Uint8Array(patch);
    corrupted[corrupted.length - 1] ^= 0xff; // flip last byte of patch CRC
    expect(() => applyBps(source, corrupted)).toThrow(BpsFormatError);
  });
});

describe('encodeBps validation', () => {
  it('rejects an empty target_read action', () => {
    expect(() =>
      encodeBps(
        [{ kind: 'target_read', data: new Uint8Array(0) }],
        new Uint8Array(0),
        new Uint8Array(0),
      ),
    ).toThrow(BpsFormatError);
  });

  it('rejects a zero-length source_read action', () => {
    expect(() =>
      encodeBps(
        [{ kind: 'source_read', length: 0 }],
        new Uint8Array(1),
        new Uint8Array(1),
      ),
    ).toThrow(BpsFormatError);
  });
});

// ─── Constants smoke ───────────────────────────────────────────────

describe('exported constants', () => {
  it('BPS_MAGIC encodes "BPS1"', () => {
    expect(new TextDecoder().decode(BPS_MAGIC)).toBe('BPS1');
  });

  it('action kind constants are 0..3', () => {
    expect(BPS_ACTION_SOURCE_READ).toBe(0);
    expect(BPS_ACTION_TARGET_READ).toBe(1);
    expect(BPS_ACTION_SOURCE_COPY).toBe(2);
    expect(BPS_ACTION_TARGET_COPY).toBe(3);
  });
});
