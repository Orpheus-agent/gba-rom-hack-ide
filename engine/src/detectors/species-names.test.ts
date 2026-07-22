import { describe, expect, it } from 'vitest';
import { CoverageMap } from '../coverage/index.js';
import { loadRomFromBytes } from '../rom/index.js';
import { encodeString, STRING_TERMINATOR } from '../text/codec.js';
import {
  SPECIES_NAME_SLOT_BYTES,
  SPECIES_PLACEHOLDER_BYTE,
} from '../species/species-names.js';
import {
  SPECIES_NAMES_DETECTOR_ID,
  speciesNamesDetector,
} from './species-names.js';

function buildRomWithSpeciesTable(opts: {
  romSize: number;
  tableOffset: number;
  names: string[];
}) {
  const bytes = new Uint8Array(opts.romSize);
  // GBA header: bare-minimum fixed-marker byte at 0xB2 so loadRomFromBytes
  // accepts it. Real GBA validators wouldn't, but our loader only requires
  // ≥192 bytes and (validate-on-detector pipeline) doesn't gate on the
  // fixed marker. To be safe set the marker:
  bytes[0xb2] = 0x96;

  // Plant placeholder slot.
  for (let i = 0; i < 10; i++) bytes[opts.tableOffset + i] = SPECIES_PLACEHOLDER_BYTE;
  bytes[opts.tableOffset + 10] = STRING_TERMINATOR;
  // Plant each subsequent name.
  for (let i = 0; i < opts.names.length; i++) {
    const slot = opts.tableOffset + (i + 1) * SPECIES_NAME_SLOT_BYTES;
    // Fill slot with terminator first.
    for (let j = 0; j < SPECIES_NAME_SLOT_BYTES; j++) bytes[slot + j] = STRING_TERMINATOR;
    const enc = encodeString(opts.names[i]!);
    for (let j = 0; j < Math.min(enc.length, SPECIES_NAME_SLOT_BYTES); j++) {
      bytes[slot + j] = enc[j]!;
    }
  }
  return loadRomFromBytes({
    bytes,
    sourcePath: 'test://species-names',
    synthetic: true,
  });
}

describe('speciesNamesDetector', () => {
  it('exports the universal RomDetector contract', () => {
    expect(speciesNamesDetector.id).toBe(SPECIES_NAMES_DETECTOR_ID);
    expect(typeof speciesNamesDetector.name).toBe('string');
    expect(speciesNamesDetector.phase).toBe(8);
    expect(typeof speciesNamesDetector.detect).toBe('function');
  });

  it('returns not_detected when ROM is too small for ≥50 slots', () => {
    const bytes = new Uint8Array(192); // GBA-loader-minimum, only 17 slots worth
    bytes[0xb2] = 0x96;
    const rom = loadRomFromBytes({ bytes, sourcePath: 'test://tiny', synthetic: true });
    const cov = new CoverageMap(bytes.length);
    const r = speciesNamesDetector.detect(rom, cov);
    expect(r.status).toBe('not_detected');
    if (r.status === 'not_detected') {
      expect(r.reason).toContain('too small');
    }
  });

  it('returns not_detected when no BULBASAUR signature is in the ROM', () => {
    const rom = buildRomWithSpeciesTable({
      romSize: 64 * 1024,
      tableOffset: 0,
      names: [], // build only the placeholder, no BULBASAUR planted
    });
    const cov = new CoverageMap(rom.bytes.length);
    const r = speciesNamesDetector.detect(rom, cov);
    expect(r.status).toBe('not_detected');
    if (r.status === 'not_detected') {
      expect(r.reason).toContain('No Gen-3 gSpeciesNames');
    }
  });

  it('finds a planted table + registers table coverage', () => {
    // Plant a credible 60-species table.
    const names = ['BULBASAUR', 'IVYSAUR', 'VENUSAUR'];
    for (let i = 0; i < 57; i++) names.push(`MON${String(i).padStart(3, '0')}`);
    const rom = buildRomWithSpeciesTable({
      romSize: 256 * 1024,
      tableOffset: 0x10000,
      names,
    });
    const cov = new CoverageMap(rom.bytes.length);
    const r = speciesNamesDetector.detect(rom, cov);
    expect(r.status).toBe('detected');
    if (r.status === 'detected') {
      expect(r.data.tableOffset).toBe(0x10000);
      expect(r.data.validSpeciesCount).toBeGreaterThanOrEqual(50);
      expect(r.data.sampleNames[1]).toBe('BULBASAUR');
      expect(r.data.sampleNames[2]).toBe('IVYSAUR');
      expect(r.data.sampleNames[3]).toBe('VENUSAUR');
    }
    const report = cov.report();
    const tableRegions = report.regions.filter(
      (rgn) => rgn.provenance?.includes(SPECIES_NAMES_DETECTOR_ID),
    );
    expect(tableRegions.length).toBe(1);
    expect(tableRegions[0]?.start).toBe(0x10000);
  });

  it('result.data is frozen', () => {
    const names = ['BULBASAUR', 'IVYSAUR', 'VENUSAUR'];
    for (let i = 0; i < 57; i++) names.push(`MON${String(i).padStart(3, '0')}`);
    const rom = buildRomWithSpeciesTable({
      romSize: 256 * 1024,
      tableOffset: 0x10000,
      names,
    });
    const cov = new CoverageMap(rom.bytes.length);
    const r = speciesNamesDetector.detect(rom, cov);
    if (r.status === 'detected') {
      expect(Object.isFrozen(r.data)).toBe(true);
    }
  });
});
