import { describe, expect, it } from 'vitest';
import { decodeBinaryScript } from './binary-script-decoder.js';

// Phase H-RC1 - verify the script bytecode decoder emits typed steps
// for the most common opcodes + detects the msgbox macro pattern
// (loadword 0, PTR; callstd TYPE) and resolves dialogue text.

const ROM_BASE = 0x08000000;
function romPtr(fileOffset: number): number {
  return (ROM_BASE + fileOffset) >>> 0;
}

function makeRom(size = 0x10000): Uint8Array {
  return new Uint8Array(size);
}

/** Write a u32 little-endian at offset. */
function writeU32(buf: Uint8Array, off: number, v: number): void {
  buf[off + 0] = v & 0xff;
  buf[off + 1] = (v >>> 8) & 0xff;
  buf[off + 2] = (v >>> 16) & 0xff;
  buf[off + 3] = (v >>> 24) & 0xff;
}

function writeU16(buf: Uint8Array, off: number, v: number): void {
  buf[off + 0] = v & 0xff;
  buf[off + 1] = (v >>> 8) & 0xff;
}

/** Encode Gen-3 text "HELLO" at offset, followed by terminator. */
function writeGen3String(buf: Uint8Array, off: number, ascii: string): number {
  // Simple ASCII → Gen-3 codec: A=0xBB, B=0xBC, ... Z=0xD4.
  // a=0xD5, b=0xD6, ... Space=0x00.
  for (let i = 0; i < ascii.length; i++) {
    const c = ascii.charCodeAt(i);
    let b: number;
    if (c === 0x20) b = 0x00; // space
    else if (c >= 0x41 && c <= 0x5a) b = 0xbb + (c - 0x41);
    else if (c >= 0x61 && c <= 0x7a) b = 0xd5 + (c - 0x61);
    else b = 0xff;
    buf[off + i] = b;
  }
  buf[off + ascii.length] = 0xff; // terminator
  return ascii.length + 1;
}

describe('decodeBinaryScript - basic terminator + lock + faceplayer', () => {
  it('decodes [lock, faceplayer, releaseall, end] into 4 steps', () => {
    const rom = makeRom();
    const start = 0x1000;
    rom[start + 0] = 0x6a; // lock
    rom[start + 1] = 0x5d; // faceplayer
    rom[start + 2] = 0x6b; // releaseall
    rom[start + 3] = 0x02; // end

    const decoded = decodeBinaryScript(rom, start);
    expect(decoded.steps.length).toBe(4);
    expect(decoded.steps[0]!.label).toBe('Lock player');
    expect(decoded.steps[1]!.label).toBe('Face player');
    expect(decoded.steps[2]!.label).toBe('Release all NPCs');
    expect(decoded.steps[3]!.label).toBe('End script');
    expect(decoded.stoppedReason).toBe('terminator');
  });
});

describe('decodeBinaryScript - flag operations', () => {
  it('decodes setflag and exposes the flag id', () => {
    const rom = makeRom();
    const start = 0x1000;
    rom[start + 0] = 0x29; // setflag
    writeU16(rom, start + 1, 0x0800);
    rom[start + 3] = 0x02; // end

    const decoded = decodeBinaryScript(rom, start);
    expect(decoded.steps.length).toBe(2);
    expect(decoded.steps[0]!.kind).toBe('set_flag');
    expect(decoded.steps[0]!.params.flagId).toBe(0x800);
    expect(decoded.steps[0]!.label).toBe('Set flag 0x800');
  });
});

describe('decodeBinaryScript - msgbox macro pattern', () => {
  it('detects loadword 0 + callstd 4 as a single dialogue step + decodes the text', () => {
    const rom = makeRom();
    const textOff = 0x2000;
    writeGen3String(rom, textOff, 'HELLO WORLD');

    const start = 0x1000;
    // loadword 0, textPtr
    rom[start + 0] = 0x0f; // loadword
    rom[start + 1] = 0x00; // bank 0
    writeU32(rom, start + 2, romPtr(textOff));
    // callstd 4
    rom[start + 6] = 0x09; // callstd
    rom[start + 7] = 0x04; // type 4 = msg_default
    // end
    rom[start + 8] = 0x02;

    const decoded = decodeBinaryScript(rom, start);
    // Should be 2 steps: the msgbox + the end.
    expect(decoded.steps.length).toBe(2);
    expect(decoded.steps[0]!.kind).toBe('dialogue');
    expect(decoded.steps[0]!.params.dialogueText).toBe('HELLO WORLD');
    expect(decoded.steps[0]!.label).toContain('HELLO WORLD');
    expect(decoded.steps[1]!.label).toBe('End script');
  });

  it('does NOT collapse loadword 0 + callstd 100 (non-msgbox std)', () => {
    const rom = makeRom();
    const start = 0x1000;
    rom[start + 0] = 0x0f; // loadword
    rom[start + 1] = 0x00;
    writeU32(rom, start + 2, romPtr(0x2000));
    rom[start + 6] = 0x09; // callstd
    rom[start + 7] = 100; // not in MSGBOX_CALLSTD_TYPES
    rom[start + 8] = 0x02; // end

    const decoded = decodeBinaryScript(rom, start);
    expect(decoded.steps.length).toBe(3);
    expect(decoded.steps[0]!.kind).not.toBe('dialogue');
  });
});

describe('decodeBinaryScript - applymovement decodes the sequence', () => {
  it('walks the movement-data block until 0xFE and stashes the bytes', () => {
    const rom = makeRom();
    const moveOff = 0x2000;
    rom[moveOff + 0] = 0x10; // walk_left
    rom[moveOff + 1] = 0x11; // walk_right
    rom[moveOff + 2] = 0x12; // walk_up
    rom[moveOff + 3] = 0xfe; // end

    const start = 0x1000;
    rom[start + 0] = 0x4f; // applymovement
    writeU16(rom, start + 1, 0x0001); // object id 1
    writeU32(rom, start + 3, romPtr(moveOff));
    rom[start + 7] = 0x02; // end

    const decoded = decodeBinaryScript(rom, start);
    expect(decoded.steps.length).toBe(2);
    expect(decoded.steps[0]!.kind).toBe('move_npc');
    expect(decoded.steps[0]!.params.objectId).toBe(1);
    expect(decoded.steps[0]!.params.movementSequence).toEqual([0x10, 0x11, 0x12]);
    expect(decoded.steps[0]!.label).toContain('3 steps');
  });
});

describe('decodeBinaryScript - unknown opcodes emit raw + keep walking', () => {
  it('emits an Unknown opcode step for an unmapped byte', () => {
    const rom = makeRom();
    const start = 0x1000;
    rom[start + 0] = 0xa5; // not in our table
    rom[start + 1] = 0x02; // end

    const decoded = decodeBinaryScript(rom, start);
    expect(decoded.steps.length).toBe(2);
    expect(decoded.steps[0]!.kind).toBe('raw');
    expect(decoded.steps[0]!.label).toContain('Unknown opcode 0xa5');
  });
});

describe('decodeBinaryScript - bounds + cap', () => {
  it('returns invalid_offset for a negative entry offset', () => {
    const rom = makeRom();
    const decoded = decodeBinaryScript(rom, -1);
    expect(decoded.stoppedReason).toBe('invalid_offset');
    expect(decoded.steps.length).toBe(0);
  });

  it('caps at MAX_OPCODES_PER_SCRIPT to avoid runaway walks', () => {
    const rom = makeRom();
    rom.fill(0x6a, 0x1000); // lock x 1000s of times - never terminates
    const decoded = decodeBinaryScript(rom, 0x1000);
    expect(decoded.stoppedReason).toBe('max_opcodes');
    expect(decoded.steps.length).toBeLessThanOrEqual(256);
  });
});

describe('decodeBinaryScript - call/goto capture pointer args', () => {
  it('decodes call with target offset', () => {
    const rom = makeRom();
    const start = 0x1000;
    rom[start + 0] = 0x04; // call
    writeU32(rom, start + 1, romPtr(0x3000));
    rom[start + 5] = 0x02; // end (without this, decoder caps)

    const decoded = decodeBinaryScript(rom, start);
    expect(decoded.steps[0]!.kind).toBe('branch');
    expect(decoded.steps[0]!.params.targetRomPtr).toBe(romPtr(0x3000));
    expect(decoded.steps[0]!.params.targetFileOffset).toBe(0x3000);
  });
});
