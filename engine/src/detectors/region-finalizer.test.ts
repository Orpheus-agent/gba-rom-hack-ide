import { describe, expect, it } from 'vitest';
import { CoverageMap } from '../coverage/index.js';
import { loadRomFromBytes } from '../rom/loader.js';
import {
  REGION_FINALIZER_DETECTOR_ID,
  regionFinalizerDetector,
  type RegionFinalizationReport,
} from './region-finalizer.js';

describe('regionFinalizerDetector', () => {
  it('has stable id, name, phase=3', () => {
    expect(regionFinalizerDetector.id).toBe(REGION_FINALIZER_DETECTOR_ID);
    expect(regionFinalizerDetector.phase).toBe(3);
    expect(regionFinalizerDetector.name.length).toBeGreaterThan(0);
  });

  it('reduces unaccountedBytes to zero on a fresh coverage map (entire ROM is one gap)', async () => {
    const rom = loadRomFromBytes({ bytes: Buffer.alloc(4096) });
    const cov = new CoverageMap(rom.byteLength);
    await regionFinalizerDetector.detect(rom, cov);
    const report = cov.report();
    expect(report.unaccountedBytes).toBe(0);
  });

  it('preserves earlier classifications (does not overwrite the GBA header region)', async () => {
    const rom = loadRomFromBytes({ bytes: Buffer.alloc(4096) });
    const cov = new CoverageMap(rom.byteLength);
    cov.addClassified({
      start: 0,
      end: 0xc0,
      probableClass: 'header',
      score: 1.0,
      provenance: 'fake-header-detector',
    });
    await regionFinalizerDetector.detect(rom, cov);
    const report = cov.report();
    expect(report.unaccountedBytes).toBe(0);
    expect(report.regions.find((r) => r.probableClass === 'header')).toBeDefined();
  });

  it('classifies all-zero gap as unknown_executable (high confidence → classified)', async () => {
    const rom = loadRomFromBytes({ bytes: Buffer.alloc(4096) });
    const cov = new CoverageMap(rom.byteLength);
    await regionFinalizerDetector.detect(rom, cov);
    const report = cov.report();
    // The single gap [0, 4096) is all zeros → classified at score >= 0.7.
    expect(report.classifiedBytes).toBe(4096);
    expect(report.unknownScoredBytes).toBe(0);
    const region = report.regions[0];
    expect(region?.probableClass).toBe('unknown_executable');
    expect(region?.kind).toBe('classified');
  });

  it('emits a RegionFinalizationReport with per-class breakdown', async () => {
    const rom = loadRomFromBytes({ bytes: Buffer.alloc(4096) });
    const cov = new CoverageMap(rom.byteLength);
    const r = await regionFinalizerDetector.detect(rom, cov);
    expect(r.status).toBe('detected');
    if (r.status === 'detected') {
      const data = r.data as RegionFinalizationReport;
      expect(data.gapCount).toBe(1);
      expect(data.classBreakdown.unknown_executable).toBe(4096);
      expect(data.bytesClassified + data.bytesScoredUnknown).toBe(4096);
    }
  });

  it('handles a coverage map with NO gaps (already fully classified) - no-op', async () => {
    const rom = loadRomFromBytes({ bytes: Buffer.alloc(4096) });
    const cov = new CoverageMap(rom.byteLength);
    cov.addClassified({
      start: 0,
      end: 4096,
      probableClass: 'header',
      score: 1.0,
      provenance: 'fake',
    });
    const r = await regionFinalizerDetector.detect(rom, cov);
    if (r.status === 'detected') {
      const data = r.data as RegionFinalizationReport;
      expect(data.gapCount).toBe(0);
      expect(data.bytesClassified).toBe(0);
      expect(data.bytesScoredUnknown).toBe(0);
    }
    expect(cov.report().unaccountedBytes).toBe(0);
  });

  it('classifies multiple gaps independently', async () => {
    const buf = Buffer.alloc(8192);
    // Make first 4 KB all-zero (will classify as zero_padding) and second
    // 4 KB pseudo-random (will classify as compression).
    for (let i = 4096; i < 8192; i++) buf[i] = (i * 1664525 + 1013904223) & 0xff;
    const rom = loadRomFromBytes({ bytes: buf });
    const cov = new CoverageMap(rom.byteLength);
    // Plant a fake earlier classification at [2048, 2560) so the gaps are:
    //   [0, 2048) - zero → unknown_executable
    //   [2560, 8192) - half-zero, half-random → mixed profile
    cov.addClassified({
      start: 2048,
      end: 2560,
      probableClass: 'table',
      score: 1.0,
      provenance: 'fake',
    });
    const r = await regionFinalizerDetector.detect(rom, cov);
    expect(cov.report().unaccountedBytes).toBe(0);
    if (r.status === 'detected') {
      const data = r.data as RegionFinalizationReport;
      expect(data.gapCount).toBe(2);
    }
  });

  it('every detection carries ≥1 evidence item (PD 1)', async () => {
    const rom = loadRomFromBytes({ bytes: Buffer.alloc(4096) });
    const cov = new CoverageMap(rom.byteLength);
    const r = await regionFinalizerDetector.detect(rom, cov);
    expect(r.evidence.length).toBeGreaterThanOrEqual(1);
  });

  it('CRITICAL: zero unaccounted bytes after finalization on a complex coverage map', async () => {
    // Set up a CoverageMap with several sparse pre-classifications
    // mimicking what Phases 0-2 leave behind.
    const rom = loadRomFromBytes({ bytes: Buffer.alloc(16384) });
    const cov = new CoverageMap(rom.byteLength);
    cov.addClassified({ start: 0, end: 0xc0, probableClass: 'header', score: 1, provenance: 'p' });
    cov.addClassified({ start: 0x1000, end: 0x1100, probableClass: 'pointer_network', score: 0.9, provenance: 'p' });
    cov.addClassified({ start: 0x2000, end: 0x2080, probableClass: 'compression', score: 0.95, provenance: 'p' });
    cov.addUnknownScored({ start: 0x3000, end: 0x3400, probableClass: 'compression', score: 0.6, provenance: 'p' });
    expect(cov.report().unaccountedBytes).toBe(16384 - 0xc0 - 0x100 - 0x80 - 0x400);
    await regionFinalizerDetector.detect(rom, cov);
    // PD 8 invariant: after finalizer, zero unaccounted.
    expect(cov.report().unaccountedBytes).toBe(0);
  });
});
