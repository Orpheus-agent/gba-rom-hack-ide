/**
 * Gen-3 LZ77-pointer-tables detector - Phase UW-3 / Category 8
 * (iter 89 / UW-3-T8).
 *
 * Detects flat u32 pointer arrays where each entry resolves to an
 * LZ77-compressed graphics block (header byte 0x10). Covers (without
 * distinguishing): gMonFrontPicTable / gMonBackPicTable /
 * gTrainerFrontPicTable / gTrainerBackPicTable / battle-background
 * pointer tables / overworld sprite arrays / many hack-introduced
 * graphics arrays.
 *
 * Per PD 16: tables aren't named - the editor surfaces each table's
 * sample {targetOffset, decompressedSize} entries so operators can
 * identify by typical sprite sizes (~2 KiB Pokémon sprite vs ~8 KiB
 * tileset etc.).
 *
 * Per PD 5: structural - 4-byte stride anchor scan + LZ77-header
 * byte-0 validation; works on any Gen-3 cart from vanilla to heavy
 * hacks with relocated/expanded sprite tables.
 *
 * Per PD 1: typed `not_detected` for ROM-too-small / no-tables paths.
 *
 * Per PD 13: editor auto-surfaces via existing PD-13 conduit.
 */

import { makeDetected, makeEvidence, makeNotDetected } from '../detection/index.js';
import type { Detection } from '../detection/index.js';
import type { CoverageMap } from '../coverage/index.js';
import type { RomImage } from '../rom/loader.js';
import type { RomDetector } from './types.js';
import {
  LZ77_POINTER_TABLE_MIN_VALID_ENTRIES,
  findLz77PointerTables,
  type Lz77PointerTable,
} from '../graphics/lz77-pointer-tables.js';

export const LZ77_POINTER_TABLES_DETECTOR_ID = 'lz77_pointer_tables';

export interface Lz77PointerTablesReport {
  readonly tableCount: number;
  readonly tables: ReadonlyArray<Lz77PointerTable>;
  readonly totalPointerEntries: number;
  /** Sample preview strings for the LARGEST table - formatted as
   *  '0xOFFSET (decompressed=N bytes)' so the editor's
   *  DetectedSubsystemSampleNames surface shows immediately useful
   *  per-entry detail (PD 12 + PD 16). */
  readonly sampleNames: ReadonlyArray<string>;
}

export const lz77PointerTablesDetector: RomDetector<Lz77PointerTablesReport> = {
  id: LZ77_POINTER_TABLES_DETECTOR_ID,
  name: 'LZ77 Pointer Tables (Gen-3 graphics-array structural scan)',
  phase: 8,
  detect(rom: RomImage, coverage: CoverageMap): Detection<Lz77PointerTablesReport> {
    const minBytes = 0xc0 + LZ77_POINTER_TABLE_MIN_VALID_ENTRIES * 4;
    if (rom.byteLength < minBytes) {
      return makeNotDetected({
        confidence: 1.0,
        evidence: [
          makeEvidence({
            kind: 'heuristic',
            summary: `ROM is ${String(rom.byteLength)} bytes - too small to host a ≥${String(LZ77_POINTER_TABLE_MIN_VALID_ENTRIES)}-entry LZ77-pointer table past the cartridge header`,
            weight: 1.0,
          }),
        ],
        reason: 'ROM too small to scan for Gen-3 LZ77-pointer tables',
      });
    }

    const tables = findLz77PointerTables(rom.bytes);
    if (tables.length === 0) {
      return makeNotDetected({
        confidence: 0.85,
        evidence: [
          makeEvidence({
            kind: 'heuristic',
            summary: `scanned ${String(rom.byteLength)} bytes at 4-byte stride for runs of ≥${String(LZ77_POINTER_TABLE_MIN_VALID_ENTRIES)} u32 pointers each resolving to an LZ77 header (byte 0 = 0x10 + valid u24 decompressed size) - none found`,
            weight: 1.0,
            detail: { romByteLength: rom.byteLength },
          }),
        ],
        reason:
          'No Gen-3 LZ77-pointer tables found - either non-Pokémon ROM, graphics engine uses non-LZ77 compression, or all sprite arrays are dynamically located',
      });
    }

    // Register each table's bytes in the coverage map.
    let totalPointerEntries = 0;
    for (const t of tables) {
      totalPointerEntries += t.entryCount;
      try {
        coverage.addClassified({
          start: t.tableOffset,
          end: t.tableEndExclusive,
          probableClass: 'pointer-network',
          score: 0.9,
          provenance: `${LZ77_POINTER_TABLES_DETECTOR_ID}#lz77_ptr_table`,
          note: `Gen-3 LZ77-pointer table (${String(t.entryCount)} entries × 4 bytes; each → compressed graphics)`,
        });
      } catch {
        // Overlap - skip.
      }
    }

    // Build sampleNames from the LARGEST table's first 8 entries.
    const largest = tables[0]!;
    const sampleNames: ReadonlyArray<string> = Object.freeze(
      largest.samplePreview.map(
        (e) =>
          `0x${e.targetOffset.toString(16).padStart(6, '0')} (decompressed=${String(e.decompressedSize)} bytes)`,
      ),
    );

    // Confidence: ≥3 tables AND largest ≥100 entries → vanilla-class.
    const confidence =
      tables.length >= 3 && largest.entryCount >= 100
        ? 0.95
        : tables.length >= 2 && largest.entryCount >= 50
          ? 0.9
          : 0.85;

    const summaryLine =
      `Found ${String(tables.length)} LZ77-pointer table(s); largest: ` +
      `${String(largest.entryCount)} entries at offset 0x${largest.tableOffset.toString(16)}`;

    return makeDetected({
      confidence,
      data: Object.freeze({
        tableCount: tables.length,
        tables,
        totalPointerEntries,
        sampleNames,
      }),
      evidence: [
        makeEvidence({
          kind: 'heuristic',
          summary: summaryLine,
          weight: 1.0,
          detail: {
            tableCount: tables.length,
            totalPointerEntries,
            largestTableOffset: largest.tableOffset,
            largestTableEntryCount: largest.entryCount,
            firstThreeDecompressedSizes: largest.samplePreview
              .slice(0, 3)
              .map((e) => e.decompressedSize),
          },
        }),
      ],
    });
  },
};
