import { describe, expect, it } from 'vitest';
import { GBA_ROM_BASE_ADDRESS } from '../pointers/index.js';
import {
  MAP_SCRIPT_ENTRY_SIZE_BYTES,
  MAP_SCRIPT_TERMINATOR,
  MAP_SCRIPT_TYPE_MAX,
  parseMapScripts,
} from './scripts.js';

interface PlantEntriesArgs {
  bufferSize?: number;
  offset?: number;
  /** Each entry: { type, scriptAt }. scriptAt = null encodes NULL pointer. */
  entries: ReadonlyArray<{ type: number; scriptAt: number | null }>;
  /** Optional override of the terminator byte. Default 0. */
  terminator?: number;
}

function plantTable(args: PlantEntriesArgs): { buf: Buffer; offset: number } {
  const offset = args.offset ?? 0x100;
  const buf = Buffer.alloc(args.bufferSize ?? 0x4000);
  let cursor = offset;
  for (const e of args.entries) {
    buf[cursor] = e.type;
    const raw = e.scriptAt === null ? 0 : (GBA_ROM_BASE_ADDRESS + e.scriptAt) >>> 0;
    buf.writeUInt32LE(raw, cursor + 1);
    cursor += MAP_SCRIPT_ENTRY_SIZE_BYTES;
  }
  buf[cursor] = args.terminator ?? MAP_SCRIPT_TERMINATOR;
  return { buf, offset };
}

describe('parseMapScripts - happy paths', () => {
  it('parses an empty table (sentinel only)', () => {
    const { buf, offset } = plantTable({ entries: [] });
    const r = parseMapScripts(buf, offset);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.scripts.entryCount).toBe(0);
      expect(r.scripts.tableFileOffset).toBe(offset);
      // table extent = 1 byte (just the terminator)
      expect(r.scripts.tableEndExclusive).toBe(offset + 1);
    }
  });

  it('parses a 3-entry table (each type 1, 3, 5 with valid script ptrs)', () => {
    const { buf, offset } = plantTable({
      entries: [
        { type: 1, scriptAt: 0x800 },
        { type: 3, scriptAt: 0x900 },
        { type: 5, scriptAt: 0xa00 },
      ],
    });
    const r = parseMapScripts(buf, offset);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.scripts.entryCount).toBe(3);
      // 3 * 5 + 1 = 16 bytes total
      expect(r.scripts.tableEndExclusive).toBe(offset + 16);
      expect(r.scripts.entries[0]?.type).toBe(1);
      expect(r.scripts.entries[0]?.typeName).toBe('ON_LOAD');
      expect(r.scripts.entries[0]?.scriptOffset).toBe(0x800);
      expect(r.scripts.entries[1]?.typeName).toBe('ON_TRANSITION');
      expect(r.scripts.entries[2]?.typeName).toBe('ON_RESUME');
    }
  });

  it('allows NULL script pointer (placeholder entry)', () => {
    const { buf, offset } = plantTable({
      entries: [
        { type: 1, scriptAt: null },
        { type: 5, scriptAt: 0xa00 },
      ],
    });
    const r = parseMapScripts(buf, offset);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.scripts.entryCount).toBe(2);
      expect(r.scripts.entries[0]?.scriptOffset).toBeNull();
      expect(r.scripts.entries[0]?.rawScriptAddress).toBe(0);
      expect(r.scripts.entries[1]?.scriptOffset).toBe(0xa00);
    }
  });

  it('returns frozen result + entries', () => {
    const { buf, offset } = plantTable({
      entries: [{ type: 1, scriptAt: 0x800 }],
    });
    const r = parseMapScripts(buf, offset);
    if (r.ok) {
      expect(Object.isFrozen(r.scripts)).toBe(true);
      expect(Object.isFrozen(r.scripts.entries)).toBe(true);
      expect(Object.isFrozen(r.scripts.entries[0])).toBe(true);
    }
  });
});

describe('parseMapScripts - failure modes', () => {
  it('fails too_short when offset >= buffer length', () => {
    const r = parseMapScripts(new Uint8Array(10), 10);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('too_short');
  });

  it('fails implausible_type when type > MAX', () => {
    const buf = Buffer.alloc(0x100);
    buf[0x10] = MAP_SCRIPT_TYPE_MAX + 1;
    buf.writeUInt32LE((GBA_ROM_BASE_ADDRESS + 0x40) >>> 0, 0x11);
    const r = parseMapScripts(buf, 0x10);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failure.kind).toBe('implausible_type');
    }
  });

  it('fails invalid_script_pointer when pointer is non-ROM (EWRAM)', () => {
    const buf = Buffer.alloc(0x100);
    buf[0x10] = 1; // type ON_LOAD
    buf.writeUInt32LE(0x02000000, 0x11); // EWRAM ptr
    const r = parseMapScripts(buf, 0x10);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('invalid_script_pointer');
  });

  it('fails too_short mid-entry (last entry truncated)', () => {
    // Plant type byte but no room for the 4-byte pointer
    const buf = Buffer.alloc(0x11);
    buf[0x0c] = 1; // type byte at position 12; needs bytes 13-16 → only 13-16 = 4 bytes; bufsize=17
    // Actually let's be more careful: bufsize=17, entry at 12 needs 5 bytes (12..17), terminator at 17
    // Make it shorter: bufsize=16, entry at 12 needs bytes 12,13,14,15,16 - 16 OOB.
    const buf2 = Buffer.alloc(15);
    buf2[10] = 1;
    const r = parseMapScripts(buf2, 10);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('too_short');
  });

  it('fails too_short when no terminator within available buffer', () => {
    // Plant 1 entry but no terminator follows.
    const buf = Buffer.alloc(6); // 1 type byte + 4 ptr + 1 byte
    buf[0] = 1;
    buf.writeUInt32LE((GBA_ROM_BASE_ADDRESS + 0x4) >>> 0, 1);
    buf[5] = 1; // not terminator
    // Cursor will be at 5, need to read another entry - only 1 byte avail
    // (buf[5]=1) → reads type=1, then needs 4 more bytes which would
    // overflow → too_short
    const r = parseMapScripts(buf, 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('too_short');
  });
});

describe('MAP_SCRIPT_ENTRY_SIZE_BYTES', () => {
  it('equals 5', () => {
    expect(MAP_SCRIPT_ENTRY_SIZE_BYTES).toBe(5);
  });
});
