import { describe, expect, it } from 'vitest';
import type { WalkedScriptBody } from './bytecode-walker.js';
import { renderWalkedBody } from './decompile.js';

function makeWalked(
  startOffset: number,
  opcodes: ReadonlyArray<{ opcodeIndex: number; argBytes: ReadonlyArray<number> }>,
  stoppedReason: WalkedScriptBody['stoppedReason'] = 'invalid_opcode',
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
    stoppedReason,
  });
}

describe('renderWalkedBody - happy paths', () => {
  it('renders an empty body with just the stop comment', () => {
    const walked = makeWalked(0x100, [], 'profile_missing');
    const out = renderWalkedBody(walked);
    expect(out).toBe('; stopped: profile_missing @ 0x00000100');
  });

  it('renders single 0-arg opcode with address column', () => {
    const walked = makeWalked(0x600600, [{ opcodeIndex: 8, argBytes: [] }]);
    const out = renderWalkedBody(walked);
    expect(out.split('\n')).toEqual([
      '00600600: op_8()',
      '; stopped: invalid_opcode @ 0x00600601',
    ]);
  });

  it('renders multi-opcode mixed argcounts (the smoke fixture body)', () => {
    const walked = makeWalked(0x600600, [
      { opcodeIndex: 8, argBytes: [] },
      { opcodeIndex: 9, argBytes: [] },
      { opcodeIndex: 0, argBytes: [0xaa, 0xbb] },
      { opcodeIndex: 10, argBytes: [] },
      { opcodeIndex: 5, argBytes: [0xcc, 0xdd] },
    ]);
    const out = renderWalkedBody(walked);
    expect(out).toContain('00600600: op_8()');
    expect(out).toContain('00600602: op_0(arg0=0xAA, arg1=0xBB)');
    expect(out).toContain('00600606: op_5(arg0=0xCC, arg1=0xDD)');
    expect(out).toContain('; stopped: invalid_opcode @ 0x00600609');
  });

  it('uses opcodeNames lookup with op_<index> fallback', () => {
    const walked = makeWalked(0x100, [
      { opcodeIndex: 0, argBytes: [] },
      { opcodeIndex: 1, argBytes: [] },
      { opcodeIndex: 99, argBytes: [] },
    ]);
    // Sparse names: index 0 named, 1 named, 99 unnamed → falls back.
    const out = renderWalkedBody(walked, {
      opcodeNames: ['end', 'nop'],
    });
    expect(out).toContain('00000100: end()');
    expect(out).toContain('00000101: nop()');
    expect(out).toContain('00000102: op_99()');
  });

  it('renders argFormat=dec when requested', () => {
    const walked = makeWalked(0x100, [
      { opcodeIndex: 0, argBytes: [10, 200] },
    ]);
    const out = renderWalkedBody(walked, { argFormat: 'dec' });
    expect(out).toContain('00000100: op_0(arg0=10, arg1=200)');
  });

  it('omits address column when addressColumn=false', () => {
    const walked = makeWalked(0x100, [
      { opcodeIndex: 0, argBytes: [0xaa] },
    ]);
    const out = renderWalkedBody(walked, { addressColumn: false });
    expect(out).toContain('op_0(arg0=0xAA)');
    expect(out).not.toContain('00000100:');
  });
});

describe('renderWalkedBody - stop reasons', () => {
  it('shows the actual stop reason in the trailing comment', () => {
    for (const reason of ['invalid_opcode', 'out_of_bounds', 'max_opcodes', 'profile_missing'] as const) {
      const walked = makeWalked(0x100, [], reason);
      const out = renderWalkedBody(walked);
      expect(out).toBe(`; stopped: ${reason} @ 0x00000100`);
    }
  });
});

describe('renderWalkedBody - sparse opcodeNames', () => {
  it('handles undefined entries in opcodeNames', () => {
    const walked = makeWalked(0x0, [
      { opcodeIndex: 0, argBytes: [] },
      { opcodeIndex: 1, argBytes: [] },
      { opcodeIndex: 2, argBytes: [] },
    ]);
    const names: Array<string | undefined> = ['end'];
    names[2] = 'goto';
    // index 1 is undefined
    const out = renderWalkedBody(walked, { opcodeNames: names });
    expect(out).toContain('00000000: end()');
    expect(out).toContain('00000001: op_1()');
    expect(out).toContain('00000002: goto()');
  });
});
