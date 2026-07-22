import { describe, expect, it } from 'vitest';
import { interpretScript } from './script-interpreter.js';
import type { WalkedScriptBody } from '../scripts/index.js';

/** Build a WalkedScriptBody from a list of (opcodeIndex, argBytes). */
function makeBody(
  startOffset: number,
  steps: ReadonlyArray<{ opcodeIndex: number; argBytes: ReadonlyArray<number> }>,
): WalkedScriptBody {
  let cursor = startOffset;
  const opcodes = steps.map((s) => {
    const opcodeOffset = cursor;
    const argByteCount = s.argBytes.length;
    cursor += 1 + argByteCount;
    return Object.freeze({
      opcodeIndex: s.opcodeIndex,
      opcodeOffset,
      argByteCount,
      argBytes: Object.freeze(s.argBytes),
    });
  });
  return Object.freeze({
    startOffset,
    endOffset: cursor,
    opcodes: Object.freeze(opcodes),
    stoppedReason: 'max_opcodes' as const,
  });
}

describe('interpretScript - happy paths', () => {
  it('emits opcode_executed events for every walked opcode', () => {
    const body = makeBody(0x100, [
      { opcodeIndex: 0, argBytes: [] },
      { opcodeIndex: 1, argBytes: [0xff] },
    ]);
    const r = interpretScript(body);
    const executed = r.traceEvents.filter((e) => e.kind === 'opcode_executed');
    expect(executed.length).toBe(2);
    expect(executed[0]?.kind === 'opcode_executed' && executed[0].pc).toBe(0x100);
    expect(executed[1]?.kind === 'opcode_executed' && executed[1].pc).toBe(0x101);
  });

  it('setflag mutates flag state + emits flag_set event with previousValue', () => {
    const body = makeBody(0x200, [
      { opcodeIndex: 41, argBytes: [0x01, 0x40] }, // setflag(0x4001)
    ]);
    const r = interpretScript(body, { opcodeNames: arrayWithNames({ 41: 'setflag' }) });
    expect(r.endState.flags.get(0x4001)).toBe(true);
    const flagSets = r.traceEvents.filter((e) => e.kind === 'flag_set');
    expect(flagSets.length).toBe(1);
    if (flagSets[0]?.kind === 'flag_set') {
      expect(flagSets[0].flagId).toBe(0x4001);
      expect(flagSets[0].previousValue).toBe(false);
    }
  });

  it('clearflag mutates flag state + emits flag_cleared event', () => {
    const body = makeBody(0x200, [
      { opcodeIndex: 42, argBytes: [0x05, 0x40] }, // clearflag(0x4005)
    ]);
    const r = interpretScript(body, {
      opcodeNames: arrayWithNames({ 42: 'clearflag' }),
      initialFlags: new Map([[0x4005, true]]),
    });
    expect(r.endState.flags.get(0x4005)).toBe(false);
    const cleared = r.traceEvents.filter((e) => e.kind === 'flag_cleared');
    expect(cleared.length).toBe(1);
    if (cleared[0]?.kind === 'flag_cleared') {
      expect(cleared[0].flagId).toBe(0x4005);
      expect(cleared[0].previousValue).toBe(true);
    }
  });

  it('checkflag observes current value (after prior setflag in same body)', () => {
    const body = makeBody(0x200, [
      { opcodeIndex: 41, argBytes: [0x01, 0x40] }, // setflag(0x4001)
      { opcodeIndex: 43, argBytes: [0x01, 0x40] }, // checkflag(0x4001)
    ]);
    const r = interpretScript(body, {
      opcodeNames: arrayWithNames({ 41: 'setflag', 43: 'checkflag' }),
    });
    const reads = r.traceEvents.filter((e) => e.kind === 'flag_read');
    expect(reads.length).toBe(1);
    if (reads[0]?.kind === 'flag_read') {
      expect(reads[0].flagId).toBe(0x4001);
      expect(reads[0].observedValue).toBe(true); // setflag fired first
    }
  });

  it('checkflag observes initial false when not set', () => {
    const body = makeBody(0x200, [
      { opcodeIndex: 43, argBytes: [0x05, 0x40] }, // checkflag(0x4005) - never set
    ]);
    const r = interpretScript(body, {
      opcodeNames: arrayWithNames({ 43: 'checkflag' }),
    });
    const reads = r.traceEvents.filter((e) => e.kind === 'flag_read');
    expect(reads.length).toBe(1);
    if (reads[0]?.kind === 'flag_read') expect(reads[0].observedValue).toBe(false);
  });

  it('setvar mutates var state + emits var_set event (with 4 argbytes: id + value)', () => {
    const body = makeBody(0x200, [
      { opcodeIndex: 22, argBytes: [0x02, 0x40, 0x10, 0x00] }, // setvar(0x4002, 0x10)
    ]);
    const r = interpretScript(body, { opcodeNames: arrayWithNames({ 22: 'setvar' }) });
    expect(r.endState.vars.get(0x4002)).toBe(0x10);
    const sets = r.traceEvents.filter((e) => e.kind === 'var_set');
    expect(sets.length).toBe(1);
    if (sets[0]?.kind === 'var_set') {
      expect(sets[0].variableId).toBe(0x4002);
      expect(sets[0].value).toBe(0x10);
      expect(sets[0].previousValue).toBe(0);
    }
  });

  it('compare_var_to_value observes current value', () => {
    const body = makeBody(0x200, [
      { opcodeIndex: 33, argBytes: [0x02, 0x40] }, // compare_var_to_value(0x4002)
    ]);
    const r = interpretScript(body, {
      opcodeNames: arrayWithNames({ 33: 'compare_var_to_value' }),
      initialVars: new Map([[0x4002, 42]]),
    });
    const reads = r.traceEvents.filter((e) => e.kind === 'var_read');
    expect(reads.length).toBe(1);
    if (reads[0]?.kind === 'var_read') {
      expect(reads[0].variableId).toBe(0x4002);
      expect(reads[0].observedValue).toBe(42);
    }
  });

  it('end opcode terminates execution + emits terminated event', () => {
    const body = makeBody(0x200, [
      { opcodeIndex: 41, argBytes: [0x01, 0x40] }, // setflag
      { opcodeIndex: 2, argBytes: [] }, // end
      { opcodeIndex: 41, argBytes: [0x02, 0x40] }, // setflag - should NOT execute
    ]);
    const r = interpretScript(body, {
      opcodeNames: arrayWithNames({ 41: 'setflag', 2: 'end' }),
    });
    // 1st setflag executed → flag 0x4001 set; end terminated → 2nd setflag did NOT execute.
    expect(r.endState.flags.get(0x4001)).toBe(true);
    expect(r.endState.flags.get(0x4002)).toBeUndefined();
    const terminated = r.traceEvents.filter((e) => e.kind === 'terminated');
    expect(terminated.length).toBe(1);
    if (terminated[0]?.kind === 'terminated') {
      expect(terminated[0].reason).toBe('end_opcode');
    }
  });

  it('result is frozen', () => {
    const body = makeBody(0x100, [{ opcodeIndex: 0, argBytes: [] }]);
    const r = interpretScript(body);
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r.traceEvents)).toBe(true);
    expect(Object.isFrozen(r.endState)).toBe(true);
  });
});

describe('interpretScript - termination + edge cases', () => {
  it('honors maxSteps and emits terminated max_steps event', () => {
    const body = makeBody(0x200, Array.from({ length: 20 }, () => ({ opcodeIndex: 0, argBytes: [] })));
    const r = interpretScript(body, { maxSteps: 5 });
    expect(r.endState.executedCount).toBe(5);
    const terminated = r.traceEvents.filter((e) => e.kind === 'terminated');
    expect(terminated.length).toBe(1);
    if (terminated[0]?.kind === 'terminated') expect(terminated[0].reason).toBe('max_steps');
  });

  it('empty body emits a single terminated event reflecting walker stop reason', () => {
    const body: WalkedScriptBody = Object.freeze({
      startOffset: 0x100,
      endOffset: 0x100,
      opcodes: Object.freeze([]),
      stoppedReason: 'invalid_opcode' as const,
    });
    const r = interpretScript(body);
    expect(r.traceEvents.length).toBe(1);
    if (r.traceEvents[0]?.kind === 'terminated') {
      expect(r.traceEvents[0].reason).toBe('invalid_opcode');
    }
  });

  it('initialFlags carry over correctly (cross-script state)', () => {
    const body = makeBody(0x300, [
      { opcodeIndex: 43, argBytes: [0xaa, 0x00] }, // checkflag(0x00AA)
    ]);
    const r = interpretScript(body, {
      opcodeNames: arrayWithNames({ 43: 'checkflag' }),
      initialFlags: new Map([[0x00aa, true]]),
    });
    const reads = r.traceEvents.filter((e) => e.kind === 'flag_read');
    if (reads[0]?.kind === 'flag_read') {
      expect(reads[0].flagId).toBe(0x00aa);
      expect(reads[0].observedValue).toBe(true);
    }
  });

  it('unknown opcode name → no semantic event, still emits opcode_executed', () => {
    const body = makeBody(0x100, [{ opcodeIndex: 99, argBytes: [0x11] }]);
    const r = interpretScript(body, { opcodeNames: arrayWithNames({}) });
    expect(r.traceEvents.length).toBe(2); // opcode_executed + terminated
    if (r.traceEvents[0]?.kind === 'opcode_executed') {
      expect(r.traceEvents[0].opcodeName).toBeNull();
    }
  });
});

/** Helper: build a sparse opcodeNames array from an index→name map. */
function arrayWithNames(
  map: Record<number, string>,
): ReadonlyArray<string | undefined> {
  const indices = Object.keys(map).map(Number);
  const max = indices.length > 0 ? Math.max(...indices) : 0;
  const out: Array<string | undefined> = new Array(max + 1).fill(undefined);
  for (const idx of indices) out[idx] = map[idx];
  return out;
}
