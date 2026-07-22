import { describe, expect, it } from 'vitest';
import { findHighEntropyRegions, shannonEntropy } from './entropy.js';

describe('shannonEntropy', () => {
  it('returns 0 for all-zero bytes', () => {
    expect(shannonEntropy(new Uint8Array(1024), 0, 1024)).toBe(0);
  });

  it('returns near-max (≥ 7.5) for uniform random bytes', () => {
    const buf = new Uint8Array(4096);
    for (let i = 0; i < 4096; i++) {
      // Pseudo-random uniform distribution.
      buf[i] = (i * 1664525 + 1013904223) & 0xff;
    }
    const h = shannonEntropy(buf, 0, 4096);
    expect(h).toBeGreaterThanOrEqual(7.5);
  });

  it('returns ~1.0 bit for binary uniform (two values)', () => {
    const buf = new Uint8Array(512);
    for (let i = 0; i < 512; i++) buf[i] = i % 2 === 0 ? 0xaa : 0x55;
    expect(shannonEntropy(buf, 0, 512)).toBeCloseTo(1.0, 1);
  });

  it('handles empty / out-of-bounds windows cleanly', () => {
    expect(shannonEntropy(new Uint8Array(10), 5, 0)).toBe(0);
    expect(shannonEntropy(new Uint8Array(10), 20, 5)).toBe(0);
  });
});

describe('findHighEntropyRegions', () => {
  it('returns empty for an all-zero buffer', () => {
    expect(findHighEntropyRegions(new Uint8Array(4096))).toEqual([]);
  });

  it('finds a single high-entropy region planted in a zero buffer', () => {
    const buf = new Uint8Array(8192);
    // Plant 2048 bytes of uniform random in the middle.
    for (let i = 0; i < 2048; i++) {
      buf[2048 + i] = (i * 1664525 + 1013904223) & 0xff;
    }
    const regions = findHighEntropyRegions(buf, {
      windowSize: 512,
      stepSize: 256,
      highEntropyThreshold: 7.0,
    });
    expect(regions.length).toBeGreaterThanOrEqual(1);
    expect(regions[0]?.start).toBeGreaterThanOrEqual(2000);
    expect(regions[0]?.peakEntropy).toBeGreaterThanOrEqual(7.0);
  });

  it('returns empty when no window crosses the threshold', () => {
    const buf = new Uint8Array(4096, 0xaa);
    expect(findHighEntropyRegions(buf, { highEntropyThreshold: 7.0 })).toEqual([]);
  });

  it('reports meanEntropy + peakEntropy for each region', () => {
    const buf = new Uint8Array(4096);
    for (let i = 0; i < 4096; i++) buf[i] = (i * 1664525 + 1013904223) & 0xff;
    const regions = findHighEntropyRegions(buf, {
      windowSize: 1024,
      stepSize: 512,
      highEntropyThreshold: 7.0,
    });
    expect(regions.length).toBeGreaterThanOrEqual(1);
    expect(regions[0]?.peakEntropy).toBeGreaterThanOrEqual(regions[0]?.meanEntropy ?? 0);
  });

  it('rejects invalid windowSize', () => {
    expect(() =>
      findHighEntropyRegions(new Uint8Array(1024), { windowSize: 8 }),
    ).toThrow();
  });

  it('rejects invalid stepSize', () => {
    expect(() =>
      findHighEntropyRegions(new Uint8Array(1024), { stepSize: 0 }),
    ).toThrow();
  });

  it('rejects window bounds outside buffer', () => {
    expect(() =>
      findHighEntropyRegions(new Uint8Array(1024), { endOffsetExclusive: 5000 }),
    ).toThrow();
  });

  it('skips when buffer < windowSize', () => {
    expect(findHighEntropyRegions(new Uint8Array(100), { windowSize: 256 })).toEqual([]);
  });

  it('returns frozen region objects', () => {
    const buf = new Uint8Array(4096);
    for (let i = 0; i < 4096; i++) buf[i] = (i * 1664525 + 1013904223) & 0xff;
    const regions = findHighEntropyRegions(buf);
    if (regions.length > 0) {
      expect(Object.isFrozen(regions[0])).toBe(true);
    }
  });
});
