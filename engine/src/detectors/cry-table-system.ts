/**
 * Gen-3 gCryTable detector - Phase UW-3 / Category 9 substrate
 * (iter 87 / UW-3-T6).
 *
 * Detects the SAPPY-engine Pokémon cry table - the array of 12-byte
 * ToneData structs (one per species) that maps each species id to its
 * cry's PCM wave data + envelope parameters. Cat 9 (audio) advance:
 * complements the existing audio-system / song-table detectors with
 * the species-level cry surface.
 *
 * Per PD 5: structural anchor (10 consecutive valid 12-byte entries
 * with type ∈ {0x00,0x80} + ROM-space wav pointer + 7-bit envelope
 * bytes) + forward walk; works on any Gen-3 cart with the canonical
 * ToneData layout incl. heavy-hack expanded-dex carts (≥1000 species).
 *
 * Per PD 1: typed `not_detected` for ROM-too-small / no-anchor paths.
 *
 * Per PD 13: editor auto-surfaces via existing WorkspaceFeatureDetection
 * conduit (subsystemIds + frontend label).
 */

import { makeDetected, makeEvidence, makeNotDetected } from '../detection/index.js';
import type { Detection } from '../detection/index.js';
import type { CoverageMap } from '../coverage/index.js';
import type { RomImage } from '../rom/loader.js';
import type { RomDetector } from './types.js';
import {
  CRY_ENTRY_SIZE_BYTES,
  CRY_TABLE_MIN_VALID_ENTRIES,
  findCryTable,
  type CryTableEntryView,
} from '../audio/cry-table.js';

export const CRY_TABLE_DETECTOR_ID = 'cry_table_system';

export interface CryTableSystemReport {
  readonly tableOffset: number;
  readonly entryCount: number;
  readonly tableByteLength: number;
  /** First 16 entries as a preview with wav pointer file offsets. */
  readonly samplePreview: ReadonlyArray<CryTableEntryView>;
  /** First 16 wav file offsets, formatted as 0x-hex strings - surfaced
   *  via the standard `sampleNames` lift so the editor can show them
   *  in DetectedSubsystemSampleNames without a custom UI surface. */
  readonly sampleNames: ReadonlyArray<string>;
}

export const cryTableDetector: RomDetector<CryTableSystemReport> = {
  id: CRY_TABLE_DETECTOR_ID,
  name: 'Cry Table (Gen-3 gCryTable structural scan)',
  phase: 9,
  detect(rom: RomImage, coverage: CoverageMap): Detection<CryTableSystemReport> {
    const minBytes = 0xc0 + CRY_TABLE_MIN_VALID_ENTRIES * CRY_ENTRY_SIZE_BYTES;
    if (rom.byteLength < minBytes) {
      return makeNotDetected({
        confidence: 1.0,
        evidence: [
          makeEvidence({
            kind: 'heuristic',
            summary: `ROM is ${String(rom.byteLength)} bytes - too small to host ≥${String(CRY_TABLE_MIN_VALID_ENTRIES)} 12-byte cry-table entries past the cartridge header`,
            weight: 1.0,
          }),
        ],
        reason: 'ROM too small to scan for Gen-3 gCryTable',
      });
    }

    const located = findCryTable(rom.bytes);
    if (located === null) {
      return makeNotDetected({
        confidence: 0.85,
        evidence: [
          makeEvidence({
            kind: 'heuristic',
            summary: `scanned ${String(rom.byteLength)} bytes at 4-byte stride for a run of ≥${String(CRY_TABLE_MIN_VALID_ENTRIES)} 12-byte ToneData entries each with type∈{0x00,0x80} + valid ROM-space wav pointer + 7-bit envelope (10-entry anchor confirmation) - none found`,
            weight: 1.0,
            detail: { romByteLength: rom.byteLength },
          }),
        ],
        reason:
          'No Gen-3 gCryTable found - either non-Pokémon ROM, audio engine rewritten, or cry table heavily customized',
      });
    }

    const tableByteLength = located.validEntries * CRY_ENTRY_SIZE_BYTES;
    try {
      coverage.addClassified({
        start: located.tableOffset,
        end: located.tableEndExclusive,
        probableClass: 'table',
        score: 0.92,
        provenance: `${CRY_TABLE_DETECTOR_ID}#gCryTable`,
        note: `Gen-3 gCryTable (${String(located.validEntries)} species × ${String(CRY_ENTRY_SIZE_BYTES)} bytes)`,
      });
    } catch {
      // Overlap with prior detection - skip coverage entry; the table
      // is still surfaced via the Detection itself.
    }

    // Build sampleNames: first 16 wav offsets as hex strings. Editor's
    // DetectedSubsystemSampleNames consumes this via the standard lift.
    const sampleNames: ReadonlyArray<string> = Object.freeze(
      located.samplePreview.map((e) =>
        e.wavOffset === null
          ? `(silent)`
          : `0x${e.wavOffset.toString(16).padStart(6, '0')}`,
      ),
    );

    // Confidence: vanilla Gen-3 ~411 species; expansion hacks ~1000+.
    // ≥300 → 0.95 (vanilla-class) / ≥200 → 0.92 / ≥150 → 0.88 floor.
    const confidence =
      located.validEntries >= 300
        ? 0.95
        : located.validEntries >= 200
          ? 0.92
          : 0.88;

    return makeDetected({
      confidence,
      data: Object.freeze({
        tableOffset: located.tableOffset,
        entryCount: located.validEntries,
        tableByteLength,
        samplePreview: located.samplePreview,
        sampleNames,
      }),
      evidence: [
        makeEvidence({
          kind: 'heuristic',
          summary: `Found gCryTable at offset 0x${located.tableOffset.toString(16)} (${String(located.validEntries)} entries × ${String(CRY_ENTRY_SIZE_BYTES)} bytes = ${String(tableByteLength)} bytes)`,
          weight: 1.0,
          detail: {
            tableOffset: located.tableOffset,
            entryCount: located.validEntries,
            firstFiveWavOffsets: located.samplePreview
              .slice(0, 5)
              .map((e) => (e.wavOffset === null ? null : e.wavOffset)),
          },
        }),
      ],
    });
  },
};
