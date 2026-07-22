import { describe, expect, it } from 'vitest';
import type { OpcodeHelperProfile } from './handler-analysis.js';
import { walkScriptBytecode } from './bytecode-walker.js';

function profile(opcodeIndex: number, totalHelperCalls: number): OpcodeHelperProfile {
  return Object.freeze({
    opcodeIndex,
    handlerOffset: 0x1000 + opcodeIndex * 0x40,
    totalHelperCalls,
    perHelperCallCount: Object.freeze({}),
  });
}

/** Build profiles array where opcode i has totalHelperCalls=argcounts[i]. */
function buildProfiles(argcounts: ReadonlyArray<number>): ReadonlyArray<OpcodeHelperProfile> {
  return argcounts.map((n, i) => profile(i, n));
}

describe('walkScriptBytecode - happy paths', () => {
  it('walks a single 0-arg opcode then stops at invalid', () => {
    const buf = Buffer.from([0x00, 0xff]); // opcode 0 (0 args), then byte 0xff (invalid)
    const profiles = buildProfiles([0, 1]); // only opcodes 0 and 1 exist
    const r = walkScriptBytecode(buf, 0, profiles);
    expect(r.opcodes).toHaveLength(1);
    expect(r.opcodes[0]?.opcodeIndex).toBe(0);
    expect(r.opcodes[0]?.argByteCount).toBe(0);
    expect(r.opcodes[0]?.argBytes).toEqual([]);
    expect(r.endOffset).toBe(1);
    expect(r.stoppedReason).toBe('invalid_opcode');
  });

  it('walks 3 opcodes with mixed argcounts', () => {
    // opcode 0 (2 args), opcode 1 (0 args), opcode 2 (3 args), then 0xff
    const buf = Buffer.from([
      0x00, 0xaa, 0xbb, // opcode 0 + 2 args
      0x01, // opcode 1 + 0 args
      0x02, 0xcc, 0xdd, 0xee, // opcode 2 + 3 args
      0xff, // invalid
    ]);
    const profiles = buildProfiles([2, 0, 3]);
    const r = walkScriptBytecode(buf, 0, profiles);
    expect(r.opcodes).toHaveLength(3);
    expect(r.opcodes[0]?.argBytes).toEqual([0xaa, 0xbb]);
    expect(r.opcodes[1]?.argByteCount).toBe(0);
    expect(r.opcodes[2]?.argBytes).toEqual([0xcc, 0xdd, 0xee]);
    expect(r.endOffset).toBe(8);
    expect(r.stoppedReason).toBe('invalid_opcode');
  });

  it('returns frozen result + per-opcode + argBytes', () => {
    const buf = Buffer.from([0x00, 0xff]);
    const profiles = buildProfiles([0]);
    const r = walkScriptBytecode(buf, 0, profiles);
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r.opcodes)).toBe(true);
    expect(Object.isFrozen(r.opcodes[0])).toBe(true);
    expect(Object.isFrozen(r.opcodes[0]?.argBytes)).toBe(true);
  });
});

describe('walkScriptBytecode - termination conditions', () => {
  it('stops on profile_missing when profiles is empty', () => {
    const buf = Buffer.from([0x00, 0x01]);
    const r = walkScriptBytecode(buf, 0, []);
    expect(r.opcodes).toEqual([]);
    expect(r.stoppedReason).toBe('profile_missing');
    expect(r.endOffset).toBe(0);
  });

  it('stops on out_of_bounds when entrypoint is past buffer end', () => {
    const buf = Buffer.from([0x00]);
    const profiles = buildProfiles([0]);
    const r = walkScriptBytecode(buf, 5, profiles);
    expect(r.stoppedReason).toBe('out_of_bounds');
  });

  it('stops on out_of_bounds when args overrun buffer mid-walk', () => {
    // opcode 0 has 5 args, but only 2 bytes available
    const buf = Buffer.from([0x00, 0xaa, 0xbb]);
    const profiles = buildProfiles([5]);
    const r = walkScriptBytecode(buf, 0, profiles);
    expect(r.opcodes).toEqual([]); // first opcode would overrun
    expect(r.stoppedReason).toBe('out_of_bounds');
  });

  it('stops at maxOpcodes cap', () => {
    // 10 opcodes each with 0 args; cap at 3
    const buf = Buffer.from(new Array(10).fill(0x00));
    const profiles = buildProfiles([0]);
    const r = walkScriptBytecode(buf, 0, profiles, { maxOpcodes: 3 });
    expect(r.opcodes).toHaveLength(3);
    expect(r.stoppedReason).toBe('max_opcodes');
  });

  it('handles entrypoint at negative offset', () => {
    const buf = Buffer.from([0x00]);
    const profiles = buildProfiles([0]);
    const r = walkScriptBytecode(buf, -1, profiles);
    expect(r.opcodes).toEqual([]);
    expect(r.stoppedReason).toBe('out_of_bounds');
  });
});

describe('walkScriptBytecode - start/end offsets', () => {
  it('reports startOffset matching entrypoint', () => {
    const buf = Buffer.from([0x00, 0xff]);
    const profiles = buildProfiles([0]);
    const r = walkScriptBytecode(buf, 0, profiles);
    expect(r.startOffset).toBe(0);
  });

  it('walks from a non-zero entrypoint', () => {
    const buf = Buffer.alloc(0x100);
    buf[0x50] = 0x00; // opcode 0
    buf[0x51] = 0xff; // invalid
    const profiles = buildProfiles([0]);
    const r = walkScriptBytecode(buf, 0x50, profiles);
    expect(r.startOffset).toBe(0x50);
    expect(r.endOffset).toBe(0x51);
    expect(r.opcodes).toHaveLength(1);
  });
});
