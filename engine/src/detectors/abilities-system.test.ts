import { describe, expect, it } from 'vitest';
import { CoverageMap } from '../coverage/index.js';
import { loadRomFromBytes } from '../rom/index.js';
import { encodeString, STRING_TERMINATOR } from '../text/codec.js';
import {
  ABILITY_NAME_SLOT_BYTES,
  ABILITY_PLACEHOLDER_BYTE,
} from '../abilities/index.js';
import {
  ABILITIES_SYSTEM_DETECTOR_ID,
  abilitiesSystemDetector,
} from './abilities-system.js';

const VANILLA_ABILITY_NAMES = [
  '---',
  'STENCH',
  'DRIZZLE',
  'SPEED BOOST',
  'BATTLE ARMOR',
  'STURDY',
  'DAMP',
  'LIMBER',
  'SAND VEIL',
  'STATIC',
];

function plantAbilityNamesTable(buf: Uint8Array, offset: number, count: number): void {
  const placeholder = new Uint8Array(ABILITY_NAME_SLOT_BYTES);
  placeholder[0] = ABILITY_PLACEHOLDER_BYTE;
  placeholder[1] = ABILITY_PLACEHOLDER_BYTE;
  placeholder[2] = ABILITY_PLACEHOLDER_BYTE;
  placeholder[3] = STRING_TERMINATOR;
  buf.set(placeholder, offset);

  for (let i = 1; i < count; i++) {
    const slotStart = offset + i * ABILITY_NAME_SLOT_BYTES;
    const name = VANILLA_ABILITY_NAMES[i] ?? `ABILITY${String(i).padStart(2, '0')}`;
    const encoded = encodeString(name);
    const slot = new Uint8Array(ABILITY_NAME_SLOT_BYTES);
    slot.set(encoded.subarray(0, Math.min(encoded.length, ABILITY_NAME_SLOT_BYTES - 1)), 0);
    const termPos = Math.min(encoded.length, ABILITY_NAME_SLOT_BYTES - 1);
    slot[termPos] = STRING_TERMINATOR;
    buf.set(slot, slotStart);
  }
}

describe('abilitiesSystemDetector', () => {
  it('exports the universal RomDetector contract', () => {
    expect(abilitiesSystemDetector.id).toBe(ABILITIES_SYSTEM_DETECTOR_ID);
    expect(typeof abilitiesSystemDetector.name).toBe('string');
    expect(abilitiesSystemDetector.phase).toBe(8);
    expect(typeof abilitiesSystemDetector.detect).toBe('function');
  });

  it('returns not_detected on ROM too small', () => {
    // 30 * 13 = 390 bytes minimum. 250 bytes is below that but past
    // the 192-byte loadRomFromBytes floor.
    const bytes = new Uint8Array(250);
    bytes[0xb2] = 0x96;
    const rom = loadRomFromBytes({ bytes, sourcePath: 'test://tiny', synthetic: true });
    const cov = new CoverageMap(bytes.length);
    const r = abilitiesSystemDetector.detect(rom, cov);
    expect(r.status).toBe('not_detected');
    if (r.status === 'not_detected') expect(r.reason).toContain('too small');
  });

  it('returns not_detected when no ability-names signature is present', () => {
    const bytes = new Uint8Array(8 * 1024);
    bytes[0xb2] = 0x96;
    for (let i = 0xc0; i < bytes.length; i++) bytes[i] = (i * 13 + 7) % 256;
    const rom = loadRomFromBytes({ bytes, sourcePath: 'test://no-abilities', synthetic: true });
    const cov = new CoverageMap(bytes.length);
    const r = abilitiesSystemDetector.detect(rom, cov);
    expect(r.status).toBe('not_detected');
    if (r.status === 'not_detected') expect(r.reason).toContain('No Gen-3 gAbilityNames');
  });

  it('finds a planted 78-ability table + registers coverage', () => {
    const bytes = new Uint8Array(16 * 1024);
    bytes[0xb2] = 0x96;
    plantAbilityNamesTable(bytes, 0x800, 78);
    const rom = loadRomFromBytes({ bytes, sourcePath: 'test://abilities', synthetic: true });
    const cov = new CoverageMap(bytes.length);
    const r = abilitiesSystemDetector.detect(rom, cov);
    expect(r.status).toBe('detected');
    if (r.status === 'detected') {
      expect(r.data.validAbilityCount).toBeGreaterThanOrEqual(10);
      expect(r.data.tableOffset).toBe(0x800);
      expect(r.data.sampleNames[1]).toBe('STENCH');
      expect(r.data.sampleNames[2]).toBe('DRIZZLE');
    }
    const report = cov.report();
    const abilityRegions = report.regions.filter((rgn) =>
      rgn.provenance?.includes(ABILITIES_SYSTEM_DETECTOR_ID),
    );
    expect(abilityRegions.length).toBe(1);
    expect(abilityRegions[0]?.start).toBe(0x800);
  });

  it('result.data is frozen', () => {
    const bytes = new Uint8Array(16 * 1024);
    bytes[0xb2] = 0x96;
    plantAbilityNamesTable(bytes, 0x800, 78);
    const rom = loadRomFromBytes({ bytes, sourcePath: 'test://abilities', synthetic: true });
    const cov = new CoverageMap(bytes.length);
    const r = abilitiesSystemDetector.detect(rom, cov);
    if (r.status === 'detected') {
      expect(Object.isFrozen(r.data)).toBe(true);
      expect(Object.isFrozen(r.data.sampleNames)).toBe(true);
    }
  });
});
