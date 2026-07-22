import { describe, expect, it } from 'vitest';
import {
  TEXT_POINTER_TABLE_ANCHOR_CONFIRMATION_ENTRIES,
  TEXT_POINTER_TABLE_MIN_PRINTABLE_CHARS,
  TEXT_POINTER_TABLE_MIN_VALID_ENTRIES,
  findTextPointerTables,
} from './text-pointer-tables.js';
import { GBA_ROM_BASE_ADDRESS } from '../pointers/index.js';
import { encodeString, STRING_TERMINATOR } from './codec.js';

/** Write `text` encoded as Gen-3 + 0xFF terminator at `offset`. */
function plantText(buf: Uint8Array, offset: number, text: string): number {
  const encoded = encodeString(text);
  buf.set(encoded, offset);
  buf[offset + encoded.length] = STRING_TERMINATOR;
  return offset + encoded.length + 1;
}

/**
 * Plant a pointer table of `count` u32 entries at `tableOffset`. Each
 * entry points to a planted text string in the `textRegionStart..`
 * area. Returns the total bytes used (table + all strings).
 */
function plantTextPointerTable(
  buf: Uint8Array,
  tableOffset: number,
  count: number,
  textRegionStart: number,
  textsPerEntry: string[] = [],
): { tableEndExclusive: number; textRegionEndExclusive: number } {
  let textCursor = textRegionStart;
  for (let i = 0; i < count; i++) {
    const text =
      textsPerEntry[i] ?? `MOVE ${String(i).padStart(3, '0')} DESCRIPTION`;
    const textAddr = (GBA_ROM_BASE_ADDRESS + textCursor) >>> 0;
    // Write u32 pointer (LE) in the table.
    const ptrSlot = tableOffset + i * 4;
    buf[ptrSlot + 0] = textAddr & 0xff;
    buf[ptrSlot + 1] = (textAddr >>> 8) & 0xff;
    buf[ptrSlot + 2] = (textAddr >>> 16) & 0xff;
    buf[ptrSlot + 3] = (textAddr >>> 24) & 0xff;
    // Write the text + terminator at textCursor.
    textCursor = plantText(buf, textCursor, text);
  }
  return {
    tableEndExclusive: tableOffset + count * 4,
    textRegionEndExclusive: textCursor,
  };
}

function plantMinimalHeader(buf: Uint8Array): void {
  buf[0xb2] = 0x96;
}

/** Fill region with 0xFF (terminators) - text decode fails for empty strings,
 *  pointer decode fails (high byte 0xFF). */
function fillNoise(buf: Uint8Array, fromOffset: number, toOffsetExclusive: number): void {
  for (let i = fromOffset; i < toOffsetExclusive; i++) {
    buf[i] = 0xff;
  }
}

describe('text-pointer-tables constants', () => {
  it('exports a 10-entry anchor confirmation threshold', () => {
    expect(TEXT_POINTER_TABLE_ANCHOR_CONFIRMATION_ENTRIES).toBe(10);
  });
  it('exports a 10-entry minimum-valid-entries threshold', () => {
    expect(TEXT_POINTER_TABLE_MIN_VALID_ENTRIES).toBe(10);
  });
  it('exports a 3-printable-char min for text validation', () => {
    expect(TEXT_POINTER_TABLE_MIN_PRINTABLE_CHARS).toBe(3);
  });
});

describe('findTextPointerTables', () => {
  it('returns empty on a tiny ROM (below header + min-entries size)', () => {
    const bytes = new Uint8Array(0x100);
    plantMinimalHeader(bytes);
    expect(findTextPointerTables(bytes)).toEqual([]);
  });

  it('returns empty when there are no valid text-pointer tables', () => {
    const bytes = new Uint8Array(128 * 1024);
    plantMinimalHeader(bytes);
    fillNoise(bytes, 0xc0, bytes.length);
    expect(findTextPointerTables(bytes)).toEqual([]);
  });

  it('detects a planted 30-entry text-pointer table + decodes strings', () => {
    const bytes = new Uint8Array(128 * 1024);
    plantMinimalHeader(bytes);
    fillNoise(bytes, 0xc0, bytes.length);
    const tableOffset = 0x1000;
    const textRegionStart = 0x2000;
    plantTextPointerTable(bytes, tableOffset, 30, textRegionStart);
    // Re-noise after the table to terminate the walk cleanly.
    fillNoise(bytes, tableOffset + 30 * 4, textRegionStart);
    const tables = findTextPointerTables(bytes);
    expect(tables.length).toBe(1);
    expect(tables[0]?.tableOffset).toBe(tableOffset);
    expect(tables[0]?.entryCount).toBe(30);
    expect(tables[0]?.sampleStrings.length).toBe(8);
    // First decoded string should be the default plant.
    expect(tables[0]?.sampleStrings[0]).toBe('MOVE 000 DESCRIPTION');
    expect(tables[0]?.sampleStrings[1]).toBe('MOVE 001 DESCRIPTION');
  });

  it('returns empty when planted entries are below MIN_VALID_ENTRIES floor', () => {
    const bytes = new Uint8Array(128 * 1024);
    plantMinimalHeader(bytes);
    fillNoise(bytes, 0xc0, bytes.length);
    // Plant only 5 entries - below the 10-entry floor.
    plantTextPointerTable(bytes, 0x1000, 5, 0x2000);
    fillNoise(bytes, 0x1000 + 5 * 4, 0x2000);
    expect(findTextPointerTables(bytes)).toEqual([]);
  });

  it('detects multiple text-pointer tables and sorts by entryCount desc', () => {
    const bytes = new Uint8Array(256 * 1024);
    plantMinimalHeader(bytes);
    fillNoise(bytes, 0xc0, bytes.length);
    // Small table at 0x1000 (15 entries) with text region 0x2000.
    const small = plantTextPointerTable(bytes, 0x1000, 15, 0x2000);
    fillNoise(bytes, small.tableEndExclusive, 0x2000);
    fillNoise(bytes, small.textRegionEndExclusive, 0x10000);
    // Larger table at 0x10000 (50 entries) with text region 0x12000.
    const large = plantTextPointerTable(bytes, 0x10000, 50, 0x12000);
    fillNoise(bytes, large.tableEndExclusive, 0x12000);
    fillNoise(bytes, large.textRegionEndExclusive, bytes.length);
    const tables = findTextPointerTables(bytes);
    expect(tables.length).toBe(2);
    // Sorted desc → 50-entry table first, 15-entry table second.
    expect(tables[0]?.entryCount).toBe(50);
    expect(tables[1]?.entryCount).toBe(15);
  });

  it('skips the cartridge header region (offsets < 0xC0) when scanning', () => {
    const bytes = new Uint8Array(128 * 1024);
    plantMinimalHeader(bytes);
    fillNoise(bytes, 0xc0, bytes.length);
    // Plant table starting right at 0xC0.
    plantTextPointerTable(bytes, 0xc0, 30, 0x2000);
    fillNoise(bytes, 0xc0 + 30 * 4, 0x2000);
    const tables = findTextPointerTables(bytes);
    expect(tables[0]?.tableOffset).toBe(0xc0);
  });

  it('rejects pointers to text shorter than MIN_PRINTABLE_CHARS', () => {
    const bytes = new Uint8Array(128 * 1024);
    plantMinimalHeader(bytes);
    fillNoise(bytes, 0xc0, bytes.length);
    const shortTexts: string[] = [];
    for (let i = 0; i < 30; i++) shortTexts.push('XY'); // Only 2 chars
    plantTextPointerTable(bytes, 0x1000, 30, 0x2000, shortTexts);
    fillNoise(bytes, 0x1000 + 30 * 4, 0x2000);
    // All entries point to 2-char strings (below 3-char floor) - rejected.
    expect(findTextPointerTables(bytes)).toEqual([]);
  });

  it('rejects pointers outside ROM space (high byte != 0x08/0x09)', () => {
    const bytes = new Uint8Array(128 * 1024);
    plantMinimalHeader(bytes);
    fillNoise(bytes, 0xc0, bytes.length);
    plantTextPointerTable(bytes, 0x1000, 30, 0x2000);
    // Corrupt every pointer's high byte to 0x03 (EWRAM, not ROM).
    for (let i = 0; i < 30; i++) {
      bytes[0x1000 + i * 4 + 3] = 0x03;
    }
    fillNoise(bytes, 0x1000 + 30 * 4, 0x2000);
    expect(findTextPointerTables(bytes)).toEqual([]);
  });

  it('frozen sampleStrings array on returned tables', () => {
    const bytes = new Uint8Array(128 * 1024);
    plantMinimalHeader(bytes);
    fillNoise(bytes, 0xc0, bytes.length);
    plantTextPointerTable(bytes, 0x1000, 30, 0x2000);
    fillNoise(bytes, 0x1000 + 30 * 4, 0x2000);
    const tables = findTextPointerTables(bytes);
    expect(Object.isFrozen(tables)).toBe(true);
    expect(Object.isFrozen(tables[0])).toBe(true);
    expect(Object.isFrozen(tables[0]?.sampleStrings)).toBe(true);
  });
});
