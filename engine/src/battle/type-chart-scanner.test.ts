import { describe, expect, it } from 'vitest';
import {
  TYPE_MATCHUP_SIZE_BYTES,
  TYPE_CHART_ENDTABLE_SENTINEL,
  TYPE_CHART_FORESIGHT_SENTINEL,
  TYPE_CHART_EFFECTIVENESS_SUPER,
  TYPE_CHART_EFFECTIVENESS_NOT_VERY,
} from './type-chart.js';
import { scanTypeChart } from './type-chart-scanner.js';

// Helper: garbage-fill so backward walk + edge detection stop at the
// planted region's boundaries instead of traversing zero-padding (which
// `parseTypeMatchup` would accept as e.g. {0, 0, 0} immune-Normal-vs-Normal).
function makeGarbageBuffer(size: number, seed = 0x73): Uint8Array {
  const b = new Uint8Array(size);
  // Use values guaranteed to FAIL parseTypeMatchup (effectiveness byte
  // not in {0,5,10,20} and attacker > 17 and not 0xFE/0xFF).
  for (let i = 0; i < size; i++) {
    b[i] = 100 + ((i * 13 + seed) % 50); // 100..149 - all >17, all !=0xFE/0xFF
  }
  return b;
}

// Plant a synthetic type chart starting at the given offset. Returns the
// number of triplets planted (including the end-table sentinel).
function plantTypeChart(
  buf: Uint8Array,
  offset: number,
  matchupCount: number,
  options: { withForesight?: boolean } = {},
): number {
  let cursor = offset;
  let planted = 0;
  // Plant `matchupCount` real matchups: (attackerType, defenderType,
  // effectiveness). Cycle through valid type IDs + effectiveness values.
  const effValues = [
    0,
    TYPE_CHART_EFFECTIVENESS_NOT_VERY,
    TYPE_CHART_EFFECTIVENESS_SUPER,
  ];
  for (let i = 0; i < matchupCount; i++) {
    buf[cursor] = i % 18;
    buf[cursor + 1] = (i * 3) % 18;
    buf[cursor + 2] = effValues[i % effValues.length]!;
    cursor += TYPE_MATCHUP_SIZE_BYTES;
    planted++;
  }
  if (options.withForesight) {
    buf[cursor] = TYPE_CHART_FORESIGHT_SENTINEL;
    buf[cursor + 1] = TYPE_CHART_FORESIGHT_SENTINEL;
    buf[cursor + 2] = 0;
    cursor += TYPE_MATCHUP_SIZE_BYTES;
    planted++;
  }
  // End-table sentinel.
  buf[cursor] = TYPE_CHART_ENDTABLE_SENTINEL;
  buf[cursor + 1] = TYPE_CHART_ENDTABLE_SENTINEL;
  buf[cursor + 2] = 0;
  planted++;
  return planted;
}

describe('scanTypeChart', () => {
  it('returns null when ROM is too small', () => {
    const tiny = new Uint8Array(64);
    expect(scanTypeChart(tiny)).toBeNull();
  });

  it('returns null when no end-table sentinel present', () => {
    // 2KB garbage with no 0xFF 0xFF 0x00 pattern.
    const buf = makeGarbageBuffer(2048);
    expect(scanTypeChart(buf)).toBeNull();
  });

  it('detects a planted vanilla-style table (~107 matchups + end-table)', () => {
    const buf = makeGarbageBuffer(4096);
    const offset = 0x200;
    const planted = plantTypeChart(buf, offset, 107);
    const result = scanTypeChart(buf);
    expect(result).not.toBeNull();
    if (result) {
      expect(result.tableStart).toBe(offset);
      expect(result.tripletCount).toBe(planted);
      expect(result.matchupCount).toBe(107);
      expect(result.hasForesightSeparator).toBe(false);
      expect(result.tableEndExclusive).toBe(
        offset + planted * TYPE_MATCHUP_SIZE_BYTES,
      );
    }
  });

  it('detects a table with foresight separator and counts it', () => {
    const buf = makeGarbageBuffer(4096);
    const offset = 0x300;
    plantTypeChart(buf, offset, 80, { withForesight: true });
    const result = scanTypeChart(buf);
    expect(result).not.toBeNull();
    if (result) {
      expect(result.matchupCount).toBe(80);
      expect(result.hasForesightSeparator).toBe(true);
      // 80 matchups + 1 foresight + 1 end-table = 82 triplets total.
      expect(result.tripletCount).toBe(82);
    }
  });

  it('rejects runs below the min-triplets floor', () => {
    const buf = makeGarbageBuffer(2048);
    // Plant only 10 matchups + end-table = 11 triplets - below default 30.
    plantTypeChart(buf, 0x200, 10);
    expect(scanTypeChart(buf)).toBeNull();
    // But passes when caller lowers the floor:
    const lenient = scanTypeChart(buf, { minTriplets: 5 });
    expect(lenient).not.toBeNull();
    if (lenient) expect(lenient.matchupCount).toBe(10);
  });

  it('returns the LONGEST run when multiple terminators exist', () => {
    const buf = makeGarbageBuffer(8192);
    // Plant a short table at 0x200 (40 matchups), garbage break, then a
    // long table at 0x800 (100 matchups).
    plantTypeChart(buf, 0x200, 40);
    // Reset garbage between tables so the long-table walk doesn't bleed
    // into the short-table region.
    for (let i = 0x200 + 41 * TYPE_MATCHUP_SIZE_BYTES; i < 0x800; i++) {
      buf[i] = 100 + ((i * 7) % 50);
    }
    plantTypeChart(buf, 0x800, 100);
    const result = scanTypeChart(buf);
    expect(result).not.toBeNull();
    if (result) {
      expect(result.tableStart).toBe(0x800);
      expect(result.matchupCount).toBe(100);
    }
  });

  it('skips the GBA cartridge header (offset 0..0xBF)', () => {
    // Even if 0xFF 0xFF 0x00 appears in the header, it must be ignored.
    const buf = makeGarbageBuffer(2048);
    buf[0x80] = TYPE_CHART_ENDTABLE_SENTINEL;
    buf[0x81] = TYPE_CHART_ENDTABLE_SENTINEL;
    buf[0x82] = 0;
    // No real table elsewhere.
    expect(scanTypeChart(buf)).toBeNull();
  });
});
