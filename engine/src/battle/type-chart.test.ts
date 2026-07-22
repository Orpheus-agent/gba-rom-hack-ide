import { describe, expect, it } from 'vitest';
import {
  TYPE_MATCHUP_SIZE_BYTES,
  TYPE_CHART_ENDTABLE_SENTINEL,
  TYPE_CHART_FORESIGHT_SENTINEL,
  TYPE_CHART_EFFECTIVENESS_IMMUNE,
  TYPE_CHART_EFFECTIVENESS_NOT_VERY,
  TYPE_CHART_EFFECTIVENESS_NORMAL,
  TYPE_CHART_EFFECTIVENESS_SUPER,
  parseTypeMatchup,
} from './type-chart.js';

describe('TYPE_MATCHUP_SIZE_BYTES', () => {
  it('is 3', () => {
    expect(TYPE_MATCHUP_SIZE_BYTES).toBe(3);
  });
});

describe('parseTypeMatchup', () => {
  it('parses a real matchup with super-effective effectiveness', () => {
    const bytes = new Uint8Array([10, 12, TYPE_CHART_EFFECTIVENESS_SUPER]); // Fire vs Grass = 2x
    const r = parseTypeMatchup(bytes, 0);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.kind).toBe('matchup');
      expect(r.value.attackerType).toBe(10);
      expect(r.value.defenderType).toBe(12);
      expect(r.value.effectiveness).toBe(TYPE_CHART_EFFECTIVENESS_SUPER);
    }
  });

  it('parses a real matchup with immune effectiveness', () => {
    const bytes = new Uint8Array([0, 7, TYPE_CHART_EFFECTIVENESS_IMMUNE]); // Normal vs Ghost = 0x
    const r = parseTypeMatchup(bytes, 0);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.kind).toBe('matchup');
      expect(r.value.effectiveness).toBe(0);
    }
  });

  it('parses a real matchup with not-very-effective', () => {
    const bytes = new Uint8Array([0, 5, TYPE_CHART_EFFECTIVENESS_NOT_VERY]); // Normal vs Rock = 0.5x
    const r = parseTypeMatchup(bytes, 0);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.kind).toBe('matchup');
  });

  it('accepts normal-effectiveness byte (10) as valid even though rarely stored', () => {
    const bytes = new Uint8Array([3, 4, TYPE_CHART_EFFECTIVENESS_NORMAL]);
    const r = parseTypeMatchup(bytes, 0);
    expect(r.ok).toBe(true);
  });

  it('parses the foresight separator sentinel', () => {
    const bytes = new Uint8Array([
      TYPE_CHART_FORESIGHT_SENTINEL,
      TYPE_CHART_FORESIGHT_SENTINEL,
      0,
    ]);
    const r = parseTypeMatchup(bytes, 0);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.kind).toBe('foresight_separator');
  });

  it('parses the end-table sentinel', () => {
    const bytes = new Uint8Array([
      TYPE_CHART_ENDTABLE_SENTINEL,
      TYPE_CHART_ENDTABLE_SENTINEL,
      0,
    ]);
    const r = parseTypeMatchup(bytes, 0);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.kind).toBe('end_table');
  });

  it('rejects malformed foresight sentinel (defender byte != 0xFE)', () => {
    const bytes = new Uint8Array([TYPE_CHART_FORESIGHT_SENTINEL, 5, 0]);
    const r = parseTypeMatchup(bytes, 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('malformed_sentinel');
  });

  it('rejects malformed end-table sentinel (third byte != 0)', () => {
    const bytes = new Uint8Array([
      TYPE_CHART_ENDTABLE_SENTINEL,
      TYPE_CHART_ENDTABLE_SENTINEL,
      99,
    ]);
    const r = parseTypeMatchup(bytes, 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('malformed_sentinel');
  });

  it('rejects attacker type > 17 (and not a sentinel)', () => {
    const bytes = new Uint8Array([18, 0, TYPE_CHART_EFFECTIVENESS_SUPER]);
    const r = parseTypeMatchup(bytes, 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('attacker_out_of_range');
  });

  it('rejects defender type > 17 (and not a sentinel)', () => {
    const bytes = new Uint8Array([0, 18, TYPE_CHART_EFFECTIVENESS_SUPER]);
    const r = parseTypeMatchup(bytes, 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('defender_out_of_range');
  });

  it('rejects effectiveness not in {0, 5, 10, 20}', () => {
    const bytes = new Uint8Array([0, 0, 3]);
    const r = parseTypeMatchup(bytes, 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('effectiveness_out_of_range');
  });

  it('rejects out-of-bounds offset', () => {
    const bytes = new Uint8Array([0, 0]);
    const r = parseTypeMatchup(bytes, 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('out_of_bounds');
  });
});
