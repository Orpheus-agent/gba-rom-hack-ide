import { describe, expect, it } from 'vitest';
import {
  TRAINER_NAME_TERMINATOR,
  TRAINER_STRUCT_SIZE_BYTES as REC,
} from './trainer.js';
import { scanTrainerTable } from './trainer-scanner.js';

/** Plant a minimal valid Trainer record at `at`. Defaults: class=1,
 *  partySize=3, aiFlags=1, name "RED", NULL party pointer. */
function plantOne(
  buf: Buffer,
  at: number,
  opts?: { trainerClass?: number; partySize?: number; name?: string },
): void {
  buf[at + 0x00] = 0; // partyFlags
  buf[at + 0x01] = opts?.trainerClass ?? 1;
  buf[at + 0x02] = 5; // encounterMusic
  buf[at + 0x03] = 0; // trainerPic
  const name = opts?.name ?? 'RED';
  for (let k = 0; k < 12; k++) {
    if (k < name.length) {
      buf[at + 0x04 + k] = name.charCodeAt(k);
    } else if (k === name.length) {
      buf[at + 0x04 + k] = TRAINER_NAME_TERMINATOR;
    } else {
      buf[at + 0x04 + k] = 0;
    }
  }
  // items[4] at 0x10..0x17 = 0
  for (let k = 0; k < 8; k++) buf[at + 0x10 + k] = 0;
  buf[at + 0x18] = 0; // doubleBattle
  // pad19/1A/1B = 0
  buf.writeUInt32LE(1, at + 0x1c); // aiFlags
  buf[at + 0x20] = opts?.partySize ?? 3;
  // pad21/22/23 = 0
  buf.writeUInt32LE(0, at + 0x24); // partyPointer NULL
}

describe('scanTrainerTable - happy paths', () => {
  it('finds an 8-record table (default min)', () => {
    const buf = Buffer.alloc(0x1000);
    const tableAt = 0x100;
    for (let i = 0; i < 8; i++) plantOne(buf, tableAt + i * REC, { trainerClass: i + 1 });
    const r = scanTrainerTable(buf);
    expect(r).not.toBeNull();
    if (r !== null) {
      expect(r.tableStart).toBe(tableAt);
      expect(r.trainerCount).toBe(8);
      expect(r.tableEndExclusive).toBe(tableAt + 8 * REC);
      expect(r.trainers[0]?.trainerClass).toBe(1);
      expect(r.trainers[7]?.trainerClass).toBe(8);
    }
  });

  it('finds a 30-record table', () => {
    const buf = Buffer.alloc(0x2000);
    const tableAt = 0x200;
    for (let i = 0; i < 30; i++) plantOne(buf, tableAt + i * REC);
    const r = scanTrainerTable(buf);
    expect(r).not.toBeNull();
    if (r !== null) expect(r.trainerCount).toBe(30);
  });

  it('walks until parse fails (run terminates on first invalid record)', () => {
    const buf = Buffer.alloc(0x2000);
    const tableAt = 0x200;
    for (let i = 0; i < 10; i++) plantOne(buf, tableAt + i * REC);
    // Plant an invalid record at slot 10: pad19 = 0xff (nonzero_padding)
    plantOne(buf, tableAt + 10 * REC);
    buf[tableAt + 10 * REC + 0x19] = 0xff;
    const r = scanTrainerTable(buf);
    expect(r).not.toBeNull();
    if (r !== null) expect(r.trainerCount).toBe(10);
  });

  it('result + trainers are frozen', () => {
    const buf = Buffer.alloc(0x1000);
    for (let i = 0; i < 8; i++) plantOne(buf, 0x100 + i * REC);
    const r = scanTrainerTable(buf);
    if (r !== null) {
      expect(Object.isFrozen(r)).toBe(true);
      expect(Object.isFrozen(r.trainers)).toBe(true);
    }
  });
});

describe('scanTrainerTable - rejection cases', () => {
  it('returns null when run < minTrainersInTable (default 8)', () => {
    const buf = Buffer.alloc(0x1000);
    for (let i = 0; i < 5; i++) plantOne(buf, 0x100 + i * REC);
    // Plant invalid at slot 5
    plantOne(buf, 0x100 + 5 * REC);
    buf[0x100 + 5 * REC + 0x19] = 0xff;
    expect(scanTrainerTable(buf)).toBeNull();
  });

  it('returns null for empty/zero buffer', () => {
    expect(scanTrainerTable(new Uint8Array(0x1000))).toBeNull();
  });

  it('honors minTrainersInTable=3 option', () => {
    const buf = Buffer.alloc(0x1000);
    for (let i = 0; i < 3; i++) plantOne(buf, 0x100 + i * REC);
    plantOne(buf, 0x100 + 3 * REC);
    buf[0x100 + 3 * REC + 0x19] = 0xff;
    const r = scanTrainerTable(buf, { minTrainersInTable: 3 });
    expect(r).not.toBeNull();
    if (r !== null) expect(r.trainerCount).toBe(3);
  });

  it('throws on invalid minTrainersInTable=0', () => {
    expect(() => scanTrainerTable(new Uint8Array(0x1000), { minTrainersInTable: 0 })).toThrow();
  });

  it('throws when maxTrainersInTable < minTrainersInTable', () => {
    expect(() =>
      scanTrainerTable(new Uint8Array(0x1000), {
        minTrainersInTable: 10,
        maxTrainersInTable: 5,
      }),
    ).toThrow();
  });
});
