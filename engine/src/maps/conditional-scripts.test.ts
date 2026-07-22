import { describe, expect, it } from 'vitest';
import { GBA_ROM_BASE_ADDRESS } from '../pointers/index.js';
import {
  MAP_SCRIPT_STUB_SIZE_BYTES,
  MAP_SCRIPT_STUB_TERMINATOR_SIZE_BYTES,
  parseConditionalScriptTable,
} from './conditional-scripts.js';

interface PlantArgs {
  bufferSize?: number;
  offset?: number;
  entries: ReadonlyArray<{ varCheck: number; valueCheck: number; scriptAt: number | null }>;
}

function plantTable(args: PlantArgs): { buf: Buffer; offset: number } {
  const offset = args.offset ?? 0x100;
  const buf = Buffer.alloc(args.bufferSize ?? 0x4000);
  let cursor = offset;
  for (const e of args.entries) {
    buf.writeUInt16LE(e.varCheck, cursor + 0x00);
    buf.writeUInt16LE(e.valueCheck, cursor + 0x02);
    const raw = e.scriptAt === null ? 0 : (GBA_ROM_BASE_ADDRESS + e.scriptAt) >>> 0;
    buf.writeUInt32LE(raw, cursor + 0x04);
    cursor += MAP_SCRIPT_STUB_SIZE_BYTES;
  }
  // 2-byte sentinel (varCheck = 0).
  buf.writeUInt16LE(0, cursor);
  return { buf, offset };
}

describe('parseConditionalScriptTable - happy paths', () => {
  it('parses an empty table (just the sentinel)', () => {
    const { buf, offset } = plantTable({ entries: [] });
    const r = parseConditionalScriptTable(buf, offset);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.table.entryCount).toBe(0);
      expect(r.table.tableFileOffset).toBe(offset);
      expect(r.table.tableEndExclusive).toBe(offset + MAP_SCRIPT_STUB_TERMINATOR_SIZE_BYTES);
      expect(r.table.entries).toEqual([]);
    }
  });

  it('parses a 3-entry table with varying gates', () => {
    const { buf, offset } = plantTable({
      entries: [
        { varCheck: 0x4000, valueCheck: 0, scriptAt: 0x800 },
        { varCheck: 0x4000, valueCheck: 1, scriptAt: 0x900 },
        { varCheck: 0x4010, valueCheck: 5, scriptAt: 0xa00 },
      ],
    });
    const r = parseConditionalScriptTable(buf, offset);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.table.entryCount).toBe(3);
      // 3 * 8 + 2 = 26 bytes
      expect(r.table.tableEndExclusive).toBe(offset + 26);
      expect(r.table.entries[0]?.varCheck).toBe(0x4000);
      expect(r.table.entries[0]?.valueCheck).toBe(0);
      expect(r.table.entries[0]?.scriptOffset).toBe(0x800);
      expect(r.table.entries[2]?.varCheck).toBe(0x4010);
      expect(r.table.entries[2]?.valueCheck).toBe(5);
    }
  });

  it('allows NULL script pointer', () => {
    const { buf, offset } = plantTable({
      entries: [
        { varCheck: 0x4001, valueCheck: 0, scriptAt: null },
        { varCheck: 0x4001, valueCheck: 1, scriptAt: 0x800 },
      ],
    });
    const r = parseConditionalScriptTable(buf, offset);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.table.entries[0]?.scriptOffset).toBeNull();
      expect(r.table.entries[0]?.rawScriptAddress).toBe(0);
      expect(r.table.entries[1]?.scriptOffset).toBe(0x800);
    }
  });

  it('result + entries are frozen', () => {
    const { buf, offset } = plantTable({
      entries: [{ varCheck: 0x4000, valueCheck: 0, scriptAt: 0x800 }],
    });
    const r = parseConditionalScriptTable(buf, offset);
    if (r.ok) {
      expect(Object.isFrozen(r.table)).toBe(true);
      expect(Object.isFrozen(r.table.entries)).toBe(true);
      expect(Object.isFrozen(r.table.entries[0])).toBe(true);
    }
  });
});

describe('parseConditionalScriptTable - failure modes', () => {
  it('fails too_short when buffer < 2 bytes available', () => {
    const r = parseConditionalScriptTable(new Uint8Array(1), 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('too_short');
  });

  it('fails too_short when entry overruns buffer mid-walk', () => {
    // Plant 1 entry + sentinel, but truncate buffer
    const buf = Buffer.alloc(6); // not enough for 1 entry (8 bytes)
    buf.writeUInt16LE(0x4000, 0); // varCheck non-zero → tries to read entry → too_short
    const r = parseConditionalScriptTable(buf, 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('too_short');
  });

  it('fails invalid_script_pointer for non-ROM pointer', () => {
    const buf = Buffer.alloc(0x100);
    buf.writeUInt16LE(0x4000, 0); // varCheck
    buf.writeUInt16LE(1, 2); // valueCheck
    buf.writeUInt32LE(0x02001234, 4); // EWRAM ptr
    const r = parseConditionalScriptTable(buf, 0);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failure.kind).toBe('invalid_script_pointer');
      if (r.failure.kind === 'invalid_script_pointer') {
        expect(r.failure.entryIndex).toBe(0);
      }
    }
  });

  it('fails too_short when no terminator within remaining buffer', () => {
    // Plant 2 entries, last one missing terminator → cursor reads varCheck
    // for a 3rd entry but only 1 byte remains
    const buf = Buffer.alloc(17); // 2 × 8 = 16 bytes of entries + 1 byte (not enough for sentinel)
    buf.writeUInt16LE(0x4000, 0);
    buf.writeUInt16LE(0, 2);
    buf.writeUInt32LE((GBA_ROM_BASE_ADDRESS + 0x4) >>> 0, 4);
    buf.writeUInt16LE(0x4001, 8);
    buf.writeUInt16LE(0, 10);
    buf.writeUInt32LE((GBA_ROM_BASE_ADDRESS + 0x4) >>> 0, 12);
    // byte 16 = uninitialized non-terminator; not enough for u16 read
    const r = parseConditionalScriptTable(buf, 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('too_short');
  });
});

describe('MAP_SCRIPT_STUB_SIZE_BYTES', () => {
  it('equals 8', () => {
    expect(MAP_SCRIPT_STUB_SIZE_BYTES).toBe(8);
  });
});

describe('MAP_SCRIPT_STUB_TERMINATOR_SIZE_BYTES', () => {
  it('equals 2', () => {
    expect(MAP_SCRIPT_STUB_TERMINATOR_SIZE_BYTES).toBe(2);
  });
});
