import { describe, expect, it } from 'vitest';
import {
  PARTY_MEMBER_SIZE_BYTES_NO_MOVES,
  PARTY_MEMBER_SIZE_BYTES_WITH_MOVES,
  parseTrainerPartyArray,
  parseTrainerPartyMember,
  partyMemberStructSize,
} from './index.js';

/** Build an 8-byte party member struct for kind 0 (no flags). */
function buildKind0(iv: number, level: number, species: number): Uint8Array {
  const buf = new Uint8Array(PARTY_MEMBER_SIZE_BYTES_NO_MOVES);
  const view = new DataView(buf.buffer);
  view.setUint16(0, iv, true);
  view.setUint16(2, level, true);
  view.setUint16(4, species, true);
  view.setUint16(6, 0, true); // padding
  return buf;
}

/** Kind 1: held item only - same size, padding becomes heldItem. */
function buildKind1(
  iv: number,
  level: number,
  species: number,
  heldItem: number,
): Uint8Array {
  const buf = new Uint8Array(PARTY_MEMBER_SIZE_BYTES_NO_MOVES);
  const view = new DataView(buf.buffer);
  view.setUint16(0, iv, true);
  view.setUint16(2, level, true);
  view.setUint16(4, species, true);
  view.setUint16(6, heldItem, true);
  return buf;
}

/** Kind 2: custom moves only - 16-byte struct, padding at 0x06, moves[4]. */
function buildKind2(
  iv: number,
  level: number,
  species: number,
  moves: ReadonlyArray<number>,
): Uint8Array {
  const buf = new Uint8Array(PARTY_MEMBER_SIZE_BYTES_WITH_MOVES);
  const view = new DataView(buf.buffer);
  view.setUint16(0, iv, true);
  view.setUint16(2, level, true);
  view.setUint16(4, species, true);
  view.setUint16(6, 0, true); // padding
  for (let i = 0; i < 4; i++) view.setUint16(8 + i * 2, moves[i] ?? 0, true);
  return buf;
}

/** Kind 3: both - 16-byte struct with heldItem at 0x06. */
function buildKind3(
  iv: number,
  level: number,
  species: number,
  heldItem: number,
  moves: ReadonlyArray<number>,
): Uint8Array {
  const buf = new Uint8Array(PARTY_MEMBER_SIZE_BYTES_WITH_MOVES);
  const view = new DataView(buf.buffer);
  view.setUint16(0, iv, true);
  view.setUint16(2, level, true);
  view.setUint16(4, species, true);
  view.setUint16(6, heldItem, true);
  for (let i = 0; i < 4; i++) view.setUint16(8 + i * 2, moves[i] ?? 0, true);
  return buf;
}

describe('partyMemberStructSize', () => {
  it('returns 8 bytes for kinds 0 and 1 (no custom moves)', () => {
    expect(partyMemberStructSize(0)).toBe(8);
    expect(partyMemberStructSize(2)).toBe(8);
  });
  it('returns 16 bytes for kinds 2 and 3 (custom moves)', () => {
    expect(partyMemberStructSize(1)).toBe(16);
    expect(partyMemberStructSize(3)).toBe(16);
  });
});

describe('parseTrainerPartyMember', () => {
  it('parses a kind-0 member (no items, default moves)', () => {
    const bytes = buildKind0(31, 25, 25); // Pikachu lvl 25
    const r = parseTrainerPartyMember(bytes, 0, 0);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.member.iv).toBe(31);
      expect(r.member.level).toBe(25);
      expect(r.member.species).toBe(25);
      expect(r.member.heldItem).toBe(0);
      expect(r.member.moves).toEqual([]);
      expect(r.member.kind).toBe(0);
    }
  });

  it('parses a kind-1 member (held item, default moves)', () => {
    const bytes = buildKind1(20, 50, 6, 42); // Charizard with item 42
    const r = parseTrainerPartyMember(bytes, 0, 2);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.member.heldItem).toBe(42);
      expect(r.member.moves).toEqual([]);
      expect(r.member.kind).toBe(2);
    }
  });

  it('parses a kind-2 member (custom moves, no item)', () => {
    const bytes = buildKind2(15, 30, 9, [33, 55, 89, 22]); // Blastoise w/ moves
    const r = parseTrainerPartyMember(bytes, 0, 1);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.member.heldItem).toBe(0);
      expect(r.member.moves).toEqual([33, 55, 89, 22]);
      expect(r.member.kind).toBe(1);
    }
  });

  it('parses a kind-3 member (custom moves + held item)', () => {
    const bytes = buildKind3(31, 100, 384, 99, [100, 200, 300, 400]); // Rayquaza
    const r = parseTrainerPartyMember(bytes, 0, 3);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.member.heldItem).toBe(99);
      expect(r.member.moves).toEqual([100, 200, 300, 400]);
      expect(r.member.species).toBe(384);
      expect(r.member.kind).toBe(3);
    }
  });

  it('rejects level 0 and level > 100', () => {
    expect(parseTrainerPartyMember(buildKind0(0, 0, 1), 0, 0).ok).toBe(false);
    expect(parseTrainerPartyMember(buildKind0(0, 101, 1), 0, 0).ok).toBe(false);
  });

  it('rejects species > 2000', () => {
    expect(parseTrainerPartyMember(buildKind0(0, 50, 2001), 0, 0).ok).toBe(false);
  });

  it('rejects invalid partyFlags', () => {
    const r = parseTrainerPartyMember(buildKind0(0, 50, 1), 0, 4);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('invalid_party_flags');
  });

  it('rejects too-short buffers', () => {
    const r = parseTrainerPartyMember(new Uint8Array(4), 0, 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('too_short');
  });
});

describe('parseTrainerPartyArray', () => {
  it('parses 6 consecutive kind-0 members', () => {
    const struct = PARTY_MEMBER_SIZE_BYTES_NO_MOVES;
    const bytes = new Uint8Array(struct * 6);
    for (let i = 0; i < 6; i++) {
      bytes.set(buildKind0(31, 10 + i * 5, 1 + i), i * struct);
    }
    const r = parseTrainerPartyArray(bytes, 0, 0, 6);
    expect(r.failureAtIndex).toBeNull();
    expect(r.members.length).toBe(6);
    expect(r.members[3]?.level).toBe(25);
    expect(r.members[5]?.species).toBe(6);
  });

  it('bails on the first failed member + reports the index', () => {
    const struct = PARTY_MEMBER_SIZE_BYTES_NO_MOVES;
    const bytes = new Uint8Array(struct * 4);
    bytes.set(buildKind0(31, 50, 100), 0);
    bytes.set(buildKind0(31, 50, 100), struct);
    bytes.set(buildKind0(0, 200, 100), struct * 2); // invalid level
    bytes.set(buildKind0(31, 50, 100), struct * 3);
    const r = parseTrainerPartyArray(bytes, 0, 0, 4);
    expect(r.failureAtIndex).toBe(2);
    expect(r.members.length).toBe(2);
    expect(r.failureReason?.kind).toBe('invalid_level');
  });
});
