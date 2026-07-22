/**
 * Gen-3 save-data format detector - Phase UW-2 / Category 10 substrate
 * (iter 76 / UW-2-T10).
 *
 * Detects the Gen-3 save format (14-sector × 4KB ring-buffer layout)
 * by scanning for the SECTOR_FOOTER_MAGIC constant `0x08012025` that
 * vanilla Pokémon ROMs embed in their save-validation code per
 * pret/pokefirered + pret/pokeemerald `src/save.c`.
 *
 * Per PD 5: signature-driven; the magic is universal across every
 * Gen-3 Pokémon ROM (including all known CFRU + Unbound + RR forks
 * since they're FRLG-derived).
 *
 * Per PD 1: typed `not_detected` with reason when the magic isn't
 * found (rom too small OR no occurrences). Per PD 12 reports all
 * occurrences via additionalOffsets[] - the magic typically appears
 * 1-3 times in vanilla.
 *
 * Distinct from iter 67's save-system detector which finds the SDK
 * backend family identifier string (FLASH_V12x / SRAM_V11x / etc.).
 * Together they cover the Cat 10 save subsystem at the format level
 * AND the Cat 2 runtime layer at the backend-driver level.
 *
 * Advances:
 *   - Category 10 (Save data) - first concrete save-format detector;
 *     flips engine status missing → partial. Cat 10 was at 5%
 *     (engine:missing) since the start of the universal-workspace
 *     master.
 */

import { makeDetected, makeEvidence, makeNotDetected } from '../detection/index.js';
import type { Detection } from '../detection/index.js';
import type { CoverageMap } from '../coverage/index.js';
import type { RomImage } from '../rom/loader.js';
import type { RomDetector } from './types.js';
import {
  SAVE_DATA_TOTAL_SIZE_BYTES,
  SAVE_SECTOR_COUNT,
  SAVE_SECTOR_FOOTER_MAGIC,
  SAVE_SECTOR_SIZE_BYTES,
  findAllSaveSectorFooterMagic,
} from '../save-data/index.js';

export const SAVE_DATA_SYSTEM_DETECTOR_ID = 'save_data_system';

export interface SaveDataSystemReport {
  /** Absolute byte offset of the primary (first) magic occurrence. */
  readonly magicOffset: number;
  /** Count of all occurrences of the magic in the ROM (≥1 if detected). */
  readonly magicOccurrenceCount: number;
  /** All additional magic offsets after the primary (PD 12 surface). */
  readonly additionalOffsets: ReadonlyArray<number>;
  /** Constants describing the canonical Gen-3 save format that the
   *  detected magic anchors to. Editor consumers can render these as
   *  "14 sectors × 4096 bytes = 56KB total" without recomputing. */
  readonly sectorCount: number;
  readonly sectorSizeBytes: number;
  readonly totalSaveSizeBytes: number;
}

export const saveDataSystemDetector: RomDetector<SaveDataSystemReport> = {
  id: SAVE_DATA_SYSTEM_DETECTOR_ID,
  name: 'Save Data Layout (Gen-3 SECTOR_FOOTER_MAGIC scan)',
  phase: 8,
  detect(rom: RomImage, coverage: CoverageMap): Detection<SaveDataSystemReport> {
    // The magic is a 4-byte literal. ROMs smaller than the header +
    // a few KB of code can't realistically contain the save infra.
    const minBytes = 0xc0 + 0x1000;
    if (rom.byteLength < minBytes) {
      return makeNotDetected({
        confidence: 1.0,
        evidence: [
          makeEvidence({
            kind: 'heuristic',
            summary: `ROM is ${String(rom.byteLength)} bytes - too small to realistically host Gen-3 save infrastructure (needs ≥${String(minBytes)} bytes after cartridge header)`,
            weight: 1.0,
          }),
        ],
        reason: 'ROM too small to scan for Gen-3 save-sector footer magic',
      });
    }

    const offsets = findAllSaveSectorFooterMagic(rom.bytes);
    if (offsets.length === 0) {
      return makeNotDetected({
        confidence: 0.9,
        evidence: [
          makeEvidence({
            kind: 'heuristic',
            summary: `scanned ${String(rom.byteLength)} bytes for the SECTOR_FOOTER_MAGIC 0x${SAVE_SECTOR_FOOTER_MAGIC.toString(16).padStart(8, '0')} (LE byte sequence 0x25 0x20 0x01 0x08) - no occurrences`,
            weight: 1.0,
            detail: { romByteLength: rom.byteLength },
          }),
        ],
        reason:
          'No Gen-3 SECTOR_FOOTER_MAGIC found - ROM may be non-Pokémon, may have stripped the save infrastructure (rare in Gen-3 hacks), or may use a custom save format with a different magic value',
      });
    }

    const primary = offsets[0]!;

    // Register coverage for the magic location (4 bytes per occurrence).
    // The full save infra spans tens of KB; we only register the literal
    // magic positions since the rest is code paths the pointer-network
    // detector covers separately.
    for (const off of offsets) {
      try {
        coverage.addClassified({
          start: off,
          end: off + 4,
          probableClass: 'string',
          score: 0.95,
          provenance: `${SAVE_DATA_SYSTEM_DETECTOR_ID}#sector_footer_magic`,
          note: `Gen-3 SECTOR_FOOTER_MAGIC (4 bytes; ${String(SAVE_SECTOR_COUNT)} sectors × ${String(SAVE_SECTOR_SIZE_BYTES)} bytes save format)`,
        });
      } catch {
        // Overlap with another detector - skip but keep detecting.
      }
    }

    // Confidence: a single occurrence is strong (magic is a 32-bit
    // constant; random chance ≈ 1/2³² per 4-byte window); multiple
    // occurrences are nearly certain. Hacks that rewrite the save
    // system might remove some occurrences but keep at least one in
    // the validation routine.
    const confidence =
      offsets.length >= 3 ? 0.95 : offsets.length >= 2 ? 0.92 : 0.88;

    return makeDetected({
      confidence,
      data: Object.freeze({
        magicOffset: primary,
        magicOccurrenceCount: offsets.length,
        additionalOffsets: Object.freeze(offsets.slice(1)),
        sectorCount: SAVE_SECTOR_COUNT,
        sectorSizeBytes: SAVE_SECTOR_SIZE_BYTES,
        totalSaveSizeBytes: SAVE_DATA_TOTAL_SIZE_BYTES,
      }),
      evidence: [
        makeEvidence({
          kind: 'heuristic',
          summary: `Found SECTOR_FOOTER_MAGIC 0x${SAVE_SECTOR_FOOTER_MAGIC.toString(16).padStart(8, '0')} at offset 0x${primary.toString(16)} (${String(offsets.length)} total occurrence${offsets.length === 1 ? '' : 's'}); Gen-3 save format is ${String(SAVE_SECTOR_COUNT)} sectors × ${String(SAVE_SECTOR_SIZE_BYTES)} bytes = ${String(SAVE_DATA_TOTAL_SIZE_BYTES)} bytes total`,
          weight: 1.0,
          detail: {
            primaryOffset: primary,
            additionalOffsets: offsets.slice(1),
            occurrenceCount: offsets.length,
          },
        }),
      ],
    });
  },
};
