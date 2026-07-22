import { describe, expect, it } from 'vitest';
import {
  aggregateVariableUsage,
  classifyVariableRole,
} from './variable-roles.js';

describe('aggregateVariableUsage', () => {
  it('returns zero counts for empty records', () => {
    const p = aggregateVariableUsage([]);
    expect(p.setsCount).toBe(0);
    expect(p.readsCount).toBe(0);
    expect(p.gatesCount).toBe(0);
    expect(p.flagBitOpCount).toBe(0);
    expect(p.multiValueOpCount).toBe(0);
    expect(p.opcodeNames).toEqual([]);
  });

  it('counts flag-bit ops correctly', () => {
    const p = aggregateVariableUsage([
      { edgeKind: 'sets_flag', opcodeName: 'setflag' },
      { edgeKind: 'reads_flag', opcodeName: 'checkflag' },
      { edgeKind: 'sets_flag', opcodeName: 'clearflag' },
    ]);
    expect(p.setsCount).toBe(2);
    expect(p.readsCount).toBe(1);
    expect(p.flagBitOpCount).toBe(3);
    expect(p.multiValueOpCount).toBe(0);
    expect(p.opcodeNames).toEqual(['checkflag', 'clearflag', 'setflag']);
  });

  it('counts multi-value ops correctly', () => {
    const p = aggregateVariableUsage([
      { edgeKind: 'sets_flag', opcodeName: 'setvar' },
      { edgeKind: 'reads_flag', opcodeName: 'compare_var_to_value' },
    ]);
    expect(p.flagBitOpCount).toBe(0);
    expect(p.multiValueOpCount).toBe(2);
  });

  it('handles gates_on edges (no opcode name)', () => {
    const p = aggregateVariableUsage([
      { edgeKind: 'gates_on' },
      { edgeKind: 'gates_on' },
      { edgeKind: 'sets_flag', opcodeName: 'setflag' },
    ]);
    expect(p.gatesCount).toBe(2);
    expect(p.setsCount).toBe(1);
    expect(p.flagBitOpCount).toBe(1);
  });

  it('returns frozen profile + nested opcodeNames', () => {
    const p = aggregateVariableUsage([
      { edgeKind: 'sets_flag', opcodeName: 'setflag' },
    ]);
    expect(Object.isFrozen(p)).toBe(true);
    expect(Object.isFrozen(p.opcodeNames)).toBe(true);
  });
});

describe('classifyVariableRole - FLAG_BIT variants', () => {
  it('classifies setflag-only as FLAG_BIT_WRITE_ONLY', () => {
    const p = aggregateVariableUsage([
      { edgeKind: 'sets_flag', opcodeName: 'setflag' },
    ]);
    expect(classifyVariableRole(p)).toBe('FLAG_BIT_WRITE_ONLY');
  });

  it('classifies checkflag-only as FLAG_BIT_READ_ONLY', () => {
    const p = aggregateVariableUsage([
      { edgeKind: 'reads_flag', opcodeName: 'checkflag' },
    ]);
    expect(classifyVariableRole(p)).toBe('FLAG_BIT_READ_ONLY');
  });

  it('classifies setflag + checkflag (no gates) as FLAG_BIT_READ_WRITE', () => {
    const p = aggregateVariableUsage([
      { edgeKind: 'sets_flag', opcodeName: 'setflag' },
      { edgeKind: 'reads_flag', opcodeName: 'checkflag' },
    ]);
    expect(classifyVariableRole(p)).toBe('FLAG_BIT_READ_WRITE');
  });

  it('classifies setflag + checkflag + gates_on as FLAG_BIT_PROGRESSION_GATE', () => {
    const p = aggregateVariableUsage([
      { edgeKind: 'sets_flag', opcodeName: 'setflag' },
      { edgeKind: 'reads_flag', opcodeName: 'checkflag' },
      { edgeKind: 'gates_on' },
      { edgeKind: 'gates_on' },
    ]);
    expect(classifyVariableRole(p)).toBe('FLAG_BIT_PROGRESSION_GATE');
  });
});

describe('classifyVariableRole - MULTI_VALUE variants', () => {
  it('classifies setvar-only as MULTI_VALUE_WRITE_ONLY', () => {
    const p = aggregateVariableUsage([
      { edgeKind: 'sets_flag', opcodeName: 'setvar' },
    ]);
    expect(classifyVariableRole(p)).toBe('MULTI_VALUE_WRITE_ONLY');
  });

  it('classifies compare-only as MULTI_VALUE_READ_ONLY', () => {
    const p = aggregateVariableUsage([
      { edgeKind: 'reads_flag', opcodeName: 'compare_var_to_value' },
    ]);
    expect(classifyVariableRole(p)).toBe('MULTI_VALUE_READ_ONLY');
  });

  it('classifies setvar + compare as MULTI_VALUE_READ_WRITE', () => {
    const p = aggregateVariableUsage([
      { edgeKind: 'sets_flag', opcodeName: 'setvar' },
      { edgeKind: 'reads_flag', opcodeName: 'compare_var_to_value' },
    ]);
    expect(classifyVariableRole(p)).toBe('MULTI_VALUE_READ_WRITE');
  });

  it('classifies setvar + gates_on as MULTI_VALUE_PROGRESSION_GATE', () => {
    const p = aggregateVariableUsage([
      { edgeKind: 'sets_flag', opcodeName: 'setvar' },
      { edgeKind: 'gates_on' },
    ]);
    expect(classifyVariableRole(p)).toBe('MULTI_VALUE_PROGRESSION_GATE');
  });
});

describe('classifyVariableRole - edge cases', () => {
  it('returns UNREFERENCED for empty profile', () => {
    expect(classifyVariableRole(aggregateVariableUsage([]))).toBe('UNREFERENCED');
  });

  it('returns MIXED_KIND when both flag-bit and multi-value ops present', () => {
    const p = aggregateVariableUsage([
      { edgeKind: 'sets_flag', opcodeName: 'setflag' },
      { edgeKind: 'sets_flag', opcodeName: 'setvar' },
    ]);
    expect(classifyVariableRole(p)).toBe('MIXED_KIND');
  });

  it('biases gates_on-only to FLAG_BIT (conventional bit gating)', () => {
    const p = aggregateVariableUsage([
      { edgeKind: 'gates_on' },
      { edgeKind: 'gates_on' },
    ]);
    // gates_on without writes → READ_ONLY (gates_on counts as a read)
    expect(classifyVariableRole(p)).toBe('FLAG_BIT_READ_ONLY');
  });
});
