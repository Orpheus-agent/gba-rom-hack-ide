import { describe, expect, it } from 'vitest';
import { CoverageMap } from '../coverage/index.js';
import { loadRomFromBytes } from '../rom/index.js';
import { encodeString, STRING_TERMINATOR } from '../text/codec.js';
import { TYPE_NAME_SLOT_BYTES } from '../battle/index.js';
import {
  TYPE_NAMES_DETECTOR_ID,
  typeNamesDetector,
} from './type-names-system.js';

const VANILLA_TYPE_NAMES = [
  'NORMAL',
  'FIGHT',
  'FLYING',
  'POISON',
  'GROUND',
  'ROCK',
  'BUG',
  'GHOST',
  'STEEL',
  'MYS',
  'FIRE',
  'WATER',
  'GRASS',
  'ELECTR',
  'PSYCHC',
  'ICE',
  'DRAGON',
  'DARK',
];

function plantTypeNamesTable(buf: Uint8Array, offset: number, count: number): void {
  for (let i = 0; i < count; i++) {
    const slotStart = offset + i * TYPE_NAME_SLOT_BYTES;
    const name = VANILLA_TYPE_NAMES[i] ?? `T${i}`;
    const encoded = encodeString(name);
    const slot = new Uint8Array(TYPE_NAME_SLOT_BYTES);
    slot.set(encoded.subarray(0, Math.min(encoded.length, TYPE_NAME_SLOT_BYTES - 1)), 0);
    const termPos = Math.min(encoded.length, TYPE_NAME_SLOT_BYTES - 1);
    slot[termPos] = STRING_TERMINATOR;
    buf.set(slot, slotStart);
  }
}

describe('typeNamesDetector', () => {
  it('exports the universal RomDetector contract', () => {
    expect(typeNamesDetector.id).toBe(TYPE_NAMES_DETECTOR_ID);
    expect(typeof typeNamesDetector.name).toBe('string');
    expect(typeNamesDetector.phase).toBe(8);
    expect(typeof typeNamesDetector.detect).toBe('function');
  });

  // Note: the detector's "ROM too small" path (bytes.length < 10 * 7 =
  // 70) is unreachable via loadRomFromBytes which requires ≥192 bytes
  // (GBA header). Skipping that test case - the gate is enforced by
  // loadRomFromBytes itself.

  it('returns not_detected when no NORMAL signature present', () => {
    const bytes = new Uint8Array(4 * 1024);
    bytes[0xb2] = 0x96;
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 13 + 7) % 256;
    const rom = loadRomFromBytes({ bytes, sourcePath: 'test://no-types', synthetic: true });
    const cov = new CoverageMap(bytes.length);
    const r = typeNamesDetector.detect(rom, cov);
    expect(r.status).toBe('not_detected');
    if (r.status === 'not_detected') expect(r.reason).toContain('No Gen-3 gTypeNames');
  });

  it('detects a planted vanilla 18-type table + registers coverage', () => {
    const bytes = new Uint8Array(4 * 1024);
    bytes[0xb2] = 0x96;
    plantTypeNamesTable(bytes, 0x200, 18);
    const rom = loadRomFromBytes({ bytes, sourcePath: 'test://types', synthetic: true });
    const cov = new CoverageMap(bytes.length);
    const r = typeNamesDetector.detect(rom, cov);
    expect(r.status).toBe('detected');
    if (r.status === 'detected') {
      expect(r.data.tableOffset).toBe(0x200);
      expect(r.data.validTypeCount).toBeGreaterThanOrEqual(15);
      expect(r.data.sampleNames[0]).toBe('NORMAL');
      expect(r.data.sampleNames[10]).toBe('FIRE');
      expect(r.data.sampleNames[17]).toBe('DARK');
      expect(r.confidence).toBeCloseTo(0.95, 5);
    }
    const report = cov.report();
    const regions = report.regions.filter((rgn) =>
      rgn.provenance?.includes(TYPE_NAMES_DETECTOR_ID),
    );
    expect(regions.length).toBe(1);
    expect(regions[0]?.start).toBe(0x200);
  });

  it('result.data is frozen', () => {
    const bytes = new Uint8Array(4 * 1024);
    bytes[0xb2] = 0x96;
    plantTypeNamesTable(bytes, 0x200, 18);
    const rom = loadRomFromBytes({ bytes, sourcePath: 'test://frozen', synthetic: true });
    const cov = new CoverageMap(bytes.length);
    const r = typeNamesDetector.detect(rom, cov);
    if (r.status === 'detected') {
      expect(Object.isFrozen(r.data)).toBe(true);
      expect(Object.isFrozen(r.data.sampleNames)).toBe(true);
    }
  });
});
