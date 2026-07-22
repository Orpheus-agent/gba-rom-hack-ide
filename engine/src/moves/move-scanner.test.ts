import { describe, expect, it } from 'vitest';
import {
  BATTLE_MOVES_SCAN_MIN_RECORDS,
  BATTLE_MOVE_STRUCT_SIZE_BYTES,
  scanBattleMovesTable,
} from './index.js';

/** Build a valid 12-byte BattleMove struct. */
function validMoveBytes(seed: number): Uint8Array {
  const b = new Uint8Array(BATTLE_MOVE_STRUCT_SIZE_BYTES);
  b[0] = seed % 200; // effect
  b[1] = (seed * 3) % 200; // power
  b[2] = seed % 18; // type 0..17
  b[3] = 75 + (seed % 25); // accuracy 75..99
  b[4] = 5 + (seed % 35); // pp 5..39
  b[5] = (seed * 7) % 100; // effect chance
  b[6] = 0;
  b[7] = 0; // priority 0
  b[8] = 0;
  b[9] = 0;
  b[10] = 0; // padding A
  b[11] = 0; // padding B
  return b;
}

describe('scanBattleMovesTable', () => {
  it('returns null when ROM is too small', () => {
    const bytes = new Uint8Array(1000);
    expect(scanBattleMovesTable(bytes)).toBeNull();
  });

  it('returns null when no consecutive move-table run exists', () => {
    const bytes = new Uint8Array(64 * 1024);
    // Fill with random-ish bytes that won't pass move-shape validation.
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7 + 31) % 256;
    expect(scanBattleMovesTable(bytes)).toBeNull();
  });

  it('finds a planted run of 100 valid moves', () => {
    const bytes = new Uint8Array(64 * 1024);
    // Fill with garbage so backward sentinel walk + forward end stop
    // at the planted region's edges (real ROMs have code+data around
    // the move table, not zero-padding).
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 13 + 7) % 256;
    const plantOffset = 0x1000; // 4-byte aligned, past header
    for (let i = 0; i < 100; i++) {
      bytes.set(validMoveBytes(i + 1), plantOffset + i * BATTLE_MOVE_STRUCT_SIZE_BYTES);
    }
    const result = scanBattleMovesTable(bytes);
    expect(result).not.toBeNull();
    expect(result?.tableStart).toBe(plantOffset);
    expect(result?.moveCount).toBe(100);
    expect(result?.tableEndExclusive).toBe(plantOffset + 100 * BATTLE_MOVE_STRUCT_SIZE_BYTES);
  });

  it('honors custom minRecords + minPopulated option', () => {
    const bytes = new Uint8Array(8 * 1024);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 13 + 7) % 256;
    const plantOffset = 0x200;
    // Plant only 30 moves - below default thresholds but above custom.
    for (let i = 0; i < 30; i++) {
      bytes.set(validMoveBytes(i + 1), plantOffset + i * BATTLE_MOVE_STRUCT_SIZE_BYTES);
    }
    expect(scanBattleMovesTable(bytes)).toBeNull(); // default 80
    const customResult = scanBattleMovesTable(bytes, {
      minRecords: 20,
      minPopulated: 20,
    });
    expect(customResult).not.toBeNull();
    expect(customResult?.moveCount).toBe(30);
  });

  it('finds the longest run when multiple candidate runs exist', () => {
    const bytes = new Uint8Array(64 * 1024);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 13 + 7) % 256;
    // Plant 85 moves at offset 0x800.
    for (let i = 0; i < 85; i++) {
      bytes.set(validMoveBytes(i + 1), 0x800 + i * BATTLE_MOVE_STRUCT_SIZE_BYTES);
    }
    // Plant 120 moves at offset 0x4000.
    for (let i = 0; i < 120; i++) {
      bytes.set(validMoveBytes(i + 1), 0x4000 + i * BATTLE_MOVE_STRUCT_SIZE_BYTES);
    }
    const result = scanBattleMovesTable(bytes);
    expect(result?.tableStart).toBe(0x4000);
    expect(result?.moveCount).toBe(120);
  });

  it('default MIN_RECORDS constant is exposed and reasonable', () => {
    expect(BATTLE_MOVES_SCAN_MIN_RECORDS).toBeGreaterThanOrEqual(50);
    expect(BATTLE_MOVES_SCAN_MIN_RECORDS).toBeLessThanOrEqual(200);
  });
});
