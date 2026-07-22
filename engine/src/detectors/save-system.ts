/**
 * GBA save-system detector - Phase UW-2 / Category 2 (Game engine &
 * runtime systems) substrate.
 *
 * Every GBA cartridge that persists state uses one of four hardware-
 * standard save backends. Nintendo's SDK library (the Sappy save
 * library used by virtually all licensed Gen-3 carts AND every fan-hack
 * built atop the original codebase) emits an ASCII identifier string
 * into the ROM body so the emulator/flashcart can detect the save type
 * at boot:
 *
 *   - `SRAM_V112` / `SRAM_V113` - 32 KiB Static RAM (oldest)
 *   - `FLASH_V120..V128` (Atmel) - 64 KiB Atmel Flash
 *   - `FLASH_V120..V128` (Macronix) - 64 KiB Macronix Flash
 *   - `FLASH_V120..V129` (Sanyo) - 64 KiB Sanyo Flash
 *   - `FLASH512_V130..V134` / `FLASH1M_V102..V103` - 64 KiB / 128 KiB Flash
 *   - `EEPROM_V120..V124` - 512-byte or 8 KiB EEPROM
 *
 * Per PD 5: this detector is universal across all GBA carts (not
 * Pokémon-specific). Any cart with save functionality has one of
 * these strings somewhere in its ROM body. Carts that have NO save
 * support (a few arcade-style carts) honestly produce `not_detected`.
 *
 * Per PD 1: returns typed `not_detected` with reason when no save
 * string is present in the ROM body. Never empty-success.
 *
 * Per PD 12: when multiple save strings appear (rare - some hacks
 * embed multiple for testing), the detector reports the FIRST match
 * but the report carries `additionalMatches` so the editor's
 * inspector can surface all of them.
 *
 * Reference: GBATEK section "Cartridge Backup Media".
 */

import { makeDetected, makeEvidence, makeNotDetected } from '../detection/index.js';
import type { Detection } from '../detection/index.js';
import type { CoverageMap } from '../coverage/index.js';
import type { RomImage } from '../rom/loader.js';
import type { RomDetector } from './types.js';

export const SAVE_SYSTEM_DETECTOR_ID = 'save_system';

/** Hardware-defined save-backend families. */
export type SaveBackendFamily = 'SRAM' | 'FLASH' | 'EEPROM';

/** Per-string identifier with its declared backend + size hint. */
interface SaveStringDescriptor {
  /** ASCII string to search for. */
  readonly needle: string;
  /** Backend family. */
  readonly family: SaveBackendFamily;
  /** Declared backup size in bytes (per the Nintendo SDK convention). */
  readonly declaredSizeBytes: number;
}

/**
 * Known save-format strings emitted by the Nintendo SDK / Sappy save
 * library across the Gen-3 GBA cart era. Ordered by frequency in the
 * wild for slight perf benefit on early-match.
 */
export const SAVE_STRING_DESCRIPTORS: ReadonlyArray<SaveStringDescriptor> = Object.freeze([
  // Most common in Pokémon-family ROMs:
  { needle: 'FLASH1M_V103', family: 'FLASH', declaredSizeBytes: 128 * 1024 },
  { needle: 'FLASH1M_V102', family: 'FLASH', declaredSizeBytes: 128 * 1024 },
  { needle: 'FLASH512_V134', family: 'FLASH', declaredSizeBytes: 64 * 1024 },
  { needle: 'FLASH512_V133', family: 'FLASH', declaredSizeBytes: 64 * 1024 },
  { needle: 'FLASH512_V132', family: 'FLASH', declaredSizeBytes: 64 * 1024 },
  { needle: 'FLASH512_V131', family: 'FLASH', declaredSizeBytes: 64 * 1024 },
  { needle: 'FLASH512_V130', family: 'FLASH', declaredSizeBytes: 64 * 1024 },
  // Generic FLASH_V12x family (used in many earlier-era carts):
  { needle: 'FLASH_V129', family: 'FLASH', declaredSizeBytes: 64 * 1024 },
  { needle: 'FLASH_V128', family: 'FLASH', declaredSizeBytes: 64 * 1024 },
  { needle: 'FLASH_V127', family: 'FLASH', declaredSizeBytes: 64 * 1024 },
  { needle: 'FLASH_V126', family: 'FLASH', declaredSizeBytes: 64 * 1024 },
  { needle: 'FLASH_V125', family: 'FLASH', declaredSizeBytes: 64 * 1024 },
  { needle: 'FLASH_V124', family: 'FLASH', declaredSizeBytes: 64 * 1024 },
  { needle: 'FLASH_V123', family: 'FLASH', declaredSizeBytes: 64 * 1024 },
  { needle: 'FLASH_V122', family: 'FLASH', declaredSizeBytes: 64 * 1024 },
  { needle: 'FLASH_V121', family: 'FLASH', declaredSizeBytes: 64 * 1024 },
  { needle: 'FLASH_V120', family: 'FLASH', declaredSizeBytes: 64 * 1024 },
  // SRAM family (32 KiB):
  { needle: 'SRAM_V113', family: 'SRAM', declaredSizeBytes: 32 * 1024 },
  { needle: 'SRAM_V112', family: 'SRAM', declaredSizeBytes: 32 * 1024 },
  { needle: 'SRAM_V111', family: 'SRAM', declaredSizeBytes: 32 * 1024 },
  { needle: 'SRAM_V110', family: 'SRAM', declaredSizeBytes: 32 * 1024 },
  // EEPROM family (size depends on cart - most are 8 KiB):
  { needle: 'EEPROM_V124', family: 'EEPROM', declaredSizeBytes: 8 * 1024 },
  { needle: 'EEPROM_V122', family: 'EEPROM', declaredSizeBytes: 8 * 1024 },
  { needle: 'EEPROM_V121', family: 'EEPROM', declaredSizeBytes: 8 * 1024 },
  { needle: 'EEPROM_V120', family: 'EEPROM', declaredSizeBytes: 8 * 1024 },
]);

export interface SaveSystemReport {
  /** Identifier string actually found (e.g. "FLASH1M_V103"). */
  readonly identifier: string;
  /** Hardware family the identifier belongs to. */
  readonly family: SaveBackendFamily;
  /** Declared backup-medium size in bytes (per SDK convention). */
  readonly declaredSizeBytes: number;
  /** File offset where the identifier string was found. */
  readonly stringOffset: number;
  /** All matching identifier strings in this ROM (PD 12: surface every
   *  occurrence so the editor's inspector can show the full set). The
   *  primary identifier above is `matches[0]`. */
  readonly additionalMatches: ReadonlyArray<{
    readonly identifier: string;
    readonly family: SaveBackendFamily;
    readonly stringOffset: number;
  }>;
}

export const saveSystemDetector: RomDetector<SaveSystemReport> = {
  id: SAVE_SYSTEM_DETECTOR_ID,
  name: 'GBA Save System Identifier (Nintendo SDK / Sappy library)',
  phase: 2,
  detect(rom: RomImage, coverage: CoverageMap): Detection<SaveSystemReport> {
    if (rom.byteLength < 256) {
      return makeNotDetected({
        confidence: 1.0,
        evidence: [
          makeEvidence({
            kind: 'heuristic',
            summary: `ROM is ${String(rom.byteLength)} bytes - too small to host any save-format identifier string`,
            weight: 1.0,
          }),
        ],
        reason: 'ROM too small to scan for save-format identifier string',
      });
    }

    // Linear scan for each known identifier. We use Buffer.indexOf
    // (when input is a Buffer subclass) or a manual byte compare.
    const allMatches: Array<{
      identifier: string;
      family: SaveBackendFamily;
      stringOffset: number;
      declaredSizeBytes: number;
    }> = [];

    const bytes = rom.bytes;
    const haystack = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    for (const desc of SAVE_STRING_DESCRIPTORS) {
      const needle = Buffer.from(desc.needle, 'ascii');
      let from = 0;
      while (from < haystack.length) {
        const idx = haystack.indexOf(needle, from);
        if (idx < 0) break;
        allMatches.push({
          identifier: desc.needle,
          family: desc.family,
          stringOffset: idx,
          declaredSizeBytes: desc.declaredSizeBytes,
        });
        from = idx + needle.length;
      }
    }

    if (allMatches.length === 0) {
      return makeNotDetected({
        confidence: 0.95,
        evidence: [
          makeEvidence({
            kind: 'heuristic',
            summary: `scanned ${String(rom.byteLength)} bytes for ${String(SAVE_STRING_DESCRIPTORS.length)} known save-format identifier strings - none found`,
            weight: 1.0,
            detail: {
              romByteLength: rom.byteLength,
              knownStringsScanned: SAVE_STRING_DESCRIPTORS.length,
            },
          }),
        ],
        reason:
          'No GBA save-format identifier string found - ROM may be a save-less cart (rare for Pokémon-family) OR a hack that stripped the identifier (rare)',
      });
    }

    // Sort by stringOffset ascending; primary identifier is the
    // first-encountered match.
    allMatches.sort((a, b) => a.stringOffset - b.stringOffset);
    const primary = allMatches[0]!;
    const additionalMatches = allMatches.slice(1).map((m) => ({
      identifier: m.identifier,
      family: m.family,
      stringOffset: m.stringOffset,
    }));

    // Register the primary identifier string region as `string`
    // coverage. We don't register additional matches (would create
    // overlap noise); the report carries the full list for the editor.
    const stringByteLength = primary.identifier.length;
    try {
      coverage.addClassified({
        start: primary.stringOffset,
        end: primary.stringOffset + stringByteLength,
        probableClass: 'string',
        score: 1.0,
        provenance: `${SAVE_SYSTEM_DETECTOR_ID}#${primary.identifier}@0x${primary.stringOffset.toString(16)}`,
        note: `GBA save-format identifier ("${primary.identifier}", ${primary.family} ${(primary.declaredSizeBytes / 1024).toFixed(0)} KiB)`,
      });
    } catch {
      // Overlap with another detector - skip coverage registration.
    }

    return makeDetected({
      confidence: 0.95,
      data: Object.freeze({
        identifier: primary.identifier,
        family: primary.family,
        declaredSizeBytes: primary.declaredSizeBytes,
        stringOffset: primary.stringOffset,
        additionalMatches: Object.freeze(additionalMatches),
      }),
      evidence: [
        makeEvidence({
          kind: 'heuristic',
          summary: `Found GBA save-format identifier "${primary.identifier}" at offset 0x${primary.stringOffset.toString(16)} (${primary.family} backend, ${(primary.declaredSizeBytes / 1024).toFixed(0)} KiB declared)${additionalMatches.length > 0 ? ` + ${String(additionalMatches.length)} additional match(es)` : ''}`,
          weight: 1.0,
          detail: {
            identifier: primary.identifier,
            family: primary.family,
            declaredSizeBytes: primary.declaredSizeBytes,
            stringOffset: primary.stringOffset,
            additionalMatchCount: additionalMatches.length,
          },
        }),
      ],
    });
  },
};
