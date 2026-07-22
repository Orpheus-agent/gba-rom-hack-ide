import { describe, expect, it } from 'vitest';
import { CoverageMap } from '../coverage/index.js';
import { GBA_ROM_BASE_ADDRESS } from '../pointers/index.js';
import { loadRomFromBytes } from '../rom/loader.js';
import {
  MAP_SYSTEM_DETECTOR_ID,
  mapSystemDetector,
  type MapSystemReport,
} from './map-system.js';

/** Same helper as in scanner.test.ts. */
function plantMapTable(args: {
  bufferSize: number;
  tableStart: number;
  numMaps: number;
}): Buffer {
  const buf = Buffer.alloc(args.bufferSize);
  const firstHeaderAt = args.tableStart + args.numMaps * 4;
  for (let i = 0; i < args.numMaps; i++) {
    const headerOffset = firstHeaderAt + i * 28;
    buf.writeUInt32LE((GBA_ROM_BASE_ADDRESS + headerOffset) >>> 0, args.tableStart + i * 4);
  }
  for (let i = 0; i < args.numMaps; i++) {
    const headerOffset = firstHeaderAt + i * 28;
    const layoutOffset = firstHeaderAt + args.numMaps * 28 + i * 4;
    buf.writeUInt32LE((GBA_ROM_BASE_ADDRESS + layoutOffset) >>> 0, headerOffset + 0);
    buf[headerOffset + 0x17] = (i % 9) + 1;
  }
  return buf;
}

describe('mapSystemDetector', () => {
  it('has stable id, name, phase=5', () => {
    expect(mapSystemDetector.id).toBe(MAP_SYSTEM_DETECTOR_ID);
    expect(mapSystemDetector.phase).toBe(5);
    expect(mapSystemDetector.name.length).toBeGreaterThan(0);
  });

  it('returns not_detected for an all-zero ROM (no maps)', async () => {
    const rom = loadRomFromBytes({ bytes: Buffer.alloc(8192) });
    const cov = new CoverageMap(rom.byteLength);
    const r = await mapSystemDetector.detect(rom, cov);
    expect(r.status).toBe('not_detected');
    if (r.status === 'not_detected') {
      expect(r.reason).toContain('No Gen-3 map-header pointer table');
    }
  });

  it('returns not_detected for a small ROM with no map tables', async () => {
    // A 192-byte buffer is the minimum loader-accepted ROM. It passes
    // the detector's own >= 32 size check but yields no map-table
    // candidates because there are no pointer tables.
    const rom = loadRomFromBytes({ bytes: Buffer.alloc(192) });
    const cov = new CoverageMap(rom.byteLength);
    const r = await mapSystemDetector.detect(rom, cov);
    expect(r.status).toBe('not_detected');
    if (r.status === 'not_detected') {
      expect(r.reason).toContain('No Gen-3 map-header pointer table');
    }
  });

  it('returns detected with map count + per-table breakdown when planted', async () => {
    const buf = plantMapTable({ bufferSize: 16 * 1024, tableStart: 0x100, numMaps: 8 });
    const rom = loadRomFromBytes({ bytes: buf });
    const cov = new CoverageMap(rom.byteLength);
    const r = await mapSystemDetector.detect(rom, cov);
    expect(r.status).toBe('detected');
    if (r.status === 'detected') {
      const data = r.data as MapSystemReport;
      expect(data.mapTableCount).toBeGreaterThanOrEqual(1);
      expect(data.totalMapCount).toBeGreaterThanOrEqual(8);
      expect(data.totalMapHeaderBytes).toBeGreaterThanOrEqual(8 * 28);
    }
  });

  it('registers each MapHeader in coverage as event_data', async () => {
    const buf = plantMapTable({ bufferSize: 16 * 1024, tableStart: 0x100, numMaps: 8 });
    const rom = loadRomFromBytes({ bytes: buf });
    const cov = new CoverageMap(rom.byteLength);
    await mapSystemDetector.detect(rom, cov);
    const report = cov.report();
    // 8 maps × 28 bytes = 224 bytes classified as event_data.
    expect(report.classifiedBytes).toBeGreaterThanOrEqual(8 * 28);
    const eventRegions = report.regions.filter((r) => r.probableClass === 'event_data');
    expect(eventRegions.length).toBeGreaterThanOrEqual(8);
    for (const r of eventRegions) {
      expect(r.end - r.start).toBe(28);
      expect(r.score).toBe(0.85);
    }
  });

  it('every detection result carries ≥1 evidence item (PD 1)', async () => {
    const buf = plantMapTable({ bufferSize: 16 * 1024, tableStart: 0x100, numMaps: 8 });
    const rom = loadRomFromBytes({ bytes: buf });
    const cov = new CoverageMap(rom.byteLength);
    const r = await mapSystemDetector.detect(rom, cov);
    expect(r.evidence.length).toBeGreaterThanOrEqual(1);
  });

  it('confidence scales with map count', async () => {
    // Small (under 10) → 0.7; medium (10..100) → 0.85; large (100+) → 0.95
    const smallBuf = plantMapTable({ bufferSize: 16 * 1024, tableStart: 0x100, numMaps: 4 });
    const smallRom = loadRomFromBytes({ bytes: smallBuf });
    const smallCov = new CoverageMap(smallRom.byteLength);
    const smallR = await mapSystemDetector.detect(smallRom, smallCov);
    if (smallR.status === 'detected') expect(smallR.confidence).toBe(0.7);

    const mediumBuf = plantMapTable({ bufferSize: 64 * 1024, tableStart: 0x100, numMaps: 16 });
    const mediumRom = loadRomFromBytes({ bytes: mediumBuf });
    const mediumCov = new CoverageMap(mediumRom.byteLength);
    const mediumR = await mapSystemDetector.detect(mediumRom, mediumCov);
    if (mediumR.status === 'detected') expect(mediumR.confidence).toBe(0.85);
  });
});
