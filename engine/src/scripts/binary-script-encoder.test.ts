import { describe, expect, it } from 'vitest';
import { decodeBinaryScript } from './binary-script-decoder.js';
import {
  encodeScript,
  encodeStep,
  type EncodableStep,
  type EncodeContext,
  GBA_ROM_BASE,
  ScriptEncodeError,
} from './binary-script-encoder.js';
import { encodeString } from '../text/codec.js';

/** Build a no-op allocator that simply parks bytes at offset 0x100000 +
 *  cumulative size. Used for tests that don't care about exact
 *  placement; the round-trip checks ignore variable-length blocks. */
function makeFakeAllocator(): EncodeContext {
  let cursor = 0x100000;
  return {
    allocate(req) {
      const offset = cursor;
      cursor += req.bytes.length;
      return offset;
    },
  };
}

/** Helper: append a known script's worth of bytes to a 1MB ROM-shaped
 *  Uint8Array and return the offset of the script + the buffer. */
function makeRom(scriptBytes: Uint8Array): { rom: Uint8Array; scriptOffset: number } {
  const rom = new Uint8Array(0x200000);
  const scriptOffset = 0x100;
  rom.set(scriptBytes, scriptOffset);
  return { rom, scriptOffset };
}

describe('encodeStep - opcode coverage', () => {
  const ctx = makeFakeAllocator();

  it('encodes lock (kind raw, opcode 0x6a)', () => {
    const step: EncodableStep = { kind: 'raw', params: { opcode: 0x6a } };
    expect(Array.from(encodeStep(step, ctx))).toEqual([0x6a]);
  });

  it('encodes release (kind raw, opcode 0x6c)', () => {
    const step: EncodableStep = { kind: 'raw', params: { opcode: 0x6c } };
    expect(Array.from(encodeStep(step, ctx))).toEqual([0x6c]);
  });

  it('encodes end (kind raw, opcode 0x02)', () => {
    const step: EncodableStep = { kind: 'raw', params: { opcode: 0x02 } };
    expect(Array.from(encodeStep(step, ctx))).toEqual([0x02]);
  });

  it('encodes setflag with u16 flagId', () => {
    // setflag 0x828 = opcode 0x29 + u16 LE [0x28, 0x08]
    const step: EncodableStep = { kind: 'set_flag', params: { flagId: 0x828 } };
    expect(Array.from(encodeStep(step, ctx))).toEqual([0x29, 0x28, 0x08]);
  });

  it('encodes clearflag', () => {
    const step: EncodableStep = { kind: 'clear_flag', params: { flagId: 0x82f } };
    expect(Array.from(encodeStep(step, ctx))).toEqual([0x2a, 0x2f, 0x08]);
  });

  it('encodes setvar varId + value', () => {
    // setvar 0x4001 = 5 → opcode 0x16, u16 0x4001, u16 0x0005
    const step: EncodableStep = {
      kind: 'set_variable',
      params: { opcodeName: 'setvar', varId: 0x4001, value: 5 },
    };
    expect(Array.from(encodeStep(step, ctx))).toEqual([0x16, 0x01, 0x40, 0x05, 0x00]);
  });

  it('encodes copyvar with dest + src', () => {
    const step: EncodableStep = {
      kind: 'set_variable',
      params: { opcodeName: 'copyvar', destVar: 0x4000, srcVar: 0x4001 },
    };
    expect(Array.from(encodeStep(step, ctx))).toEqual([0x19, 0x00, 0x40, 0x01, 0x40]);
  });

  it('encodes giveitem with itemId + quantity + callbackType', () => {
    // giveitem ITEM_POTION (0x0d) × 5 with callback 0 → opcode 0x44
    const step: EncodableStep = {
      kind: 'give_item',
      params: { opcodeName: 'giveitem', itemId: 0x0d, quantity: 5, callbackType: 0 },
    };
    expect(Array.from(encodeStep(step, ctx))).toEqual([0x44, 0x0d, 0x00, 0x05, 0x00, 0x00]);
  });

  it('encodes warp with bank + num + warpId + x + y', () => {
    // warp 3.0 #1 (5, 7) → opcode 0x39
    const step: EncodableStep = {
      kind: 'warp_player',
      params: {
        opcodeName: 'warp',
        destMapBank: 3,
        destMapNum: 0,
        warpId: 1,
        x: 5,
        y: 7,
      },
    };
    expect(Array.from(encodeStep(step, ctx))).toEqual([0x39, 0x03, 0x00, 0x01, 0x05, 0x00, 0x07, 0x00]);
  });

  it('encodes playse with u16 songId', () => {
    const step: EncodableStep = {
      kind: 'play_sound',
      params: { opcodeName: 'playse', songId: 0x13e },
    };
    expect(Array.from(encodeStep(step, ctx))).toEqual([0x2f, 0x3e, 0x01]);
  });

  it('encodes waitse (zero-arg)', () => {
    const step: EncodableStep = {
      kind: 'play_sound',
      params: { opcodeName: 'waitse' },
    };
    expect(Array.from(encodeStep(step, ctx))).toEqual([0x30]);
  });

  it('encodes fadescreen with u8 fadeType', () => {
    const step: EncodableStep = {
      kind: 'fade_scene',
      params: { opcodeName: 'fadescreen', fadeType: 1 },
    };
    expect(Array.from(encodeStep(step, ctx))).toEqual([0x9a, 0x01]);
  });

  it('encodes random with u16 range', () => {
    const step: EncodableStep = {
      kind: 'randomize_branch',
      params: { range: 4 },
    };
    expect(Array.from(encodeStep(step, ctx))).toEqual([0x42, 0x04, 0x00]);
  });

  it('encodes goto with u32 targetRomPtr', () => {
    const step: EncodableStep = {
      kind: 'branch',
      params: { opcodeName: 'goto', targetRomPtr: 0x08123456 },
    };
    expect(Array.from(encodeStep(step, ctx))).toEqual([0x05, 0x56, 0x34, 0x12, 0x08]);
  });

  it('encodes goto_if with condition + target', () => {
    const step: EncodableStep = {
      kind: 'branch',
      params: { opcodeName: 'goto_if', condition: 1, targetRomPtr: 0x08123456 },
    };
    expect(Array.from(encodeStep(step, ctx))).toEqual([0x06, 0x01, 0x56, 0x34, 0x12, 0x08]);
  });

  it('encodes compare via branch kind', () => {
    const step: EncodableStep = {
      kind: 'branch',
      params: { opcodeName: 'compare', varId: 0x4001, value: 1 },
    };
    expect(Array.from(encodeStep(step, ctx))).toEqual([0x21, 0x01, 0x40, 0x01, 0x00]);
  });

  it('encodes applymovement with existing pointer (no realloc)', () => {
    const step: EncodableStep = {
      kind: 'move_npc',
      params: {
        opcodeName: 'applymovement',
        objectId: 2,
        movementPtr: 0x08123456,
      },
    };
    expect(Array.from(encodeStep(step, ctx))).toEqual([
      0x4f, 0x02, 0x00, 0x56, 0x34, 0x12, 0x08,
    ]);
  });

  it('encodes applymovement with fresh sequence (allocates new block)', () => {
    let allocated = false;
    let allocatedBytes: Uint8Array | null = null;
    const allocatingCtx: EncodeContext = {
      allocate(req) {
        allocated = true;
        allocatedBytes = req.bytes;
        return 0x123000;
      },
    };
    const step: EncodableStep = {
      kind: 'move_npc',
      params: {
        opcodeName: 'applymovement',
        objectId: 2,
        movementSequence: [0x10, 0x11, 0x12, 0x13], // walk down/up/left/right
      },
    };
    const bytes = encodeStep(step, allocatingCtx);
    expect(allocated).toBe(true);
    // Movement block = the 4 commands + the 0xFE terminator
    expect(allocatedBytes).not.toBeNull();
    expect(Array.from(allocatedBytes!)).toEqual([0x10, 0x11, 0x12, 0x13, 0xfe]);
    // Bytecode = opcode + u16 objectId + u32 ptr (0x123000 + GBA_ROM_BASE)
    const expectedPtr = (0x123000 + GBA_ROM_BASE) >>> 0;
    expect(Array.from(bytes)).toEqual([
      0x4f,
      0x02, 0x00,
      expectedPtr & 0xff,
      (expectedPtr >>> 8) & 0xff,
      (expectedPtr >>> 16) & 0xff,
      (expectedPtr >>> 24) & 0xff,
    ]);
  });

  it('encodes dialogue (msgbox macro) with existing textPtr', () => {
    const step: EncodableStep = {
      kind: 'dialogue',
      params: { textPtr: 0x08abcdef, stdType: 4 },
    };
    // loadword 0, 0x08abcdef → 0x0f, 0x00, [ef cd ab 08]
    // callstd 4              → 0x09, 0x04
    expect(Array.from(encodeStep(step, ctx))).toEqual([
      0x0f, 0x00, 0xef, 0xcd, 0xab, 0x08,
      0x09, 0x04,
    ]);
  });

  it('encodes dialogue with new text (allocates fresh space)', () => {
    let allocated = false;
    let allocatedBytes: Uint8Array | null = null;
    const allocatingCtx: EncodeContext = {
      allocate(req) {
        allocated = true;
        allocatedBytes = req.bytes;
        return 0x150000;
      },
    };
    const step: EncodableStep = {
      kind: 'dialogue',
      params: { dialogueText: 'Hi!' },
    };
    const bytes = encodeStep(step, allocatingCtx);
    expect(allocated).toBe(true);
    // Encoded text should be a non-empty Gen-3 string
    expect(allocatedBytes).not.toBeNull();
    expect(allocatedBytes!.length).toBeGreaterThan(0);
    const expectedPtr = (0x150000 + GBA_ROM_BASE) >>> 0;
    expect(bytes[0]).toBe(0x0f); // loadword
    expect(bytes[1]).toBe(0x00); // bank arg
    // Pointer bytes
    expect(bytes[2]).toBe(expectedPtr & 0xff);
    expect(bytes[3]).toBe((expectedPtr >>> 8) & 0xff);
    expect(bytes[4]).toBe((expectedPtr >>> 16) & 0xff);
    expect(bytes[5]).toBe((expectedPtr >>> 24) & 0xff);
    expect(bytes[6]).toBe(0x09); // callstd
    expect(bytes[7]).toBe(0x04); // default stdType
  });

  it('throws ScriptEncodeError on missing required param', () => {
    const step: EncodableStep = { kind: 'set_flag', params: {} };
    expect(() => encodeStep(step, ctx)).toThrow(ScriptEncodeError);
  });
});

describe('encodeScript - full-script assembly', () => {
  const ctx = makeFakeAllocator();

  it('encodes a multi-step script and appends end terminator', () => {
    // lock; setflag 0x828; release; (auto-appended end)
    const steps: EncodableStep[] = [
      { kind: 'raw', params: { opcode: 0x6a } },
      { kind: 'set_flag', params: { flagId: 0x828 } },
      { kind: 'raw', params: { opcode: 0x6c } },
    ];
    const bytes = encodeScript(steps, ctx);
    expect(Array.from(bytes)).toEqual([
      0x6a, // lock
      0x29, 0x28, 0x08, // setflag 0x828
      0x6c, // release
      0x02, // end (auto-appended)
    ]);
  });

  it('does not append end when last step is already end', () => {
    const steps: EncodableStep[] = [
      { kind: 'set_flag', params: { flagId: 0x828 } },
      { kind: 'raw', params: { opcode: 0x02 } }, // end
    ];
    const bytes = encodeScript(steps, ctx);
    expect(Array.from(bytes)).toEqual([
      0x29, 0x28, 0x08, // setflag
      0x02, // end
    ]);
  });

  it('does not append end when last step is return', () => {
    const steps: EncodableStep[] = [
      { kind: 'raw', params: { opcode: 0x03 } }, // return
    ];
    const bytes = encodeScript(steps, ctx);
    expect(Array.from(bytes)).toEqual([0x03]);
  });

  it('reports the step index in errors so user knows which card broke', () => {
    const steps: EncodableStep[] = [
      { kind: 'raw', params: { opcode: 0x6a } },
      { kind: 'raw', params: { opcode: 0x6a } },
      { kind: 'set_flag', params: {} }, // missing flagId
    ];
    try {
      encodeScript(steps, ctx);
      expect.fail('expected ScriptEncodeError');
    } catch (e) {
      expect(e).toBeInstanceOf(ScriptEncodeError);
      expect((e as ScriptEncodeError).stepIndex).toBe(2);
    }
  });
});

describe('round-trip - decode then encode preserves bytes', () => {
  const ctx: EncodeContext = {
    // For round-trip tests, preserve existing pointers; never allocate.
    allocate() {
      throw new Error('allocator should not be called in round-trip tests');
    },
  };

  function roundTripPure(scriptBytes: number[]): void {
    const { rom, scriptOffset } = makeRom(new Uint8Array(scriptBytes));
    const decoded = decodeBinaryScript(rom, scriptOffset);
    const encoded = encodeScript(
      decoded.steps.map((s) => ({ kind: s.kind, params: s.params })),
      ctx,
    );
    // We compare only the bytes the decoder claims it consumed, not any
    // auto-appended `end` (round-trip tests use scripts that end with
    // a real terminator).
    const expected = scriptBytes.slice(0, decoded.bytesConsumed);
    expect(Array.from(encoded.slice(0, expected.length))).toEqual(expected);
  }

  it('round-trips: lock, setflag, release, end', () => {
    roundTripPure([
      0x6a, // lock
      0x29, 0x28, 0x08, // setflag 0x828
      0x6c, // release
      0x02, // end
    ]);
  });

  it('round-trips: setvar, addvar, compare, end', () => {
    roundTripPure([
      0x16, 0x01, 0x40, 0x05, 0x00, // setvar 0x4001 = 5
      0x17, 0x01, 0x40, 0x01, 0x00, // addvar 0x4001 += 1
      0x21, 0x01, 0x40, 0x06, 0x00, // compare 0x4001, 6
      0x02, // end
    ]);
  });

  it('round-trips: giveitem + warp + fadescreen + end', () => {
    roundTripPure([
      0x44, 0x0d, 0x00, 0x01, 0x00, 0x00, // giveitem 0x0d × 1 cb 0
      0x39, 0x03, 0x00, 0x01, 0x05, 0x00, 0x07, 0x00, // warp 3.0 #1 (5,7)
      0x9a, 0x01, // fadescreen 1
      0x02, // end
    ]);
  });

  it('round-trips: applymovement (pointer preserved through encoder)', () => {
    roundTripPure([
      0x4f, 0x02, 0x00, 0x56, 0x34, 0x12, 0x08, // applymovement obj 2, ptr 0x08123456
      0x02, // end
    ]);
  });

  it('round-trips: playse, waitse, end', () => {
    roundTripPure([
      0x2f, 0x3e, 0x01, // playse 0x13e
      0x30, // waitse
      0x02, // end
    ]);
  });

  it('round-trips: goto with full u32 ptr', () => {
    roundTripPure([
      0x05, 0x56, 0x34, 0x12, 0x08, // goto 0x08123456
    ]);
  });

  it('round-trips: random + end', () => {
    roundTripPure([
      0x42, 0x04, 0x00, // random 4
      0x02, // end
    ]);
  });
});

describe('round-trip - dialogue with allocator', () => {
  it('round-trips msgbox bytecode when the allocator returns the original pointer', () => {
    // msgbox at 0x08abcdef, callstd 4
    const scriptBytes = [
      0x0f, 0x00, 0xef, 0xcd, 0xab, 0x08, // loadword 0, 0x08abcdef
      0x09, 0x04, // callstd 4
      0x02, // end
    ];
    const { rom, scriptOffset } = makeRom(new Uint8Array(scriptBytes));
    // Put a fake Gen-3-encoded "Hi" at 0x0bcdef (file offset of 0x08abcdef)
    // Decoder will read garbage but we don't care for this test.
    const decoded = decodeBinaryScript(rom, scriptOffset);
    const dialogueStep = decoded.steps.find((s) => s.kind === 'dialogue');
    expect(dialogueStep).toBeDefined();

    // Re-encode with the existing textPtr preserved (no allocation).
    const ctx: EncodeContext = {
      allocate() {
        throw new Error('should not allocate when textPtr preserved');
      },
    };
    const encoded = encodeScript(
      decoded.steps.map((s) => {
        if (s.kind === 'dialogue') {
          // Strip dialogueText so the encoder preserves the pointer.
          const { dialogueText: _dt, ...rest } = s.params as Record<string, unknown>;
          return { kind: s.kind, params: rest };
        }
        return { kind: s.kind, params: s.params };
      }),
      ctx,
    );
    // First 8 bytes (loadword + callstd) should round-trip exactly.
    expect(Array.from(encoded.slice(0, 8))).toEqual(scriptBytes.slice(0, 8));
  });
});

describe('dirty-flag opt-in allocations', () => {
  it('applymovement with both ptr + sequence preserves ptr by default', () => {
    const ctx: EncodeContext = {
      allocate() {
        throw new Error('should not allocate by default');
      },
    };
    const step: EncodableStep = {
      kind: 'move_npc',
      params: {
        opcodeName: 'applymovement',
        objectId: 2,
        movementPtr: 0x08123456,
        movementSequence: [0x10, 0x11], // decoder always populates both
      },
    };
    const bytes = encodeStep(step, ctx);
    // Should preserve the original pointer.
    expect(Array.from(bytes)).toEqual([0x4f, 0x02, 0x00, 0x56, 0x34, 0x12, 0x08]);
  });

  it('applymovement with movementDirty=true allocates a new block', () => {
    let allocated = false;
    const ctx: EncodeContext = {
      allocate(req) {
        allocated = true;
        // Verify the new sequence + 0xFE terminator is what we got
        expect(Array.from(req.bytes)).toEqual([0x10, 0x10, 0xfe]);
        return 0x200000;
      },
    };
    const step: EncodableStep = {
      kind: 'move_npc',
      params: {
        opcodeName: 'applymovement',
        objectId: 2,
        movementPtr: 0x08123456, // old pointer, should be ignored
        movementSequence: [0x10, 0x10], // new sequence
        movementDirty: true,
      },
    };
    encodeStep(step, ctx);
    expect(allocated).toBe(true);
  });

  it('dialogue with both ptr + text preserves ptr by default', () => {
    const ctx: EncodeContext = {
      allocate() {
        throw new Error('should not allocate by default');
      },
    };
    const step: EncodableStep = {
      kind: 'dialogue',
      params: {
        textPtr: 0x08abcdef,
        dialogueText: 'Old text', // decoder always populates both
        stdType: 4,
      },
    };
    const bytes = encodeStep(step, ctx);
    // Should preserve the original pointer.
    expect(Array.from(bytes)).toEqual([
      0x0f, 0x00, 0xef, 0xcd, 0xab, 0x08,
      0x09, 0x04,
    ]);
  });

  it('dialogue with dialogueDirty=true allocates new text', () => {
    let allocated = false;
    const ctx: EncodeContext = {
      allocate(req) {
        allocated = true;
        // Should be the encoded "Hi!" bytes
        const expected = encodeString('Hi!');
        expect(Array.from(req.bytes)).toEqual(Array.from(expected));
        return 0x300000;
      },
    };
    const step: EncodableStep = {
      kind: 'dialogue',
      params: {
        textPtr: 0x08abcdef, // old pointer, should be ignored
        dialogueText: 'Hi!',
        dialogueDirty: true,
        stdType: 4,
      },
    };
    encodeStep(step, ctx);
    expect(allocated).toBe(true);
  });
});

describe('branch_on_var - Phase 2B', () => {
  const ctx = makeFakeAllocator();

  it('encodes "if VAR_RA_EMO_LOG ≥ 3 → 0x08123456" (greaterorequal, condition 4)', () => {
    const step: EncodableStep = {
      kind: 'branch_on_var',
      params: {
        varId: 0x40d0,
        value: 3,
        operator: 'greaterorequal',
        targetRomPtr: 0x08123456,
      },
    };
    // compare 0x40D0, 3  → 0x21, 0xD0, 0x40, 0x03, 0x00
    // goto_if 4, 0x08123456 → 0x06, 0x04, 0x56, 0x34, 0x12, 0x08
    expect(Array.from(encodeStep(step, ctx))).toEqual([
      0x21, 0xd0, 0x40, 0x03, 0x00,
      0x06, 0x04, 0x56, 0x34, 0x12, 0x08,
    ]);
  });

  it('encodes "if VAR = 0 → target" (equal, condition 1)', () => {
    const step: EncodableStep = {
      kind: 'branch_on_var',
      params: {
        varId: 0x4001,
        value: 0,
        operator: 'equal',
        targetRomPtr: 0x08aabbcc,
      },
    };
    expect(Array.from(encodeStep(step, ctx))).toEqual([
      0x21, 0x01, 0x40, 0x00, 0x00,
      0x06, 0x01, 0xcc, 0xbb, 0xaa, 0x08,
    ]);
  });

  it('encodes "if VAR ≠ 1 → target" (notequal, condition 5)', () => {
    const step: EncodableStep = {
      kind: 'branch_on_var',
      params: {
        varId: 0x40d1,
        value: 1,
        operator: 'notequal',
        targetRomPtr: 0x081f0000,
      },
    };
    expect(Array.from(encodeStep(step, ctx))).toEqual([
      0x21, 0xd1, 0x40, 0x01, 0x00,
      0x06, 0x05, 0x00, 0x00, 0x1f, 0x08,
    ]);
  });

  it('rejects unknown operator strings with a useful message', () => {
    const step: EncodableStep = {
      kind: 'branch_on_var',
      params: {
        varId: 0x4000,
        value: 0,
        operator: 'gizmonotal', // bogus
        targetRomPtr: 0x08000000,
      },
    };
    expect(() => encodeStep(step, ctx)).toThrowError(
      /unknown operator "gizmonotal"/,
    );
  });

  it('rejects missing operator', () => {
    const step: EncodableStep = {
      kind: 'branch_on_var',
      params: {
        varId: 0x4000,
        value: 0,
        targetRomPtr: 0x08000000,
      },
    };
    expect(() => encodeStep(step, ctx)).toThrowError(/operator/);
  });
});

describe('branch_on_var - decoder pattern recognition', () => {
  it('collapses "compare; goto_if" pair into a single branch_on_var step', () => {
    // compare 0x40D0, 3
    // goto_if 4, 0x08123456 (4 = greaterorequal)
    // end
    const bytes = [
      0x21, 0xd0, 0x40, 0x03, 0x00,
      0x06, 0x04, 0x56, 0x34, 0x12, 0x08,
      0x02,
    ];
    const { rom, scriptOffset } = makeRom(new Uint8Array(bytes));
    const decoded = decodeBinaryScript(rom, scriptOffset);
    // Two steps: the collapsed branch_on_var + end.
    expect(decoded.steps.length).toBe(2);
    expect(decoded.steps[0]!.kind).toBe('branch_on_var');
    expect(decoded.steps[0]!.params['varId']).toBe(0x40d0);
    expect(decoded.steps[0]!.params['value']).toBe(3);
    expect(decoded.steps[0]!.params['operator']).toBe('greaterorequal');
    expect(decoded.steps[0]!.params['targetRomPtr']).toBe(0x08123456);
    expect(decoded.steps[1]!.kind).toBe('raw'); // end
  });

  it('does NOT collapse a bare `compare` not followed by `goto_if`', () => {
    // compare 0x4001, 1
    // setflag 0x800  ← NOT goto_if, so the compare stays as a branch step
    // end
    const bytes = [
      0x21, 0x01, 0x40, 0x01, 0x00,
      0x29, 0x00, 0x08,
      0x02,
    ];
    const { rom, scriptOffset } = makeRom(new Uint8Array(bytes));
    const decoded = decodeBinaryScript(rom, scriptOffset);
    // 3 steps: compare (branch), setflag, end.
    expect(decoded.steps.length).toBe(3);
    expect(decoded.steps[0]!.kind).toBe('branch');
    expect(decoded.steps[0]!.params['opcodeName']).toBe('compare');
  });

  it('does NOT collapse when goto_if condition byte is out-of-range', () => {
    // Condition byte 0xff is unknown → don't collapse; fall through.
    const bytes = [
      0x21, 0x01, 0x40, 0x01, 0x00,
      0x06, 0xff, 0x00, 0x00, 0x00, 0x08,
      0x02,
    ];
    const { rom, scriptOffset } = makeRom(new Uint8Array(bytes));
    const decoded = decodeBinaryScript(rom, scriptOffset);
    // The two opcodes should decode separately: compare (branch) + goto_if (branch) + end.
    expect(decoded.steps.length).toBe(3);
    expect(decoded.steps[0]!.kind).toBe('branch');
    expect(decoded.steps[0]!.params['opcodeName']).toBe('compare');
    expect(decoded.steps[1]!.kind).toBe('branch');
    expect(decoded.steps[1]!.params['opcodeName']).toBe('goto_if');
  });
});

describe('branch_on_var - round-trip', () => {
  const ctx: EncodeContext = {
    allocate() {
      throw new Error('allocator should not be called for branch_on_var');
    },
  };

  function roundTrip(bytes: number[]): void {
    const { rom, scriptOffset } = makeRom(new Uint8Array(bytes));
    const decoded = decodeBinaryScript(rom, scriptOffset);
    const encoded = encodeScript(
      decoded.steps.map((s) => ({ kind: s.kind, params: s.params })),
      ctx,
    );
    const expected = bytes.slice(0, decoded.bytesConsumed);
    expect(Array.from(encoded.slice(0, expected.length))).toEqual(expected);
  }

  it('round-trips all six operators', () => {
    for (const cond of [0, 1, 2, 3, 4, 5]) {
      roundTrip([
        0x21, 0x01, 0x40, 0x07, 0x00, // compare 0x4001, 7
        0x06, cond, 0x78, 0x56, 0x34, 0x08, // goto_if cond, 0x08345678
        0x02, // end
      ]);
    }
  });

  it('round-trips the Resonance-Alignment-shaped pattern (var 0x40D0)', () => {
    roundTrip([
      0x21, 0xd0, 0x40, 0x03, 0x00, // compare 0x40D0, 3
      0x06, 0x04, 0x56, 0x34, 0x12, 0x08, // goto_if 4 (≥), 0x08123456
      0x02, // end
    ]);
  });
});

describe('round-trip - encoded string ↔ allocator', () => {
  it('encodes a dialogue step with new text + roundtrips the bytecode shape', () => {
    let allocatedOffset = 0x180000;
    const ctx: EncodeContext = {
      allocate(req) {
        // The allocator returns where the bytes will live; the encoder
        // converts to a GBA pointer. We verify the encoded text is
        // exactly what the codec would produce.
        const fresh = encodeString('Hello!');
        expect(req.bytes.length).toBe(fresh.length);
        for (let i = 0; i < fresh.length; i++) {
          expect(req.bytes[i]).toBe(fresh[i]);
        }
        return allocatedOffset;
      },
    };
    const step: EncodableStep = {
      kind: 'dialogue',
      params: { dialogueText: 'Hello!', stdType: 4 },
    };
    const bytes = encodeStep(step, ctx);
    expect(bytes.length).toBe(8); // loadword (6) + callstd (2)
  });
});
