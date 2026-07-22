import { describe, expect, it } from 'vitest';
import { CoverageMap } from '../coverage/index.js';
import { loadRomFromBytes } from '../rom/loader.js';
import { GBA_ROM_BASE_ADDRESS } from '../pointers/index.js';
import {
  POINTER_NETWORK_DETECTOR_ID,
  pointerNetworkDetector,
  type PointerNetworkSummary,
} from './pointer-network.js';

/** Plant N pointers at consecutive 4-byte offsets starting at `start`. */
function plantPointerTable(buf: Buffer, start: number, length: number, target: number): void {
  for (let i = 0; i < length; i++) {
    buf.writeUInt32LE((GBA_ROM_BASE_ADDRESS + target + i) >>> 0, start + i * 4);
  }
}

describe('pointerNetworkDetector', () => {
  it('has stable id, name, phase=2', () => {
    expect(pointerNetworkDetector.id).toBe(POINTER_NETWORK_DETECTOR_ID);
    expect(pointerNetworkDetector.phase).toBe(2);
    expect(pointerNetworkDetector.name.length).toBeGreaterThan(0);
  });

  it('returns not_detected with reason for all-zero (synthetic) buffer', async () => {
    const rom = loadRomFromBytes({ bytes: Buffer.alloc(4096) });
    const cov = new CoverageMap(rom.byteLength);
    const r = await pointerNetworkDetector.detect(rom, cov);
    expect(r.status).toBe('not_detected');
    if (r.status === 'not_detected') {
      expect(r.reason).toContain('No internal ROM pointers');
    }
  });

  it('returns detected with summary when a single dense table is planted', async () => {
    const buf = Buffer.alloc(8192);
    plantPointerTable(buf, 0x100, 32, 0x500); // 32-entry table at 0x100
    const rom = loadRomFromBytes({ bytes: buf });
    const cov = new CoverageMap(rom.byteLength);
    const r = await pointerNetworkDetector.detect(rom, cov);
    expect(r.status).toBe('detected');
    if (r.status === 'detected') {
      const data = r.data as PointerNetworkSummary;
      expect(data.pointerCount).toBe(32);
      expect(data.tables).toHaveLength(1);
      expect(data.tables[0]?.length).toBe(32);
      expect(data.tableBytesCovered).toBe(32 * 4);
    }
  });

  it('classifies discovered tables into coverage as pointer_network', async () => {
    const buf = Buffer.alloc(8192);
    plantPointerTable(buf, 0x100, 16, 0x500);
    const rom = loadRomFromBytes({ bytes: buf });
    const cov = new CoverageMap(rom.byteLength);
    await pointerNetworkDetector.detect(rom, cov);
    const report = cov.report();
    expect(report.classifiedBytes).toBe(16 * 4);
    expect(report.regions[0]?.probableClass).toBe('pointer_network');
    expect(report.regions[0]?.start).toBe(0x100);
    expect(report.regions[0]?.end).toBe(0x100 + 16 * 4);
  });

  it('builds cross-reference clusters and reports hotspots', async () => {
    const buf = Buffer.alloc(8192);
    // Plant 10 pointers all targeting offset 0x800.
    for (let i = 0; i < 10; i++) {
      buf.writeUInt32LE((GBA_ROM_BASE_ADDRESS + 0x800) >>> 0, 0x200 + i * 32);
    }
    const rom = loadRomFromBytes({ bytes: buf });
    const cov = new CoverageMap(rom.byteLength);
    const r = await pointerNetworkDetector.detect(rom, cov);
    expect(r.status).toBe('detected');
    if (r.status === 'detected') {
      const data = r.data as PointerNetworkSummary;
      expect(data.pointerCount).toBe(10);
      expect(data.topHotspots[0]?.targetOffset).toBe(0x800);
      expect(data.topHotspots[0]?.referenceCount).toBe(10);
    }
  });

  it('reports multiple tables when present', async () => {
    const buf = Buffer.alloc(8192);
    plantPointerTable(buf, 0x100, 10, 0x500);
    plantPointerTable(buf, 0x400, 12, 0x600);
    const rom = loadRomFromBytes({ bytes: buf });
    const cov = new CoverageMap(rom.byteLength);
    const r = await pointerNetworkDetector.detect(rom, cov);
    if (r.status === 'detected') {
      const data = r.data as PointerNetworkSummary;
      expect(data.tables).toHaveLength(2);
      expect(data.tables[0]?.length).toBe(10);
      expect(data.tables[1]?.length).toBe(12);
    } else {
      throw new Error('expected detected');
    }
  });

  it('every detection result carries ≥1 evidence item (PD 1)', async () => {
    const buf = Buffer.alloc(8192);
    plantPointerTable(buf, 0x100, 16, 0x500);
    const rom = loadRomFromBytes({ bytes: buf });
    const cov = new CoverageMap(rom.byteLength);
    const r = await pointerNetworkDetector.detect(rom, cov);
    expect(r.evidence.length).toBeGreaterThanOrEqual(1);
  });

  it('confidence scales with pointer count', async () => {
    const big = Buffer.alloc(64 * 1024);
    // 2000 pointers all targeting offset 0x100.
    for (let i = 0; i < 2000; i++) {
      big.writeUInt32LE((GBA_ROM_BASE_ADDRESS + 0x100) >>> 0, i * 8);
    }
    const rom = loadRomFromBytes({ bytes: big });
    const cov = new CoverageMap(rom.byteLength);
    const r = await pointerNetworkDetector.detect(rom, cov);
    if (r.status === 'detected') {
      expect(r.confidence).toBeGreaterThanOrEqual(0.9);
    } else {
      throw new Error('expected detected');
    }
  });

  it('survives a ROM with NO tables (only isolated pointers)', async () => {
    // Plant isolated pointers far apart (no run of 8+ consecutive).
    const buf = Buffer.alloc(8192);
    for (let i = 0; i < 5; i++) {
      buf.writeUInt32LE((GBA_ROM_BASE_ADDRESS + 0x100) >>> 0, i * 256);
    }
    const rom = loadRomFromBytes({ bytes: buf });
    const cov = new CoverageMap(rom.byteLength);
    const r = await pointerNetworkDetector.detect(rom, cov);
    expect(r.status).toBe('detected');
    if (r.status === 'detected') {
      const data = r.data as PointerNetworkSummary;
      expect(data.pointerCount).toBe(5);
      expect(data.tables).toHaveLength(0);
      expect(data.tableBytesCovered).toBe(0);
    }
  });
});
