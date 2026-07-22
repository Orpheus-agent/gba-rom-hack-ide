import { describe, expect, it } from 'vitest';
import {
  THUMB_BL_INSTRUCTION_SIZE_BYTES,
  tryDecodeThumbBL,
} from './thumb-disasm.js';

/**
 * Encode a Thumb-1 BL instruction at `instructionOffset` targeting
 * `targetOffset`. Writes 4 bytes (two halfwords) into `buf`.
 *
 * The BL target is relative to (instructionOffset + 4), per ARMv4T.
 */
function encodeThumbBL(buf: Buffer, instructionOffset: number, targetOffset: number): void {
  const off = targetOffset - (instructionOffset + 4);
  // ARMv4T BL encoding: hw1[10..0] = bits 22..12 of 23-bit signed
  // offset (bit 10 of hw1 = sign); hw2[10..0] = bits 11..1.
  const off23 = off & 0x7fffff; // low 23 bits include sign at bit 22
  const upper11 = (off23 >>> 12) & 0x7ff; // 11 bits (bit 10 = sign)
  const lower11 = (off23 >>> 1) & 0x7ff;
  const hw1 = 0xf000 | upper11;
  const hw2 = 0xf800 | lower11;
  buf.writeUInt16LE(hw1, instructionOffset);
  buf.writeUInt16LE(hw2, instructionOffset + 2);
}

describe('tryDecodeThumbBL - happy paths', () => {
  it('decodes a positive-offset BL', () => {
    const buf = Buffer.alloc(0x1000);
    encodeThumbBL(buf, 0x100, 0x200);
    const r = tryDecodeThumbBL(buf, 0x100);
    expect(r).not.toBeNull();
    if (r !== null) {
      expect(r.targetOffset).toBe(0x200);
      expect(r.instructionOffset).toBe(0x100);
      expect(r.instructionByteLength).toBe(4);
    }
  });

  it('decodes a negative-offset BL (target before BL)', () => {
    const buf = Buffer.alloc(0x1000);
    encodeThumbBL(buf, 0x200, 0x100);
    const r = tryDecodeThumbBL(buf, 0x200);
    expect(r).not.toBeNull();
    if (r !== null) expect(r.targetOffset).toBe(0x100);
  });

  it('decodes BL with a zero offset (target = BL + 4)', () => {
    const buf = Buffer.alloc(0x1000);
    encodeThumbBL(buf, 0x100, 0x104);
    const r = tryDecodeThumbBL(buf, 0x100);
    expect(r).not.toBeNull();
    if (r !== null) expect(r.targetOffset).toBe(0x104);
  });

  it('decodes a moderate-distance BL (a few KB away)', () => {
    const buf = Buffer.alloc(0x10000);
    encodeThumbBL(buf, 0x100, 0x5000);
    const r = tryDecodeThumbBL(buf, 0x100);
    expect(r).not.toBeNull();
    if (r !== null) expect(r.targetOffset).toBe(0x5000);
  });

  it('result is frozen', () => {
    const buf = Buffer.alloc(0x1000);
    encodeThumbBL(buf, 0x100, 0x200);
    const r = tryDecodeThumbBL(buf, 0x100);
    if (r !== null) expect(Object.isFrozen(r)).toBe(true);
  });
});

describe('tryDecodeThumbBL - rejection cases', () => {
  it('returns null when fewer than 4 bytes available', () => {
    expect(tryDecodeThumbBL(new Uint8Array(2), 0)).toBeNull();
    expect(tryDecodeThumbBL(new Uint8Array(10), 8)).toBeNull(); // only 2 bytes left
  });

  it('returns null when hw1 is not BL prefix (e.g. POP {pc})', () => {
    const buf = Buffer.alloc(8);
    buf.writeUInt16LE(0xbd00, 0); // POP {pc}
    buf.writeUInt16LE(0x0000, 2);
    expect(tryDecodeThumbBL(buf, 0)).toBeNull();
  });

  it('returns null when hw1 is BLX prefix but hw2 is BLX low form', () => {
    // BLX has hw2 top-5-bits = 0b11101 (0xE800), NOT 0b11111 (0xF800)
    const buf = Buffer.alloc(8);
    buf.writeUInt16LE(0xf000, 0); // hw1 BL/BLX prefix
    buf.writeUInt16LE(0xe800, 2); // hw2 BLX form - should be rejected
    expect(tryDecodeThumbBL(buf, 0)).toBeNull();
  });

  it('returns null when target falls outside buffer', () => {
    const buf = Buffer.alloc(0x100);
    // Encode BL at 0x10 targeting 0x500 (way past buffer end of 0x100).
    const off = 0x500 - (0x10 + 4);
    const off23 = off & 0x7fffff;
    const upper11 = (off23 >>> 12) & 0x7ff;
    const lower11 = (off23 >>> 1) & 0x7ff;
    buf.writeUInt16LE(0xf000 | upper11, 0x10);
    buf.writeUInt16LE(0xf800 | lower11, 0x12);
    expect(tryDecodeThumbBL(buf, 0x10)).toBeNull();
  });
});

describe('THUMB_BL_INSTRUCTION_SIZE_BYTES', () => {
  it('equals 4', () => {
    expect(THUMB_BL_INSTRUCTION_SIZE_BYTES).toBe(4);
  });
});
