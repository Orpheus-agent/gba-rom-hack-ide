/**
 * Gen-3 text-pointer-tables detector - Phase UW-3 / Categories 4 + 7
 * (iter 88 / UW-3-T7).
 *
 * Detects all text-pointer tables in the ROM - runs of u32 pointers
 * to Gen-3-encoded text strings. Covers (without distinguishing):
 *   - gMoveDescriptions  (Cat 4 moves)
 *   - gAbilityDescriptions (Cat 4 abilities)
 *   - gItemDescriptions (Cat 4 items)
 *   - Pokédex description arrays (Cat 3/7)
 *   - dialogue / sign / NPC text pointer tables (Cat 7)
 *
 * Per PD 16: tables aren't named - the editor surfaces the sample
 * decoded strings so operators can identify each table by content
 * (e.g. "Powers up the holder's Bug moves" → ability descriptions;
 * "An item to be held by a Pokémon" → item descriptions).
 *
 * Per PD 5: 4-byte stride structural scan with anchor confirmation;
 * works on any Gen-3 cart with the universal u32-pointer-to-text
 * layout, incl. heavy hacks where tables are relocated/expanded.
 *
 * Per PD 1: typed `not_detected` for ROM-too-small / no-tables paths.
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
  TEXT_POINTER_TABLE_MIN_VALID_ENTRIES,
  findTextPointerTables,
  type TextPointerTable,
} from '../text/text-pointer-tables.js';

export const TEXT_POINTER_TABLES_DETECTOR_ID = 'text_pointer_tables';

export interface TextPointerTablesReport {
  /** Total tables found across the scan (capped at MAX_TABLES_PER_SCAN). */
  readonly tableCount: number;
  /** All detected tables, sorted by entryCount desc (largest first). */
  readonly tables: ReadonlyArray<TextPointerTable>;
  /** Total u32 pointer entries across every detected table. */
  readonly totalPointerEntries: number;
  /** Decoded strings from the LARGEST table (first 8) - surfaced via
   *  the standard sampleNames lift so the editor renders them as
   *  inspectable identification context (PD 16). Iter 90 (UW-3-T9)
   *  prefixes each entry with the LARGEST table's probable kind so
   *  operators see "[ability_descriptions] Powers up Bug moves." */
  readonly sampleNames: ReadonlyArray<string>;
  /** Iter 90 (UW-3-T9) - per-kind table count breakdown. e.g.
   *  `{ ability_descriptions: 1, item_descriptions: 1, ... }`. */
  readonly tableKindBreakdown: Readonly<Record<string, number>>;
}

export const textPointerTablesDetector: RomDetector<TextPointerTablesReport> = {
  id: TEXT_POINTER_TABLES_DETECTOR_ID,
  name: 'Text Pointer Tables (Gen-3 u32-pointer-to-text structural scan)',
  phase: 7,
  detect(rom: RomImage, coverage: CoverageMap): Detection<TextPointerTablesReport> {
    const minBytes = 0xc0 + TEXT_POINTER_TABLE_MIN_VALID_ENTRIES * 4;
    if (rom.byteLength < minBytes) {
      return makeNotDetected({
        confidence: 1.0,
        evidence: [
          makeEvidence({
            kind: 'heuristic',
            summary: `ROM is ${String(rom.byteLength)} bytes - too small to host a ≥${String(TEXT_POINTER_TABLE_MIN_VALID_ENTRIES)}-entry text-pointer table past the cartridge header`,
            weight: 1.0,
          }),
        ],
        reason: 'ROM too small to scan for Gen-3 text-pointer tables',
      });
    }

    const tables = findTextPointerTables(rom.bytes);
    if (tables.length === 0) {
      return makeNotDetected({
        confidence: 0.85,
        evidence: [
          makeEvidence({
            kind: 'heuristic',
            summary: `scanned ${String(rom.byteLength)} bytes at 4-byte stride for runs of ≥${String(TEXT_POINTER_TABLE_MIN_VALID_ENTRIES)} u32 pointers each resolving to Gen-3 text with ≥3 printable chars + 0xFF terminator within 256 bytes (10-entry anchor confirmation) - none found`,
            weight: 1.0,
            detail: { romByteLength: rom.byteLength },
          }),
        ],
        reason:
          'No Gen-3 text-pointer tables found - either non-Pokémon ROM, text system rewritten with non-pointer layout, or text in custom non-Gen-3 codec',
      });
    }

    // Register each table's bytes in the coverage map. Largest table
    // first so the score reflects the primary content.
    let totalPointerEntries = 0;
    for (const t of tables) {
      totalPointerEntries += t.entryCount;
      try {
        coverage.addClassified({
          start: t.tableOffset,
          end: t.tableEndExclusive,
          probableClass: 'pointer-network',
          score: 0.9,
          provenance: `${TEXT_POINTER_TABLES_DETECTOR_ID}#text_ptr_table`,
          note: `Gen-3 text-pointer table (${String(t.entryCount)} entries × 4 bytes)`,
        });
      } catch {
        // Overlap - skip; the table is still surfaced via Detection.
      }
    }

    // Lift sampleNames from the LARGEST table (tables[0] per
    // entryCount-desc sort in findTextPointerTables). Iter 90 prefixes
    // each entry with the largest table's probable kind so operators
    // see "[ability_descriptions] Powers up Bug moves." (PD 16).
    const largest = tables[0]!;
    const largestKindLabel = `[${largest.classification.kind}]`;
    const sampleNames: ReadonlyArray<string> = Object.freeze(
      largest.sampleStrings.map((s) => `${largestKindLabel} ${s}`),
    );

    // Per-kind breakdown for editor / report display.
    const tableKindBreakdown: Record<string, number> = {};
    for (const t of tables) {
      const k = t.classification.kind;
      tableKindBreakdown[k] = (tableKindBreakdown[k] ?? 0) + 1;
    }

    // Confidence scales with how many tables we found AND how big the
    // largest is. ≥3 tables AND largest ≥100 entries → vanilla-class
    // confidence; smaller hauls get lower confidence per PD 3.
    const confidence =
      tables.length >= 3 && largest.entryCount >= 100
        ? 0.95
        : tables.length >= 2 && largest.entryCount >= 50
          ? 0.9
          : 0.85;

    const breakdownLine = Object.entries(tableKindBreakdown)
      .map(([k, n]) => `${String(n)}× ${k}`)
      .join(', ');
    const summaryLine =
      `Found ${String(tables.length)} text-pointer table(s) (${breakdownLine}); ` +
      `largest: ${String(largest.entryCount)} entries at offset 0x${largest.tableOffset.toString(16)} ` +
      `→ ${largest.classification.kind} (conf ${largest.classification.confidence.toFixed(2)})`;

    return makeDetected({
      confidence,
      data: Object.freeze({
        tableCount: tables.length,
        tables,
        totalPointerEntries,
        sampleNames,
        tableKindBreakdown: Object.freeze(tableKindBreakdown),
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
            largestTableKind: largest.classification.kind,
            largestTableKindConfidence: largest.classification.confidence,
            tableKindBreakdown,
            firstThreeSamplesFromLargest: largest.sampleStrings.slice(0, 3),
          },
        }),
      ],
    });
  },
};
