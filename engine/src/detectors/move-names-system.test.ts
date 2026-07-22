import { describe, expect, it } from 'vitest';
import { CoverageMap } from '../coverage/index.js';
import { loadRomFromBytes } from '../rom/index.js';
import { encodeString, STRING_TERMINATOR } from '../text/codec.js';
import { MOVE_NAME_SLOT_BYTES, MOVE_PLACEHOLDER_BYTE } from '../moves/index.js';
import { MOVE_NAMES_DETECTOR_ID, moveNamesDetector } from './move-names-system.js';

const VANILLA_MOVE_NAMES = [
  '-',
  'POUND',
  'KARATE CHOP',
  'DOUBLE SLAP',
  'COMET PUNCH',
  'MEGA PUNCH',
  'PAY DAY',
  'FIRE PUNCH',
  'ICE PUNCH',
  'THUNDERPUNCH',
];

function plantMoveNamesTable(buf: Uint8Array, offset: number, count: number): void {
  const placeholder = new Uint8Array(MOVE_NAME_SLOT_BYTES);
  placeholder[0] = MOVE_PLACEHOLDER_BYTE;
  placeholder[1] = STRING_TERMINATOR;
  buf.set(placeholder, offset);

  for (let i = 1; i < count; i++) {
    const slotStart = offset + i * MOVE_NAME_SLOT_BYTES;
    const name = VANILLA_MOVE_NAMES[i] ?? `MOVE${String(i).padStart(3, '0')}`;
    const encoded = encodeString(name);
    const slot = new Uint8Array(MOVE_NAME_SLOT_BYTES);
    slot.set(encoded.subarray(0, Math.min(encoded.length, MOVE_NAME_SLOT_BYTES - 1)), 0);
    const termPos = Math.min(encoded.length, MOVE_NAME_SLOT_BYTES - 1);
    slot[termPos] = STRING_TERMINATOR;
    buf.set(slot, slotStart);
  }
}

describe('moveNamesDetector', () => {
  it('exports the universal RomDetector contract', () => {
    expect(moveNamesDetector.id).toBe(MOVE_NAMES_DETECTOR_ID);
    expect(typeof moveNamesDetector.name).toBe('string');
    expect(moveNamesDetector.phase).toBe(8);
    expect(typeof moveNamesDetector.detect).toBe('function');
  });

  it('returns not_detected on ROM too small', () => {
    // 50 * 13 = 650 bytes minimum. 400 bytes is below that but past the
    // 192-byte loadRomFromBytes floor.
    const bytes = new Uint8Array(400);
    bytes[0xb2] = 0x96;
    const rom = loadRomFromBytes({ bytes, sourcePath: 'test://tiny', synthetic: true });
    const cov = new CoverageMap(bytes.length);
    const r = moveNamesDetector.detect(rom, cov);
    expect(r.status).toBe('not_detected');
    if (r.status === 'not_detected') expect(r.reason).toContain('too small');
  });

  it('returns not_detected when no move-names signature is present', () => {
    const bytes = new Uint8Array(8 * 1024);
    bytes[0xb2] = 0x96;
    for (let i = 0xc0; i < bytes.length; i++) bytes[i] = (i * 13 + 7) % 256;
    const rom = loadRomFromBytes({ bytes, sourcePath: 'test://no-moves', synthetic: true });
    const cov = new CoverageMap(bytes.length);
    const r = moveNamesDetector.detect(rom, cov);
    expect(r.status).toBe('not_detected');
    if (r.status === 'not_detected') expect(r.reason).toContain('No Gen-3 gMoveNames');
  });

  it('finds a planted 60-move-name table + registers coverage', () => {
    const bytes = new Uint8Array(16 * 1024);
    bytes[0xb2] = 0x96;
    plantMoveNamesTable(bytes, 0x800, 60);
    const rom = loadRomFromBytes({ bytes, sourcePath: 'test://moves', synthetic: true });
    const cov = new CoverageMap(bytes.length);
    const r = moveNamesDetector.detect(rom, cov);
    expect(r.status).toBe('detected');
    if (r.status === 'detected') {
      expect(r.data.validMoveCount).toBeGreaterThanOrEqual(10);
      expect(r.data.tableOffset).toBe(0x800);
      expect(r.data.sampleNames[1]).toBe('POUND');
      expect(r.data.sampleNames[2]).toBe('KARATE CHOP');
    }
    const report = cov.report();
    const moveRegions = report.regions.filter((rgn) =>
      rgn.provenance?.includes(MOVE_NAMES_DETECTOR_ID),
    );
    expect(moveRegions.length).toBe(1);
    expect(moveRegions[0]?.start).toBe(0x800);
  });

  it('result.data is frozen', () => {
    const bytes = new Uint8Array(16 * 1024);
    bytes[0xb2] = 0x96;
    plantMoveNamesTable(bytes, 0x800, 60);
    const rom = loadRomFromBytes({ bytes, sourcePath: 'test://moves', synthetic: true });
    const cov = new CoverageMap(bytes.length);
    const r = moveNamesDetector.detect(rom, cov);
    if (r.status === 'detected') {
      expect(Object.isFrozen(r.data)).toBe(true);
      expect(Object.isFrozen(r.data.sampleNames)).toBe(true);
    }
  });
});
