import { describe, expect, it } from 'vitest';
import {
  CRY_ENTRY_SIZE_BYTES,
  CRY_TABLE_ANCHOR_CONFIRMATION_ENTRIES,
  CRY_TABLE_MIN_VALID_ENTRIES,
  findCryTable,
} from './cry-table.js';
import { GBA_ROM_BASE_ADDRESS } from '../pointers/index.js';

/**
 * Plant `count` valid cry-table entries starting at `offset`. Each entry
 * has type=0x00 (PCM), a wav-pointer at offset + 0x100000 + i*0x100
 * (well inside ROM space), and small envelope params.
 */
function plantCryTable(buf: Uint8Array, offset: number, count: number): void {
  for (let i = 0; i < count; i++) {
    const start = offset + i * CRY_ENTRY_SIZE_BYTES;
    // type=0 (PCM), key=60 (middle C), length=0, panSweep=0
    buf[start + 0] = 0x00;
    buf[start + 1] = 60;
    buf[start + 2] = 0;
    buf[start + 3] = 0;
    // wav GBA addr = 0x08000000 + 0x4000 + i*0x10 (fits within 64 KiB test ROMs).
    const wavAddr = (GBA_ROM_BASE_ADDRESS + 0x4000 + i * 0x10) >>> 0;
    buf[start + 4] = wavAddr & 0xff;
    buf[start + 5] = (wavAddr >>> 8) & 0xff;
    buf[start + 6] = (wavAddr >>> 16) & 0xff;
    buf[start + 7] = (wavAddr >>> 24) & 0xff;
    // ADSR: small values, all < 128
    buf[start + 8] = 5;   // attack
    buf[start + 9] = 10;  // decay
    buf[start + 10] = 60; // sustain
    buf[start + 11] = 15; // release
  }
}

/** Plant valid header bytes so loadRomFromBytes doesn't complain. */
function plantMinimalHeader(buf: Uint8Array): void {
  // Fixed marker byte at 0xB2 = 0x96 (Nintendo)
  buf[0xb2] = 0x96;
}

/** Fill non-entry bytes with noise that breaks the cry-entry validator. */
function fillNoise(buf: Uint8Array, fromOffset: number, toOffsetExclusive: number): void {
  for (let i = fromOffset; i < toOffsetExclusive; i++) {
    // 0xFF in any byte slot - type=0xFF rejects, wav-ptr high byte 0xFF
    // rejects, envelope >=128 rejects. Sets ALL validity checks to fail.
    buf[i] = 0xff;
  }
}

describe('cry-table constants', () => {
  it('exports the canonical 12-byte entry size', () => {
    expect(CRY_ENTRY_SIZE_BYTES).toBe(12);
  });
  it('exports the 10-entry anchor confirmation threshold', () => {
    expect(CRY_TABLE_ANCHOR_CONFIRMATION_ENTRIES).toBe(10);
  });
  it('exports the 150-entry minimum-floor threshold', () => {
    expect(CRY_TABLE_MIN_VALID_ENTRIES).toBe(150);
  });
});

describe('findCryTable', () => {
  it('returns null on a tiny ROM (below header + min-entries size)', () => {
    const bytes = new Uint8Array(0x100);
    plantMinimalHeader(bytes);
    expect(findCryTable(bytes)).toBe(null);
  });

  it('returns null when no valid entries are planted', () => {
    const bytes = new Uint8Array(64 * 1024);
    plantMinimalHeader(bytes);
    fillNoise(bytes, 0xc0, bytes.length);
    expect(findCryTable(bytes)).toBe(null);
  });

  it('detects a 200-entry planted cry table at 0x1000', () => {
    const bytes = new Uint8Array(64 * 1024);
    plantMinimalHeader(bytes);
    fillNoise(bytes, 0xc0, bytes.length);
    plantCryTable(bytes, 0x1000, 200);
    // Re-noise after the table to ensure boundary cleanly terminates.
    fillNoise(bytes, 0x1000 + 200 * CRY_ENTRY_SIZE_BYTES, bytes.length);
    const located = findCryTable(bytes);
    expect(located).not.toBeNull();
    expect(located?.tableOffset).toBe(0x1000);
    expect(located?.validEntries).toBe(200);
    expect(located?.tableEndExclusive).toBe(0x1000 + 200 * CRY_ENTRY_SIZE_BYTES);
  });

  it('returns null when planted entries are below MIN_VALID_ENTRIES floor', () => {
    const bytes = new Uint8Array(64 * 1024);
    plantMinimalHeader(bytes);
    fillNoise(bytes, 0xc0, bytes.length);
    // Plant only 100 entries - below the 150-entry floor.
    plantCryTable(bytes, 0x1000, 100);
    fillNoise(bytes, 0x1000 + 100 * CRY_ENTRY_SIZE_BYTES, bytes.length);
    expect(findCryTable(bytes)).toBe(null);
  });

  it('skips the cartridge header region (offsets < 0xC0) when scanning', () => {
    const bytes = new Uint8Array(64 * 1024);
    plantMinimalHeader(bytes);
    // Plant entries fully past header.
    plantCryTable(bytes, 0xc0, 200);
    fillNoise(bytes, 0xc0 + 200 * CRY_ENTRY_SIZE_BYTES, bytes.length);
    const located = findCryTable(bytes);
    expect(located?.tableOffset).toBe(0xc0);
  });

  it('reports samplePreview capped at 16 entries with correct wav offsets', () => {
    const bytes = new Uint8Array(64 * 1024);
    plantMinimalHeader(bytes);
    fillNoise(bytes, 0xc0, bytes.length);
    plantCryTable(bytes, 0x1000, 200);
    fillNoise(bytes, 0x1000 + 200 * CRY_ENTRY_SIZE_BYTES, bytes.length);
    const located = findCryTable(bytes);
    expect(located?.samplePreview.length).toBe(16);
    // Entry 0's wav offset should be 0x4000 (per plantCryTable).
    expect(located?.samplePreview[0]?.wavOffset).toBe(0x4000);
    expect(located?.samplePreview[0]?.index).toBe(0);
    expect(located?.samplePreview[0]?.type).toBe(0x00);
    // Entry 5's wav offset should be 0x4000 + 5 * 0x10 = 0x4050.
    expect(located?.samplePreview[5]?.wavOffset).toBe(0x4050);
  });

  it('accepts type=0x80 (compressed PCM) as a valid cry-entry type', () => {
    const bytes = new Uint8Array(64 * 1024);
    plantMinimalHeader(bytes);
    fillNoise(bytes, 0xc0, bytes.length);
    plantCryTable(bytes, 0x1000, 200);
    // Flip every other entry's type to 0x80 (compressed).
    for (let i = 0; i < 200; i += 2) {
      bytes[0x1000 + i * CRY_ENTRY_SIZE_BYTES] = 0x80;
    }
    fillNoise(bytes, 0x1000 + 200 * CRY_ENTRY_SIZE_BYTES, bytes.length);
    const located = findCryTable(bytes);
    expect(located?.validEntries).toBe(200);
  });

  it('rejects entries with envelope bytes >= 128 (not 7-bit)', () => {
    const bytes = new Uint8Array(64 * 1024);
    plantMinimalHeader(bytes);
    fillNoise(bytes, 0xc0, bytes.length);
    plantCryTable(bytes, 0x1000, 200);
    // Corrupt envelope byte 8 (attack) on every entry to be >= 128.
    for (let i = 0; i < 200; i++) {
      bytes[0x1000 + i * CRY_ENTRY_SIZE_BYTES + 8] = 0xff;
    }
    fillNoise(bytes, 0x1000 + 200 * CRY_ENTRY_SIZE_BYTES, bytes.length);
    // Detector should reject - all entries are now invalid.
    expect(findCryTable(bytes)).toBe(null);
  });

  it('accepts NULL wav pointers (silent species)', () => {
    const bytes = new Uint8Array(64 * 1024);
    plantMinimalHeader(bytes);
    fillNoise(bytes, 0xc0, bytes.length);
    plantCryTable(bytes, 0x1000, 200);
    // Zero out the wav pointer of every 4th entry (NULL = silent).
    for (let i = 0; i < 200; i += 4) {
      const ptrOffset = 0x1000 + i * CRY_ENTRY_SIZE_BYTES + 4;
      bytes[ptrOffset] = 0;
      bytes[ptrOffset + 1] = 0;
      bytes[ptrOffset + 2] = 0;
      bytes[ptrOffset + 3] = 0;
    }
    fillNoise(bytes, 0x1000 + 200 * CRY_ENTRY_SIZE_BYTES, bytes.length);
    const located = findCryTable(bytes);
    expect(located?.validEntries).toBe(200);
    // Entry 0 had its pointer zeroed.
    expect(located?.samplePreview[0]?.wavOffset).toBe(null);
    // Entry 1 should still have its planted pointer.
    expect(located?.samplePreview[1]?.wavOffset).toBe(0x4000 + 0x10);
  });

  it('rejects wav pointers outside ROM space (high byte != 0x08/0x09)', () => {
    const bytes = new Uint8Array(64 * 1024);
    plantMinimalHeader(bytes);
    fillNoise(bytes, 0xc0, bytes.length);
    plantCryTable(bytes, 0x1000, 200);
    // Corrupt wav-ptr high byte to 0x02 (IWRAM) on every entry.
    for (let i = 0; i < 200; i++) {
      bytes[0x1000 + i * CRY_ENTRY_SIZE_BYTES + 7] = 0x02;
    }
    fillNoise(bytes, 0x1000 + 200 * CRY_ENTRY_SIZE_BYTES, bytes.length);
    expect(findCryTable(bytes)).toBe(null);
  });
});
