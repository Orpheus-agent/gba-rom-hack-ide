import { describe, expect, it } from 'vitest';
import { CoverageMap } from '../coverage/index.js';
import { loadRomFromBytes } from '../rom/index.js';
import { encodeString, STRING_TERMINATOR } from '../text/codec.js';
import { GBA_ROM_BASE } from '../items/index.js';
import {
  POKEDEX_CATEGORY_NAME_LENGTH_BYTES,
  POKEDEX_ENTRY_STRUCT_SIZE_BYTES,
  POKEDEX_OFFSET_CATEGORY_NAME,
  POKEDEX_OFFSET_DESCRIPTION_PTR,
  POKEDEX_OFFSET_HEIGHT,
  POKEDEX_OFFSET_WEIGHT,
} from '../species/index.js';
import { POKEDEX_SYSTEM_DETECTOR_ID, pokedexSystemDetector } from './pokedex-system.js';

function writeU16LE(b: Uint8Array, offset: number, v: number): void {
  b[offset] = v & 0xff;
  b[offset + 1] = (v >> 8) & 0xff;
}
function writeU32LE(b: Uint8Array, offset: number, v: number): void {
  b[offset] = v & 0xff;
  b[offset + 1] = (v >> 8) & 0xff;
  b[offset + 2] = (v >> 16) & 0xff;
  b[offset + 3] = (v >> 24) & 0xff;
}

function plantPokedexTable(buf: Uint8Array, offset: number, count: number): void {
  for (let i = 0; i < count; i++) {
    const p = offset + i * POKEDEX_ENTRY_STRUCT_SIZE_BYTES;
    for (let j = 0; j < POKEDEX_ENTRY_STRUCT_SIZE_BYTES; j++) buf[p + j] = 0;
    const cat = i === 0 ? 'UNKNOWN' : i === 1 ? 'SEED' : i === 2 ? 'LIZARD' : `CAT${String(i)}`;
    const encoded = encodeString(cat);
    const copyLen = Math.min(encoded.length, POKEDEX_CATEGORY_NAME_LENGTH_BYTES - 1);
    for (let j = 0; j < copyLen; j++) buf[p + POKEDEX_OFFSET_CATEGORY_NAME + j] = encoded[j]!;
    buf[p + POKEDEX_OFFSET_CATEGORY_NAME + copyLen] = STRING_TERMINATOR;
    writeU16LE(buf, p + POKEDEX_OFFSET_HEIGHT, 7);
    writeU16LE(buf, p + POKEDEX_OFFSET_WEIGHT, 69);
    writeU32LE(buf, p + POKEDEX_OFFSET_DESCRIPTION_PTR, GBA_ROM_BASE + 0x100000);
  }
}

function fillNonPokedexBytes(buf: Uint8Array, fromOffset: number): void {
  for (let i = fromOffset; i < buf.length; i++) {
    buf[i] = i % 2 === 1 ? 0x80 | ((i * 13) % 128) : (i * 7) % 256;
  }
}

describe('pokedexSystemDetector', () => {
  it('exports the universal RomDetector contract', () => {
    expect(pokedexSystemDetector.id).toBe(POKEDEX_SYSTEM_DETECTOR_ID);
    expect(typeof pokedexSystemDetector.name).toBe('string');
    expect(pokedexSystemDetector.phase).toBe(8);
    expect(typeof pokedexSystemDetector.detect).toBe('function');
  });

  it('returns not_detected on ROM too small', () => {
    const bytes = new Uint8Array(1000);
    bytes[0xb2] = 0x96;
    const rom = loadRomFromBytes({ bytes, sourcePath: 'test://tiny', synthetic: true });
    const cov = new CoverageMap(bytes.length);
    const r = pokedexSystemDetector.detect(rom, cov);
    expect(r.status).toBe('not_detected');
    if (r.status === 'not_detected') expect(r.reason).toContain('too small');
  });

  it('returns not_detected when no Pokédex table is present', () => {
    const bytes = new Uint8Array(64 * 1024);
    bytes[0xb2] = 0x96;
    fillNonPokedexBytes(bytes, 0xc0);
    const rom = loadRomFromBytes({ bytes, sourcePath: 'test://no-pokedex', synthetic: true });
    const cov = new CoverageMap(bytes.length);
    const r = pokedexSystemDetector.detect(rom, cov);
    expect(r.status).toBe('not_detected');
    if (r.status === 'not_detected') expect(r.reason).toContain('No Gen-3 gPokedexEntries');
  });

  it('detects a planted 411-entry vanilla-shaped table + populates samples + registers coverage', () => {
    const bytes = new Uint8Array(64 * 1024);
    bytes[0xb2] = 0x96;
    fillNonPokedexBytes(bytes, 0xc0);
    plantPokedexTable(bytes, 0x1000, 411);
    const rom = loadRomFromBytes({ bytes, sourcePath: 'test://pokedex', synthetic: true });
    const cov = new CoverageMap(bytes.length);
    const r = pokedexSystemDetector.detect(rom, cov);
    expect(r.status).toBe('detected');
    if (r.status === 'detected') {
      expect(r.data.entryCount).toBe(411);
      expect(r.data.pokedexTable.tableStart).toBe(0x1000);
      expect(r.data.sampleCategoryNames[0]).toBe('UNKNOWN');
      expect(r.data.sampleCategoryNames[1]).toBe('SEED');
      expect(r.data.sampleCategoryNames[2]).toBe('LIZARD');
      expect(r.confidence).toBeCloseTo(0.95, 5);
      expect(Object.isFrozen(r.data)).toBe(true);
      expect(Object.isFrozen(r.data.sampleCategoryNames)).toBe(true);
      // Iter 91 - out-of-ROM descriptionPtrs (0x100000 > 64 KiB ROM)
      // should yield empty flavor texts, not crash. sampleNames
      // falls back to category-only.
      expect(Object.isFrozen(r.data.sampleFlavorTexts)).toBe(true);
      expect(Object.isFrozen(r.data.sampleNames)).toBe(true);
      expect(r.data.sampleFlavorTexts.every((t) => t === '')).toBe(true);
      expect(r.data.sampleNames[0]).toBe('UNKNOWN');
      expect(r.data.sampleNames[1]).toBe('SEED');
      // Phase O.2 - per-entry struct file offsets are surfaced for the
      // editor's category-name + flavor-text write paths.
      expect(r.data.sampleEntryFileOffsets.length).toBeGreaterThan(0);
      expect(r.data.sampleEntryFileOffsets[0]).toBe(0x1000);
      expect(r.data.sampleEntryFileOffsets[1]).toBe(0x1020);
      // Out-of-ROM descriptionPtrs → file offset -1 (no flavor-text edit).
      expect(r.data.sampleDescriptionFileOffsets.every((o) => o === -1)).toBe(true);
    }
    const report = cov.report();
    const regions = report.regions.filter((rgn) =>
      rgn.provenance?.includes(POKEDEX_SYSTEM_DETECTOR_ID),
    );
    expect(regions.length).toBe(1);
    expect(regions[0]?.start).toBe(0x1000);
  });

  it('UW-3-T10: decodes flavor text when descriptionPtr targets an in-ROM Gen-3 text string', () => {
    // Plant a 200-entry pokedex table at 0x1000. Then plant in-ROM
    // flavor-text strings at 0x4000+ and rewrite each entry's
    // descriptionPtr to point there.
    const bytes = new Uint8Array(64 * 1024);
    bytes[0xb2] = 0x96;
    fillNonPokedexBytes(bytes, 0xc0);
    plantPokedexTable(bytes, 0x1000, 200);
    // Plant flavor texts for first 5 entries at 0x4000, 0x4080, 0x4100, etc.
    // encodeString accepts only ASCII alpha + digits + space (Gen-3 codec
    // exports). Test strings stay within that subset.
    const flavorTexts = [
      'A round POKEMON that lives in lakes',
      'It loves to eat seeds and nuts gathered',
      'A fierce predator with sharp claws',
      'This species is known for its long sleep',
      'A graceful flier that migrates seasonally',
    ];
    for (let i = 0; i < flavorTexts.length; i++) {
      const textOffset = 0x4000 + i * 0x80;
      const encoded = encodeString(flavorTexts[i]!);
      for (let j = 0; j < encoded.length; j++) bytes[textOffset + j] = encoded[j]!;
      bytes[textOffset + encoded.length] = STRING_TERMINATOR;
      // Rewrite descriptionPtr in entry i to point at our planted text.
      const entryOffset = 0x1000 + i * POKEDEX_ENTRY_STRUCT_SIZE_BYTES;
      writeU32LE(
        bytes,
        entryOffset + POKEDEX_OFFSET_DESCRIPTION_PTR,
        GBA_ROM_BASE + textOffset,
      );
    }
    const rom = loadRomFromBytes({ bytes, sourcePath: 'test://pokedex-flavor', synthetic: true });
    const cov = new CoverageMap(bytes.length);
    const r = pokedexSystemDetector.detect(rom, cov);
    expect(r.status).toBe('detected');
    if (r.status === 'detected') {
      // First 5 entries should have decoded flavor text.
      expect(r.data.sampleFlavorTexts[0]).toBe('A round POKEMON that lives in lakes');
      expect(r.data.sampleFlavorTexts[1]).toBe('It loves to eat seeds and nuts gathered');
      expect(r.data.sampleFlavorTexts[4]).toBe('A graceful flier that migrates seasonally');
      // Remaining sampled entries (5..15) still have out-of-ROM ptrs → empty.
      expect(r.data.sampleFlavorTexts[5]).toBe('');
      // Combined sampleNames format: "CATEGORY - flavor snippet".
      expect(r.data.sampleNames[0]).toContain('UNKNOWN');
      expect(r.data.sampleNames[0]).toContain(' - ');
      expect(r.data.sampleNames[0]).toContain('A round POKEMON');
      expect(r.data.sampleNames[1]).toContain('SEED');
      expect(r.data.sampleNames[1]).toContain('It loves to eat');
      // Entry without flavor text falls back to category-only.
      expect(r.data.sampleNames[5]).toBe('CAT5');
      // Phase O.2 - decoded entries surface descriptionFileOffset >= 0.
      expect(r.data.sampleDescriptionFileOffsets[0]).toBeGreaterThanOrEqual(0);
      expect(r.data.sampleDescriptionFileOffsets[4]).toBeGreaterThanOrEqual(0);
      // Out-of-ROM entries still emit -1.
      expect(r.data.sampleDescriptionFileOffsets[5]).toBe(-1);
    }
  });

  it('UW-3-T10: truncates flavor-text snippets longer than 60 chars with ellipsis', () => {
    const bytes = new Uint8Array(64 * 1024);
    bytes[0xb2] = 0x96;
    fillNonPokedexBytes(bytes, 0xc0);
    plantPokedexTable(bytes, 0x1000, 200);
    // Plant a long flavor text (>60 chars) at 0x4000. ASCII-only to
    // satisfy the encoder's char range.
    const longText =
      'This is a particularly long flavor text entry that exceeds the snippet truncation limit by many many characters indeed';
    const encoded = encodeString(longText);
    for (let j = 0; j < encoded.length; j++) bytes[0x4000 + j] = encoded[j]!;
    bytes[0x4000 + encoded.length] = STRING_TERMINATOR;
    const entryOffset = 0x1000; // Entry 0
    writeU32LE(bytes, entryOffset + POKEDEX_OFFSET_DESCRIPTION_PTR, GBA_ROM_BASE + 0x4000);
    const rom = loadRomFromBytes({ bytes, sourcePath: 'test://pokedex-long', synthetic: true });
    const cov = new CoverageMap(bytes.length);
    const r = pokedexSystemDetector.detect(rom, cov);
    expect(r.status).toBe('detected');
    if (r.status === 'detected') {
      // Full flavor text preserved in sampleFlavorTexts.
      expect(r.data.sampleFlavorTexts[0]).toBe(longText);
      // sampleNames snippet should be truncated with ellipsis.
      expect(r.data.sampleNames[0]).toMatch(/…$/);
      expect(r.data.sampleNames[0].length).toBeLessThan(longText.length + 30);
    }
  });

  it('UW-3-T10: NULL descriptionPtr (0) yields empty flavor text gracefully', () => {
    const bytes = new Uint8Array(64 * 1024);
    bytes[0xb2] = 0x96;
    fillNonPokedexBytes(bytes, 0xc0);
    plantPokedexTable(bytes, 0x1000, 200);
    // Zero out the first 3 entries' descriptionPtrs.
    for (let i = 0; i < 3; i++) {
      const entryOffset = 0x1000 + i * POKEDEX_ENTRY_STRUCT_SIZE_BYTES;
      writeU32LE(bytes, entryOffset + POKEDEX_OFFSET_DESCRIPTION_PTR, 0);
    }
    const rom = loadRomFromBytes({ bytes, sourcePath: 'test://pokedex-null', synthetic: true });
    const cov = new CoverageMap(bytes.length);
    const r = pokedexSystemDetector.detect(rom, cov);
    expect(r.status).toBe('detected');
    if (r.status === 'detected') {
      expect(r.data.sampleFlavorTexts[0]).toBe('');
      expect(r.data.sampleFlavorTexts[1]).toBe('');
      expect(r.data.sampleNames[0]).toBe('UNKNOWN');
      expect(r.data.sampleNames[1]).toBe('SEED');
    }
  });
});
