import { describe, expect, it } from 'vitest';
import { CoverageMap } from '../coverage/index.js';
import { loadRomFromBytes } from '../rom/index.js';
import {
  SAVE_DATA_TOTAL_SIZE_BYTES,
  SAVE_SECTOR_COUNT,
  SAVE_SECTOR_SIZE_BYTES,
} from '../save-data/index.js';
import {
  SAVE_DATA_SYSTEM_DETECTOR_ID,
  saveDataSystemDetector,
} from './save-data-system.js';

const MAGIC_LE = Uint8Array.of(0x25, 0x20, 0x01, 0x08);

describe('saveDataSystemDetector', () => {
  it('exports the universal RomDetector contract', () => {
    expect(saveDataSystemDetector.id).toBe(SAVE_DATA_SYSTEM_DETECTOR_ID);
    expect(typeof saveDataSystemDetector.name).toBe('string');
    expect(saveDataSystemDetector.phase).toBe(8);
    expect(typeof saveDataSystemDetector.detect).toBe('function');
  });

  it('returns not_detected on ROM too small', () => {
    // Detector requires ≥0xC0 + 0x1000 = 4288 bytes. 1000 bytes is below.
    const bytes = new Uint8Array(1000);
    bytes[0xb2] = 0x96;
    const rom = loadRomFromBytes({ bytes, sourcePath: 'test://tiny', synthetic: true });
    const cov = new CoverageMap(bytes.length);
    const r = saveDataSystemDetector.detect(rom, cov);
    expect(r.status).toBe('not_detected');
    if (r.status === 'not_detected') expect(r.reason).toContain('too small');
  });

  it('returns not_detected when the magic is absent', () => {
    const bytes = new Uint8Array(16 * 1024);
    bytes[0xb2] = 0x96;
    for (let i = 0xc0; i < bytes.length; i++) bytes[i] = (i * 13 + 7) % 256;
    // Defensively scrub any incidental magic
    for (let i = 0xc0; i + 3 < bytes.length; i++) {
      if (
        bytes[i] === 0x25 &&
        bytes[i + 1] === 0x20 &&
        bytes[i + 2] === 0x01 &&
        bytes[i + 3] === 0x08
      ) {
        bytes[i] = 0;
      }
    }
    const rom = loadRomFromBytes({ bytes, sourcePath: 'test://no-magic', synthetic: true });
    const cov = new CoverageMap(bytes.length);
    const r = saveDataSystemDetector.detect(rom, cov);
    expect(r.status).toBe('not_detected');
    if (r.status === 'not_detected') expect(r.reason).toContain('No Gen-3 SECTOR_FOOTER_MAGIC');
  });

  it('detects a single planted magic occurrence + registers coverage', () => {
    const bytes = new Uint8Array(16 * 1024);
    bytes[0xb2] = 0x96;
    bytes.set(MAGIC_LE, 0x2000);
    const rom = loadRomFromBytes({ bytes, sourcePath: 'test://save-data', synthetic: true });
    const cov = new CoverageMap(bytes.length);
    const r = saveDataSystemDetector.detect(rom, cov);
    expect(r.status).toBe('detected');
    if (r.status === 'detected') {
      expect(r.data.magicOffset).toBe(0x2000);
      expect(r.data.magicOccurrenceCount).toBe(1);
      expect(r.data.additionalOffsets).toEqual([]);
      expect(r.data.sectorCount).toBe(SAVE_SECTOR_COUNT);
      expect(r.data.sectorSizeBytes).toBe(SAVE_SECTOR_SIZE_BYTES);
      expect(r.data.totalSaveSizeBytes).toBe(SAVE_DATA_TOTAL_SIZE_BYTES);
      expect(r.confidence).toBeCloseTo(0.88, 5);
    }
    const report = cov.report();
    const magicRegions = report.regions.filter((rgn) =>
      rgn.provenance?.includes(SAVE_DATA_SYSTEM_DETECTOR_ID),
    );
    expect(magicRegions.length).toBe(1);
    expect(magicRegions[0]?.start).toBe(0x2000);
  });

  it('detects multiple magic occurrences with higher confidence', () => {
    const bytes = new Uint8Array(16 * 1024);
    bytes[0xb2] = 0x96;
    bytes.set(MAGIC_LE, 0x1000);
    bytes.set(MAGIC_LE, 0x2000);
    bytes.set(MAGIC_LE, 0x3000);
    const rom = loadRomFromBytes({ bytes, sourcePath: 'test://multi-magic', synthetic: true });
    const cov = new CoverageMap(bytes.length);
    const r = saveDataSystemDetector.detect(rom, cov);
    expect(r.status).toBe('detected');
    if (r.status === 'detected') {
      expect(r.data.magicOffset).toBe(0x1000);
      expect(r.data.magicOccurrenceCount).toBe(3);
      expect(r.data.additionalOffsets).toEqual([0x2000, 0x3000]);
      expect(r.confidence).toBeCloseTo(0.95, 5);
    }
  });

  it('result.data is frozen including the additionalOffsets array', () => {
    const bytes = new Uint8Array(16 * 1024);
    bytes[0xb2] = 0x96;
    bytes.set(MAGIC_LE, 0x1000);
    bytes.set(MAGIC_LE, 0x2000);
    const rom = loadRomFromBytes({ bytes, sourcePath: 'test://frozen', synthetic: true });
    const cov = new CoverageMap(bytes.length);
    const r = saveDataSystemDetector.detect(rom, cov);
    if (r.status === 'detected') {
      expect(Object.isFrozen(r.data)).toBe(true);
      expect(Object.isFrozen(r.data.additionalOffsets)).toBe(true);
    }
  });
});
