import { describe, expect, it } from 'vitest';
import { encodeString } from '../text/codec.js';
import {
  REGION_MAP_SECTION_SIZE_BYTES,
  REGION_MAP_SECTIONS_MIN_NAMED,
  scanRegionMapSections,
} from './index.js';

const GBA_ROM_BASE = 0x08000000;

/** Build a planted test ROM with a region-map sections table + name
 *  strings. Returns the byte buffer + the offsets. */
function buildTestRom(opts: {
  romSize: number;
  tableOffset: number;
  namesOffset: number;
  /** Names to plant; null = unnamed sentinel slot (entry with name ptr 0). */
  names: ReadonlyArray<string | null>;
  /** Extra entries past the named ones (with name ptr 0) to push total
   *  entry count above the min-entries threshold. */
  extraSentinels?: number;
}): Uint8Array {
  const bytes = new Uint8Array(opts.romSize);
  // Fill with garbage so the scanner can't false-positive on padding.
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 13 + 7) % 256;

  const view = new DataView(bytes.buffer);
  // Plant the name strings sequentially starting at namesOffset.
  // Each name is encoded via Gen-3 codec + 0xFF terminator.
  let cursorName = opts.namesOffset;
  const namePointers: number[] = [];
  for (const name of opts.names) {
    if (name === null) {
      namePointers.push(0);
      continue;
    }
    const encoded = encodeString(name);
    bytes.set(encoded, cursorName);
    bytes[cursorName + encoded.length] = 0xff;
    namePointers.push(GBA_ROM_BASE + cursorName);
    cursorName += encoded.length + 1;
  }

  // Plant the table entries.
  let cursor = opts.tableOffset;
  for (let i = 0; i < opts.names.length; i++) {
    view.setInt16(cursor + 0x00, (i % 30) - 1, true); // x in range
    view.setInt16(cursor + 0x02, (i % 20), true); // y in range
    bytes[cursor + 0x04] = 2; // width
    bytes[cursor + 0x05] = 2; // height
    view.setUint16(cursor + 0x06, 0, true); // padding
    view.setUint32(cursor + 0x08, namePointers[i]!, true);
    cursor += REGION_MAP_SECTION_SIZE_BYTES;
  }
  // Extra sentinels (entries with name ptr 0).
  const extras = opts.extraSentinels ?? 0;
  for (let i = 0; i < extras; i++) {
    view.setInt16(cursor + 0x00, 0, true);
    view.setInt16(cursor + 0x02, 0, true);
    bytes[cursor + 0x04] = 0;
    bytes[cursor + 0x05] = 0;
    view.setUint16(cursor + 0x06, 0, true);
    view.setUint32(cursor + 0x08, 0, true);
    cursor += REGION_MAP_SECTION_SIZE_BYTES;
  }
  // Place an obviously-invalid entry right after to ensure scan stops cleanly.
  bytes[cursor + 0x06] = 0xff; // padding non-zero → fails

  return bytes;
}

describe('scanRegionMapSections', () => {
  it('returns null when ROM is too small', () => {
    expect(scanRegionMapSections(new Uint8Array(500))).toBeNull();
  });

  it('returns null when no plausible table exists', () => {
    const bytes = new Uint8Array(64 * 1024);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 11 + 17) % 256;
    expect(scanRegionMapSections(bytes)).toBeNull();
  });

  it('finds a planted vanilla-shape table with names', () => {
    // 12 named + 30 sentinels = 42 total entries, well above min-entries 40.
    const names: (string | null)[] = [
      'PALLET TOWN',
      'VIRIDIAN CITY',
      'PEWTER CITY',
      'CERULEAN CITY',
      'LAVENDER TOWN',
      'VERMILION CITY',
      'CELADON CITY',
      'FUCHSIA CITY',
      'CINNABAR ISLAND',
      'INDIGO PLATEAU',
      'SAFFRON CITY',
      'ROUTE 1',
    ];
    const bytes = buildTestRom({
      romSize: 256 * 1024,
      tableOffset: 0x4000,
      namesOffset: 0x10000,
      names,
      extraSentinels: 30,
    });
    const r = scanRegionMapSections(bytes);
    expect(r).not.toBeNull();
    expect(r?.tableStart).toBe(0x4000);
    expect(r?.entryCount).toBeGreaterThanOrEqual(42);
    expect(r?.namedCount).toBeGreaterThanOrEqual(12);
    expect(r?.sections[0]?.name).toBe('PALLET TOWN');
    expect(r?.sections[10]?.name).toBe('SAFFRON CITY');
  });

  it('rejects a 12-byte table whose named entries all share y=0 (ability-info false positive)', () => {
    // The corpus scan reproduced a false positive on FRLG / Unbound /
    // Radical Red where a non-region-map 12-byte structure passes
    // padding=0 + name-ptr-in-ROM but has every entry at y=0, w=1, h=0.
    // Names that decoded were ability strings ("STENCH", "THICK FAT",
    // ...) lifted from an adjacent gAbilityInfo-shaped table. The
    // coordinate-variety guard rejects this without breaking real
    // region maps (varied y).
    const bytes = new Uint8Array(64 * 1024);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 11 + 17) % 256;
    const view = new DataView(bytes.buffer);
    let cursorName = 0x8000;
    const namePointers: number[] = [];
    const fakeAbilityNames = [
      'STENCH', 'THICK FAT', 'RAIN DISH', 'DRIZZLE', 'ARENA TRAP',
      'INTIMIDATE', 'ROCK HEAD', 'COLOR', 'ALT. COLOR', 'ROCK',
      'WHITE', 'BLACK', 'GREEN', 'BLUE', 'YELLOW',
    ];
    for (const n of fakeAbilityNames) {
      const encoded = encodeString(n);
      bytes.set(encoded, cursorName);
      bytes[cursorName + encoded.length] = 0xff;
      namePointers.push(GBA_ROM_BASE + cursorName);
      cursorName += encoded.length + 1;
    }
    let cursor = 0x2000;
    // Plant 50 entries with x varying but y/w/h frozen - mimics the
    // corpus false-positive's fingerprint exactly.
    for (let i = 0; i < 50; i++) {
      view.setInt16(cursor + 0x00, (i * 3) % 30, true); // varied x
      view.setInt16(cursor + 0x02, 0, true);            // y=0 always
      bytes[cursor + 0x04] = 1;                          // w=1 always
      bytes[cursor + 0x05] = 0;                          // h=0 always
      view.setUint16(cursor + 0x06, 0, true);
      // First 15 entries get a real name pointer; rest are sentinels - 
      // matches the corpus shape (108 named, all y=0). The guard
      // rejects regardless because namedY.size === 1.
      view.setUint32(
        cursor + 0x08,
        i < namePointers.length ? namePointers[i]! : 0,
        true,
      );
      cursor += REGION_MAP_SECTION_SIZE_BYTES;
    }
    bytes[cursor + 0x06] = 0xff;
    expect(scanRegionMapSections(bytes)).toBeNull();
  });

  it('rejects when not enough named entries', () => {
    // Only 5 named - below default minNamed=10.
    const names: (string | null)[] = [
      'ALPHA',
      'BETA',
      'GAMMA',
      'DELTA',
      'EPSILON',
    ];
    const bytes = buildTestRom({
      romSize: 64 * 1024,
      tableOffset: 0x2000,
      namesOffset: 0x8000,
      names,
      extraSentinels: 50,
    });
    expect(scanRegionMapSections(bytes)).toBeNull();
  });

  it('honors custom minNamed option', () => {
    // Names must be multi-word ("Area 1" not "AREA1") to pass the
    // real-Pokémon-place-name heuristic added in RT-1.1.
    const names: (string | null)[] = [
      'Area 1',
      'Area 2',
      'Area 3',
    ];
    const bytes = buildTestRom({
      romSize: 64 * 1024,
      tableOffset: 0x2000,
      namesOffset: 0x8000,
      names,
      extraSentinels: 50,
    });
    // The coord-variety guards default to 10 distinct XY and 3 distinct
    // Y. With only 3 named entries we have to lower both thresholds in
    // lockstep with minNamed.
    expect(
      scanRegionMapSections(bytes, { minNamed: 3, minDistinctXY: 3, minDistinctY: 2 }),
    ).not.toBeNull();
  });

  it('Phase O.4 - accepts an expanded hack table with coords up to 100 and dims up to 12', () => {
    // Simulate a heavy hack (Unbound-ish) that bumped its region map
    // significantly past vanilla's 28×16 grid. Build entries with
    // coords up to ~95 and dims up to 12 (between vanilla MAX=8 and
    // bumped MAX=16). Pre-bump these would have all been rejected.
    const bytes = new Uint8Array(128 * 1024);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 13 + 7) % 256;
    const view = new DataView(bytes.buffer);
    // Plant names somewhere clean.
    let cursorName = 0xc000;
    const namePointers: number[] = [];
    for (let i = 0; i < 15; i++) {
      // Multi-word names so the multiWord-fraction guard passes.
      const encoded = encodeString(`HACK CITY ${String(i)}`);
      bytes.set(encoded, cursorName);
      bytes[cursorName + encoded.length] = 0xff;
      namePointers.push(GBA_ROM_BASE + cursorName);
      cursorName += encoded.length + 1;
    }
    // Plant table entries with HACK-scale coords (beyond vanilla MAX=64
    // but within Phase O.4 MAX=127) and dims (beyond vanilla MAX=8 but
    // within Phase O.4 MAX=16).
    let cursor = 0x3000;
    for (let i = 0; i < 15; i++) {
      view.setInt16(cursor + 0x00, 50 + (i * 3), true); // x: 50..92
      view.setInt16(cursor + 0x02, 30 + (i * 2), true); // y: 30..58
      bytes[cursor + 0x04] = 12; // width = 12 (was rejected pre-bump)
      bytes[cursor + 0x05] = 10; // height = 10 (was rejected pre-bump)
      view.setUint16(cursor + 0x06, 0, true);
      view.setUint32(cursor + 0x08, namePointers[i]!, true);
      cursor += REGION_MAP_SECTION_SIZE_BYTES;
    }
    // Add 30 sentinel slots to clear minEntries=40.
    for (let i = 0; i < 30; i++) {
      view.setInt16(cursor + 0x00, 0, true);
      view.setInt16(cursor + 0x02, 0, true);
      bytes[cursor + 0x04] = 0;
      bytes[cursor + 0x05] = 0;
      view.setUint16(cursor + 0x06, 0, true);
      view.setUint32(cursor + 0x08, 0, true);
      cursor += REGION_MAP_SECTION_SIZE_BYTES;
    }
    bytes[cursor + 0x06] = 0xff; // explicit terminator
    const r = scanRegionMapSections(bytes);
    expect(r).not.toBeNull();
    expect(r!.namedCount).toBeGreaterThanOrEqual(REGION_MAP_SECTIONS_MIN_NAMED);
    expect(r!.sections[0]?.x).toBe(50);
    expect(r!.sections[0]?.width).toBe(12);
    expect(r!.sections[0]?.name).toBe('HACK CITY 0');
  });

  it('tolerates mix of named and unnamed sentinel slots', () => {
    const names: (string | null)[] = [
      'TOWN A',
      null,
      'TOWN B',
      null,
      'TOWN C',
      'TOWN D',
      'TOWN E',
      'TOWN F',
      'TOWN G',
      'TOWN H',
      'TOWN I',
      'TOWN J',
      null,
      null,
      'TOWN K',
    ];
    const bytes = buildTestRom({
      romSize: 128 * 1024,
      tableOffset: 0x3000,
      namesOffset: 0xc000,
      names,
      extraSentinels: 30,
    });
    const r = scanRegionMapSections(bytes);
    expect(r).not.toBeNull();
    expect(r!.namedCount).toBeGreaterThanOrEqual(REGION_MAP_SECTIONS_MIN_NAMED);
    expect(r!.sections[1]?.name).toBe(''); // sentinel slot has empty name
    expect(r!.sections[1]?.nameRomPointer).toBe(0);
    expect(r!.sections[0]?.name).toBe('TOWN A');
  });

  it('reports layoutKind=12byte for the standard Emerald-style table', () => {
    const names: (string | null)[] = [
      'LITTLEROOT TOWN',
      'OLDALE TOWN',
      'PETALBURG CITY',
      'RUSTBORO CITY',
      'DEWFORD TOWN',
      'SLATEPORT CITY',
      'MAUVILLE CITY',
      'VERDANTURF TOWN',
      'FALLARBOR TOWN',
      'LAVARIDGE TOWN',
      'FORTREE CITY',
      'LILYCOVE CITY',
    ];
    const bytes = buildTestRom({
      romSize: 256 * 1024,
      tableOffset: 0x4000,
      namesOffset: 0x10000,
      names,
      extraSentinels: 30,
    });
    const r = scanRegionMapSections(bytes);
    expect(r).not.toBeNull();
    expect(r!.layoutKind).toBe('12byte');
    expect(r!.entrySize).toBe(12);
  });
});

/** Plant an 8-byte FRLG-style table at `tableOffset`. Layout: each
 *  entry is `{u8 x; u8 y; u8 w; u8 h; u32 name_ptr}`. Mirrors the
 *  12-byte planter above. */
function buildTestRom8Byte(opts: {
  romSize: number;
  tableOffset: number;
  namesOffset: number;
  names: ReadonlyArray<string | null>;
  /** Per-entry coords. When omitted, defaults to a varied scatter. */
  coords?: ReadonlyArray<{ x: number; y: number; w: number; h: number }>;
  extraSentinels?: number;
}): Uint8Array {
  const bytes = new Uint8Array(opts.romSize);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 13 + 7) % 256;
  const view = new DataView(bytes.buffer);
  let cursorName = opts.namesOffset;
  const namePointers: number[] = [];
  for (const name of opts.names) {
    if (name === null) { namePointers.push(0); continue; }
    const encoded = encodeString(name);
    bytes.set(encoded, cursorName);
    bytes[cursorName + encoded.length] = 0xff;
    namePointers.push(GBA_ROM_BASE + cursorName);
    cursorName += encoded.length + 1;
  }
  let cursor = opts.tableOffset;
  for (let i = 0; i < opts.names.length; i++) {
    const c = opts.coords?.[i] ?? { x: (i % 30) + 1, y: (i % 16) + 1, w: 2, h: 2 };
    bytes[cursor + 0x00] = c.x;
    bytes[cursor + 0x01] = c.y;
    bytes[cursor + 0x02] = c.w;
    bytes[cursor + 0x03] = c.h;
    view.setUint32(cursor + 0x04, namePointers[i]!, true);
    cursor += 8;
  }
  const extras = opts.extraSentinels ?? 0;
  for (let i = 0; i < extras; i++) {
    bytes[cursor + 0x00] = 0;
    bytes[cursor + 0x01] = 0;
    bytes[cursor + 0x02] = 0;
    bytes[cursor + 0x03] = 0;
    view.setUint32(cursor + 0x04, 0, true);
    cursor += 8;
  }
  // Make the entry right after the run invalid so the scanner stops cleanly.
  bytes[cursor + 0x02] = 0xff; // width = 255 → fails DIM_MAX
  bytes[cursor + 0x03] = 0xff;
  return bytes;
}

describe('scanRegionMapSections - 8-byte (FRLG) layout (RT-1.1)', () => {
  it('finds a planted FRLG-style 8-byte table', () => {
    const names: (string | null)[] = [
      'PALLET TOWN',
      'VIRIDIAN CITY',
      'PEWTER CITY',
      'CERULEAN CITY',
      'VERMILION CITY',
      'CELADON CITY',
      'FUCHSIA CITY',
      'SAFFRON CITY',
      'LAVENDER TOWN',
      'CINNABAR ISLAND',
      'INDIGO PLATEAU',
      'ROUTE 1',
    ];
    const bytes = buildTestRom8Byte({
      romSize: 256 * 1024,
      tableOffset: 0x4000,
      namesOffset: 0x10000,
      names,
      extraSentinels: 30,
    });
    const r = scanRegionMapSections(bytes);
    expect(r).not.toBeNull();
    expect(r!.layoutKind).toBe('8byte');
    expect(r!.entrySize).toBe(8);
    expect(r!.tableStart).toBe(0x4000);
    expect(r!.entryCount).toBeGreaterThanOrEqual(42);
    expect(r!.namedCount).toBeGreaterThanOrEqual(12);
    expect(r!.sections[0]?.name).toBe('PALLET TOWN');
    expect(r!.sections[10]?.name).toBe('INDIGO PLATEAU');
  });

  it('accepts vanilla FRLG y=237/238 below-map label coords (full u8 range)', () => {
    // Real FRLG packs most route labels at y=237 or y=238 (label below
    // the map). The 8-byte scanner allows the full u8 range for y; the
    // variety guard still passes because we have at least 3 distinct y
    // (e.g., 1, 237, 238) across 12+ named entries.
    const names: (string | null)[] = [
      'PALLET TOWN', // y=1
      'ROUTE 1',     // y=237
      'ROUTE 2',     // y=237
      'ROUTE 3',     // y=237
      'ROUTE 4',     // y=237
      'ROUTE 5',     // y=237
      'ROUTE 22',    // y=237
      'ROUTE 23',    // y=237
      'ROUTE 24',    // y=237
      'ROUTE 25',    // y=237
      'VIRIDIAN FOREST', // y=238
      'MT. MOON',    // y=238
    ];
    const coords = [
      { x: 15, y: 1, w: 2, h: 0 },
      { x: 8, y: 237, w: 8, h: 8 },
      { x: 30, y: 237, w: 8, h: 8 },
      { x: 60, y: 237, w: 8, h: 8 },
      { x: 90, y: 237, w: 8, h: 8 },
      { x: 119, y: 237, w: 8, h: 8 },
      { x: 147, y: 237, w: 8, h: 8 },
      { x: 164, y: 237, w: 8, h: 8 },
      { x: 180, y: 237, w: 8, h: 8 },
      { x: 196, y: 237, w: 8, h: 8 },
      { x: 7, y: 238, w: 8, h: 8 },
      { x: 25, y: 238, w: 8, h: 8 },
    ];
    const bytes = buildTestRom8Byte({
      romSize: 256 * 1024,
      tableOffset: 0x4000,
      namesOffset: 0x10000,
      names,
      coords,
      extraSentinels: 30,
    });
    const r = scanRegionMapSections(bytes);
    expect(r).not.toBeNull();
    expect(r!.layoutKind).toBe('8byte');
    expect(r!.sections[0]?.name).toBe('PALLET TOWN');
    expect(r!.sections[0]?.y).toBe(1);
    expect(r!.sections[1]?.name).toBe('ROUTE 1');
    expect(r!.sections[1]?.y).toBe(237);
    expect(r!.sections[10]?.y).toBe(238);
  });

  it('rejects 8-byte tables with y pegged to a single value (variety guard)', () => {
    // Mirror of the wrong-table case from the 12-byte side: all named
    // entries at y=0 means it's likely an item/ability/etc. struct
    // table that happens to have a ROM-space pointer at +4. The variety
    // guards reject regardless of named count.
    const names: (string | null)[] = [
      'STENCH', 'THICK FAT', 'RAIN DISH', 'DRIZZLE', 'ARENA TRAP',
      'INTIMIDATE', 'ROCK HEAD', 'COLOR', 'ALT. COLOR', 'ROCK',
      'WHITE', 'BLACK', 'GREEN', 'BLUE', 'YELLOW',
    ];
    const coords = names.map((_n, i) => ({ x: i + 1, y: 0, w: 1, h: 0 }));
    const bytes = buildTestRom8Byte({
      romSize: 256 * 1024,
      tableOffset: 0x4000,
      namesOffset: 0x10000,
      names,
      coords,
      extraSentinels: 50,
    });
    expect(scanRegionMapSections(bytes)).toBeNull();
  });

  it('picks the 8-byte layout over a competing 12-byte table when 8-byte has more named entries', () => {
    // Plant a small 12-byte table + a larger 8-byte table in the same
    // buffer. The scanner runs both and accepts the one with the
    // higher named-count.
    const bytes = new Uint8Array(512 * 1024);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 13 + 7) % 256;
    const view = new DataView(bytes.buffer);

    // 12-byte table at 0x4000 with 12 named entries (above min-named=10).
    // Names must pass the printability check: ≥3 chars, no '?', only
    // [A-Z0-9 .'-]. 'T01ARE' / 'T02ARE' etc. satisfy this.
    let cursorName = 0x10000;
    const names12 = ['T01ARE','T02ARE','T03ARE','T04ARE','T05ARE','T06ARE','T07ARE','T08ARE','T09ARE','T10ARE','T11ARE','T12ARE'];
    const ptrs12: number[] = [];
    for (const n of names12) {
      const enc = encodeString(n);
      bytes.set(enc, cursorName);
      bytes[cursorName + enc.length] = 0xff;
      ptrs12.push(GBA_ROM_BASE + cursorName);
      cursorName += enc.length + 1;
    }
    let cursor = 0x4000;
    for (let i = 0; i < names12.length; i++) {
      view.setInt16(cursor + 0x00, (i % 30) - 1, true);
      view.setInt16(cursor + 0x02, (i % 20), true);
      bytes[cursor + 0x04] = 2;
      bytes[cursor + 0x05] = 2;
      view.setUint16(cursor + 0x06, 0, true);
      view.setUint32(cursor + 0x08, ptrs12[i]!, true);
      cursor += 12;
    }
    for (let i = 0; i < 30; i++) {
      view.setInt16(cursor + 0x00, 0, true);
      view.setInt16(cursor + 0x02, 0, true);
      bytes[cursor + 0x04] = 0;
      bytes[cursor + 0x05] = 0;
      view.setUint16(cursor + 0x06, 0, true);
      view.setUint32(cursor + 0x08, 0, true);
      cursor += 12;
    }
    bytes[cursor + 0x06] = 0xff;

    // 8-byte table at 0x20000 with 20 named entries (more than 12-byte).
    // Multi-word names so the multiWord-fraction guard (≥40%) passes.
    cursorName = 0x30000;
    const names8 = Array.from({length: 20}, (_, i) => `Area ${i} Town`);
    const ptrs8: number[] = [];
    for (const n of names8) {
      const enc = encodeString(n);
      bytes.set(enc, cursorName);
      bytes[cursorName + enc.length] = 0xff;
      ptrs8.push(GBA_ROM_BASE + cursorName);
      cursorName += enc.length + 1;
    }
    cursor = 0x20000;
    for (let i = 0; i < names8.length; i++) {
      bytes[cursor + 0x00] = (i % 25) + 1;
      bytes[cursor + 0x01] = (i % 15) + 1;
      bytes[cursor + 0x02] = 2;
      bytes[cursor + 0x03] = 2;
      view.setUint32(cursor + 0x04, ptrs8[i]!, true);
      cursor += 8;
    }
    for (let i = 0; i < 30; i++) {
      bytes[cursor + 0x00] = 0;
      bytes[cursor + 0x01] = 0;
      bytes[cursor + 0x02] = 0;
      bytes[cursor + 0x03] = 0;
      view.setUint32(cursor + 0x04, 0, true);
      cursor += 8;
    }
    bytes[cursor + 0x02] = 0xff;

    const r = scanRegionMapSections(bytes);
    expect(r).not.toBeNull();
    expect(r!.layoutKind).toBe('8byte');
    expect(r!.namedCount).toBeGreaterThanOrEqual(20);
    expect(r!.sections[0]?.name).toBe('Area 0 Town');
  });

  it('honors layoutKind option to restrict to a single layout', () => {
    const names: (string | null)[] = [
      'PALLET TOWN', 'VIRIDIAN CITY', 'PEWTER CITY', 'CERULEAN CITY',
      'VERMILION CITY', 'CELADON CITY', 'FUCHSIA CITY', 'SAFFRON CITY',
      'LAVENDER TOWN', 'CINNABAR ISLAND', 'INDIGO PLATEAU', 'ROUTE 1',
    ];
    const bytes = buildTestRom8Byte({
      romSize: 256 * 1024,
      tableOffset: 0x4000,
      namesOffset: 0x10000,
      names,
      extraSentinels: 30,
    });
    // Forcing 12-byte should yield null (this is an 8-byte table).
    expect(scanRegionMapSections(bytes, { layoutKind: '12byte' })).toBeNull();
    // Forcing 8-byte should find it.
    const r = scanRegionMapSections(bytes, { layoutKind: '8byte' });
    expect(r).not.toBeNull();
    expect(r!.layoutKind).toBe('8byte');
  });
});
