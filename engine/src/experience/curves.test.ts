import { describe, expect, it } from 'vitest';
import {
  EXPERIENCE_CURVE_BYTES_PER_CURVE,
  EXPERIENCE_CURVE_COUNT,
  EXPERIENCE_CURVE_ENTRIES_PER_CURVE,
  EXPERIENCE_CURVE_PROFILES,
  EXPERIENCE_CURVE_TABLE_BYTES,
  classifyGrowthRate,
  scanExperienceTable,
} from './index.js';

/** Build a single 404-byte curve sub-array. Entries[0]=0, [1]=0, then
 *  monotone increasing values reaching `xpAtLevel100`. Generates a
 *  power-law curve scaled to hit the target at index 100. */
function buildCurveBytes(xpAtLevel100: number): Uint8Array {
  const buf = new Uint8Array(EXPERIENCE_CURVE_BYTES_PER_CURVE);
  const view = new DataView(buf.buffer);
  // Indices 0 + 1 = 0 (mandatory).
  view.setUint32(0, 0, true);
  view.setUint32(4, 0, true);
  // Indices 2..100: monotone increasing power curve.
  for (let lvl = 2; lvl <= 100; lvl++) {
    const fraction = (lvl - 1) / 99;
    const xp = Math.max(lvl, Math.floor(xpAtLevel100 * Math.pow(fraction, 3)));
    view.setUint32(lvl * 4, xp, true);
  }
  // Force exact magnitude at level 100.
  view.setUint32(100 * 4, xpAtLevel100, true);
  return buf;
}

/** Build the full 2424-byte 6-curve table with the canonical vanilla
 *  ordering: MEDIUM_FAST / ERRATIC / FLUCTUATING / MEDIUM_SLOW / FAST /
 *  SLOW. */
function buildVanillaTable(): Uint8Array {
  const buf = new Uint8Array(EXPERIENCE_CURVE_TABLE_BYTES);
  for (let c = 0; c < EXPERIENCE_CURVE_COUNT; c++) {
    buf.set(
      buildCurveBytes(EXPERIENCE_CURVE_PROFILES[c]!.xpAtLevel100),
      c * EXPERIENCE_CURVE_BYTES_PER_CURVE,
    );
  }
  return buf;
}

describe('classifyGrowthRate', () => {
  it('identifies all 6 canonical growth-rate magnitudes', () => {
    expect(classifyGrowthRate(1_000_000)).toBe('MEDIUM_FAST');
    expect(classifyGrowthRate(600_000)).toBe('ERRATIC');
    expect(classifyGrowthRate(1_640_000)).toBe('FLUCTUATING');
    expect(classifyGrowthRate(1_059_860)).toBe('MEDIUM_SLOW');
    expect(classifyGrowthRate(800_000)).toBe('FAST');
    expect(classifyGrowthRate(1_250_000)).toBe('SLOW');
  });

  it('tolerates ±0.5% drift on canonical magnitudes', () => {
    // 1,000,000 ± 0.5% = ±5000 - within tolerance.
    expect(classifyGrowthRate(999_500)).toBe('MEDIUM_FAST');
    expect(classifyGrowthRate(1_004_999)).toBe('MEDIUM_FAST');
  });

  it('returns null for magnitudes that match no profile', () => {
    expect(classifyGrowthRate(123_456)).toBeNull();
    expect(classifyGrowthRate(1_999_999)).toBeNull();
  });
});

describe('scanExperienceTable', () => {
  it('returns null when ROM is too small to host the table', () => {
    const bytes = new Uint8Array(1000);
    expect(scanExperienceTable(bytes)).toBeNull();
  });

  it('returns null when no 6-curve run exists', () => {
    const bytes = new Uint8Array(64 * 1024);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 11 + 17) % 256;
    expect(scanExperienceTable(bytes)).toBeNull();
  });

  it('finds the planted vanilla table at an aligned offset', () => {
    const bytes = new Uint8Array(128 * 1024);
    // Fill with garbage so the scan can't false-positive on padding.
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7 + 13) % 256;
    const plantOffset = 0x4000;
    bytes.set(buildVanillaTable(), plantOffset);
    const result = scanExperienceTable(bytes);
    expect(result).not.toBeNull();
    expect(result?.tableStart).toBe(plantOffset);
    expect(result?.tableEndExclusive).toBe(plantOffset + EXPERIENCE_CURVE_TABLE_BYTES);
    expect(result?.curves.length).toBe(EXPERIENCE_CURVE_COUNT);
  });

  it('parses each curve with 101 entries + leading zero pair + monotone tail', () => {
    const bytes = new Uint8Array(128 * 1024);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7 + 13) % 256;
    bytes.set(buildVanillaTable(), 0x1000);
    const result = scanExperienceTable(bytes);
    expect(result).not.toBeNull();
    for (const curve of result!.curves) {
      expect(curve.xpPerLevel.length).toBe(EXPERIENCE_CURVE_ENTRIES_PER_CURVE);
      expect(curve.xpPerLevel[0]).toBe(0);
      expect(curve.xpPerLevel[1]).toBe(0);
      // Tail strictly monotone.
      for (let lvl = 3; lvl <= 100; lvl++) {
        expect(curve.xpPerLevel[lvl]).toBeGreaterThan(curve.xpPerLevel[lvl - 1]!);
      }
    }
  });

  it('classifies all 6 canonical curves by name', () => {
    const bytes = new Uint8Array(128 * 1024);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7 + 13) % 256;
    bytes.set(buildVanillaTable(), 0x2000);
    const result = scanExperienceTable(bytes);
    expect(result).not.toBeNull();
    const names = result!.curves.map((c) => c.growthRateName);
    expect(names).toEqual([
      'MEDIUM_FAST',
      'ERRATIC',
      'FLUCTUATING',
      'MEDIUM_SLOW',
      'FAST',
      'SLOW',
    ]);
  });

  it('rejects a table with a non-zero entry at level 0', () => {
    const bytes = new Uint8Array(128 * 1024);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7 + 13) % 256;
    const tableBytes = buildVanillaTable();
    // Corrupt curve-0 level-0 entry - should fail the leading-zero check.
    new DataView(tableBytes.buffer).setUint32(0, 1, true);
    bytes.set(tableBytes, 0x3000);
    expect(scanExperienceTable(bytes)).toBeNull();
  });

  it('rejects a table whose tail is not monotone', () => {
    const bytes = new Uint8Array(128 * 1024);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7 + 13) % 256;
    const tableBytes = buildVanillaTable();
    // Corrupt curve-0 level-50 entry to be < level-49 entry.
    new DataView(tableBytes.buffer).setUint32(50 * 4, 1, true);
    bytes.set(tableBytes, 0x3000);
    expect(scanExperienceTable(bytes)).toBeNull();
  });
});
