import { describe, expect, it } from 'vitest';
import { CoverageMap } from '../coverage/index.js';
import { loadRomFromBytes } from '../rom/index.js';
import {
  ITEM_NAME_LENGTH_BYTES,
  ITEM_OFFSET_ITEM_ID,
  ITEM_OFFSET_NAME,
  ITEM_OFFSET_POCKET,
  ITEM_STRUCT_SIZE_BYTES,
} from '../items/index.js';
import { encodeString, STRING_TERMINATOR } from '../text/codec.js';
import {
  ITEMS_SYSTEM_DETECTOR_ID,
  itemsSystemDetector,
} from './items-system.js';

function writeU16LE(b: Uint8Array, offset: number, v: number): void {
  b[offset] = v & 0xff;
  b[offset + 1] = (v >> 8) & 0xff;
}

/** A handful of canonical vanilla FRLG item names by ID for the
 *  sampleNames-decode test. Index aligns with itemId. Note: the engine
 *  encodeString only handles space + digits + A-Z + a-z, so we use the
 *  ASCII-safe transcriptions ("POKE BALL" instead of "POKé BALL");
 *  decoders downstream produce the original Unicode when reading real
 *  ROMs since the codec table has the full Gen-3 charset. Item 0 is
 *  intentionally absent here so its name field gets the empty
 *  fallback (0xFF terminator at slot 0). */
const VANILLA_ITEM_NAMES: ReadonlyArray<string | undefined> = [
  undefined, // 0 ITEM_NONE → empty name (0xFF at slot 0)
  'MASTER BALL',
  'ULTRA BALL',
  'GREAT BALL',
  'POKE BALL',
  'SAFARI BALL',
  'NET BALL',
  'DIVE BALL',
  'NEST BALL',
  'REPEAT BALL',
];

/** Plant an items table with all-0xFF names (default) - used for the
 *  scanner-correctness tests where decoded names don't matter. */
function plantItemsTable(buf: Uint8Array, offset: number, itemCount: number): void {
  for (let i = 0; i < itemCount; i++) {
    const p = offset + i * ITEM_STRUCT_SIZE_BYTES;
    for (let j = 0; j < ITEM_STRUCT_SIZE_BYTES; j++) buf[p + j] = 0;
    for (let j = 0; j < ITEM_NAME_LENGTH_BYTES; j++) buf[p + j] = 0xff;
    writeU16LE(buf, p + ITEM_OFFSET_ITEM_ID, i);
    buf[p + ITEM_OFFSET_POCKET] = i % 10;
  }
}

/** Plant an items table whose first N entries have REAL Gen-3-encoded
 *  vanilla item names. Used for the sampleNames-decode test. */
function plantItemsTableWithNames(
  buf: Uint8Array,
  offset: number,
  itemCount: number,
): void {
  for (let i = 0; i < itemCount; i++) {
    const p = offset + i * ITEM_STRUCT_SIZE_BYTES;
    for (let j = 0; j < ITEM_STRUCT_SIZE_BYTES; j++) buf[p + j] = 0;
    // Name field: encode a vanilla name if available, otherwise fill
    // with 0xFF terminator at slot 0 (empty name).
    const name = VANILLA_ITEM_NAMES[i];
    if (name) {
      const encoded = encodeString(name);
      const copyLen = Math.min(encoded.length, ITEM_NAME_LENGTH_BYTES - 1);
      for (let j = 0; j < copyLen; j++) buf[p + ITEM_OFFSET_NAME + j] = encoded[j]!;
      buf[p + ITEM_OFFSET_NAME + copyLen] = STRING_TERMINATOR;
      // Remaining name bytes already zero from the wipe above; that's
      // fine (decoder will stop at the terminator).
    } else {
      // No vanilla name → use 0xFF terminator at slot 0.
      for (let j = 0; j < ITEM_NAME_LENGTH_BYTES; j++) buf[p + j] = 0xff;
    }
    writeU16LE(buf, p + ITEM_OFFSET_ITEM_ID, i);
    buf[p + ITEM_OFFSET_POCKET] = i % 10;
  }
}

function garbageFill(buf: Uint8Array, fromOffset: number): void {
  for (let i = fromOffset; i < buf.length; i++) {
    buf[i] = 50 + ((i * 13 + 7) % 200);
  }
}

describe('itemsSystemDetector', () => {
  it('exports the universal RomDetector contract', () => {
    expect(itemsSystemDetector.id).toBe(ITEMS_SYSTEM_DETECTOR_ID);
    expect(typeof itemsSystemDetector.name).toBe('string');
    expect(itemsSystemDetector.phase).toBe(8);
    expect(typeof itemsSystemDetector.detect).toBe('function');
  });

  it('returns not_detected on ROM too small', () => {
    // 0xC0 + 100 * 44 = 4592 bytes minimum. 500 bytes is comfortably below
    // but past the 192-byte loadRomFromBytes floor.
    const bytes = new Uint8Array(500);
    bytes[0xb2] = 0x96;
    const rom = loadRomFromBytes({ bytes, sourcePath: 'test://tiny', synthetic: true });
    const cov = new CoverageMap(bytes.length);
    const r = itemsSystemDetector.detect(rom, cov);
    expect(r.status).toBe('not_detected');
    if (r.status === 'not_detected') expect(r.reason).toContain('too small');
  });

  it('returns not_detected when no item table is in the ROM', () => {
    const bytes = new Uint8Array(64 * 1024);
    bytes[0xb2] = 0x96;
    garbageFill(bytes, 0xc0);
    const rom = loadRomFromBytes({ bytes, sourcePath: 'test://no-items', synthetic: true });
    const cov = new CoverageMap(bytes.length);
    const r = itemsSystemDetector.detect(rom, cov);
    expect(r.status).toBe('not_detected');
    if (r.status === 'not_detected') expect(r.reason).toContain('No Gen-3 gItems');
  });

  it('finds a planted 376-item table + registers coverage', () => {
    const bytes = new Uint8Array(128 * 1024);
    bytes[0xb2] = 0x96;
    garbageFill(bytes, 0xc0);
    plantItemsTable(bytes, 0x4000, 376);
    const rom = loadRomFromBytes({ bytes, sourcePath: 'test://items', synthetic: true });
    const cov = new CoverageMap(bytes.length);
    const r = itemsSystemDetector.detect(rom, cov);
    expect(r.status).toBe('detected');
    if (r.status === 'detected') {
      expect(r.data.itemCount).toBe(376);
      expect(r.data.itemsTable.tableStart).toBe(0x4000);
    }
    const report = cov.report();
    const itemRegions = report.regions.filter((rgn) =>
      rgn.provenance?.includes(ITEMS_SYSTEM_DETECTOR_ID),
    );
    expect(itemRegions.length).toBe(1);
    expect(itemRegions[0]?.start).toBe(0x4000);
  });

  it('result.data is frozen', () => {
    const bytes = new Uint8Array(128 * 1024);
    bytes[0xb2] = 0x96;
    garbageFill(bytes, 0xc0);
    plantItemsTable(bytes, 0x4000, 376);
    const rom = loadRomFromBytes({ bytes, sourcePath: 'test://items', synthetic: true });
    const cov = new CoverageMap(bytes.length);
    const r = itemsSystemDetector.detect(rom, cov);
    if (r.status === 'detected') expect(Object.isFrozen(r.data)).toBe(true);
  });

  it('populates sampleNames with decoded vanilla item names (UW-2-T8 iter 74)', () => {
    const bytes = new Uint8Array(128 * 1024);
    bytes[0xb2] = 0x96;
    garbageFill(bytes, 0xc0);
    plantItemsTableWithNames(bytes, 0x4000, 376);
    const rom = loadRomFromBytes({ bytes, sourcePath: 'test://items-with-names', synthetic: true });
    const cov = new CoverageMap(bytes.length);
    const r = itemsSystemDetector.detect(rom, cov);
    expect(r.status).toBe('detected');
    if (r.status === 'detected') {
      // RT-1.6: sampleNames now carries ALL decoded items (no longer
      // capped at 24) - the lifter iterates this to populate
      // manifest.items[].
      expect(r.data.sampleNames.length).toBe(376);
      // Item 0: planted with 0xFF terminator at byte 0 → decoder returns
      // empty string.
      expect(r.data.sampleNames[0]).toBe('');
      // Items 1..9 were planted with real ASCII-encoded vanilla names.
      expect(r.data.sampleNames[1]).toBe('MASTER BALL');
      expect(r.data.sampleNames[2]).toBe('ULTRA BALL');
      expect(r.data.sampleNames[3]).toBe('GREAT BALL');
      expect(r.data.sampleNames[4]).toBe('POKE BALL');
      expect(r.data.sampleNames[9]).toBe('REPEAT BALL');
      // sampleNames must be frozen.
      expect(Object.isFrozen(r.data.sampleNames)).toBe(true);
    }
  });

  it('decodes all items into sampleNames (RT-1.6: no 24-entry cap)', () => {
    const bytes = new Uint8Array(128 * 1024);
    bytes[0xb2] = 0x96;
    garbageFill(bytes, 0xc0);
    plantItemsTableWithNames(bytes, 0x4000, 120);
    const rom = loadRomFromBytes({ bytes, sourcePath: 'test://items-small', synthetic: true });
    const cov = new CoverageMap(bytes.length);
    const r = itemsSystemDetector.detect(rom, cov);
    if (r.status === 'detected') {
      // Previously capped at 24; now carries all 120 planted items so
      // the lifter can populate every manifest entry.
      expect(r.data.sampleNames.length).toBe(120);
    }
  });

  it('confidence scales with item count', () => {
    const buf1 = new Uint8Array(128 * 1024);
    buf1[0xb2] = 0x96;
    garbageFill(buf1, 0xc0);
    plantItemsTable(buf1, 0x4000, 150); // <200 → 0.88
    const rom1 = loadRomFromBytes({ bytes: buf1, sourcePath: 'test://small', synthetic: true });
    const cov1 = new CoverageMap(buf1.length);
    const r1 = itemsSystemDetector.detect(rom1, cov1);
    if (r1.status === 'detected') expect(r1.confidence).toBeCloseTo(0.88, 5);

    const buf2 = new Uint8Array(128 * 1024);
    buf2[0xb2] = 0x96;
    garbageFill(buf2, 0xc0);
    plantItemsTable(buf2, 0x4000, 376); // ≥300 → 0.95
    const rom2 = loadRomFromBytes({ bytes: buf2, sourcePath: 'test://vanilla', synthetic: true });
    const cov2 = new CoverageMap(buf2.length);
    const r2 = itemsSystemDetector.detect(rom2, cov2);
    if (r2.status === 'detected') expect(r2.confidence).toBeCloseTo(0.95, 5);
  });
});
