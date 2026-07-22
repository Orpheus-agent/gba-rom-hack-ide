import { describe, expect, it } from 'vitest';
import {
  CFRU_PROBE_WINDOW_START,
  VANILLA_FRLG_ROM_SIZE,
  detectCfruHeuristic,
} from './cfru-heuristic.js';

/** Build a synthetic ROM with the FRLG game code at 0xAC and a given
 *  total size. The body is 0xFF (free space) unless explicitly set. */
function makeFrlgRom(size: number): Uint8Array {
  const rom = new Uint8Array(size).fill(0xff);
  // Set "BPRE" at offset 0xAC.
  rom[0xac] = 0x42;
  rom[0xad] = 0x50;
  rom[0xae] = 0x52;
  rom[0xaf] = 0x45;
  return rom;
}

/** Fill a 16-byte window starting at `offset` with code-shaped bytes
 *  (mostly non-FF, mostly non-zero) so the probe loop detects it. */
function plantCodeAt(rom: Uint8Array, offset: number): void {
  // Realistic-ish THUMB code prologue/epilogue mix:
  //   push {r4,lr}, mov r4,r0, ldr r0,[r4], ..., pop {r4,pc}, bx lr
  const codeBytes = [
    0x10, 0xb5, 0x04, 0x46, 0x20, 0x68, 0x00, 0x68,
    0x01, 0x21, 0x08, 0x40, 0x10, 0xbd, 0x70, 0x47,
  ];
  for (let i = 0; i < codeBytes.length; i++) {
    rom[offset + i] = codeBytes[i]!;
  }
}

describe('detectCfruHeuristic', () => {
  it('rejects a vanilla-shaped ROM with no inserted code', () => {
    const rom = makeFrlgRom(VANILLA_FRLG_ROM_SIZE);
    const result = detectCfruHeuristic(rom);
    expect(result.matched).toBe(false);
    expect(result.buildOffset).toBe(null);
    // Should mention header passes but size is at vanilla.
    expect(result.evidence.length).toBeGreaterThanOrEqual(1);
    expect(result.evidence.some((e) => /not expanded|at or below vanilla/i.test(e))).toBe(true);
  });

  it('rejects a non-FRLG ROM (wrong game code)', () => {
    const rom = makeFrlgRom(32 * 1024 * 1024);
    // Corrupt the game code to "AXVE" (Ruby).
    rom[0xac] = 0x41;
    rom[0xad] = 0x58;
    rom[0xae] = 0x56;
    rom[0xaf] = 0x45;
    const result = detectCfruHeuristic(rom);
    expect(result.matched).toBe(false);
    expect(result.buildOffset).toBe(null);
    expect(result.evidence[0]).toMatch(/not "BPRE"/);
  });

  it('rejects a too-small ROM (smaller than vanilla)', () => {
    const rom = makeFrlgRom(8 * 1024 * 1024);
    const result = detectCfruHeuristic(rom);
    expect(result.matched).toBe(false);
    expect(result.buildOffset).toBe(null);
    expect(result.evidence.some((e) => /not expanded|at or below vanilla/i.test(e))).toBe(true);
  });

  it('rejects an expanded ROM with no code in the probe window', () => {
    // Expanded ROM but entire [0x800000, 0xA00000) is 0xFF (free space).
    const rom = makeFrlgRom(32 * 1024 * 1024);
    const result = detectCfruHeuristic(rom);
    expect(result.matched).toBe(false);
    expect(result.buildOffset).toBe(null);
    expect(result.evidence.some((e) => /no inserted code detected/i.test(e))).toBe(true);
  });

  it('matches a 32 MiB ROM with code planted at the canonical CFRU offset 0x900000', () => {
    const rom = makeFrlgRom(32 * 1024 * 1024);
    plantCodeAt(rom, 0x900000);
    const result = detectCfruHeuristic(rom);
    expect(result.matched).toBe(true);
    expect(result.buildOffset).toBe(0x900000);
    expect(result.evidence.length).toBeGreaterThanOrEqual(3);
    expect(result.evidence.some((e) => /inserted code detected/i.test(e))).toBe(true);
  });

  it('matches a ROM with code planted at a custom (non-canonical) offset', () => {
    const rom = makeFrlgRom(32 * 1024 * 1024);
    plantCodeAt(rom, 0x880000); // user changed OFFSET_TO_PUT to 0x880000
    const result = detectCfruHeuristic(rom);
    expect(result.matched).toBe(true);
    expect(result.buildOffset).toBe(0x880000);
  });

  it('reports the FIRST code window found when multiple are present', () => {
    const rom = makeFrlgRom(32 * 1024 * 1024);
    plantCodeAt(rom, 0x900000);
    plantCodeAt(rom, 0x950000);
    const result = detectCfruHeuristic(rom);
    expect(result.matched).toBe(true);
    expect(result.buildOffset).toBe(0x900000);
  });

  it('rejects a 0xFF-only sample (free space, not code)', () => {
    const rom = makeFrlgRom(32 * 1024 * 1024);
    // Don't plant any code - every byte in the probe window is 0xFF.
    const result = detectCfruHeuristic(rom);
    expect(result.matched).toBe(false);
  });

  it('rejects a 0x00-only sample (zero padding, not code)', () => {
    const rom = makeFrlgRom(32 * 1024 * 1024);
    // Zero out a 16-byte window inside the probe range.
    for (let i = 0; i < 16; i++) rom[0x900000 + i] = 0x00;
    const result = detectCfruHeuristic(rom);
    expect(result.matched).toBe(false);
  });

  it('reports the probe window bounds correctly in its public constants', () => {
    expect(CFRU_PROBE_WINDOW_START).toBe(0x800000);
    expect(VANILLA_FRLG_ROM_SIZE).toBe(16 * 1024 * 1024);
  });
});
