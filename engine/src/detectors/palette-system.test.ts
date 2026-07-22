import { describe, expect, it } from 'vitest';
import { CoverageMap } from '../coverage/index.js';
import { loadRomFromBytes } from '../rom/index.js';
import { COLORS_PER_PALETTE, PALETTE_BYTES } from '../graphics/index.js';
import {
  PALETTE_DETECT_MIN_REGIONS,
  PALETTE_SYSTEM_DETECTOR_ID,
  paletteSystemDetector,
} from './palette-system.js';

function plantPalette(buf: Uint8Array, offset: number, seed = 0): void {
  for (let i = 0; i < COLORS_PER_PALETTE; i++) {
    const colorIndex = (seed + i) & 0x7fff;
    buf[offset + i * 2] = colorIndex & 0xff;
    buf[offset + i * 2 + 1] = (colorIndex >> 8) & 0x7f;
  }
}

function plantNPalettes(buf: Uint8Array, startOffset: number, count: number): void {
  for (let i = 0; i < count; i++) {
    plantPalette(buf, startOffset + i * PALETTE_BYTES, 0x100 + i * 17);
  }
}

function fillNonPaletteBytes(buf: Uint8Array): void {
  // Every odd-indexed byte has bit 7 set → bit 15 of every u16 = 1 → fails validation.
  for (let i = 0; i < buf.length; i++) {
    buf[i] = i % 2 === 1 ? 0x80 : (i * 7) % 128;
  }
}

describe('paletteSystemDetector', () => {
  it('exports the universal RomDetector contract', () => {
    expect(paletteSystemDetector.id).toBe(PALETTE_SYSTEM_DETECTOR_ID);
    expect(typeof paletteSystemDetector.name).toBe('string');
    expect(paletteSystemDetector.phase).toBe(8);
    expect(typeof paletteSystemDetector.detect).toBe('function');
  });

  it('returns not_detected on ROM too small', () => {
    // 0xC0 + 50*32 = 1792 bytes minimum. 1000 bytes is below.
    const bytes = new Uint8Array(1000);
    bytes[0xb2] = 0x96;
    const rom = loadRomFromBytes({ bytes, sourcePath: 'test://tiny', synthetic: true });
    const cov = new CoverageMap(bytes.length);
    const r = paletteSystemDetector.detect(rom, cov);
    expect(r.status).toBe('not_detected');
    if (r.status === 'not_detected') expect(r.reason).toContain('too small');
  });

  it('returns not_detected when fewer than 50 palette regions are found', () => {
    const bytes = new Uint8Array(64 * 1024);
    bytes[0xb2] = 0x96;
    fillNonPaletteBytes(bytes);
    // Plant only 10 palettes - below the min threshold of 50.
    plantNPalettes(bytes, 0x800, 10);
    const rom = loadRomFromBytes({ bytes, sourcePath: 'test://few', synthetic: true });
    const cov = new CoverageMap(bytes.length);
    const r = paletteSystemDetector.detect(rom, cov);
    expect(r.status).toBe('not_detected');
    if (r.status === 'not_detected') {
      expect(r.reason).toContain('Fewer than 50');
    }
  });

  it('detects when ≥50 palette regions are planted + registers coverage', () => {
    const bytes = new Uint8Array(64 * 1024);
    bytes[0xb2] = 0x96;
    fillNonPaletteBytes(bytes);
    plantNPalettes(bytes, 0x800, 60);
    const rom = loadRomFromBytes({ bytes, sourcePath: 'test://palettes', synthetic: true });
    const cov = new CoverageMap(bytes.length);
    const r = paletteSystemDetector.detect(rom, cov);
    expect(r.status).toBe('detected');
    if (r.status === 'detected') {
      expect(r.data.paletteRegionCount).toBe(60);
      expect(r.data.firstRegionOffsets[0]).toBe(0x800);
      expect(r.data.bytesPerPalette).toBe(PALETTE_BYTES);
      expect(r.data.colorsPerPalette).toBe(COLORS_PER_PALETTE);
      expect(r.confidence).toBeCloseTo(0.88, 5);
    }
    const report = cov.report();
    const paletteRegions = report.regions.filter((rgn) =>
      rgn.provenance?.includes(PALETTE_SYSTEM_DETECTOR_ID),
    );
    expect(paletteRegions.length).toBe(1);
    expect(paletteRegions[0]?.start).toBe(0x800);
  });

  it('confidence scales with the number of palette regions found', () => {
    // 60 regions → 0.88
    const buf1 = new Uint8Array(64 * 1024);
    buf1[0xb2] = 0x96;
    fillNonPaletteBytes(buf1);
    plantNPalettes(buf1, 0x800, 60);
    const rom1 = loadRomFromBytes({ bytes: buf1, sourcePath: 'test://60', synthetic: true });
    const cov1 = new CoverageMap(buf1.length);
    const r1 = paletteSystemDetector.detect(rom1, cov1);
    if (r1.status === 'detected') expect(r1.confidence).toBeCloseTo(0.88, 5);

    // 1024 regions → 0.95 (vanilla-level)
    const buf2 = new Uint8Array(256 * 1024);
    buf2[0xb2] = 0x96;
    fillNonPaletteBytes(buf2);
    plantNPalettes(buf2, 0x800, 1024);
    const rom2 = loadRomFromBytes({ bytes: buf2, sourcePath: 'test://1024', synthetic: true });
    const cov2 = new CoverageMap(buf2.length);
    const r2 = paletteSystemDetector.detect(rom2, cov2);
    if (r2.status === 'detected') expect(r2.confidence).toBeCloseTo(0.95, 5);
  });

  it('result.data is frozen including firstRegionOffsets', () => {
    const bytes = new Uint8Array(64 * 1024);
    bytes[0xb2] = 0x96;
    fillNonPaletteBytes(bytes);
    plantNPalettes(bytes, 0x800, 60);
    const rom = loadRomFromBytes({ bytes, sourcePath: 'test://frozen', synthetic: true });
    const cov = new CoverageMap(bytes.length);
    const r = paletteSystemDetector.detect(rom, cov);
    if (r.status === 'detected') {
      expect(Object.isFrozen(r.data)).toBe(true);
      expect(Object.isFrozen(r.data.firstRegionOffsets)).toBe(true);
    }
  });

  it('uses PALETTE_DETECT_MIN_REGIONS as the threshold', () => {
    expect(PALETTE_DETECT_MIN_REGIONS).toBeGreaterThanOrEqual(50);
  });
});
