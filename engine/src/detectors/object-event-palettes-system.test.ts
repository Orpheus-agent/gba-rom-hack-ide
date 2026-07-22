import { describe, expect, it } from 'vitest';
import { CoverageMap } from '../coverage/index.js';
import { loadRomFromBytes } from '../rom/index.js';
import { GBA_ROM_BASE_ADDRESS } from '../pointers/index.js';
import {
  OBJECT_EVENT_PALETTES_SYSTEM_DETECTOR_ID,
  objectEventPalettesSystemDetector,
} from './object-event-palettes-system.js';

const ENTRY_SIZE = 8;
const PALETTE_BYTES = 32;

function plantMinimalHeader(buf: Uint8Array): void {
  buf[0xb2] = 0x96;
}

function fillNoise(buf: Uint8Array, fromOffset: number, toOffsetExclusive: number): void {
  for (let i = fromOffset; i < toOffsetExclusive; i++) {
    buf[i] = 0xff;
  }
}

/** Plant a 32-byte BGR555 palette starting at `offset`. Each color
 *  shifts hue progressively + always clears bit 15. Yields a region
 *  with 16 distinct colors so `isValidPaletteRegion` accepts it. */
function plantPalette(buf: Uint8Array, offset: number, seed: number): void {
  for (let i = 0; i < 16; i++) {
    // Pack BGR555 with bit 15 = 0; vary R/G/B per i + seed to keep colors distinct.
    const r5 = (seed + i) & 0x1f;
    const g5 = (seed * 2 + i * 3) & 0x1f;
    const b5 = (seed * 3 + i * 5) & 0x1f;
    const bgr = (b5 << 10) | (g5 << 5) | r5;
    buf[offset + i * 2 + 0] = bgr & 0xff;
    buf[offset + i * 2 + 1] = (bgr >>> 8) & 0xff;
  }
}

/** Plant `count` SpritePalette entries starting at `tableOffset`.
 *  Each entry points to a unique palette block starting at
 *  `palettesBaseOffset + i * 32`. Entry tags are 0x1100 + i. Appends an
 *  8-byte NULL sentinel `{0, 0x11FF, 0}` after the last entry. */
function plantSpritePaletteTable(
  buf: Uint8Array,
  tableOffset: number,
  palettesBaseOffset: number,
  count: number,
): void {
  for (let i = 0; i < count; i++) {
    const entryStart = tableOffset + i * ENTRY_SIZE;
    const paletteOffset = palettesBaseOffset + i * PALETTE_BYTES;
    plantPalette(buf, paletteOffset, i + 1);
    const ptr = (GBA_ROM_BASE_ADDRESS + paletteOffset) >>> 0;
    buf[entryStart + 0] = ptr & 0xff;
    buf[entryStart + 1] = (ptr >>> 8) & 0xff;
    buf[entryStart + 2] = (ptr >>> 16) & 0xff;
    buf[entryStart + 3] = (ptr >>> 24) & 0xff;
    const tag = 0x1100 + i;
    buf[entryStart + 4] = tag & 0xff;
    buf[entryStart + 5] = (tag >>> 8) & 0xff;
    buf[entryStart + 6] = 0; // padding
    buf[entryStart + 7] = 0;
  }
  // Sentinel: NULL pointer + tag 0x11FF + padding 0.
  const sentinelStart = tableOffset + count * ENTRY_SIZE;
  buf[sentinelStart + 0] = 0;
  buf[sentinelStart + 1] = 0;
  buf[sentinelStart + 2] = 0;
  buf[sentinelStart + 3] = 0;
  buf[sentinelStart + 4] = 0xff;
  buf[sentinelStart + 5] = 0x11;
  buf[sentinelStart + 6] = 0;
  buf[sentinelStart + 7] = 0;
}

describe('objectEventPalettesSystemDetector', () => {
  it('exports the universal RomDetector contract', () => {
    expect(objectEventPalettesSystemDetector.id).toBe(
      OBJECT_EVENT_PALETTES_SYSTEM_DETECTOR_ID,
    );
    expect(typeof objectEventPalettesSystemDetector.name).toBe('string');
    expect(objectEventPalettesSystemDetector.phase).toBe(8);
    expect(typeof objectEventPalettesSystemDetector.detect).toBe('function');
  });

  it('returns not_detected on a noise ROM', () => {
    const bytes = new Uint8Array(64 * 1024);
    plantMinimalHeader(bytes);
    fillNoise(bytes, 0xc0, bytes.length);
    const rom = loadRomFromBytes({ bytes, sourcePath: 'test://noise', synthetic: true });
    const cov = new CoverageMap(bytes.length);
    const r = objectEventPalettesSystemDetector.detect(rom, cov);
    expect(r.status).toBe('not_detected');
  });

  it('detects a planted 25-entry table and surfaces resolved RGBA palettes', () => {
    const bytes = new Uint8Array(64 * 1024);
    plantMinimalHeader(bytes);
    fillNoise(bytes, 0xc0, bytes.length);
    // Table starts at 0x1000 (well past header), palettes at 0x4000.
    plantSpritePaletteTable(bytes, 0x1000, 0x4000, 25);
    const rom = loadRomFromBytes({
      bytes,
      sourcePath: 'test://sprite-palettes',
      synthetic: true,
    });
    const cov = new CoverageMap(bytes.length);
    const r = objectEventPalettesSystemDetector.detect(rom, cov);
    expect(r.status).toBe('detected');
    if (r.status === 'detected') {
      expect(r.confidence).toBe(0.95);
      expect(r.data.paletteTable.tableStart).toBe(0x1000);
      expect(r.data.entryCount).toBe(25);
      // Sentinel is 8 bytes past the last entry: 0x1000 + 25*8 + 8 = 0x10D0.
      expect(r.data.paletteTable.tableEndExclusive).toBe(0x1000 + 26 * 8);
      // Tags should be 0x1100..0x1118.
      expect(r.data.paletteTable.entries[0]?.tag).toBe(0x1100);
      expect(r.data.paletteTable.entries[24]?.tag).toBe(0x1118);
      // Each entry's paletteFileOffset points to the planted block.
      expect(r.data.paletteTable.entries[0]?.paletteFileOffset).toBe(0x4000);
      expect(r.data.paletteTable.entries[1]?.paletteFileOffset).toBe(0x4020);
      // Each entry resolves a 16-color RGBA palette; index 0 is
      // transparent per Gen-3 convention.
      expect(r.data.paletteTable.entries[0]?.paletteRgba.length).toBe(16);
      expect(r.data.paletteTable.entries[0]?.paletteRgba[0]).toBe(0);
      // Non-zero indices should have alpha 0xff in the high byte.
      const rgba1 = r.data.paletteTable.entries[0]!.paletteRgba[1]!;
      expect((rgba1 >>> 24) & 0xff).toBe(0xff);
    }
    const report = cov.report();
    const regions = report.regions.filter((rgn) =>
      rgn.provenance?.includes(OBJECT_EVENT_PALETTES_SYSTEM_DETECTOR_ID),
    );
    expect(regions.length).toBe(1);
    expect(regions[0]?.start).toBe(0x1000);
    expect(regions[0]?.end).toBe(0x1000 + 26 * 8);
  });

  it('rejects a table below the minimum entry threshold', () => {
    const bytes = new Uint8Array(64 * 1024);
    plantMinimalHeader(bytes);
    fillNoise(bytes, 0xc0, bytes.length);
    // Only 5 entries - below the 8-entry minimum.
    plantSpritePaletteTable(bytes, 0x1000, 0x4000, 5);
    const rom = loadRomFromBytes({
      bytes,
      sourcePath: 'test://too-few',
      synthetic: true,
    });
    const cov = new CoverageMap(bytes.length);
    const r = objectEventPalettesSystemDetector.detect(rom, cov);
    expect(r.status).toBe('not_detected');
  });

  it('confidence falls to 0.9 between 15-24 entries', () => {
    const bytes = new Uint8Array(64 * 1024);
    plantMinimalHeader(bytes);
    fillNoise(bytes, 0xc0, bytes.length);
    plantSpritePaletteTable(bytes, 0x1000, 0x4000, 18);
    const rom = loadRomFromBytes({
      bytes,
      sourcePath: 'test://moderate',
      synthetic: true,
    });
    const cov = new CoverageMap(bytes.length);
    const r = objectEventPalettesSystemDetector.detect(rom, cov);
    expect(r.status).toBe('detected');
    if (r.status === 'detected') {
      expect(r.confidence).toBe(0.9);
      expect(r.data.entryCount).toBe(18);
    }
  });
});
