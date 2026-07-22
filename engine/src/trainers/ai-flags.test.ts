import { describe, it, expect } from 'vitest';
import {
  AI_FLAG_BIT_INDICES,
  ELITE_FOUR_AI_FLAGS,
  GYM_LEADER_AI_FLAGS,
  SMART_TRAINER_AI_FLAGS,
  decodeAiFlags,
  encodeAiFlags,
} from './ai-flags.js';

describe('decodeAiFlags', () => {
  it('decodes the vanilla smart-trainer preset (0x07)', () => {
    const set = decodeAiFlags(SMART_TRAINER_AI_FLAGS);
    expect(set.checkBadMove).toBe(true);
    expect(set.tryToFaint).toBe(true);
    expect(set.checkViability).toBe(true);
    expect(set.setupFirstTurn).toBe(false);
    expect(set.unknownBits).toBe(0);
  });

  it('decodes the gym-leader preset', () => {
    const set = decodeAiFlags(GYM_LEADER_AI_FLAGS);
    expect(set.checkBadMove).toBe(true);
    expect(set.checkHp).toBe(true);
    expect(set.setupFirstTurn).toBe(true);
    expect(set.superEffective).toBe(false); // exclusively in Elite Four
  });

  it('decodes the Elite Four preset', () => {
    const set = decodeAiFlags(ELITE_FOUR_AI_FLAGS);
    expect(set.superEffective).toBe(true);
    expect(set.checkAbility).toBe(true);
  });

  it('preserves unknown bits in unknownBits', () => {
    // Bit 16 isn't part of the named set.
    const unknown = 1 << 16;
    const set = decodeAiFlags(unknown);
    expect(set.unknownBits).toBe(unknown);
  });
});

describe('encodeAiFlags', () => {
  it('round-trips the smart-trainer preset', () => {
    const set = decodeAiFlags(SMART_TRAINER_AI_FLAGS);
    expect(encodeAiFlags(set)).toBe(SMART_TRAINER_AI_FLAGS);
  });

  it('round-trips all presets', () => {
    expect(encodeAiFlags(decodeAiFlags(GYM_LEADER_AI_FLAGS))).toBe(GYM_LEADER_AI_FLAGS);
    expect(encodeAiFlags(decodeAiFlags(ELITE_FOUR_AI_FLAGS))).toBe(ELITE_FOUR_AI_FLAGS);
  });

  it('round-trips the roaming bit (bit 31)', () => {
    const v = 1 << 31;
    expect(encodeAiFlags(decodeAiFlags(v))).toBe(v >>> 0);
  });

  it('round-trips unknown bits unchanged', () => {
    const v = 0x10000 | SMART_TRAINER_AI_FLAGS;
    expect(encodeAiFlags(decodeAiFlags(v))).toBe(v);
  });
});

describe('AI_FLAG_BIT_INDICES', () => {
  it('exposes the canonical bit positions', () => {
    expect(AI_FLAG_BIT_INDICES.checkBadMove).toBe(0);
    expect(AI_FLAG_BIT_INDICES.roaming).toBe(31);
  });
});
