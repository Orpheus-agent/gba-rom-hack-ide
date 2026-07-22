import { describe, expect, it } from 'vitest';
import { CoverageMap } from '../coverage/index.js';
import { loadRomFromBytes } from '../rom/index.js';
import {
  TYPE_MATCHUP_SIZE_BYTES,
  TYPE_CHART_ENDTABLE_SENTINEL,
  TYPE_CHART_EFFECTIVENESS_SUPER,
  TYPE_CHART_EFFECTIVENESS_NOT_VERY,
} from '../battle/index.js';
import {
  TYPE_CHART_SYSTEM_DETECTOR_ID,
  typeChartSystemDetector,
} from './type-chart-system.js';

function plantValidChart(bytes: Uint8Array, offset: number, matchupCount: number): void {
  let cursor = offset;
  const effValues = [0, TYPE_CHART_EFFECTIVENESS_NOT_VERY, TYPE_CHART_EFFECTIVENESS_SUPER];
  for (let i = 0; i < matchupCount; i++) {
    bytes[cursor] = i % 18;
    bytes[cursor + 1] = (i * 3) % 18;
    bytes[cursor + 2] = effValues[i % effValues.length]!;
    cursor += TYPE_MATCHUP_SIZE_BYTES;
  }
  bytes[cursor] = TYPE_CHART_ENDTABLE_SENTINEL;
  bytes[cursor + 1] = TYPE_CHART_ENDTABLE_SENTINEL;
  bytes[cursor + 2] = 0;
}

describe('typeChartSystemDetector', () => {
  it('exports the universal RomDetector contract', () => {
    expect(typeChartSystemDetector.id).toBe(TYPE_CHART_SYSTEM_DETECTOR_ID);
    expect(typeof typeChartSystemDetector.name).toBe('string');
    expect(typeChartSystemDetector.phase).toBe(8);
    expect(typeof typeChartSystemDetector.detect).toBe('function');
  });

  it('returns not_detected on ROM too small', () => {
    // 250 bytes is past the GBA header minimum (192) but well below the
    // 0xC0 + 30*3 = 282-byte minimum the detector needs to even attempt
    // a scan.
    const bytes = new Uint8Array(250);
    bytes[0xb2] = 0x96;
    const rom = loadRomFromBytes({ bytes, sourcePath: 'test://tiny', synthetic: true });
    const cov = new CoverageMap(bytes.length);
    const r = typeChartSystemDetector.detect(rom, cov);
    expect(r.status).toBe('not_detected');
    if (r.status === 'not_detected') expect(r.reason).toContain('too small');
  });

  it('returns not_detected when no type-chart table is in the ROM', () => {
    const bytes = new Uint8Array(8 * 1024);
    bytes[0xb2] = 0x96;
    // Fill with non-table-shaped bytes: attacker > 17 + not 0xFE/0xFF.
    for (let i = 0xc0; i < bytes.length; i++) bytes[i] = 100 + ((i * 7) % 50);
    const rom = loadRomFromBytes({ bytes, sourcePath: 'test://no-chart', synthetic: true });
    const cov = new CoverageMap(bytes.length);
    const r = typeChartSystemDetector.detect(rom, cov);
    expect(r.status).toBe('not_detected');
    if (r.status === 'not_detected') expect(r.reason).toContain('No Gen-3 gTypeEffectiveness');
  });

  it('finds a planted 107-matchup table + registers coverage', () => {
    const bytes = new Uint8Array(16 * 1024);
    // Garbage-fill so backward walk stops at the planted boundary.
    for (let i = 0xc0; i < bytes.length; i++) bytes[i] = 100 + ((i * 13 + 7) % 50);
    bytes[0xb2] = 0x96;
    plantValidChart(bytes, 0x800, 107);
    const rom = loadRomFromBytes({ bytes, sourcePath: 'test://chart', synthetic: true });
    const cov = new CoverageMap(bytes.length);
    const r = typeChartSystemDetector.detect(rom, cov);
    expect(r.status).toBe('detected');
    if (r.status === 'detected') {
      expect(r.data.matchupCount).toBe(107);
      expect(r.data.hasForesightSeparator).toBe(false);
      expect(r.data.typeChart.tableStart).toBe(0x800);
      // 107 matchups + 1 end-table = 108 triplets × 3 = 324 bytes total.
      expect(r.data.typeChart.tableEndExclusive - r.data.typeChart.tableStart).toBe(108 * 3);
    }
    const report = cov.report();
    const chartRegions = report.regions.filter((rgn) =>
      rgn.provenance?.includes(TYPE_CHART_SYSTEM_DETECTOR_ID),
    );
    expect(chartRegions.length).toBe(1);
    expect(chartRegions[0]?.start).toBe(0x800);
  });

  it('result.data is frozen', () => {
    const bytes = new Uint8Array(16 * 1024);
    for (let i = 0xc0; i < bytes.length; i++) bytes[i] = 100 + ((i * 13 + 7) % 50);
    bytes[0xb2] = 0x96;
    plantValidChart(bytes, 0x800, 107);
    const rom = loadRomFromBytes({ bytes, sourcePath: 'test://chart', synthetic: true });
    const cov = new CoverageMap(bytes.length);
    const r = typeChartSystemDetector.detect(rom, cov);
    if (r.status === 'detected') expect(Object.isFrozen(r.data)).toBe(true);
  });

  it('confidence scales with matchup count', () => {
    const buf1 = new Uint8Array(16 * 1024);
    for (let i = 0xc0; i < buf1.length; i++) buf1[i] = 100 + ((i * 13 + 7) % 50);
    buf1[0xb2] = 0x96;
    plantValidChart(buf1, 0x800, 30); // low-end → 0.85
    const rom1 = loadRomFromBytes({ bytes: buf1, sourcePath: 'test://small', synthetic: true });
    const cov1 = new CoverageMap(buf1.length);
    const r1 = typeChartSystemDetector.detect(rom1, cov1);
    if (r1.status === 'detected') expect(r1.confidence).toBeCloseTo(0.85, 5);

    const buf2 = new Uint8Array(16 * 1024);
    for (let i = 0xc0; i < buf2.length; i++) buf2[i] = 100 + ((i * 13 + 7) % 50);
    buf2[0xb2] = 0x96;
    plantValidChart(buf2, 0x800, 107); // vanilla → 0.95
    const rom2 = loadRomFromBytes({ bytes: buf2, sourcePath: 'test://vanilla', synthetic: true });
    const cov2 = new CoverageMap(buf2.length);
    const r2 = typeChartSystemDetector.detect(rom2, cov2);
    if (r2.status === 'detected') expect(r2.confidence).toBeCloseTo(0.95, 5);
  });
});
