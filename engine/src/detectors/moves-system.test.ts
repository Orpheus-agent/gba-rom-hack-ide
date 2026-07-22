import { describe, expect, it } from 'vitest';
import { CoverageMap } from '../coverage/index.js';
import { loadRomFromBytes } from '../rom/index.js';
import { BATTLE_MOVE_STRUCT_SIZE_BYTES } from '../moves/index.js';
import { MOVES_SYSTEM_DETECTOR_ID, movesSystemDetector } from './moves-system.js';

function plantValidMoves(bytes: Uint8Array, offset: number, count: number): void {
  for (let i = 0; i < count; i++) {
    const o = offset + i * BATTLE_MOVE_STRUCT_SIZE_BYTES;
    bytes[o + 0] = i % 200; // effect
    bytes[o + 1] = (i * 3) % 200; // power
    bytes[o + 2] = i % 18; // type
    bytes[o + 3] = 75 + (i % 25); // accuracy
    bytes[o + 4] = 5 + (i % 35); // pp
    bytes[o + 5] = (i * 7) % 100; // effect chance
    bytes[o + 6] = 0;
    bytes[o + 7] = 0; // priority
    bytes[o + 8] = 0;
    bytes[o + 9] = 0;
    bytes[o + 10] = 0;
    bytes[o + 11] = 0;
  }
}

describe('movesSystemDetector', () => {
  it('exports the universal RomDetector contract', () => {
    expect(movesSystemDetector.id).toBe(MOVES_SYSTEM_DETECTOR_ID);
    expect(typeof movesSystemDetector.name).toBe('string');
    expect(movesSystemDetector.phase).toBe(8);
    expect(typeof movesSystemDetector.detect).toBe('function');
  });

  it('returns not_detected on ROM too small', () => {
    const bytes = new Uint8Array(500);
    bytes[0xb2] = 0x96;
    const rom = loadRomFromBytes({ bytes, sourcePath: 'test://tiny', synthetic: true });
    const cov = new CoverageMap(bytes.length);
    const r = movesSystemDetector.detect(rom, cov);
    expect(r.status).toBe('not_detected');
    if (r.status === 'not_detected') expect(r.reason).toContain('too small');
  });

  it('returns not_detected when no move table is in the ROM', () => {
    const bytes = new Uint8Array(64 * 1024);
    bytes[0xb2] = 0x96;
    // Fill with non-move-shaped bytes.
    for (let i = 0x100; i < bytes.length; i++) bytes[i] = (i * 13 + 7) % 256;
    const rom = loadRomFromBytes({ bytes, sourcePath: 'test://no-moves', synthetic: true });
    const cov = new CoverageMap(bytes.length);
    const r = movesSystemDetector.detect(rom, cov);
    expect(r.status).toBe('not_detected');
    if (r.status === 'not_detected') expect(r.reason).toContain('No Gen-3 gBattleMoves');
  });

  it('finds a planted 100-move table + registers coverage', () => {
    const bytes = new Uint8Array(64 * 1024);
    // Garbage-fill so backward sentinel walk + edge detection stop
    // at the planted region boundary.
    for (let i = 0xc0; i < bytes.length; i++) bytes[i] = (i * 13 + 7) % 256;
    bytes[0xb2] = 0x96;
    plantValidMoves(bytes, 0x2000, 100);
    const rom = loadRomFromBytes({ bytes, sourcePath: 'test://moves', synthetic: true });
    const cov = new CoverageMap(bytes.length);
    const r = movesSystemDetector.detect(rom, cov);
    expect(r.status).toBe('detected');
    if (r.status === 'detected') {
      expect(r.data.moveCount).toBe(100);
      expect(r.data.battleMovesTable.tableStart).toBe(0x2000);
    }
    const report = cov.report();
    const moveRegions = report.regions.filter((rgn) =>
      rgn.provenance?.includes(MOVES_SYSTEM_DETECTOR_ID),
    );
    expect(moveRegions.length).toBe(1);
    expect(moveRegions[0]?.start).toBe(0x2000);
  });

  it('result.data is frozen', () => {
    const bytes = new Uint8Array(64 * 1024);
    for (let i = 0xc0; i < bytes.length; i++) bytes[i] = (i * 13 + 7) % 256;
    bytes[0xb2] = 0x96;
    plantValidMoves(bytes, 0x2000, 100);
    const rom = loadRomFromBytes({ bytes, sourcePath: 'test://moves', synthetic: true });
    const cov = new CoverageMap(bytes.length);
    const r = movesSystemDetector.detect(rom, cov);
    if (r.status === 'detected') expect(Object.isFrozen(r.data)).toBe(true);
  });
});
