import { describe, it, expect } from 'vitest';
import { readLz77 } from './lz77.js';
import { encodeLz77 } from './lz77-encoder.js';

function roundTrip(input: Uint8Array): { compressed: Uint8Array; ratio: number } {
  const compressed = encodeLz77(input);
  const result = readLz77(compressed, 0);
  if (!result.ok) throw new Error(`decode failed: ${JSON.stringify(result.failure)}`);
  expect(result.uncompressedSize).toBe(input.length);
  expect(result.decompressedBytes.length).toBe(input.length);
  for (let i = 0; i < input.length; i++) {
    if (result.decompressedBytes[i] !== input[i]) {
      throw new Error(`mismatch at byte ${String(i)}: expected ${String(input[i])}, got ${String(result.decompressedBytes[i])}`);
    }
  }
  return { compressed, ratio: compressed.length / input.length };
}

describe('encodeLz77 - round-trip + decode invariants', () => {
  it('round-trips a tiny input', () => {
    const input = new Uint8Array([1, 2, 3, 4, 5]);
    const { compressed } = roundTrip(input);
    expect(compressed[0]).toBe(0x10); // LZ77 header
  });

  it('round-trips a 256-byte alphabet', () => {
    const input = new Uint8Array(256);
    for (let i = 0; i < 256; i++) input[i] = i;
    roundTrip(input);
  });

  it('round-trips a 1 KB run of zeros (RLE-friendly via 1-displacement)', () => {
    const input = new Uint8Array(1024);
    const { ratio } = roundTrip(input);
    // All-same data should compress dramatically.
    expect(ratio).toBeLessThan(0.2);
  });

  it('round-trips a 1 KB repeating pattern (long backrefs)', () => {
    const input = new Uint8Array(1024);
    for (let i = 0; i < input.length; i++) input[i] = i & 0x0f;
    const { ratio } = roundTrip(input);
    // 16-byte repeating pattern compresses well too.
    expect(ratio).toBeLessThan(0.4);
  });

  it('round-trips random data (compression near 1.0)', () => {
    const input = new Uint8Array(512);
    // Pseudo-random (deterministic seed)
    let s = 0x12345678;
    for (let i = 0; i < input.length; i++) {
      s = (s * 1103515245 + 12345) >>> 0;
      input[i] = (s >> 16) & 0xff;
    }
    const { ratio } = roundTrip(input);
    // Random data shouldn't blow up much past 1.15x.
    expect(ratio).toBeLessThan(1.2);
  });

  it('round-trips a known sprite-like pattern (mostly-zero with sparse data)', () => {
    const input = new Uint8Array(2048);
    // Simulate a sparse 4bpp tile: mostly zeros, with some patterned data.
    for (let i = 0; i < 200; i++) input[i * 7 % input.length] = (i & 0x0f) | ((i & 0xf0) << 4);
    const { ratio } = roundTrip(input);
    expect(ratio).toBeLessThan(0.6);
  });

  it('rejects empty input', () => {
    expect(() => encodeLz77(new Uint8Array(0))).toThrow(/empty/);
  });

  it('rejects oversize input', () => {
    expect(() => encodeLz77(new Uint8Array(5 * 1024 * 1024))).toThrow(/LZ77_MAX_UNCOMPRESSED_BYTES/);
  });

  it('round-trips byte 0xFF runs correctly (back-references must not corrupt)', () => {
    const input = new Uint8Array(100).fill(0xff);
    roundTrip(input);
  });

  it('round-trips boundary-of-window back-references', () => {
    // Build an input that requires back-references near the 4096-byte
    // window edge. Pattern: 4096 distinct bytes, then a repeat of the
    // first 18 bytes.
    const input = new Uint8Array(4096 + 18);
    for (let i = 0; i < 4096; i++) input[i] = i & 0xff;
    for (let i = 0; i < 18; i++) input[4096 + i] = i & 0xff;
    roundTrip(input);
  });
});
