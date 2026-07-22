/**
 * WP-B v2.2 - savedataResolver tests.
 *
 * Each test builds a synthetic 397312-byte savestate buffer, plants
 * the per-family SaveBlock pointers at their IWRAM addresses
 * (FRLG: 0x03005008/C, Emerald: 0x03005D8C/90), wires those pointers
 * to fake EWRAM SaveBlock base addresses, and verifies the resolver
 * helpers read/write the right bytes via the EmulatorMemory bridge.
 *
 * The buffer manipulation here is THE INVERSE of what the resolver
 * does at runtime, so getting either side wrong is caught by the
 * other. Both sides are verified against pret's include/global.h.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import {
  EmulatorMemory,
  SAVESTATE_TOTAL_SIZE,
  SAVESTATE_EWRAM_OFFSET,
  SAVESTATE_IWRAM_OFFSET,
  type EmulatorMemoryHost,
} from './emulatorMemory';
import {
  getSaveBlockBase,
  getFlag,
  setFlag,
  getVar,
  setVar,
  getMoney,
  setMoney,
  getBadges,
  setBadge,
  getPlayerName,
  setPlayerName,
  getPlayerGender,
  setPlayerGender,
  healParty,
  encodePlayerName,
  decodePlayerName,
} from './savedataResolver';
import { SAVEBLOCK_LAYOUT_FRLG, SAVEBLOCK_LAYOUT_EMERALD } from './savedataLayout';

/** Build a fake host with a savestate buffer the resolver can
 *  read/write through. The returned `buffer` is a mutable holder
 *  so tests can read `buffer.buffer` after loadAutoSaveState
 *  swaps the live bytes. */
function makeHost(): {
  host: EmulatorMemoryHost;
  buffer: { buffer: Uint8Array };
} {
  const state = { buffer: new Uint8Array(SAVESTATE_TOTAL_SIZE) };
  let staged: Uint8Array | null = null;
  const host: EmulatorMemoryHost = {
    forceAutoSaveState: () => true,
    getAutoSaveState: () => ({
      autoSaveStateName: '/data/autosave/fake.ssm',
      data: new Uint8Array(state.buffer),
    }),
    uploadAutoSaveState: async (_name, data) => {
      staged = new Uint8Array(data);
    },
    loadAutoSaveState: () => {
      if (staged) {
        state.buffer = staged;
        staged = null;
      }
      return true;
    },
  };
  return { host, buffer: state };
}

/** Plant a u32 LE in the savestate buffer at a GBA IWRAM address.
 *  Mirrors EmulatorMemory's gbaAddressToSavestateOffset internally. */
function plantIwramU32(buf: Uint8Array, gbaAddr: number, value: number): void {
  const off = SAVESTATE_IWRAM_OFFSET + (gbaAddr - 0x03000000);
  buf[off + 0] = value & 0xff;
  buf[off + 1] = (value >>> 8) & 0xff;
  buf[off + 2] = (value >>> 16) & 0xff;
  buf[off + 3] = (value >>> 24) & 0xff;
}

/** Read a u32 LE from EWRAM at the given GBA address (for assertions). */
function readEwramU32(buf: Uint8Array, gbaAddr: number): number {
  const off = SAVESTATE_EWRAM_OFFSET + (gbaAddr - 0x02000000);
  return (
    ((buf[off + 0]! | (buf[off + 1]! << 8) | (buf[off + 2]! << 16) | (buf[off + 3]! << 24)) >>> 0)
  );
}

/** Set up a host pre-seeded with realistic FRLG SaveBlock pointers.
 *  We pick arbitrary-but-valid EWRAM addresses for the two SaveBlocks
 *  that don't collide with each other. */
function makeFrlgHost(opts?: { sb1Base?: number; sb2Base?: number }): {
  host: EmulatorMemoryHost;
  buffer: { buffer: Uint8Array };
  sb1Base: number;
  sb2Base: number;
} {
  const sb1Base = opts?.sb1Base ?? 0x02024284;
  const sb2Base = opts?.sb2Base ?? 0x02025838;
  const { host, buffer } = makeHost();
  // Plant the IWRAM pointers so getSaveBlockBase resolves correctly.
  plantIwramU32(buffer.buffer, 0x03005008, sb1Base);
  plantIwramU32(buffer.buffer, 0x0300500c, sb2Base);
  return { host, buffer, sb1Base, sb2Base };
}

function makeEmeraldHost(opts?: { sb1Base?: number; sb2Base?: number }): {
  host: EmulatorMemoryHost;
  buffer: { buffer: Uint8Array };
  sb1Base: number;
  sb2Base: number;
} {
  const sb1Base = opts?.sb1Base ?? 0x02025a00;
  const sb2Base = opts?.sb2Base ?? 0x02024a00;
  const { host, buffer } = makeHost();
  plantIwramU32(buffer.buffer, 0x03005d8c, sb1Base);
  plantIwramU32(buffer.buffer, 0x03005d90, sb2Base);
  return { host, buffer, sb1Base, sb2Base };
}

// ────────────────────────────────────────────────────────────────
// getSaveBlockBase
// ────────────────────────────────────────────────────────────────

describe('getSaveBlockBase', () => {
  it('dereferences the FRLG IWRAM pointer to find the live SB1 EWRAM base', async () => {
    const { host, sb1Base } = makeFrlgHost();
    const mem = new EmulatorMemory(host);
    expect(await getSaveBlockBase(mem, 'firered-vanilla', 'sb1')).toBe(sb1Base);
  });

  it('dereferences for SB2 too', async () => {
    const { host, sb2Base } = makeFrlgHost();
    const mem = new EmulatorMemory(host);
    expect(await getSaveBlockBase(mem, 'firered-vanilla', 'sb2')).toBe(sb2Base);
  });

  it('works for Emerald with its distinct pointer addresses', async () => {
    const { host, sb1Base, sb2Base } = makeEmeraldHost();
    const mem = new EmulatorMemory(host);
    expect(await getSaveBlockBase(mem, 'emerald-vanilla', 'sb1')).toBe(sb1Base);
    expect(await getSaveBlockBase(mem, 'emerald-vanilla', 'sb2')).toBe(sb2Base);
  });

  it('throws when the SaveBlock pointer reads as 0 (game not booted past title)', async () => {
    const { host } = makeHost(); // No pointers planted; all zeros.
    const mem = new EmulatorMemory(host);
    await expect(getSaveBlockBase(mem, 'firered-vanilla', 'sb1')).rejects.toThrow(
      /hasn't initialized|reads as 0/i,
    );
  });

  it('throws when the SaveBlock pointer is outside EWRAM', async () => {
    const { host, buffer } = makeHost();
    plantIwramU32(buffer.buffer, 0x03005008, 0x08000000); // ROM, not EWRAM
    const mem = new EmulatorMemory(host);
    await expect(getSaveBlockBase(mem, 'firered-vanilla', 'sb1')).rejects.toThrow(
      /outside EWRAM/,
    );
  });
});

// ────────────────────────────────────────────────────────────────
// Flags
// ────────────────────────────────────────────────────────────────

describe('getFlag / setFlag (FRLG)', () => {
  it('setFlag(true) sets the right bit; getFlag returns true', async () => {
    const { host, buffer, sb1Base } = makeFrlgHost();
    const mem = new EmulatorMemory(host);
    // Pick FLAG_BADGE01_GET = 0x820 → byte 0x820/8 = 0x104, bit 0
    await setFlag(mem, 'firered-vanilla', 0x820, true);
    expect(await getFlag(mem, 'firered-vanilla', 0x820)).toBe(true);
    // Verify the underlying byte: SB1.flagsArray base = sb1Base + 0xEE0
    // → byte at sb1Base + 0xEE0 + 0x104. Bit 0 set → byte == 0x01.
    const flagByteOffset = SAVEBLOCK_EWRAM_OFFSET(sb1Base) + 0x0ee0 + 0x104;
    expect(buffer.buffer[flagByteOffset]).toBe(0x01);
  });

  it('setFlag(false) clears the right bit', async () => {
    const { host } = makeFrlgHost();
    const mem = new EmulatorMemory(host);
    await setFlag(mem, 'firered-vanilla', 0x820, true);
    expect(await getFlag(mem, 'firered-vanilla', 0x820)).toBe(true);
    await setFlag(mem, 'firered-vanilla', 0x820, false);
    expect(await getFlag(mem, 'firered-vanilla', 0x820)).toBe(false);
  });

  it('flags in different bytes are independent', async () => {
    const { host } = makeFrlgHost();
    const mem = new EmulatorMemory(host);
    await setFlag(mem, 'firered-vanilla', 0x100, true);
    await setFlag(mem, 'firered-vanilla', 0x108, true); // different byte
    expect(await getFlag(mem, 'firered-vanilla', 0x100)).toBe(true);
    expect(await getFlag(mem, 'firered-vanilla', 0x108)).toBe(true);
    await setFlag(mem, 'firered-vanilla', 0x100, false);
    expect(await getFlag(mem, 'firered-vanilla', 0x100)).toBe(false);
    expect(await getFlag(mem, 'firered-vanilla', 0x108)).toBe(true);
  });

  it('rejects flag IDs outside the family range', async () => {
    const { host } = makeFrlgHost();
    const mem = new EmulatorMemory(host);
    // FRLG has 2304 flags (288 * 8)
    await expect(setFlag(mem, 'firered-vanilla', 2304, true)).rejects.toThrow(/out of range/);
    await expect(setFlag(mem, 'firered-vanilla', -1, true)).rejects.toThrow(/out of range/);
  });
});

describe('Vars', () => {
  it('setVar(0x4001, 25) stored at vars + 2*1 = offset+2', async () => {
    const { host, buffer, sb1Base } = makeFrlgHost();
    const mem = new EmulatorMemory(host);
    await setVar(mem, 'firered-vanilla', 0x4001, 25);
    expect(await getVar(mem, 'firered-vanilla', 0x4001)).toBe(25);
    // Verify underlying bytes at SB1 0x1000 + 2
    const off = SAVEBLOCK_EWRAM_OFFSET(sb1Base) + 0x1000 + 2;
    expect(buffer.buffer[off]).toBe(25);
    expect(buffer.buffer[off + 1]).toBe(0);
  });

  it('setVar handles u16 values correctly', async () => {
    const { host } = makeFrlgHost();
    const mem = new EmulatorMemory(host);
    await setVar(mem, 'firered-vanilla', 0x4002, 0xabcd);
    expect(await getVar(mem, 'firered-vanilla', 0x4002)).toBe(0xabcd);
  });

  it('rejects vars outside the 0x4000-based range', async () => {
    const { host } = makeFrlgHost();
    const mem = new EmulatorMemory(host);
    await expect(setVar(mem, 'firered-vanilla', 0x3fff, 0)).rejects.toThrow(/out of range/);
    await expect(setVar(mem, 'firered-vanilla', 0x4100, 0)).rejects.toThrow(/out of range/);
  });
});

// ────────────────────────────────────────────────────────────────
// Money (XOR-encrypted)
// ────────────────────────────────────────────────────────────────

describe('Money (XOR-encrypted with encryptionKey)', () => {
  it('setMoney(N) → getMoney returns N (XOR handled correctly)', async () => {
    const { host, buffer, sb2Base } = makeFrlgHost();
    const mem = new EmulatorMemory(host);
    // Plant a non-zero encryption key in SB2 at 0xF20 so the XOR is
    // exercised. (If key were 0, XOR is identity and we'd miss a bug.)
    const key = 0xdeadbeef;
    const keyOff = SAVEBLOCK_EWRAM_OFFSET(sb2Base) + 0x0f20;
    buffer.buffer[keyOff + 0] = key & 0xff;
    buffer.buffer[keyOff + 1] = (key >>> 8) & 0xff;
    buffer.buffer[keyOff + 2] = (key >>> 16) & 0xff;
    buffer.buffer[keyOff + 3] = (key >>> 24) & 0xff;

    await setMoney(mem, 'firered-vanilla', 12345);
    expect(await getMoney(mem, 'firered-vanilla')).toBe(12345);
  });

  it('the underlying stored u32 is XOR(money, key) - not the plaintext money', async () => {
    const { host, buffer, sb1Base, sb2Base } = makeFrlgHost();
    const mem = new EmulatorMemory(host);
    const key = 0x12345678;
    const keyOff = SAVEBLOCK_EWRAM_OFFSET(sb2Base) + 0x0f20;
    buffer.buffer[keyOff + 0] = key & 0xff;
    buffer.buffer[keyOff + 1] = (key >>> 8) & 0xff;
    buffer.buffer[keyOff + 2] = (key >>> 16) & 0xff;
    buffer.buffer[keyOff + 3] = (key >>> 24) & 0xff;

    const money = 100;
    await setMoney(mem, 'firered-vanilla', money);
    // The bytes at SB1 0x290 should be (money ^ key) LE, NOT money LE.
    const stored = readEwramU32(buffer.buffer, sb1Base + 0x290);
    expect(stored).toBe((money ^ key) >>> 0);
    expect(stored).not.toBe(money);
  });

  it('Emerald money lives at SB1 0x490 with key at SB2 0x0AC', async () => {
    const { host, buffer, sb1Base, sb2Base } = makeEmeraldHost();
    const mem = new EmulatorMemory(host);
    const key = 0xc0ffee00;
    const keyOff = SAVEBLOCK_EWRAM_OFFSET(sb2Base) + 0x00ac;
    buffer.buffer[keyOff + 0] = key & 0xff;
    buffer.buffer[keyOff + 1] = (key >>> 8) & 0xff;
    buffer.buffer[keyOff + 2] = (key >>> 16) & 0xff;
    buffer.buffer[keyOff + 3] = (key >>> 24) & 0xff;
    await setMoney(mem, 'emerald-vanilla', 99999);
    expect(await getMoney(mem, 'emerald-vanilla')).toBe(99999);
    const stored = readEwramU32(buffer.buffer, sb1Base + 0x490);
    expect(stored).toBe((99999 ^ key) >>> 0);
  });

  it('rejects amounts outside [0, 999999]', async () => {
    const { host } = makeFrlgHost();
    const mem = new EmulatorMemory(host);
    await expect(setMoney(mem, 'firered-vanilla', -1)).rejects.toThrow(/out of range/);
    await expect(setMoney(mem, 'firered-vanilla', 1000000)).rejects.toThrow(/out of range/);
  });
});

// ────────────────────────────────────────────────────────────────
// Badges
// ────────────────────────────────────────────────────────────────

describe('Badges', () => {
  it('all 8 badges start cleared, then setBadge(N, true) sets exactly that one', async () => {
    const { host } = makeFrlgHost();
    const mem = new EmulatorMemory(host);
    const initial = await getBadges(mem, 'firered-vanilla');
    expect(initial).toEqual([false, false, false, false, false, false, false, false]);
    await setBadge(mem, 'firered-vanilla', 0, true);
    expect(await getBadges(mem, 'firered-vanilla')).toEqual([
      true, false, false, false, false, false, false, false,
    ]);
    await setBadge(mem, 'firered-vanilla', 5, true);
    expect(await getBadges(mem, 'firered-vanilla')).toEqual([
      true, false, false, false, false, true, false, false,
    ]);
  });

  it('rejects badge indices outside [0, 7]', async () => {
    const { host } = makeFrlgHost();
    const mem = new EmulatorMemory(host);
    await expect(setBadge(mem, 'firered-vanilla', -1, true)).rejects.toThrow(/out of range/);
    await expect(setBadge(mem, 'firered-vanilla', 8, true)).rejects.toThrow(/out of range/);
  });
});

// ────────────────────────────────────────────────────────────────
// Player name + gender
// ────────────────────────────────────────────────────────────────

describe('encodePlayerName / decodePlayerName', () => {
  it('round-trips a 5-char name', () => {
    const encoded = encodePlayerName('RED');
    expect(encoded).toHaveLength(8);
    expect(encoded[3]).toBe(0xff); // terminator at position 3
    expect(decodePlayerName(encoded)).toBe('RED');
  });

  it('truncates names longer than 7 chars', () => {
    const encoded = encodePlayerName('CHEATERMAX');
    expect(encoded).toHaveLength(8);
    expect(encoded[7]).toBe(0xff);
    expect(decodePlayerName(encoded)).toBe('CHEATER');
  });

  it('handles lowercase + digits', () => {
    const encoded = encodePlayerName('Max123');
    expect(decodePlayerName(encoded)).toBe('Max123');
  });

  it('unknown chars decode as ?', () => {
    const buf = new Uint8Array([0xbb, 0x55, 0xff, 0x00, 0x00, 0x00, 0x00, 0x00]); // A, unknown, terminator
    expect(decodePlayerName(buf)).toBe('A?');
  });

  it('empty string encodes to 8 bytes of 0xFF', () => {
    const encoded = encodePlayerName('');
    expect(encoded[0]).toBe(0xff);
    expect(decodePlayerName(encoded)).toBe('');
  });
});

describe('Player name + gender via the memory bridge', () => {
  it('setPlayerName then getPlayerName round-trips', async () => {
    const { host } = makeFrlgHost();
    const mem = new EmulatorMemory(host);
    await setPlayerName(mem, 'firered-vanilla', 'ASH');
    expect(await getPlayerName(mem, 'firered-vanilla')).toBe('ASH');
  });

  it('setPlayerGender male/female maps to 0/1 byte', async () => {
    const { host, buffer, sb2Base } = makeFrlgHost();
    const mem = new EmulatorMemory(host);
    await setPlayerGender(mem, 'firered-vanilla', 'female');
    expect(await getPlayerGender(mem, 'firered-vanilla')).toBe('female');
    expect(buffer.buffer[SAVEBLOCK_EWRAM_OFFSET(sb2Base) + 0x008]).toBe(1);
    await setPlayerGender(mem, 'firered-vanilla', 'male');
    expect(await getPlayerGender(mem, 'firered-vanilla')).toBe('male');
    expect(buffer.buffer[SAVEBLOCK_EWRAM_OFFSET(sb2Base) + 0x008]).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────
// Heal party
// ────────────────────────────────────────────────────────────────

describe('healParty', () => {
  it('zeroes status + sets HP=maxHP on every non-empty slot', async () => {
    const { host, buffer, sb1Base } = makeFrlgHost();
    const mem = new EmulatorMemory(host);
    // Seed 2 slots with non-zero PIDs (occupied), 4 empty.
    const partyBase = SAVEBLOCK_EWRAM_OFFSET(sb1Base) + 0x038;
    // Slot 0: PID=1, maxHP=42, hp=5, status=0x01 (poison)
    buffer.buffer[partyBase + 0] = 0x01;
    buffer.buffer[partyBase + 0x50] = 0x01; // status
    buffer.buffer[partyBase + 0x56] = 0x05; // hp lo
    buffer.buffer[partyBase + 0x58] = 0x2a; // maxHP lo (42)
    // Slot 1: PID=2, maxHP=100, hp=80, status=0x02
    buffer.buffer[partyBase + 100 + 0] = 0x02;
    buffer.buffer[partyBase + 100 + 0x50] = 0x02;
    buffer.buffer[partyBase + 100 + 0x56] = 0x50;
    buffer.buffer[partyBase + 100 + 0x58] = 0x64; // 100

    const result = await healParty(mem, 'firered-vanilla');
    expect(result.healedSlots).toBe(2);
    expect(buffer.buffer[partyBase + 0x50]).toBe(0);
    expect(buffer.buffer[partyBase + 0x56]).toBe(0x2a); // hp = maxHP
    expect(buffer.buffer[partyBase + 100 + 0x50]).toBe(0);
    expect(buffer.buffer[partyBase + 100 + 0x56]).toBe(0x64);
  });

  it('skips empty slots (PID=0)', async () => {
    const { host } = makeFrlgHost();
    const mem = new EmulatorMemory(host);
    const result = await healParty(mem, 'firered-vanilla');
    expect(result.healedSlots).toBe(0);
  });
});

// Helper: convert an EWRAM GBA address to a buffer offset for direct
// byte assertions. Mirrors EmulatorMemory.gbaAddressToSavestateOffset
// for the EWRAM region only.
function SAVEBLOCK_EWRAM_OFFSET(gbaAddr: number): number {
  return SAVESTATE_EWRAM_OFFSET + (gbaAddr - 0x02000000);
}
