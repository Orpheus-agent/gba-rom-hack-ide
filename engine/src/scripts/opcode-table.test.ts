import { describe, expect, it } from 'vitest';
import { GBA_ROM_BASE_ADDRESS } from '../pointers/index.js';
import {
  SCRIPT_OPCODE_TABLE_ENTRY_SIZE_BYTES,
  SCRIPT_OPCODE_TABLE_MIN_ENTRIES,
  scanScriptOpcodeTable,
} from './opcode-table.js';

/** Plant a Thumb push prologue (0xB5 0x00 = `push {lr}`) at `at`. */
function plantThumbPrologue(buf: Buffer, at: number, opts?: { highByte?: number }): void {
  buf[at + 0] = 0x00;
  buf[at + 1] = opts?.highByte ?? 0xb5;
}

/** Plant an opcode table with N entries, each pointing to a planted
 *  Thumb prologue handler. */
function plantOpcodeTable(args: {
  bufferSize?: number;
  tableAt: number;
  numOpcodes: number;
  handlersBase?: number;
  handlerStride?: number;
  /** Per-opcode override for the high byte of the Thumb prologue (default 0xB5). */
  prologueHighBytes?: ReadonlyArray<number>;
  /** Whether to set the Thumb bit (low bit) on each pointer. Default false. */
  thumbTag?: boolean;
}): { buf: Buffer; tableEnd: number } {
  const buf = Buffer.alloc(args.bufferSize ?? 0x10000);
  const handlersBase = args.handlersBase ?? 0x4000;
  const stride = args.handlerStride ?? 0x40;
  for (let i = 0; i < args.numOpcodes; i++) {
    const handlerAt = handlersBase + i * stride;
    plantThumbPrologue(buf, handlerAt, {
      highByte: args.prologueHighBytes?.[i] ?? 0xb5,
    });
    let raw = (GBA_ROM_BASE_ADDRESS + handlerAt) >>> 0;
    if (args.thumbTag) raw |= 1;
    buf.writeUInt32LE(raw, args.tableAt + i * SCRIPT_OPCODE_TABLE_ENTRY_SIZE_BYTES);
  }
  return { buf, tableEnd: args.tableAt + args.numOpcodes * SCRIPT_OPCODE_TABLE_ENTRY_SIZE_BYTES };
}

describe('scanScriptOpcodeTable - happy paths', () => {
  it('finds a 64-entry opcode table (default min)', () => {
    const { buf, tableEnd } = plantOpcodeTable({ tableAt: 0x800, numOpcodes: 64 });
    const r = scanScriptOpcodeTable(buf);
    expect(r).not.toBeNull();
    if (r !== null) {
      expect(r.tableStart).toBe(0x800);
      expect(r.tableEndExclusive).toBe(tableEnd);
      expect(r.opcodeCount).toBe(64);
      expect(r.handlerOffsets).toHaveLength(64);
      expect(r.anyThumbTaggedPointer).toBe(false);
    }
  });

  it('finds a 100-entry opcode table', () => {
    const { buf } = plantOpcodeTable({ tableAt: 0x500, numOpcodes: 100 });
    const r = scanScriptOpcodeTable(buf);
    expect(r).not.toBeNull();
    if (r !== null) expect(r.opcodeCount).toBe(100);
  });

  it('detects thumb-tagged pointers', () => {
    const { buf } = plantOpcodeTable({
      tableAt: 0x500,
      numOpcodes: 64,
      thumbTag: true,
    });
    const r = scanScriptOpcodeTable(buf);
    expect(r).not.toBeNull();
    if (r !== null) {
      expect(r.anyThumbTaggedPointer).toBe(true);
      // handlerOffsets should be CLEAN (Thumb bit stripped) for downstream use
      for (const off of r.handlerOffsets) {
        expect(off & 1).toBe(0);
      }
    }
  });

  it('accepts 0xB4 prologue (push without lr) in addition to 0xB5', () => {
    const buf = Buffer.alloc(0x10000);
    const tableAt = 0x800;
    const handlersBase = 0x4000;
    for (let i = 0; i < 64; i++) {
      const handlerAt = handlersBase + i * 0x40;
      // Alternate 0xB4 / 0xB5 prologue high bytes
      buf[handlerAt + 0] = 0x00;
      buf[handlerAt + 1] = i % 2 === 0 ? 0xb5 : 0xb4;
      buf.writeUInt32LE((GBA_ROM_BASE_ADDRESS + handlerAt) >>> 0, tableAt + i * 4);
    }
    const r = scanScriptOpcodeTable(buf);
    expect(r).not.toBeNull();
    if (r !== null) expect(r.opcodeCount).toBe(64);
  });

  it('result + handlerOffsets are frozen', () => {
    const { buf } = plantOpcodeTable({ tableAt: 0x500, numOpcodes: 64 });
    const r = scanScriptOpcodeTable(buf);
    if (r !== null) {
      expect(Object.isFrozen(r)).toBe(true);
      expect(Object.isFrozen(r.handlerOffsets)).toBe(true);
    }
  });
});

describe('scanScriptOpcodeTable - rejection cases', () => {
  it('returns null when fewer than minOpcodesInTable valid entries', () => {
    // Plant only 32 entries (default min 64)
    const { buf } = plantOpcodeTable({ tableAt: 0x500, numOpcodes: 32 });
    expect(scanScriptOpcodeTable(buf)).toBeNull();
  });

  it('returns null for an all-zero buffer', () => {
    expect(scanScriptOpcodeTable(new Uint8Array(0x10000))).toBeNull();
  });

  it('returns null when target bytes are not Thumb prologue', () => {
    const buf = Buffer.alloc(0x10000);
    const tableAt = 0x500;
    for (let i = 0; i < 64; i++) {
      const handlerAt = 0x4000 + i * 0x40;
      // Plant 0xAA 0xAA at handler (NOT a push instruction)
      buf[handlerAt] = 0xaa;
      buf[handlerAt + 1] = 0xaa;
      buf.writeUInt32LE((GBA_ROM_BASE_ADDRESS + handlerAt) >>> 0, tableAt + i * 4);
    }
    expect(scanScriptOpcodeTable(buf)).toBeNull();
  });

  it('honors minOpcodesInTable=32 option', () => {
    const { buf } = plantOpcodeTable({ tableAt: 0x500, numOpcodes: 32 });
    const r = scanScriptOpcodeTable(buf, { minOpcodesInTable: 32 });
    expect(r).not.toBeNull();
    if (r !== null) expect(r.opcodeCount).toBe(32);
  });

  it('throws on invalid minOpcodesInTable=0', () => {
    expect(() =>
      scanScriptOpcodeTable(new Uint8Array(0x10000), { minOpcodesInTable: 0 }),
    ).toThrow();
  });

  it('throws when maxOpcodesInTable < minOpcodesInTable', () => {
    expect(() =>
      scanScriptOpcodeTable(new Uint8Array(0x10000), {
        minOpcodesInTable: 64,
        maxOpcodesInTable: 32,
      }),
    ).toThrow();
  });
});

describe('SCRIPT_OPCODE_TABLE_MIN_ENTRIES', () => {
  it('equals 64', () => {
    expect(SCRIPT_OPCODE_TABLE_MIN_ENTRIES).toBe(64);
  });
});
