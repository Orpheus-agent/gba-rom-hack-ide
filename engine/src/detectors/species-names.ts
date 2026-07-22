/**
 * Species name table detector - Phase UW-3 / Category 3 substrate
 * (iter 59, UW-0-T6).
 *
 * Detects the Gen-3 `gSpeciesNames` table - a packed array of
 * 11-byte slots holding decoded species names ("BULBASAUR" vanilla
 * style, "Bulbasaur" CFRU style). Uses `findSpeciesNamesTable` from
 * `../species/species-names.js`, which tries pointer dereference at
 * the canonical BPRE 0x144 slot first and falls back to BULBASAUR/
 * Bulbasaur byte-pattern search.
 *
 * Slot counting uses byte-level slot validation (not regex on
 * decoded strings) so it cleanly handles vanilla FRLG's 412-slot
 * table AND CFRU forks' extended tables (CFRU stock = 1294 slots,
 * Radical Red 4.10 = 1376, Unbound 2.1.1.1 = 1294).
 *
 * Per PD 5: no FireRed/Emerald baked offsets; the pointer-dereference
 * path works universally on every BPRE/BPGE ROM (vanilla + every
 * known fork).
 *
 * Per PD 1: returns `not_detected` with reason when no plausible
 * table is found (ROM too small, no BULBASAUR signature, or
 * signature found but placeholder slot validation fails). Never
 * empty-success.
 *
 * Per PD 13: this detector is the canonical engine-side path; the
 * editor's `app/backend/src/rom-binary/species.ts` migrates to
 * consume this detector's output in UW-0-T7.
 */

import { makeDetected, makeEvidence, makeNotDetected } from '../detection/index.js';
import type { Detection } from '../detection/index.js';
import type { CoverageMap } from '../coverage/index.js';
import type { RomImage } from '../rom/loader.js';
import type { RomDetector } from './types.js';
import {
  SPECIES_NAME_SLOT_BYTES,
  SPECIES_NAMES_MIN_VALID_SLOTS,
  findSpeciesNamesTable,
  measureSpeciesNamesTable,
  readSpeciesNamesAt,
  validateSpeciesNames,
} from '../species/species-names.js';

export const SPECIES_NAMES_DETECTOR_ID = 'species_names';

export interface SpeciesNamesReport {
  /** File offset of the gSpeciesNames table (placeholder slot 0). */
  readonly tableOffset: number;
  /** Best-effort count of slots that decode as plausible species
   *  names (placeholder + real entries). May undercount a hack's
   *  true dex if later entries fall back to garbage. */
  readonly validSpeciesCount: number;
  /** First 16 decoded names for at-a-glance audit (placeholder at
   *  index 0; species #1 at index 1). */
  readonly sampleNames: ReadonlyArray<string>;
}

export const speciesNamesDetector: RomDetector<SpeciesNamesReport> = {
  id: SPECIES_NAMES_DETECTOR_ID,
  name: 'Species Names (Gen-3 gSpeciesNames signature scan)',
  phase: 8,
  detect(rom: RomImage, coverage: CoverageMap): Detection<SpeciesNamesReport> {
    if (rom.byteLength < SPECIES_NAMES_MIN_VALID_SLOTS * SPECIES_NAME_SLOT_BYTES) {
      return makeNotDetected({
        confidence: 1.0,
        evidence: [
          makeEvidence({
            kind: 'heuristic',
            summary: `ROM is ${String(rom.byteLength)} bytes - too small to host ≥${String(SPECIES_NAMES_MIN_VALID_SLOTS)} 11-byte species name slots`,
            weight: 1.0,
          }),
        ],
        reason: 'ROM too small to scan for Gen-3 gSpeciesNames table',
      });
    }

    const tableOffset = findSpeciesNamesTable(rom.bytes);
    if (tableOffset === null) {
      return makeNotDetected({
        confidence: 0.9,
        evidence: [
          makeEvidence({
            kind: 'heuristic',
            summary: `scanned ${String(rom.byteLength)} bytes for the gSpeciesNames signature (BULBASAUR at slot+11, IVYSAUR at slot+22, placeholder shape at slot 0) - no match`,
            weight: 1.0,
            detail: { romByteLength: rom.byteLength },
          }),
        ],
        reason:
          'No Gen-3 gSpeciesNames table found - ROM may be non-Pokémon, may have replaced the Bulbasaur/Ivysaur ordering, or may have removed those species (rare in Gen-3 hacks)',
      });
    }

    // Walk the table with the byte-level slot validator. Returns the
    // true table length in slots - i.e. (max species ID + 1), matching
    // CFRU's `NUM_SPECIES` macro. Unlike the prior decoded-string
    // walker, this rejects misaligned reads into the adjacent
    // `gMoveNames` table (vanilla FRLG's species table sits a few
    // bytes from `gMoveNames`; old code over-counted to ~744 because
    // the 11-byte stride into `gMoveNames`'s 13-byte slots produced
    // letter-rich-but-meaningless decodes).
    const shape = measureSpeciesNamesTable(rom.bytes, tableOffset);
    const validSpeciesCount = shape.totalSlotCount;

    // Pull a sample for the evidence + RT-1.5 lifter. Capped at the
    // table's true length; oversize requests would walk into garbage.
    const sampleNames = readSpeciesNamesAt(rom.bytes, tableOffset, validSpeciesCount);
    if (!validateSpeciesNames(sampleNames)) {
      return makeNotDetected({
        confidence: 0.75,
        evidence: [
          makeEvidence({
            kind: 'heuristic',
            summary: `gSpeciesNames signature matched at offset 0x${tableOffset.toString(16)} but validation rejected the table (most entries don't decode as species-name-shaped strings)`,
            weight: 1.0,
            detail: { tableOffset, probedCount: sampleNames.length },
          }),
        ],
        reason:
          'gSpeciesNames signature matched but the decoded table fails the species-name shape validator - likely a coincidental signature match rather than a real table',
      });
    }

    const tableByteLength = validSpeciesCount * SPECIES_NAME_SLOT_BYTES;
    try {
      coverage.addClassified({
        start: tableOffset,
        end: tableOffset + tableByteLength,
        probableClass: 'table',
        score: 0.9,
        provenance: `${SPECIES_NAMES_DETECTOR_ID}#gSpeciesNames`,
        note: `Gen-3 gSpeciesNames (${String(validSpeciesCount)} slots × 11 bytes)`,
      });
    } catch {
      // Overlap with another detector - skip coverage registration but still
      // return the detection.
    }

    // Confidence scales with validSpeciesCount per the species-system
    // detector's convention. Vanilla = 412; heavy hacks may exceed 700.
    const confidence =
      validSpeciesCount >= 400 ? 0.95 : validSpeciesCount >= 150 ? 0.9 : 0.8;

    return makeDetected({
      confidence,
      data: Object.freeze({
        tableOffset,
        validSpeciesCount,
        // RT-1.5: return ALL validated names. Pre-RT-1.5 the lifter
        // saw only 16 of vanilla's 412 species names.
        sampleNames: Object.freeze(sampleNames),
      }),
      evidence: [
        makeEvidence({
          kind: 'heuristic',
          summary: `Found gSpeciesNames at offset 0x${tableOffset.toString(16)} (${String(validSpeciesCount)} valid slots, ${String(tableByteLength)} bytes)`,
          weight: 1.0,
          detail: {
            tableOffset,
            validSpeciesCount,
            tableByteLength,
            nameSlotCount: shape.nameSlotCount,
            placeholderSlotCount: shape.placeholderSlotCount,
            sampleSpeciesNames: sampleNames.slice(1, 6),
          },
        }),
      ],
    });
  },
};
