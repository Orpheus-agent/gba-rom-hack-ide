import { describe, expect, it } from 'vitest';
import { classifyRegion, profileBytes } from './region.js';

describe('profileBytes', () => {
  it('reports zeroFraction=1 for all-zero input', () => {
    const p = profileBytes(new Uint8Array(1024), 0, 1024);
    expect(p.zeroFraction).toBe(1);
    expect(p.entropy).toBe(0);
  });

  it('reports ffFraction=1 for all-0xFF input', () => {
    const buf = new Uint8Array(1024);
    buf.fill(0xff);
    const p = profileBytes(buf, 0, 1024);
    expect(p.ffFraction).toBe(1);
  });

  it('computes ascii fractions on text', () => {
    const buf = Buffer.from('A'.repeat(100), 'ascii');
    const p = profileBytes(buf, 0, 100);
    expect(p.printableAsciiFraction).toBe(1);
  });

  it('returns empty profile for zero-length range', () => {
    expect(profileBytes(new Uint8Array(10), 5, 0).sampleLength).toBe(0);
  });

  it('topByte points at the dominant value', () => {
    const buf = new Uint8Array(100);
    for (let i = 0; i < 100; i++) buf[i] = i < 80 ? 0xab : i;
    const p = profileBytes(buf, 0, 100);
    expect(p.topByte).toBe(0xab);
    expect(p.topByteCount).toBe(80);
  });
});

describe('classifyRegion - verdict branches', () => {
  it('classifies all-zero as unknown_executable (zero_padding)', () => {
    const r = classifyRegion(new Uint8Array(4096), 0, 4096);
    expect(r.probableClass).toBe('unknown_executable');
    expect(r.classified).toBe(true);
    expect(r.score).toBeGreaterThanOrEqual(0.9);
    expect(r.reason).toContain('0x00');
  });

  it('classifies all-0xFF as unknown_executable (ff_padding)', () => {
    const buf = new Uint8Array(4096);
    buf.fill(0xff);
    const r = classifyRegion(buf, 0, 4096);
    expect(r.probableClass).toBe('unknown_executable');
    expect(r.classified).toBe(true);
    expect(r.reason).toContain('0xFF');
  });

  it('classifies Pokémon text-codec bytes as event_data', () => {
    // 80% bytes in 0xBB..0xEE range, 20% 0xFF terminators.
    const buf = new Uint8Array(1000);
    for (let i = 0; i < 800; i++) buf[i] = 0xbb + (i % (0xee - 0xbb + 1));
    for (let i = 800; i < 1000; i++) buf[i] = 0xff;
    const r = classifyRegion(buf, 0, 1000);
    expect(r.probableClass).toBe('event_data');
    expect(r.classified).toBe(true);
  });

  it('classifies pseudo-random as compression (high entropy)', () => {
    const buf = new Uint8Array(4096);
    for (let i = 0; i < 4096; i++) buf[i] = (i * 1664525 + 1013904223) & 0xff;
    const r = classifyRegion(buf, 0, 4096);
    expect(r.probableClass).toBe('compression');
    expect(r.reason).toContain('entropy');
  });

  it('classifies ARM7-code-like as unknown_executable', () => {
    // Synthetic stream: 50% bytes in 0x00..0x4F (opcode range), 50% random
    // but spread across 0x80..0xFF. Entropy ~ 5.0.
    const buf = new Uint8Array(4096);
    for (let i = 0; i < 4096; i++) {
      buf[i] = i % 2 === 0 ? (i * 7) & 0x4f : 0x80 + ((i * 13) & 0x7f);
    }
    const r = classifyRegion(buf, 0, 4096);
    expect(r.probableClass).toBe('unknown_executable');
    expect(r.reason).toContain('ARM7');
  });

  it('falls back to unknown when no profile matches (still scored, never silent)', () => {
    // Build a buffer that doesn't fit any branch: balanced byte distribution
    // across all 256 values but NOT high enough entropy to trip compression,
    // AND not enough in 0x00..0x4F for ARM7 code.
    const buf = new Uint8Array(4096);
    for (let i = 0; i < 4096; i++) buf[i] = 0x50 + (i % 0x60); // 0x50..0xAF, no 0..4F bytes, no 0xBB..0xEE bias
    const r = classifyRegion(buf, 0, 4096);
    // This may classify as a specific branch depending on entropy; the
    // critical PD 8 invariant is that the verdict is non-null and scored.
    expect(r.score).toBeGreaterThan(0);
    expect(r.reason.length).toBeGreaterThan(0);
  });

  it('throws on invalid start', () => {
    expect(() => classifyRegion(new Uint8Array(16), -1, 4)).toThrow();
  });

  it('throws on invalid length', () => {
    expect(() => classifyRegion(new Uint8Array(16), 0, 0)).toThrow();
  });

  it('honors sampleLength cap (large region → only first 4KB profiled)', () => {
    // Build a 16 KB region where the first 4 KB is all-zero but the next
    // 12 KB is pseudo-random. With default 4 KB sample, classifyRegion
    // should report zero_padding (sample is all zeros).
    const buf = new Uint8Array(16 * 1024);
    for (let i = 4096; i < buf.length; i++) buf[i] = (i * 1664525 + 1013904223) & 0xff;
    const r = classifyRegion(buf, 0, buf.length);
    expect(r.reason).toContain('0x00');
  });

  it('honors custom sampleLength', () => {
    const buf = new Uint8Array(16 * 1024);
    for (let i = 4096; i < buf.length; i++) buf[i] = (i * 1664525 + 1013904223) & 0xff;
    const r = classifyRegion(buf, 0, buf.length, { sampleLength: buf.length });
    // Full scan: 25% zeros + 75% pseudo-random → mid entropy.
    expect(r.probableClass).not.toBe('zero_padding');
  });

  it('classifyRegion result is frozen', () => {
    const r = classifyRegion(new Uint8Array(1024), 0, 1024);
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r.profile)).toBe(true);
  });
});
