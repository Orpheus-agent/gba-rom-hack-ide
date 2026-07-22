import { describe, expect, it } from 'vitest';
import {
  analyzeHandler,
  analyzeScriptHandlers,
  helperCallHistogram,
  inferOpcodeHelperProfiles,
} from './handler-analysis.js';

/** Encode a Thumb-1 BL at `instructionOffset` targeting `targetOffset`.
 *  Mirror of the encoder in thumb-disasm.test.ts. */
function encodeThumbBL(buf: Buffer, instructionOffset: number, targetOffset: number): void {
  const off = targetOffset - (instructionOffset + 4);
  const off23 = off & 0x7fffff;
  const upper11 = (off23 >>> 12) & 0x7ff;
  const lower11 = (off23 >>> 1) & 0x7ff;
  buf.writeUInt16LE(0xf000 | upper11, instructionOffset);
  buf.writeUInt16LE(0xf800 | lower11, instructionOffset + 2);
}

describe('analyzeHandler - happy paths', () => {
  it('stops at BX LR and collects 0 BL targets when none present', () => {
    const buf = Buffer.alloc(0x1000);
    buf.writeUInt16LE(0xb500, 0x100); // push {lr}
    buf.writeUInt16LE(0x4770, 0x102); // bx lr
    const r = analyzeHandler(buf, 0x100);
    expect(r.stoppedReason).toBe('function_return');
    expect(r.blTargets).toEqual([]);
    expect(r.bytesWalked).toBe(4);
  });

  it('stops at POP {pc} and collects 0 BL targets', () => {
    const buf = Buffer.alloc(0x1000);
    buf.writeUInt16LE(0xb500, 0x100); // push {lr}
    buf.writeUInt16LE(0xbd00, 0x102); // pop {pc}
    const r = analyzeHandler(buf, 0x100);
    expect(r.stoppedReason).toBe('function_return');
    expect(r.bytesWalked).toBe(4);
  });

  it('decodes a handler with 1 BL call then BX LR', () => {
    const buf = Buffer.alloc(0x1000);
    buf.writeUInt16LE(0xb500, 0x100); // push {lr}
    encodeThumbBL(buf, 0x102, 0x500); // bl 0x500
    buf.writeUInt16LE(0x4770, 0x106); // bx lr
    const r = analyzeHandler(buf, 0x100);
    expect(r.stoppedReason).toBe('function_return');
    expect(r.blTargets).toEqual([0x500]);
    expect(r.bytesWalked).toBe(8);
  });

  it('decodes a handler with 3 BL calls', () => {
    const buf = Buffer.alloc(0x1000);
    buf.writeUInt16LE(0xb500, 0x100);
    encodeThumbBL(buf, 0x102, 0x500);
    encodeThumbBL(buf, 0x106, 0x600);
    encodeThumbBL(buf, 0x10a, 0x500); // duplicate target
    buf.writeUInt16LE(0xbd00, 0x10e); // pop {pc}
    const r = analyzeHandler(buf, 0x100);
    expect(r.blTargets).toEqual([0x500, 0x600, 0x500]);
    expect(r.stoppedReason).toBe('function_return');
  });

  it('stops at maxInstructions when no return found', () => {
    const buf = Buffer.alloc(0x1000);
    // Plant 100 plain MOV instructions (0x46C0 = nop on Thumb)
    for (let i = 0; i < 100; i++) {
      buf.writeUInt16LE(0x46c0, 0x100 + i * 2);
    }
    const r = analyzeHandler(buf, 0x100, 16);
    expect(r.stoppedReason).toBe('max_instructions');
    expect(r.bytesWalked).toBe(32); // 16 × 2
    expect(r.blTargets).toEqual([]);
  });

  it('detects out_of_bounds when handler walks past buffer', () => {
    const buf = Buffer.alloc(8);
    // No return instruction; walk to end of buffer
    const r = analyzeHandler(buf, 0, 100);
    expect(r.stoppedReason).toBe('out_of_bounds');
  });

  it('result is frozen', () => {
    const buf = Buffer.alloc(0x100);
    buf.writeUInt16LE(0x4770, 0); // bx lr
    const r = analyzeHandler(buf, 0);
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r.blTargets)).toBe(true);
  });
});

describe('analyzeScriptHandlers - aggregation', () => {
  it('returns empty aggregation for zero handlers', () => {
    const buf = Buffer.alloc(0x100);
    const r = analyzeScriptHandlers(buf, []);
    expect(r.perHandler).toEqual([]);
    expect(r.commonHelperFunctions).toEqual([]);
  });

  it('aggregates BL-target frequencies across handlers', () => {
    const buf = Buffer.alloc(0x2000);
    const handlerOffsets: number[] = [];
    // Plant 5 handlers, each calling a shared helper at 0x1000 + their own helper
    for (let i = 0; i < 5; i++) {
      const at = 0x100 + i * 0x40;
      buf.writeUInt16LE(0xb500, at); // push {lr}
      encodeThumbBL(buf, at + 2, 0x1000); // bl shared helper
      encodeThumbBL(buf, at + 6, 0x1100 + i * 0x10); // bl unique helper
      buf.writeUInt16LE(0xbd00, at + 10); // pop {pc}
      handlerOffsets.push(at);
    }
    const r = analyzeScriptHandlers(buf, handlerOffsets);
    expect(r.perHandler).toHaveLength(5);
    // The shared helper should be top (callCount=5, callerCount=5)
    expect(r.commonHelperFunctions[0]?.offset).toBe(0x1000);
    expect(r.commonHelperFunctions[0]?.callCount).toBe(5);
    expect(r.commonHelperFunctions[0]?.callerCount).toBe(5);
    // Followed by 5 unique helpers each with callCount=1
    const uniqueHelpers = r.commonHelperFunctions.slice(1);
    expect(uniqueHelpers).toHaveLength(5);
    for (const h of uniqueHelpers) expect(h.callCount).toBe(1);
  });

  it('respects topN option', () => {
    const buf = Buffer.alloc(0x2000);
    const handlerOffsets: number[] = [];
    for (let i = 0; i < 8; i++) {
      const at = 0x100 + i * 0x40;
      buf.writeUInt16LE(0xb500, at);
      encodeThumbBL(buf, at + 2, 0x1000 + i * 0x10); // unique per handler
      buf.writeUInt16LE(0xbd00, at + 6);
      handlerOffsets.push(at);
    }
    const r = analyzeScriptHandlers(buf, handlerOffsets, { topN: 3 });
    expect(r.commonHelperFunctions).toHaveLength(3);
  });

  it('counts duplicate calls within the same handler', () => {
    const buf = Buffer.alloc(0x1000);
    buf.writeUInt16LE(0xb500, 0x100);
    encodeThumbBL(buf, 0x102, 0x500);
    encodeThumbBL(buf, 0x106, 0x500);
    encodeThumbBL(buf, 0x10a, 0x500);
    buf.writeUInt16LE(0xbd00, 0x10e);
    const r = analyzeScriptHandlers(buf, [0x100]);
    expect(r.commonHelperFunctions[0]?.callCount).toBe(3);
    expect(r.commonHelperFunctions[0]?.callerCount).toBe(1); // one handler
  });
});

describe('inferOpcodeHelperProfiles', () => {
  it('returns empty array for empty handlerOffsets', () => {
    const buf = Buffer.alloc(0x100);
    expect(inferOpcodeHelperProfiles(buf, [], [])).toEqual([]);
  });

  it('counts per-helper calls per opcode', () => {
    const buf = Buffer.alloc(0x2000);
    // 3 opcodes, each calling helpers at 0x1000 and 0x1100 different counts
    // opcode 0: 2 calls to 0x1000, 1 call to 0x1100
    buf.writeUInt16LE(0xb500, 0x100);
    encodeThumbBL(buf, 0x102, 0x1000);
    encodeThumbBL(buf, 0x106, 0x1100);
    encodeThumbBL(buf, 0x10a, 0x1000);
    buf.writeUInt16LE(0xbd00, 0x10e);
    // opcode 1: 0 helper calls (immediate bx lr)
    buf.writeUInt16LE(0x4770, 0x200);
    // opcode 2: 3 calls to 0x1000
    buf.writeUInt16LE(0xb500, 0x300);
    encodeThumbBL(buf, 0x302, 0x1000);
    encodeThumbBL(buf, 0x306, 0x1000);
    encodeThumbBL(buf, 0x30a, 0x1000);
    buf.writeUInt16LE(0xbd00, 0x30e);

    const profiles = inferOpcodeHelperProfiles(
      buf,
      [0x100, 0x200, 0x300],
      [0x1000, 0x1100],
    );
    expect(profiles).toHaveLength(3);
    expect(profiles[0]?.opcodeIndex).toBe(0);
    expect(profiles[0]?.totalHelperCalls).toBe(3);
    expect(profiles[0]?.perHelperCallCount[String(0x1000)]).toBe(2);
    expect(profiles[0]?.perHelperCallCount[String(0x1100)]).toBe(1);
    expect(profiles[1]?.totalHelperCalls).toBe(0);
    expect(profiles[1]?.perHelperCallCount).toEqual({});
    expect(profiles[2]?.totalHelperCalls).toBe(3);
    expect(profiles[2]?.perHelperCallCount[String(0x1000)]).toBe(3);
  });

  it('ignores BL targets not in topHelperOffsets', () => {
    const buf = Buffer.alloc(0x2000);
    buf.writeUInt16LE(0xb500, 0x100);
    encodeThumbBL(buf, 0x102, 0x1000); // counted (in top set)
    encodeThumbBL(buf, 0x106, 0x1200); // NOT counted (not in top set)
    buf.writeUInt16LE(0xbd00, 0x10a);

    const profiles = inferOpcodeHelperProfiles(buf, [0x100], [0x1000]);
    expect(profiles[0]?.totalHelperCalls).toBe(1);
    expect(profiles[0]?.perHelperCallCount[String(0x1000)]).toBe(1);
    expect(profiles[0]?.perHelperCallCount[String(0x1200)]).toBeUndefined();
  });

  it('result + per-profile objects are frozen', () => {
    const buf = Buffer.alloc(0x1000);
    buf.writeUInt16LE(0x4770, 0); // bx lr
    const profiles = inferOpcodeHelperProfiles(buf, [0], []);
    expect(Object.isFrozen(profiles)).toBe(true);
    expect(Object.isFrozen(profiles[0])).toBe(true);
    expect(Object.isFrozen(profiles[0]?.perHelperCallCount)).toBe(true);
  });
});

describe('helperCallHistogram', () => {
  it('returns empty for empty profiles', () => {
    expect(helperCallHistogram([])).toEqual({});
  });

  it('buckets opcodes by totalHelperCalls', () => {
    const profiles = [
      { opcodeIndex: 0, handlerOffset: 0, totalHelperCalls: 0, perHelperCallCount: {} },
      { opcodeIndex: 1, handlerOffset: 0, totalHelperCalls: 0, perHelperCallCount: {} },
      { opcodeIndex: 2, handlerOffset: 0, totalHelperCalls: 2, perHelperCallCount: {} },
      { opcodeIndex: 3, handlerOffset: 0, totalHelperCalls: 5, perHelperCallCount: {} },
      { opcodeIndex: 4, handlerOffset: 0, totalHelperCalls: 2, perHelperCallCount: {} },
    ];
    const h = helperCallHistogram(profiles);
    expect(h['0']).toBe(2);
    expect(h['2']).toBe(2);
    expect(h['5']).toBe(1);
  });

  it('histogram is frozen', () => {
    expect(Object.isFrozen(helperCallHistogram([]))).toBe(true);
  });
});
