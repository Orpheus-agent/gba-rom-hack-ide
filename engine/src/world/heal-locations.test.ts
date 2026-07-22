import { describe, it, expect } from 'vitest';
import {
  HEAL_LOCATIONS_MIN_ENTRIES,
  HEAL_LOCATION_SIZE_BYTES,
  scanHealLocations,
} from './heal-locations.js';

/** Synthesize a buffer with a heal-locations table placed at the given
 *  offset, with `count` entries plus optional surrounding fill bytes. */
function buildBuffer(
  tableOffset: number,
  entries: ReadonlyArray<{ group: number; mapNum: number; x: number; y: number }>,
  totalSize = 4096,
): Uint8Array {
  const buf = new Uint8Array(totalSize);
  // Fill with garbage that's NOT valid heal locations (use 0xCC so
  // group=0xCC fails the GROUP_MAX bound).
  buf.fill(0xcc);
  // Header bytes - leave as-is (the scanner skips the first 0xC0 anyway).
  for (let i = 0; i < entries.length; i++) {
    const off = tableOffset + i * HEAL_LOCATION_SIZE_BYTES;
    const e = entries[i]!;
    buf[off + 0] = e.group;
    buf[off + 1] = e.mapNum;
    buf[off + 2] = e.x & 0xff;
    buf[off + 3] = (e.x >> 8) & 0xff;
    buf[off + 4] = e.y & 0xff;
    buf[off + 5] = (e.y >> 8) & 0xff;
  }
  return buf;
}

describe('scanHealLocations', () => {
  it('finds a vanilla-FRLG-style table of 13 entries', () => {
    const offset = 0x500;
    const vanillaEntries = [
      { group: 0, mapNum: 12, x: 6, y: 9 }, // PALLET_TOWN
      { group: 0, mapNum: 10, x: 22, y: 28 }, // VIRIDIAN_CITY
      { group: 0, mapNum: 11, x: 14, y: 7 }, // PEWTER_CITY
      { group: 0, mapNum: 6, x: 30, y: 28 }, // CERULEAN_CITY
      { group: 0, mapNum: 13, x: 24, y: 6 }, // VERMILION_CITY
      { group: 0, mapNum: 14, x: 24, y: 9 }, // LAVENDER_TOWN
      { group: 0, mapNum: 7, x: 12, y: 21 }, // CELADON_CITY
      { group: 0, mapNum: 8, x: 14, y: 6 }, // FUCHSIA_CITY
      { group: 0, mapNum: 15, x: 9, y: 5 }, // CINNABAR_ISLAND
      { group: 0, mapNum: 9, x: 14, y: 8 }, // SAFFRON_CITY
      { group: 0, mapNum: 18, x: 9, y: 11 }, // INDIGO_PLATEAU
      { group: 1, mapNum: 4, x: 7, y: 7 }, // POKEMON_LEAGUE
      { group: 24, mapNum: 6, x: 5, y: 8 }, // ONE_ISLAND
    ];
    const buf = buildBuffer(offset, vanillaEntries);
    const result = scanHealLocations(buf);
    expect(result).not.toBeNull();
    expect(result!.tableStart).toBe(offset);
    expect(result!.entryCount).toBe(13);
    expect(result!.entries[0]).toMatchObject({
      group: 0,
      mapNum: 12,
      x: 6,
      y: 9,
      slotIndex: 0,
    });
    expect(result!.entries[12]).toMatchObject({
      group: 24,
      mapNum: 6,
      x: 5,
      y: 8,
      slotIndex: 12,
    });
  });

  it('returns null on a ROM with no plausible heal-locations region', () => {
    // 0xCC fill throughout - group=0xCC fails GROUP_MAX (cap 50).
    const buf = new Uint8Array(4096);
    buf.fill(0xcc);
    expect(scanHealLocations(buf)).toBeNull();
  });

  it('rejects an all-zero region (mapNum=0 across all rows trips the nonzero-fraction guard)', () => {
    // 16 entries of (0, 0, 0, 0) - passes per-entry bounds but fails
    // the 50% nonzero-mapNum threshold.
    const offset = 0x300;
    const buf = new Uint8Array(4096);
    buf.fill(0xcc);
    for (let i = 0; i < 16; i++) {
      const off = offset + i * HEAL_LOCATION_SIZE_BYTES;
      buf[off + 0] = 0;
      buf[off + 1] = 0;
      buf[off + 2] = 0;
      buf[off + 3] = 0;
      buf[off + 4] = 0;
      buf[off + 5] = 0;
    }
    expect(scanHealLocations(buf)).toBeNull();
  });

  it('returns null when the longest run is shorter than min-entries', () => {
    // Place 6 valid entries (less than MIN_ENTRIES=8) at an offset.
    const offset = 0x300;
    const entries = [
      { group: 0, mapNum: 12, x: 6, y: 9 },
      { group: 0, mapNum: 10, x: 22, y: 28 },
      { group: 0, mapNum: 11, x: 14, y: 7 },
      { group: 0, mapNum: 6, x: 30, y: 28 },
      { group: 0, mapNum: 13, x: 24, y: 6 },
      { group: 0, mapNum: 14, x: 24, y: 9 },
    ];
    const buf = buildBuffer(offset, entries);
    expect(scanHealLocations(buf)).toBeNull();
  });

  it('picks the LONGEST valid run when multiple candidates exist', () => {
    // 8 entries at 0x300 (short) + 12 entries at 0x500 (long), with
    // 0xCC garbage between them so the runs don't merge.
    const buf = new Uint8Array(8192);
    buf.fill(0xcc);
    function writeEntry(
      off: number,
      e: { group: number; mapNum: number; x: number; y: number },
    ) {
      buf[off + 0] = e.group;
      buf[off + 1] = e.mapNum;
      buf[off + 2] = e.x & 0xff;
      buf[off + 3] = (e.x >> 8) & 0xff;
      buf[off + 4] = e.y & 0xff;
      buf[off + 5] = (e.y >> 8) & 0xff;
    }
    for (let i = 0; i < 8; i++) {
      writeEntry(0x300 + i * HEAL_LOCATION_SIZE_BYTES, {
        group: 0,
        mapNum: 10 + i,
        x: 5,
        y: 5,
      });
    }
    for (let i = 0; i < 12; i++) {
      writeEntry(0x500 + i * HEAL_LOCATION_SIZE_BYTES, {
        group: 0,
        mapNum: 20 + i,
        x: 10,
        y: 10,
      });
    }
    const result = scanHealLocations(buf);
    expect(result).not.toBeNull();
    expect(result!.tableStart).toBe(0x500);
    expect(result!.entryCount).toBe(12);
  });

  it('honors the minEntries override', () => {
    const offset = 0x300;
    const entries = [
      { group: 0, mapNum: 1, x: 5, y: 5 },
      { group: 0, mapNum: 2, x: 5, y: 5 },
      { group: 0, mapNum: 3, x: 5, y: 5 },
      { group: 0, mapNum: 4, x: 5, y: 5 },
    ];
    const buf = buildBuffer(offset, entries);
    expect(scanHealLocations(buf, { minEntries: 4 })).not.toBeNull();
    expect(scanHealLocations(buf, { minEntries: 5 })).toBeNull();
  });

  it('stops at the first invalid entry - short ROM tail does not over-extend the run', () => {
    // 10 valid entries followed immediately by garbage; the scanner
    // should accept exactly 10.
    const offset = 0x300;
    const entries: Array<{ group: number; mapNum: number; x: number; y: number }> = [];
    for (let i = 0; i < 10; i++) entries.push({ group: 0, mapNum: 5 + i, x: 5, y: 5 });
    const buf = buildBuffer(offset, entries, 4096);
    // Place a garbage byte AT the next would-be entry's group field - 
    // group=0xCC fails GROUP_MAX, terminating the run.
    buf[offset + 10 * HEAL_LOCATION_SIZE_BYTES + 0] = 0xcc;
    const result = scanHealLocations(buf);
    expect(result).not.toBeNull();
    expect(result!.entryCount).toBe(10);
  });

  it('returns null when the ROM is smaller than the minimum table size', () => {
    const small = new Uint8Array(0xc0 + 5 * HEAL_LOCATION_SIZE_BYTES); // < MIN_ENTRIES
    expect(scanHealLocations(small)).toBeNull();
  });

  it('exposes the right HEAL_LOCATIONS_MIN_ENTRIES constant', () => {
    expect(HEAL_LOCATIONS_MIN_ENTRIES).toBe(8);
  });
});
