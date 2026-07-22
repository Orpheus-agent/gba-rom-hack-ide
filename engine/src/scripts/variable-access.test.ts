import { describe, expect, it } from 'vitest';
import type { WalkedScriptBody } from './bytecode-walker.js';
import {
  classifyOpcodeVariableAccess,
  detectVariableAccessSites,
} from './variable-access.js';

function makeWalked(
  startOffset: number,
  opcodes: ReadonlyArray<{ opcodeIndex: number; argBytes: ReadonlyArray<number> }>,
): WalkedScriptBody {
  let cursor = startOffset;
  const walked = opcodes.map((o) => {
    const opcodeOffset = cursor;
    cursor += 1 + o.argBytes.length;
    return Object.freeze({
      opcodeIndex: o.opcodeIndex,
      opcodeOffset,
      argByteCount: o.argBytes.length,
      argBytes: Object.freeze([...o.argBytes]),
    });
  });
  return Object.freeze({
    startOffset,
    endOffset: cursor,
    opcodes: Object.freeze(walked),
    stoppedReason: 'invalid_opcode' as const,
  });
}

describe('classifyOpcodeVariableAccess - flag writes', () => {
  it('classifies setflag/clearflag as sets_flag', () => {
    expect(classifyOpcodeVariableAccess('setflag')).toBe('sets_flag');
    expect(classifyOpcodeVariableAccess('clearflag')).toBe('sets_flag');
  });

  it('classifies all variable-write ops as sets_flag', () => {
    expect(classifyOpcodeVariableAccess('setvar')).toBe('sets_flag');
    expect(classifyOpcodeVariableAccess('addvar')).toBe('sets_flag');
    expect(classifyOpcodeVariableAccess('subvar')).toBe('sets_flag');
    expect(classifyOpcodeVariableAccess('copyvar')).toBe('sets_flag');
    expect(classifyOpcodeVariableAccess('setorcopyvar')).toBe('sets_flag');
  });
});

describe('classifyOpcodeVariableAccess - flag reads', () => {
  it('classifies checkflag as reads_flag', () => {
    expect(classifyOpcodeVariableAccess('checkflag')).toBe('reads_flag');
  });

  it('classifies compare_var_to_value / compare_var_to_var as reads_flag', () => {
    expect(classifyOpcodeVariableAccess('compare_var_to_value')).toBe('reads_flag');
    expect(classifyOpcodeVariableAccess('compare_var_to_var')).toBe('reads_flag');
  });
});

describe('classifyOpcodeVariableAccess - non-access opcodes return null', () => {
  it('returns null for control-flow opcodes', () => {
    expect(classifyOpcodeVariableAccess('nop')).toBeNull();
    expect(classifyOpcodeVariableAccess('end')).toBeNull();
    expect(classifyOpcodeVariableAccess('return')).toBeNull();
    expect(classifyOpcodeVariableAccess('call')).toBeNull();
    expect(classifyOpcodeVariableAccess('goto')).toBeNull();
  });

  it('returns null for unknown / op_<N> fallback names', () => {
    expect(classifyOpcodeVariableAccess('op_42')).toBeNull();
    expect(classifyOpcodeVariableAccess('unknown_thing')).toBeNull();
  });

  it('returns null for undefined / empty string', () => {
    expect(classifyOpcodeVariableAccess(undefined)).toBeNull();
    expect(classifyOpcodeVariableAccess('')).toBeNull();
  });

  it('does not match compare-non-var compares (compare_local_to_value etc.)', () => {
    // These compare local-scope (memory addresses) not script variables;
    // they shouldn't generate reads_flag edges.
    expect(classifyOpcodeVariableAccess('compare_local_to_local')).toBeNull();
    expect(classifyOpcodeVariableAccess('compare_local_to_value')).toBeNull();
  });
});

describe('detectVariableAccessSites', () => {
  it('returns empty for a body with no flag/var accesses', () => {
    const walked = makeWalked(0x100, [
      { opcodeIndex: 0, argBytes: [] }, // nop
      { opcodeIndex: 2, argBytes: [] }, // end
    ]);
    const sites = detectVariableAccessSites(walked, ['nop', 'nop1', 'end']);
    expect(sites).toEqual([]);
  });

  it('detects setflag with variableId from argbytes', () => {
    // opcode 41 named "setflag" reads u16 flag id from first 2 argbytes
    const walked = makeWalked(0x100, [
      { opcodeIndex: 41, argBytes: [0x10, 0x40] }, // flag 0x4010
    ]);
    const names: Array<string | undefined> = [];
    names[41] = 'setflag';
    const sites = detectVariableAccessSites(walked, names);
    expect(sites).toHaveLength(1);
    expect(sites[0]?.accessKind).toBe('sets_flag');
    expect(sites[0]?.opcodeName).toBe('setflag');
    expect(sites[0]?.variableId).toBe(0x4010);
    expect(sites[0]?.opcodeOffset).toBe(0x100);
  });

  it('detects multiple accesses (read + write) in one body', () => {
    const walked = makeWalked(0x100, [
      { opcodeIndex: 41, argBytes: [0x01, 0x40] }, // setflag 0x4001
      { opcodeIndex: 43, argBytes: [0x02, 0x40] }, // checkflag 0x4002
      { opcodeIndex: 22, argBytes: [0x03, 0x40, 0x05, 0x00] }, // setvar 0x4003 = 5
    ]);
    const names: Array<string | undefined> = [];
    names[22] = 'setvar';
    names[41] = 'setflag';
    names[43] = 'checkflag';
    const sites = detectVariableAccessSites(walked, names);
    expect(sites).toHaveLength(3);
    expect(sites[0]?.accessKind).toBe('sets_flag');
    expect(sites[0]?.variableId).toBe(0x4001);
    expect(sites[1]?.accessKind).toBe('reads_flag');
    expect(sites[1]?.variableId).toBe(0x4002);
    expect(sites[2]?.accessKind).toBe('sets_flag');
    expect(sites[2]?.variableId).toBe(0x4003);
  });

  it('skips opcodes whose names are not in the access set', () => {
    const walked = makeWalked(0x100, [
      { opcodeIndex: 0, argBytes: [] }, // nop
      { opcodeIndex: 41, argBytes: [0x01, 0x40] }, // setflag
      { opcodeIndex: 5, argBytes: [0x00] }, // goto
    ]);
    const names: Array<string | undefined> = [];
    names[0] = 'nop';
    names[5] = 'goto';
    names[41] = 'setflag';
    const sites = detectVariableAccessSites(walked, names);
    expect(sites).toHaveLength(1);
    expect(sites[0]?.opcodeIndex).toBe(41);
  });

  it('handles unnamed opcodes safely (no fake classifications)', () => {
    const walked = makeWalked(0x100, [
      { opcodeIndex: 99, argBytes: [0x01, 0x40] }, // unnamed
    ]);
    const sites = detectVariableAccessSites(walked, []);
    expect(sites).toEqual([]);
  });

  it('returns variableId=null when opcode has fewer than 2 argbytes', () => {
    const walked = makeWalked(0x100, [
      { opcodeIndex: 41, argBytes: [0x01] }, // setflag with only 1 argbyte
    ]);
    const names: Array<string | undefined> = [];
    names[41] = 'setflag';
    const sites = detectVariableAccessSites(walked, names);
    expect(sites).toHaveLength(1);
    expect(sites[0]?.variableId).toBeNull();
  });

  it('returns frozen result + per-site objects', () => {
    const walked = makeWalked(0x100, [
      { opcodeIndex: 41, argBytes: [0x00, 0x40] },
    ]);
    const names: Array<string | undefined> = [];
    names[41] = 'setflag';
    const sites = detectVariableAccessSites(walked, names);
    expect(Object.isFrozen(sites)).toBe(true);
    expect(Object.isFrozen(sites[0])).toBe(true);
  });
});
