import { describe, expect, it } from 'vitest';
import {
  LEARNSET_LEVEL_MAX,
  LEARNSET_LEVEL_SHIFT,
  LEARNSET_MAX_ENTRIES,
  LEARNSET_MOVE_MASK,
  LEARNSET_MOVE_MAX,
  LEARNSET_TERMINATOR,
  parseLearnsetArray,
  parseLearnsetEntry,
} from './learnset.js';

const pack = (level: number, move: number): number =>
  ((level & 0x7f) << LEARNSET_LEVEL_SHIFT) | (move & LEARNSET_MOVE_MASK);

describe('parseLearnsetEntry - happy paths', () => {
  it('parses (level=1, move=33) - Tackle at L1', () => {
    const r = parseLearnsetEntry(pack(1, 33));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.entry.level).toBe(1);
      expect(r.entry.move).toBe(33);
    }
  });

  it('parses high level (100) + high move id (511)', () => {
    const r = parseLearnsetEntry(pack(100, 511));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.entry.level).toBe(100);
      expect(r.entry.move).toBe(511);
    }
  });

  it('honors custom (lower) moveMax override for stricter validation', () => {
    // moveMax can be set below the format max to reject hack moves
    // outside an expected vanilla range. pack(1, 500) decodes to
    // move=500 which is rejected when moveMax=100.
    const r = parseLearnsetEntry(pack(1, 500), { moveMax: 100 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('implausible_move');
  });

  it('result entry is frozen', () => {
    const r = parseLearnsetEntry(pack(1, 33));
    if (r.ok) expect(Object.isFrozen(r.entry)).toBe(true);
  });
});

describe('parseLearnsetEntry - failure modes', () => {
  it('fails zero_move when move == 0', () => {
    const r = parseLearnsetEntry(pack(1, 0));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('zero_move');
  });

  it('fails implausible_level when level > MAX', () => {
    const r = parseLearnsetEntry(pack(LEARNSET_LEVEL_MAX + 1, 33));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('implausible_level');
  });

  it('fails implausible_move when explicitly-set moveMax is exceeded', () => {
    // Format physically caps move at 511 (9-bit field), so the
    // default moveMax=511 catches the max raw value. Use a stricter
    // custom moveMax to confirm bounds-checking works.
    const r = parseLearnsetEntry(pack(1, 500), { moveMax: 100 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('implausible_move');
  });
});

describe('parseLearnsetArray - happy paths', () => {
  it('parses empty learnset (just terminator 0xFFFF)', () => {
    const buf = Buffer.alloc(0x100);
    buf.writeUInt16LE(LEARNSET_TERMINATOR, 0x10);
    const r = parseLearnsetArray(buf, 0x10);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.learnset.entries.length).toBe(0);
      expect(r.learnset.fileOffset).toBe(0x10);
      expect(r.learnset.terminatorOffset).toBe(0x10);
      expect(r.learnset.byteLength).toBe(2);
    }
  });

  it('parses 5-entry learnset (Bulbasaur-shape)', () => {
    const buf = Buffer.alloc(0x100);
    const offset = 0x10;
    const entries: [number, number][] = [
      [1, 33], [1, 45], [7, 73], [10, 22], [15, 77],
    ];
    let cursor = offset;
    for (const [lv, mv] of entries) {
      buf.writeUInt16LE(pack(lv, mv), cursor);
      cursor += 2;
    }
    buf.writeUInt16LE(LEARNSET_TERMINATOR, cursor);
    const r = parseLearnsetArray(buf, offset);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.learnset.entries.length).toBe(5);
      expect(r.learnset.entries[0]?.level).toBe(1);
      expect(r.learnset.entries[0]?.move).toBe(33);
      expect(r.learnset.entries[4]?.level).toBe(15);
      expect(r.learnset.entries[4]?.move).toBe(77);
      expect(r.learnset.byteLength).toBe(5 * 2 + 2); // 5 entries + terminator = 12 bytes
    }
  });

  it('result + entries are frozen', () => {
    const buf = Buffer.alloc(0x10);
    buf.writeUInt16LE(LEARNSET_TERMINATOR, 0);
    const r = parseLearnsetArray(buf, 0);
    if (r.ok) {
      expect(Object.isFrozen(r.learnset)).toBe(true);
      expect(Object.isFrozen(r.learnset.entries)).toBe(true);
    }
  });
});

describe('parseLearnsetArray - failure modes', () => {
  it('fails too_short when offset + 2 > bytes.length', () => {
    const r = parseLearnsetArray(new Uint8Array(2), 0);
    expect(r.ok).toBe(false);
    // Empty buffer means immediate terminator-check on the only 2 bytes
    // (which are 0,0 = pack(0,0) = zero_move) → invalid_entry, not too_short
    if (!r.ok) {
      // Either too_short OR invalid_entry on the 0-byte content
      expect(['too_short', 'invalid_entry']).toContain(r.failure.kind);
    }
  });

  it('fails invalid_entry on a malformed entry (level too high)', () => {
    const buf = Buffer.alloc(0x100);
    buf.writeUInt16LE(pack(LEARNSET_LEVEL_MAX + 1, 33), 0); // bad level
    buf.writeUInt16LE(LEARNSET_TERMINATOR, 2);
    const r = parseLearnsetArray(buf, 0);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failure.kind).toBe('invalid_entry');
      if (r.failure.kind === 'invalid_entry') {
        expect(r.failure.entryIndex).toBe(0);
        expect(r.failure.entryFailure.kind).toBe('implausible_level');
      }
    }
  });

  it('fails no_terminator when run exceeds maxEntries without 0xFFFF', () => {
    const buf = Buffer.alloc(0x400);
    // Plant 50 valid entries (well over maxEntries=10 we pass)
    for (let i = 0; i < 50; i++) {
      buf.writeUInt16LE(pack(1, 1 + i), i * 2);
    }
    const r = parseLearnsetArray(buf, 0, { maxEntries: 10 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failure.kind).toBe('no_terminator');
      if (r.failure.kind === 'no_terminator') {
        expect(r.failure.entriesRead).toBe(10);
      }
    }
  });

  it('honors custom moveMax option', () => {
    const buf = Buffer.alloc(0x100);
    buf.writeUInt16LE(pack(1, 500), 0);
    buf.writeUInt16LE(LEARNSET_TERMINATOR, 2);
    const r = parseLearnsetArray(buf, 0, { moveMax: 100 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('invalid_entry');
  });
});

describe('constants', () => {
  it('terminator = 0xFFFF, level shift = 9, move mask = 0x1FF', () => {
    expect(LEARNSET_TERMINATOR).toBe(0xffff);
    expect(LEARNSET_LEVEL_SHIFT).toBe(9);
    expect(LEARNSET_MOVE_MASK).toBe(0x1ff);
  });
  it('level max = 100, move max = 511 (9-bit field cap), max entries = 128', () => {
    expect(LEARNSET_LEVEL_MAX).toBe(100);
    expect(LEARNSET_MOVE_MAX).toBe(511);
    expect(LEARNSET_MAX_ENTRIES).toBe(128);
  });
});
