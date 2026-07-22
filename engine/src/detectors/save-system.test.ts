import { describe, expect, it } from 'vitest';
import { CoverageMap } from '../coverage/index.js';
import { loadRomFromBytes } from '../rom/index.js';
import {
  SAVE_STRING_DESCRIPTORS,
  SAVE_SYSTEM_DETECTOR_ID,
  saveSystemDetector,
} from './save-system.js';

function buildRomWithSaveString(opts: {
  romSize: number;
  identifier: string;
  offset: number;
  /** Optional secondary identifier planted at a later offset. */
  extraIdentifier?: { identifier: string; offset: number };
}) {
  const bytes = new Uint8Array(opts.romSize);
  bytes[0xb2] = 0x96; // valid GBA fixed marker so loadRomFromBytes accepts
  const buf = Buffer.from(opts.identifier, 'ascii');
  bytes.set(buf, opts.offset);
  if (opts.extraIdentifier) {
    const ebuf = Buffer.from(opts.extraIdentifier.identifier, 'ascii');
    bytes.set(ebuf, opts.extraIdentifier.offset);
  }
  return loadRomFromBytes({
    bytes,
    sourcePath: 'test://save-system',
    synthetic: true,
  });
}

describe('saveSystemDetector', () => {
  it('exports the universal RomDetector contract', () => {
    expect(saveSystemDetector.id).toBe(SAVE_SYSTEM_DETECTOR_ID);
    expect(typeof saveSystemDetector.name).toBe('string');
    expect(saveSystemDetector.phase).toBe(2);
    expect(typeof saveSystemDetector.detect).toBe('function');
  });

  it('returns not_detected when ROM is too small (<256 bytes)', () => {
    const bytes = new Uint8Array(192); // GBA loader minimum
    bytes[0xb2] = 0x96;
    const rom = loadRomFromBytes({ bytes, sourcePath: 'test://tiny', synthetic: true });
    const cov = new CoverageMap(bytes.length);
    const r = saveSystemDetector.detect(rom, cov);
    expect(r.status).toBe('not_detected');
    if (r.status === 'not_detected') {
      expect(r.reason).toContain('too small');
    }
  });

  it('returns not_detected when no known save string is in the ROM', () => {
    const bytes = new Uint8Array(64 * 1024);
    bytes[0xb2] = 0x96;
    // Fill with non-matching ASCII pattern.
    for (let i = 0x100; i < bytes.length; i++) bytes[i] = 0x41 + (i % 26); // 'A'..'Z' rotation
    const rom = loadRomFromBytes({ bytes, sourcePath: 'test://no-save', synthetic: true });
    const cov = new CoverageMap(bytes.length);
    const r = saveSystemDetector.detect(rom, cov);
    expect(r.status).toBe('not_detected');
    if (r.status === 'not_detected') {
      expect(r.reason).toContain('No GBA save-format identifier');
    }
  });

  it('detects FLASH1M_V103 (FireRed-shape) + registers string coverage', () => {
    const rom = buildRomWithSaveString({
      romSize: 1024 * 1024,
      identifier: 'FLASH1M_V103',
      offset: 0x80000,
    });
    const cov = new CoverageMap(rom.bytes.length);
    const r = saveSystemDetector.detect(rom, cov);
    expect(r.status).toBe('detected');
    if (r.status === 'detected') {
      expect(r.data.identifier).toBe('FLASH1M_V103');
      expect(r.data.family).toBe('FLASH');
      expect(r.data.declaredSizeBytes).toBe(128 * 1024);
      expect(r.data.stringOffset).toBe(0x80000);
      expect(r.data.additionalMatches).toEqual([]);
    }
    const report = cov.report();
    const saveRegions = report.regions.filter(
      (rgn) => rgn.provenance?.includes(SAVE_SYSTEM_DETECTOR_ID),
    );
    expect(saveRegions.length).toBe(1);
    expect(saveRegions[0]?.start).toBe(0x80000);
    expect(saveRegions[0]?.end).toBe(0x80000 + 'FLASH1M_V103'.length);
  });

  it('detects SRAM_V112 (older Gen-3 shape)', () => {
    const rom = buildRomWithSaveString({
      romSize: 64 * 1024,
      identifier: 'SRAM_V112',
      offset: 0x4000,
    });
    const cov = new CoverageMap(rom.bytes.length);
    const r = saveSystemDetector.detect(rom, cov);
    expect(r.status).toBe('detected');
    if (r.status === 'detected') {
      expect(r.data.identifier).toBe('SRAM_V112');
      expect(r.data.family).toBe('SRAM');
      expect(r.data.declaredSizeBytes).toBe(32 * 1024);
    }
  });

  it('detects EEPROM_V124 (small-cart shape)', () => {
    const rom = buildRomWithSaveString({
      romSize: 64 * 1024,
      identifier: 'EEPROM_V124',
      offset: 0x2000,
    });
    const cov = new CoverageMap(rom.bytes.length);
    const r = saveSystemDetector.detect(rom, cov);
    expect(r.status).toBe('detected');
    if (r.status === 'detected') {
      expect(r.data.identifier).toBe('EEPROM_V124');
      expect(r.data.family).toBe('EEPROM');
      expect(r.data.declaredSizeBytes).toBe(8 * 1024);
    }
  });

  it('reports additionalMatches when multiple save strings present (rare)', () => {
    const rom = buildRomWithSaveString({
      romSize: 1024 * 1024,
      identifier: 'FLASH1M_V103',
      offset: 0x80000,
      extraIdentifier: { identifier: 'SRAM_V112', offset: 0x90000 },
    });
    const cov = new CoverageMap(rom.bytes.length);
    const r = saveSystemDetector.detect(rom, cov);
    expect(r.status).toBe('detected');
    if (r.status === 'detected') {
      // Primary is the EARLIER offset (FLASH1M_V103 at 0x80000).
      expect(r.data.identifier).toBe('FLASH1M_V103');
      expect(r.data.additionalMatches.length).toBe(1);
      expect(r.data.additionalMatches[0]?.identifier).toBe('SRAM_V112');
      expect(r.data.additionalMatches[0]?.stringOffset).toBe(0x90000);
    }
  });

  it('result.data is frozen', () => {
    const rom = buildRomWithSaveString({
      romSize: 1024 * 1024,
      identifier: 'FLASH_V126',
      offset: 0x10000,
    });
    const cov = new CoverageMap(rom.bytes.length);
    const r = saveSystemDetector.detect(rom, cov);
    if (r.status === 'detected') {
      expect(Object.isFrozen(r.data)).toBe(true);
    }
  });

  it('SAVE_STRING_DESCRIPTORS covers all 3 backend families with non-empty needles', () => {
    const families = new Set(SAVE_STRING_DESCRIPTORS.map((d) => d.family));
    expect(families.has('SRAM')).toBe(true);
    expect(families.has('FLASH')).toBe(true);
    expect(families.has('EEPROM')).toBe(true);
    for (const d of SAVE_STRING_DESCRIPTORS) {
      expect(d.needle.length).toBeGreaterThan(0);
      expect(d.declaredSizeBytes).toBeGreaterThan(0);
    }
  });
});
