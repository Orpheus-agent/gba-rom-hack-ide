/**
 * WP-B v2.2 - High-level savedata helpers built on EmulatorMemory.
 *
 * The debug menu calls these with plain English ("set this flag",
 * "give the player $999999", "heal the party") and this layer fans
 * out to the right EmulatorMemory writes at the right offsets per
 * the family's SaveBlockFieldLayout.
 *
 * Every helper has the same shape:
 *   1. Resolve the SaveBlock base address by dereferencing the
 *      per-family IWRAM pointer.
 *   2. Compute the field's absolute EWRAM address: base + offset.
 *   3. Read / write via the memory bridge.
 *   4. Handle game-specific quirks (money XOR encryption, badge bits).
 *
 * All offsets are sourced from pret's include/global.h via
 * savedataLayout.ts; nothing in this file hardcodes a hex address.
 */

import type { EmulatorMemory } from './emulatorMemory';
import {
  getSaveBlockLayout,
  SAVEBLOCK_POINTERS,
  BADGE_FLAG_IDS,
  FLAGS_COUNT_BY_FAMILY,
  VARS_COUNT_BY_FAMILY,
  VARS_START_BASE,
  type SupportedFamily,
  type SaveBlock,
} from './savedataLayout';

/** Resolve the live EWRAM base address for a given SaveBlock by
 *  dereferencing the per-family IWRAM pointer. Returns the GBA-bus
 *  address (0x02xxxxxx-range), NOT a savestate offset.
 *
 *  Throws if the pointer reads as 0 - that happens when the game
 *  hasn't booted past the title screen yet (the SaveBlock pointers
 *  are set during CB2_InitCopyrightScreenAfterBootup, before the
 *  title screen renders). The debug menu shows a "Press Start to
 *  reach the title screen" hint instead of calling write helpers
 *  when this throws. */
export async function getSaveBlockBase(
  mem: EmulatorMemory,
  family: SupportedFamily,
  block: SaveBlock,
): Promise<number> {
  const ptrAddr =
    block === 'sb1' ? SAVEBLOCK_POINTERS[family].sb1 : SAVEBLOCK_POINTERS[family].sb2;
  const ptr = await mem.readU32LE(ptrAddr);
  if (ptr === 0) {
    throw new Error(
      `SaveBlock${block === 'sb1' ? '1' : '2'} pointer at 0x${ptrAddr.toString(16)} reads as 0 - the game hasn't initialized its save blocks yet. Wait for the title screen to appear.`,
    );
  }
  // Sanity: must point into EWRAM (0x02000000-0x0203FFFF).
  if (ptr < 0x02000000 || ptr >= 0x02040000) {
    throw new Error(
      `SaveBlock${block === 'sb1' ? '1' : '2'} pointer 0x${ptr.toString(16)} is outside EWRAM (0x02000000-0x0203FFFF). The ROM may be a non-vanilla fork with a different SaveBlock layout.`,
    );
  }
  return ptr;
}

/** Compute the absolute EWRAM address of a field within a SaveBlock. */
async function resolveFieldAddress(
  mem: EmulatorMemory,
  family: SupportedFamily,
  block: SaveBlock,
  offsetWithinBlock: number,
): Promise<number> {
  const base = await getSaveBlockBase(mem, family, block);
  return base + offsetWithinBlock;
}

// ────────────────────────────────────────────────────────────────
// Flag helpers
// ────────────────────────────────────────────────────────────────

/** Read whether a specific flag (by numeric flag id) is currently set.
 *  Flag N → byte N/8, bit N%8 in the flagsArray region. */
export async function getFlag(
  mem: EmulatorMemory,
  family: SupportedFamily,
  flagId: number,
): Promise<boolean> {
  const totalFlags = FLAGS_COUNT_BY_FAMILY[family];
  if (flagId < 0 || flagId >= totalFlags) {
    throw new RangeError(
      `Flag id ${String(flagId)} out of range [0, ${String(totalFlags)}) for ${family}`,
    );
  }
  const layout = getSaveBlockLayout(family);
  const byteOffset = Math.floor(flagId / 8);
  const bitMask = 1 << (flagId % 8);
  const addr = await resolveFieldAddress(mem, family, layout.flagsArray.block, layout.flagsArray.offset + byteOffset);
  const byte = await mem.readU8(addr);
  return (byte & bitMask) !== 0;
}

/** Set or clear a flag. */
export async function setFlag(
  mem: EmulatorMemory,
  family: SupportedFamily,
  flagId: number,
  value: boolean,
): Promise<void> {
  const totalFlags = FLAGS_COUNT_BY_FAMILY[family];
  if (flagId < 0 || flagId >= totalFlags) {
    throw new RangeError(
      `Flag id ${String(flagId)} out of range [0, ${String(totalFlags)}) for ${family}`,
    );
  }
  const layout = getSaveBlockLayout(family);
  const byteOffset = Math.floor(flagId / 8);
  const bitMask = 1 << (flagId % 8);
  const addr = await resolveFieldAddress(mem, family, layout.flagsArray.block, layout.flagsArray.offset + byteOffset);
  const current = await mem.readU8(addr);
  const next = value ? current | bitMask : current & ~bitMask & 0xff;
  if (next !== current) {
    await mem.writeU8(addr, next);
  }
}

// ────────────────────────────────────────────────────────────────
// Variable helpers
// ────────────────────────────────────────────────────────────────

/** Convert a pret VAR_* id (in the 0x4000-0x40FF range) to a byte
 *  offset within the vars array. */
function varOffsetWithinArray(varId: number, family: SupportedFamily): number {
  const totalVars = VARS_COUNT_BY_FAMILY[family];
  const idxFromStart = varId - VARS_START_BASE;
  if (idxFromStart < 0 || idxFromStart >= totalVars) {
    throw new RangeError(
      `Variable id 0x${varId.toString(16)} (index ${String(idxFromStart)}) out of range [0, ${String(totalVars)}) for ${family}. VAR_* ids are 0x4000-based.`,
    );
  }
  return idxFromStart * 2;
}

export async function getVar(
  mem: EmulatorMemory,
  family: SupportedFamily,
  varId: number,
): Promise<number> {
  const layout = getSaveBlockLayout(family);
  const off = varOffsetWithinArray(varId, family);
  const addr = await resolveFieldAddress(mem, family, layout.varsArray.block, layout.varsArray.offset + off);
  return await mem.readU16LE(addr);
}

export async function setVar(
  mem: EmulatorMemory,
  family: SupportedFamily,
  varId: number,
  value: number,
): Promise<void> {
  const layout = getSaveBlockLayout(family);
  const off = varOffsetWithinArray(varId, family);
  const addr = await resolveFieldAddress(mem, family, layout.varsArray.block, layout.varsArray.offset + off);
  await mem.writeU16LE(addr, value);
}

// ────────────────────────────────────────────────────────────────
// Money + coins (XOR-encrypted with SaveBlock2.encryptionKey)
// ────────────────────────────────────────────────────────────────

/** Read the SaveBlock2 encryption key. Cached per-call rather than
 *  per-session because the key can change (notably after a save: the
 *  encryption is re-randomized on each save-write). Reading it
 *  fresh each time keeps us correct without a cache-invalidation
 *  bug. */
async function getEncryptionKey(
  mem: EmulatorMemory,
  family: SupportedFamily,
): Promise<number> {
  const layout = getSaveBlockLayout(family);
  const addr = await resolveFieldAddress(mem, family, 'sb2', layout.encryptionKey.offset);
  return await mem.readU32LE(addr);
}

export async function getMoney(
  mem: EmulatorMemory,
  family: SupportedFamily,
): Promise<number> {
  const layout = getSaveBlockLayout(family);
  const addr = await resolveFieldAddress(mem, family, layout.money.block, layout.money.offset);
  const key = await getEncryptionKey(mem, family);
  const enc = await mem.readU32LE(addr);
  return (enc ^ key) >>> 0;
}

export async function setMoney(
  mem: EmulatorMemory,
  family: SupportedFamily,
  amount: number,
): Promise<void> {
  if (!Number.isInteger(amount) || amount < 0 || amount > 999999) {
    throw new RangeError(
      `Money amount ${String(amount)} out of range [0, 999999]. (Gen-3 money cap is 999999.)`,
    );
  }
  const layout = getSaveBlockLayout(family);
  const addr = await resolveFieldAddress(mem, family, layout.money.block, layout.money.offset);
  const key = await getEncryptionKey(mem, family);
  await mem.writeU32LE(addr, (amount ^ key) >>> 0);
}

// ────────────────────────────────────────────────────────────────
// Badges (8 flag bits)
// ────────────────────────────────────────────────────────────────

/** Returns an array of 8 booleans for the 8 gym badges. */
export async function getBadges(
  mem: EmulatorMemory,
  family: SupportedFamily,
): Promise<boolean[]> {
  const ids = BADGE_FLAG_IDS[family];
  const out: boolean[] = [];
  for (const id of ids) {
    out.push(await getFlag(mem, family, id));
  }
  return out;
}

export async function setBadge(
  mem: EmulatorMemory,
  family: SupportedFamily,
  badgeIndex: number,
  owned: boolean,
): Promise<void> {
  if (!Number.isInteger(badgeIndex) || badgeIndex < 0 || badgeIndex > 7) {
    throw new RangeError(`Badge index ${String(badgeIndex)} out of range [0, 7]`);
  }
  const id = BADGE_FLAG_IDS[family][badgeIndex]!;
  await setFlag(mem, family, id, owned);
}

// ────────────────────────────────────────────────────────────────
// Player name + gender
// ────────────────────────────────────────────────────────────────

/** Gen-3 character → byte table (subset adequate for player names).
 *  Source: pret/agbcc/charmap.txt. Supports A-Z, a-z, 0-9, space,
 *  and common punctuation. Names longer than PLAYER_NAME_LENGTH=7
 *  are truncated. */
const GEN3_CHAR_TABLE: Readonly<Record<string, number>> = {
  ' ': 0x00,
  '0': 0xa1, '1': 0xa2, '2': 0xa3, '3': 0xa4, '4': 0xa5,
  '5': 0xa6, '6': 0xa7, '7': 0xa8, '8': 0xa9, '9': 0xaa,
  'A': 0xbb, 'B': 0xbc, 'C': 0xbd, 'D': 0xbe, 'E': 0xbf,
  'F': 0xc0, 'G': 0xc1, 'H': 0xc2, 'I': 0xc3, 'J': 0xc4,
  'K': 0xc5, 'L': 0xc6, 'M': 0xc7, 'N': 0xc8, 'O': 0xc9,
  'P': 0xca, 'Q': 0xcb, 'R': 0xcc, 'S': 0xcd, 'T': 0xce,
  'U': 0xcf, 'V': 0xd0, 'W': 0xd1, 'X': 0xd2, 'Y': 0xd3, 'Z': 0xd4,
  'a': 0xd5, 'b': 0xd6, 'c': 0xd7, 'd': 0xd8, 'e': 0xd9,
  'f': 0xda, 'g': 0xdb, 'h': 0xdc, 'i': 0xdd, 'j': 0xde,
  'k': 0xdf, 'l': 0xe0, 'm': 0xe1, 'n': 0xe2, 'o': 0xe3,
  'p': 0xe4, 'q': 0xe5, 'r': 0xe6, 's': 0xe7, 't': 0xe8,
  'u': 0xe9, 'v': 0xea, 'w': 0xeb, 'x': 0xec, 'y': 0xed, 'z': 0xee,
};
const GEN3_TERMINATOR = 0xff;

/** Encode a string as Gen-3 player-name bytes. Up to 7 chars + 0xFF
 *  terminator (8 bytes total). Unknown chars become spaces. */
export function encodePlayerName(name: string): Uint8Array {
  const out = new Uint8Array(8).fill(GEN3_TERMINATOR);
  const trimmed = name.slice(0, 7);
  for (let i = 0; i < trimmed.length; i++) {
    out[i] = GEN3_CHAR_TABLE[trimmed[i]!] ?? GEN3_CHAR_TABLE[' ']!;
  }
  // out[trimmed.length] is already 0xFF from fill().
  return out;
}

/** Decode Gen-3 player-name bytes back to a string. Stops at the
 *  first 0xFF terminator. Unknown bytes become '?'. */
export function decodePlayerName(bytes: Uint8Array): string {
  const reverse = new Map<number, string>();
  for (const [ch, byte] of Object.entries(GEN3_CHAR_TABLE)) reverse.set(byte, ch);
  let out = '';
  for (const b of bytes) {
    if (b === GEN3_TERMINATOR) break;
    out += reverse.get(b) ?? '?';
  }
  return out;
}

export async function getPlayerName(
  mem: EmulatorMemory,
  family: SupportedFamily,
): Promise<string> {
  const layout = getSaveBlockLayout(family);
  const addr = await resolveFieldAddress(mem, family, layout.playerName.block, layout.playerName.offset);
  const bytes = await mem.readBytes(addr, layout.playerName.size);
  return decodePlayerName(bytes);
}

export async function setPlayerName(
  mem: EmulatorMemory,
  family: SupportedFamily,
  name: string,
): Promise<void> {
  const layout = getSaveBlockLayout(family);
  const addr = await resolveFieldAddress(mem, family, layout.playerName.block, layout.playerName.offset);
  await mem.writeBytes(addr, encodePlayerName(name));
}

export async function getPlayerGender(
  mem: EmulatorMemory,
  family: SupportedFamily,
): Promise<'male' | 'female'> {
  const layout = getSaveBlockLayout(family);
  const addr = await resolveFieldAddress(mem, family, layout.playerGender.block, layout.playerGender.offset);
  const b = await mem.readU8(addr);
  return b === 0 ? 'male' : 'female';
}

export async function setPlayerGender(
  mem: EmulatorMemory,
  family: SupportedFamily,
  gender: 'male' | 'female',
): Promise<void> {
  const layout = getSaveBlockLayout(family);
  const addr = await resolveFieldAddress(mem, family, layout.playerGender.block, layout.playerGender.offset);
  await mem.writeU8(addr, gender === 'male' ? 0 : 1);
}

// ────────────────────────────────────────────────────────────────
// Heal party
// ────────────────────────────────────────────────────────────────

/** Reset every party slot's current-HP byte to maxHP + clear status.
 *  Per pret/include/pokemon.h struct Pokemon party-only fields:
 *    status: u32 at slot offset 0x50
 *    level:  u8  at slot offset 0x54
 *    mail:   u8  at slot offset 0x55
 *    hp:     u16 at slot offset 0x56
 *    maxHP:  u16 at slot offset 0x58
 *    attack: u16 at slot offset 0x5A
 *    ...
 *
 *  We only touch hp and status - not the full party encryption. The
 *  game recomputes stats on the next "switch" or "turn end", so
 *  setting hp = maxHP + status = 0 is the canonical "heal" op. */
const PARTY_SLOT_STATUS_OFFSET = 0x50;
const PARTY_SLOT_HP_OFFSET = 0x56;
const PARTY_SLOT_MAXHP_OFFSET = 0x58;
const PARTY_SLOT_PERSONALITY_OFFSET = 0x00;

export async function healParty(
  mem: EmulatorMemory,
  family: SupportedFamily,
): Promise<{ healedSlots: number }> {
  const layout = getSaveBlockLayout(family);
  const base = await getSaveBlockBase(mem, family, layout.playerParty.block);
  const partyBase = base + layout.playerParty.offset;
  let healed = 0;
  for (let i = 0; i < layout.playerParty.slotCount; i++) {
    const slotBase = partyBase + i * layout.playerParty.slotSize;
    // Personality value of 0 == empty slot. Skip.
    const pid = await mem.readU32LE(slotBase + PARTY_SLOT_PERSONALITY_OFFSET);
    if (pid === 0) continue;
    const maxHP = await mem.readU16LE(slotBase + PARTY_SLOT_MAXHP_OFFSET);
    await mem.writeU16LE(slotBase + PARTY_SLOT_HP_OFFSET, maxHP);
    await mem.writeU32LE(slotBase + PARTY_SLOT_STATUS_OFFSET, 0);
    healed++;
  }
  return { healedSlots: healed };
}
