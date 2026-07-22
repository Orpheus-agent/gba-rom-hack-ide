/**
 * GBA palette-region detector - Phase UW-2 / Category 8 substrate (iter
 * 78 / UW-2-T12).
 *
 * Detects the GBA graphics palette substrate by scanning the ROM for
 * 32-byte BGR555 palette regions. Each region is 16 colors × 2 bytes
 * with bit 15 of every u16 color clear (GBA hardware unused bit).
 *
 * Per PD 5: BGR555 is GBA hardware format, not a Pokémon-specific
 * convention; detector works on every GBA cart (Cat 8 advance applies
 * to all carts).
 *
 * Per PD 1: typed `not_detected` when ROM too small OR fewer than
 * `PALETTE_DETECT_MIN_REGIONS` regions found.
 *
 * Per PD 12: returns first N palette offsets via
 * `firstRegionOffsets` array - no silent absorption.
 *
 * Advances:
 *   - Category 8 (Graphics / tiles / sprites / visual assets) - 
 *     FIRST concrete graphics detector; flips engine status missing →
 *     partial. Cat 8 was the LAST engine:missing category after iters
 *     76 (Cat 10) + 77 (Cat 11). After this iter, ZERO categories
 *     remain engine:missing - major Phase UW-2 milestone.
 */

import { makeDetected, makeEvidence, makeNotDetected } from '../detection/index.js';
import type { Detection } from '../detection/index.js';
import type { CoverageMap } from '../coverage/index.js';
import type { RomImage } from '../rom/loader.js';
import type { RomDetector } from './types.js';
import {
  PALETTE_BYTES,
  COLORS_PER_PALETTE,
  scanPaletteRegions,
} from '../graphics/index.js';

export const PALETTE_SYSTEM_DETECTOR_ID = 'palette_system';

/** Minimum number of palette regions a ROM must contain for confident
 *  detection. Vanilla FRLG has thousands; even tiny hacks have ≥100.
 *  Set to 50 to stay defensive against false-positives on small ROMs. */
export const PALETTE_DETECT_MIN_REGIONS = 50;

/** How many palette offsets to expose in the editor preview. */
const PALETTE_SAMPLE_OFFSET_COUNT = 16;

export interface PaletteSystemReport {
  /** Total count of valid 32-byte palette regions found. */
  readonly paletteRegionCount: number;
  /** First N palette offsets for the IdentityCard preview surface. */
  readonly firstRegionOffsets: ReadonlyArray<number>;
  /** Palette format constants surfaced for editor render convenience. */
  readonly bytesPerPalette: number;
  readonly colorsPerPalette: number;
}

export const paletteSystemDetector: RomDetector<PaletteSystemReport> = {
  id: PALETTE_SYSTEM_DETECTOR_ID,
  name: 'Palette Regions (BGR555 32-byte scan)',
  phase: 8,
  detect(rom: RomImage, coverage: CoverageMap): Detection<PaletteSystemReport> {
    // Smallest plausible ROM with PALETTE_DETECT_MIN_REGIONS palettes:
    // 0xC0 (header) + 50 * 32 (palettes) + slack = ~1.7 KiB. Anything
    // smaller can't realistically host the threshold.
    const minBytes = 0xc0 + PALETTE_DETECT_MIN_REGIONS * PALETTE_BYTES;
    if (rom.byteLength < minBytes) {
      return makeNotDetected({
        confidence: 1.0,
        evidence: [
          makeEvidence({
            kind: 'heuristic',
            summary: `ROM is ${String(rom.byteLength)} bytes - too small to host ≥${String(PALETTE_DETECT_MIN_REGIONS)} 32-byte BGR555 palette regions (needs ≥${String(minBytes)} bytes after cartridge header)`,
            weight: 1.0,
          }),
        ],
        reason: 'ROM too small to scan for GBA BGR555 palette regions',
      });
    }

    const scan = scanPaletteRegions(rom.bytes);

    if (scan.regionCount < PALETTE_DETECT_MIN_REGIONS) {
      return makeNotDetected({
        confidence: 0.85,
        evidence: [
          makeEvidence({
            kind: 'heuristic',
            summary: `scanned ${String(rom.byteLength)} bytes for valid 32-byte BGR555 palette regions (every u16 color has bit 15 = 0, ≥3 distinct colors) - found ${String(scan.regionCount)} (need ≥${String(PALETTE_DETECT_MIN_REGIONS)})`,
            weight: 1.0,
            detail: {
              romByteLength: rom.byteLength,
              regionsFound: scan.regionCount,
              threshold: PALETTE_DETECT_MIN_REGIONS,
            },
          }),
        ],
        reason:
          'Fewer than 50 valid BGR555 palette regions found - ROM may be a tiny test fixture, non-GBA, or stripped of graphics assets',
      });
    }

    // Register coverage at the FIRST region offset (full coverage across
    // every region would balloon the coverage map; the pointer-network
    // detector covers the bulk of the data section already).
    const firstOffset = scan.regionOffsets[0]!;
    try {
      coverage.addClassified({
        start: firstOffset,
        end: firstOffset + PALETTE_BYTES,
        probableClass: 'graphics',
        score: 0.9,
        provenance: `${PALETTE_SYSTEM_DETECTOR_ID}#first_palette`,
        note: `GBA BGR555 palette (16 colors × 2 bytes; anchor for palette-system detection - ${String(scan.regionCount)} regions total)`,
      });
    } catch {
      // Overlap - skip but keep detecting.
    }

    // Confidence: regions found scales with the ROM's graphics
    // density. ≥1000 regions = vanilla-level = 0.95.
    // ≥200 = moderate hack = 0.92.
    // ≥50 = baseline detection threshold = 0.88.
    const confidence =
      scan.regionCount >= 1000 ? 0.95 : scan.regionCount >= 200 ? 0.92 : 0.88;

    return makeDetected({
      confidence,
      data: Object.freeze({
        paletteRegionCount: scan.regionCount,
        firstRegionOffsets: Object.freeze(
          scan.regionOffsets.slice(0, PALETTE_SAMPLE_OFFSET_COUNT),
        ),
        bytesPerPalette: PALETTE_BYTES,
        colorsPerPalette: COLORS_PER_PALETTE,
      }),
      evidence: [
        makeEvidence({
          kind: 'heuristic',
          summary: `Found ${String(scan.regionCount)} valid 32-byte BGR555 palette regions; first at offset 0x${firstOffset.toString(16)}`,
          weight: 1.0,
          detail: {
            paletteRegionCount: scan.regionCount,
            firstRegionOffset: firstOffset,
            sampleOffsets: scan.regionOffsets.slice(0, 5),
          },
        }),
      ],
    });
  },
};
