import { describe, expect, it } from 'vitest';
import { CoverageMap } from '../coverage/index.js';
import { loadRomFromBytes } from '../rom/loader.js';
import { encodeLz77Literal } from '../compression/lz77.js';
import {
  COMPRESSION_FORMAT_DETECTOR_ID,
  compressionFormatDetector,
  type CompressionInventory,
} from './compression-format.js';

describe('compressionFormatDetector', () => {
  it('has stable id, name, phase=2', () => {
    expect(compressionFormatDetector.id).toBe(COMPRESSION_FORMAT_DETECTOR_ID);
    expect(compressionFormatDetector.phase).toBe(2);
    expect(compressionFormatDetector.name.length).toBeGreaterThan(0);
  });

  it('returns not_detected for an all-zero ROM (no compression anywhere)', async () => {
    const rom = loadRomFromBytes({ bytes: Buffer.alloc(4096) });
    const cov = new CoverageMap(rom.byteLength);
    const r = await compressionFormatDetector.detect(rom, cov);
    expect(r.status).toBe('not_detected');
    if (r.status === 'not_detected') {
      expect(r.reason).toContain('No LZ77 streams');
    }
  });

  it('returns detected + registers confirmed LZ77 coverage when a block is planted', async () => {
    const buf = Buffer.alloc(4096);
    const compressed = encodeLz77Literal(Buffer.from('Pokémon GBA sample payload', 'utf8'));
    Buffer.from(compressed).copy(buf, 0x100);
    const rom = loadRomFromBytes({ bytes: buf });
    const cov = new CoverageMap(rom.byteLength);
    const r = await compressionFormatDetector.detect(rom, cov);
    expect(r.status).toBe('detected');
    if (r.status === 'detected') {
      const data = r.data as CompressionInventory;
      expect(data.lz77Blocks).toHaveLength(1);
      expect(data.lz77Blocks[0]?.start).toBe(0x100);
      expect(data.lz77BytesCovered).toBeGreaterThan(0);
    }
    const report = cov.report();
    expect(report.classifiedBytes).toBeGreaterThanOrEqual(compressed.length);
    expect(report.regions[0]?.probableClass).toBe('compression');
    expect(report.regions[0]?.score).toBe(0.95);
  });

  it('registers high-entropy regions as probable_compression unknowns', async () => {
    // 16 KB buffer of pseudo-random bytes - no LZ77 header, but very
    // high entropy. Detector should report 0 LZ77 blocks but ≥ 1
    // probable_compression region.
    const buf = new Uint8Array(16 * 1024);
    for (let i = 0; i < buf.length; i++) {
      buf[i] = (i * 1664525 + 1013904223) & 0xff;
    }
    const rom = loadRomFromBytes({ bytes: buf });
    const cov = new CoverageMap(rom.byteLength);
    const r = await compressionFormatDetector.detect(rom, cov);
    expect(r.status).toBe('detected');
    if (r.status === 'detected') {
      const data = r.data as CompressionInventory;
      expect(data.lz77Blocks).toHaveLength(0);
      expect(data.probableCompressionRegions.length).toBeGreaterThanOrEqual(1);
      expect(data.probableCompressionBytesScored).toBeGreaterThan(0);
    }
    const report = cov.report();
    expect(report.unknownScoredBytes).toBeGreaterThan(0);
    // The scored-unknown regions are tagged as probable compression.
    const scored = report.regions.find((reg) => reg.kind === 'unknown_scored');
    expect(scored?.probableClass).toBe('compression');
  });

  it('does NOT double-classify a confirmed LZ77 block as scored-unknown', async () => {
    // Plant an LZ77 block + random bytes around it. The detector should
    // register the LZ77 region at 0.95 confidence and skip its bytes when
    // emitting probable_compression scored unknowns.
    const buf = new Uint8Array(16 * 1024);
    for (let i = 0; i < buf.length; i++) {
      buf[i] = (i * 1664525 + 1013904223) & 0xff;
    }
    const compressed = encodeLz77Literal(Buffer.from('payload that gets compressed'));
    // Plant the LZ77 stream at offset 0x800 (well within a random region).
    Buffer.from(compressed).copy(buf, 0x800);
    const rom = loadRomFromBytes({ bytes: buf });
    const cov = new CoverageMap(rom.byteLength);
    await compressionFormatDetector.detect(rom, cov);
    const report = cov.report();
    // No region should overlap [0x800, 0x800+compressed.length).
    const lz77Region = report.regions.find((reg) => reg.start === 0x800);
    expect(lz77Region).toBeDefined();
    expect(lz77Region?.kind).toBe('classified');
  });

  it('returns detected with PD-1-compliant evidence chain', async () => {
    const buf = Buffer.alloc(4096);
    const compressed = encodeLz77Literal(Buffer.from('test'));
    Buffer.from(compressed).copy(buf, 0x100);
    const rom = loadRomFromBytes({ bytes: buf });
    const cov = new CoverageMap(rom.byteLength);
    const r = await compressionFormatDetector.detect(rom, cov);
    expect(r.evidence.length).toBeGreaterThanOrEqual(1);
    for (const e of r.evidence) {
      expect(e.summary.length).toBeGreaterThan(0);
      expect(e.weight).toBeGreaterThanOrEqual(0);
      expect(e.weight).toBeLessThanOrEqual(1);
    }
  });

  it('returns not_detected for tiny ROM (too small to scan)', async () => {
    const rom = loadRomFromBytes({ bytes: Buffer.alloc(200) }); // ≥ ROM_MIN_BYTES but < threshold
    const cov = new CoverageMap(rom.byteLength);
    const r = await compressionFormatDetector.detect(rom, cov);
    // 200 bytes < ENTROPY_WINDOW_SIZE so entropy scan finds nothing, AND
    // an all-zero 200-byte buffer has no LZ77. Result: not_detected with
    // the "no compressed regions found" reason.
    expect(r.status).toBe('not_detected');
  });
});
