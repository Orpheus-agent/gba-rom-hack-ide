import { describe, expect, it } from 'vitest';
import {
  EVOLUTION_BLOCK_SIZE_BYTES,
  EVOLUTION_METHOD_MAX,
  EVOLUTION_SLOTS_PER_SPECIES,
  EVOLUTION_SPECIES_MAX,
  EVOLUTION_STRUCT_SIZE_BYTES,
  EVO_NONE,
  parseEvolutionBlock,
  parseEvolutionSlot,
} from './evolution.js';

function makeBuf(size = 0x1000): Buffer {
  return Buffer.alloc(size);
}

/** Plant a populated evolution slot (method, param, targetSpecies). */
function plantSlot(
  buf: Buffer,
  at: number,
  method: number,
  param: number,
  targetSpecies: number,
): void {
  buf.writeUInt16LE(method, at + 0x00);
  buf.writeUInt16LE(param, at + 0x02);
  buf.writeUInt16LE(targetSpecies, at + 0x04);
  // padding 0x06..0x07 stays 0
}

describe('parseEvolutionSlot - happy paths', () => {
  it('parses a populated slot (EVO_LEVEL @ 16 → species 1)', () => {
    const buf = makeBuf();
    plantSlot(buf, 0x100, 4, 16, 1);
    const r = parseEvolutionSlot(buf, 0x100);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.evolution.method).toBe(4);
      expect(r.evolution.param).toBe(16);
      expect(r.evolution.targetSpecies).toBe(1);
      expect(r.evolution.isEmpty).toBe(false);
      expect(r.evolution.fileOffset).toBe(0x100);
    }
  });

  it('parses an empty EVO_NONE slot (all-zero)', () => {
    const buf = makeBuf();
    // All-zero - should parse as EVO_NONE
    const r = parseEvolutionSlot(buf, 0x100);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.evolution.method).toBe(EVO_NONE);
      expect(r.evolution.isEmpty).toBe(true);
      expect(r.evolution.targetSpecies).toBe(0);
    }
  });

  it('parses high method codes up to MAX', () => {
    const buf = makeBuf();
    plantSlot(buf, 0x100, EVOLUTION_METHOD_MAX, 100, 50);
    expect(parseEvolutionSlot(buf, 0x100).ok).toBe(true);
  });

  it('result slot is frozen', () => {
    const buf = makeBuf();
    plantSlot(buf, 0x100, 4, 16, 1);
    const r = parseEvolutionSlot(buf, 0x100);
    if (r.ok) expect(Object.isFrozen(r.evolution)).toBe(true);
  });
});

describe('parseEvolutionSlot - failure modes', () => {
  it('fails too_short when buffer < 8 bytes', () => {
    const r = parseEvolutionSlot(new Uint8Array(4), 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('too_short');
  });

  it('fails implausible_method when method > MAX', () => {
    const buf = makeBuf();
    plantSlot(buf, 0x100, EVOLUTION_METHOD_MAX + 1, 16, 1);
    const r = parseEvolutionSlot(buf, 0x100);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('implausible_method');
  });

  it('fails implausible_species when targetSpecies > MAX', () => {
    const buf = makeBuf();
    plantSlot(buf, 0x100, 4, 16, EVOLUTION_SPECIES_MAX + 1);
    const r = parseEvolutionSlot(buf, 0x100);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('implausible_species');
  });

  it('fails nonzero_padding when padding != 0', () => {
    const buf = makeBuf();
    plantSlot(buf, 0x100, 4, 16, 1);
    buf.writeUInt16LE(0x42, 0x100 + 0x06); // corrupt padding
    const r = parseEvolutionSlot(buf, 0x100);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('nonzero_padding');
  });

  it('fails malformed_empty_slot when method=EVO_NONE but param or targetSpecies != 0', () => {
    const buf = makeBuf();
    // method=0 (EVO_NONE) but with nonzero param
    plantSlot(buf, 0x100, 0, 5, 0);
    const r = parseEvolutionSlot(buf, 0x100);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('malformed_empty_slot');
  });

  it('fails malformed_empty_slot when method != EVO_NONE but targetSpecies = 0', () => {
    const buf = makeBuf();
    plantSlot(buf, 0x100, 4, 16, 0); // EVO_LEVEL but no target
    const r = parseEvolutionSlot(buf, 0x100);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('malformed_empty_slot');
  });
});

describe('parseEvolutionBlock - happy paths', () => {
  it('parses all-empty block (every slot EVO_NONE)', () => {
    const buf = makeBuf();
    const r = parseEvolutionBlock(buf, 0x100);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.block.slots.length).toBe(5);
      expect(r.block.populatedSlots.length).toBe(0);
    }
  });

  it('parses single-evolution block (slot 0 populated, rest empty)', () => {
    const buf = makeBuf();
    plantSlot(buf, 0x100 + 0 * EVOLUTION_STRUCT_SIZE_BYTES, 4, 16, 1);
    const r = parseEvolutionBlock(buf, 0x100);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.block.populatedSlots.length).toBe(1);
      expect(r.block.populatedSlots[0]?.targetSpecies).toBe(1);
    }
  });

  it('parses multi-evolution block (branching, e.g. Wurmple-style 2 slots)', () => {
    const buf = makeBuf();
    plantSlot(buf, 0x100 + 0 * EVOLUTION_STRUCT_SIZE_BYTES, 11, 7, 14); // EVO_LEVEL_SILCOON → Silcoon
    plantSlot(buf, 0x100 + 1 * EVOLUTION_STRUCT_SIZE_BYTES, 12, 7, 15); // EVO_LEVEL_CASCOON → Cascoon
    const r = parseEvolutionBlock(buf, 0x100);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.block.populatedSlots.length).toBe(2);
      expect(r.block.populatedSlots[0]?.method).toBe(11);
      expect(r.block.populatedSlots[1]?.method).toBe(12);
    }
  });

  it('result block + slots are frozen', () => {
    const buf = makeBuf();
    plantSlot(buf, 0x100, 4, 16, 1);
    const r = parseEvolutionBlock(buf, 0x100);
    if (r.ok) {
      expect(Object.isFrozen(r.block)).toBe(true);
      expect(Object.isFrozen(r.block.slots)).toBe(true);
      expect(Object.isFrozen(r.block.populatedSlots)).toBe(true);
    }
  });
});

describe('parseEvolutionBlock - failure modes', () => {
  it('fails too_short when buffer < 40 bytes from offset', () => {
    const r = parseEvolutionBlock(new Uint8Array(20), 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('too_short');
  });

  it('fails slot_failure with slot index when any slot is malformed', () => {
    const buf = makeBuf();
    // Slot 0 valid, slot 2 has bad method
    plantSlot(buf, 0x100 + 0 * EVOLUTION_STRUCT_SIZE_BYTES, 4, 16, 1);
    plantSlot(buf, 0x100 + 2 * EVOLUTION_STRUCT_SIZE_BYTES, 99, 16, 2); // bad method
    const r = parseEvolutionBlock(buf, 0x100);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failure.kind).toBe('slot_failure');
      if (r.failure.kind === 'slot_failure') {
        expect(r.failure.slotIndex).toBe(2);
        expect(r.failure.slotFailure.kind).toBe('implausible_method');
      }
    }
  });
});

describe('constants', () => {
  it('struct size = 8, block size = 40, slots per block = 5', () => {
    expect(EVOLUTION_STRUCT_SIZE_BYTES).toBe(8);
    expect(EVOLUTION_SLOTS_PER_SPECIES).toBe(5);
    expect(EVOLUTION_BLOCK_SIZE_BYTES).toBe(40);
  });
  it('METHOD_MAX = 50, SPECIES_MAX = 2048, EVO_NONE = 0', () => {
    expect(EVOLUTION_METHOD_MAX).toBe(50);
    expect(EVOLUTION_SPECIES_MAX).toBe(2048);
    expect(EVO_NONE).toBe(0);
  });
});
