/**
 * Gen-3 gPokedexEntries detector - Phase UW-3 / Category 3 substrate
 * (iter 82 / UW-3-T1).
 *
 * Detects the gPokedexEntries table - an array of 32-byte PokedexEntry
 * structs holding categoryName / height / weight / description-pointer
 * / sprite-scale data per National Dex species. Combined with the
 * existing species-names + species-system + base-stats / evolutions /
 * learnsets / TM-HM detectors, this is the canonical Cat 3 substrate
 * for ROM-side species inspection.
 *
 * Per PD 5: structural - works on any Gen-3 cart that retains the
 * canonical 32-byte struct layout.
 *
 * Per PD 1: typed `not_detected` when ROM too small or no run found.
 *
 * Per PD 12: returns first N decoded sample category names + first
 * record offset so the editor can preview the data.
 *
 * Advances:
 *   - Category 3 (Species content) - FIRST new UW-3 substrate.
 *   - Category 7 (Dialogue/text) - Pokédex flavor text pointers
 *     surfaced (descriptions live behind these pointers).
 */

import { makeDetected, makeEvidence, makeNotDetected } from '../detection/index.js';
import type { Detection } from '../detection/index.js';
import type { CoverageMap } from '../coverage/index.js';
import type { RomImage } from '../rom/loader.js';
import type { RomDetector } from './types.js';
import {
  POKEDEX_ENTRY_STRUCT_SIZE_BYTES,
  POKEDEX_SCAN_MIN_RECORDS,
  parsePokedexEntry,
  scanPokedexTable,
  type PokedexTable,
} from '../species/index.js';
import { GBA_ROM_BASE_ADDRESS, GBA_ROM_END_ADDRESS_EXCLUSIVE } from '../pointers/index.js';
import { decodeString, STRING_TERMINATOR } from '../text/index.js';

export const POKEDEX_SYSTEM_DETECTOR_ID = 'pokedex_system';

const POKEDEX_SAMPLE_NAME_COUNT = 16;
/** Max bytes to scan when decoding a single Pokédex flavor text via
 *  descriptionPtr. Vanilla entries are ~120-180 chars; cap at 256 to
 *  give headroom for heavy hacks with expanded flavor text. */
const POKEDEX_FLAVOR_TEXT_MAX_LEN = 256;
/** Truncation length for combined "CATEGORY - flavor snippet" preview
 *  strings surfaced via sampleNames. */
const POKEDEX_FLAVOR_TEXT_SNIPPET_LEN = 60;

export interface PokedexSystemReport {
  readonly pokedexTable: PokedexTable;
  readonly entryCount: number;
  /** Sampled category names from first N entries (placeholder + early
   *  species). */
  readonly sampleCategoryNames: ReadonlyArray<string>;
  /** Iter 91 (UW-3-T10) - decoded flavor texts from first N entries'
   *  descriptionPtr targets. Empty strings for entries whose
   *  descriptionPtr is null OR out-of-ROM. */
  readonly sampleFlavorTexts: ReadonlyArray<string>;
  /** Iter 91 - formatted preview strings combining category name +
   *  flavor-text snippet for the editor's PD-13 sampleNames lift conduit
   *  (DetectedSubsystemSampleNames component). Format:
   *  `"CATEGORY - flavor snippet (first 60 chars)"` per entry. */
  readonly sampleNames: ReadonlyArray<string>;
  /** Phase O.2 - per-entry file offset of the 32-byte PokedexEntry
   *  struct (one per sample, aligned with sampleCategoryNames /
   *  sampleFlavorTexts indices). Used by the lifter to stash a
   *  write-anchor on each PokedexEntryRecord so the editor can patch
   *  the category-name slot in place. */
  readonly sampleEntryFileOffsets: ReadonlyArray<number>;
  /** Phase O.2 - per-entry file offset of the flavor-text bytes
   *  (descriptionPtr − GBA_ROM_BASE_ADDRESS), or -1 when the pointer
   *  is null / out-of-ROM. Aligned with the same sample indices. */
  readonly sampleDescriptionFileOffsets: ReadonlyArray<number>;
}

export const pokedexSystemDetector: RomDetector<PokedexSystemReport> = {
  id: POKEDEX_SYSTEM_DETECTOR_ID,
  name: 'Pokédex System (Gen-3 gPokedexEntries scanner)',
  phase: 8,
  detect(rom: RomImage, coverage: CoverageMap): Detection<PokedexSystemReport> {
    const minBytes = 0xc0 + POKEDEX_SCAN_MIN_RECORDS * POKEDEX_ENTRY_STRUCT_SIZE_BYTES;
    if (rom.byteLength < minBytes) {
      return makeNotDetected({
        confidence: 1.0,
        evidence: [
          makeEvidence({
            kind: 'heuristic',
            summary: `ROM is ${String(rom.byteLength)} bytes - too small to host a ≥${String(POKEDEX_SCAN_MIN_RECORDS)}-record gPokedexEntries table (needs ≥${String(minBytes)} bytes after cartridge header)`,
            weight: 1.0,
          }),
        ],
        reason: 'ROM too small to scan for Gen-3 gPokedexEntries table',
      });
    }

    const table = scanPokedexTable(rom.bytes);
    if (table === null) {
      return makeNotDetected({
        confidence: 0.85,
        evidence: [
          makeEvidence({
            kind: 'heuristic',
            summary: `scanned ${String(rom.byteLength)} bytes for a run of ≥${String(POKEDEX_SCAN_MIN_RECORDS)} 32-byte PokedexEntry records (categoryName ≥3 A-Z chars, height ≤999, weight ≤9999, description ptr zero-or-ROM-space) - none found`,
            weight: 1.0,
            detail: {
              romByteLength: rom.byteLength,
              structSize: POKEDEX_ENTRY_STRUCT_SIZE_BYTES,
              minRecords: POKEDEX_SCAN_MIN_RECORDS,
            },
          }),
        ],
        reason:
          'No Gen-3 gPokedexEntries table found - either non-Pokémon ROM, Pokédex system rewritten, or table shorter than min-records threshold',
      });
    }

    // Sample first N category names for the editor preview surface +
    // (iter 91) decode each entry's flavor text via descriptionPtr.
    const sampleCategoryNames: string[] = [];
    const sampleFlavorTexts: string[] = [];
    const sampleNames: string[] = [];
    const sampleEntryFileOffsets: number[] = [];
    const sampleDescriptionFileOffsets: number[] = [];
    const namesCap = Math.min(POKEDEX_SAMPLE_NAME_COUNT, table.entryCount);
    for (let i = 0; i < namesCap; i++) {
      const entryFileOffset = table.tableStart + i * POKEDEX_ENTRY_STRUCT_SIZE_BYTES;
      const r = parsePokedexEntry(rom.bytes, entryFileOffset);
      if (!r.ok) continue;
      const categoryName = r.value.categoryName;
      sampleCategoryNames.push(categoryName);
      sampleEntryFileOffsets.push(entryFileOffset);
      // Follow descriptionPtr to decode flavor text. NULL ptr OR
      // out-of-ROM ptr (e.g. test ROMs pointing at fixed offsets that
      // don't exist) → empty flavor text. Real ROMs almost always have
      // valid pointers here.
      const ptr = r.value.descriptionPtr;
      let flavorText = '';
      let descriptionFileOffset = -1;
      if (
        ptr !== 0 &&
        ptr >= GBA_ROM_BASE_ADDRESS &&
        ptr < GBA_ROM_END_ADDRESS_EXCLUSIVE
      ) {
        const targetOffset = ptr - GBA_ROM_BASE_ADDRESS;
        if (targetOffset >= 0 && targetOffset < rom.byteLength) {
          // Verify terminator is reachable within the cap before
          // accepting the decode - guards against runaway reads on
          // malformed pointers.
          let foundTerminator = false;
          const scanLimit = Math.min(
            targetOffset + POKEDEX_FLAVOR_TEXT_MAX_LEN,
            rom.byteLength,
          );
          for (let j = targetOffset; j < scanLimit; j++) {
            if (rom.bytes[j] === STRING_TERMINATOR) {
              foundTerminator = true;
              break;
            }
          }
          if (foundTerminator) {
            flavorText = decodeString(rom.bytes, targetOffset, POKEDEX_FLAVOR_TEXT_MAX_LEN);
            descriptionFileOffset = targetOffset;
          }
        }
      }
      sampleFlavorTexts.push(flavorText);
      sampleDescriptionFileOffsets.push(descriptionFileOffset);
      // Build combined sample-name string. Trim flavor text + collapse
      // any '?' placeholder runs that signal undecoded bytes.
      const snippet =
        flavorText.length > POKEDEX_FLAVOR_TEXT_SNIPPET_LEN
          ? `${flavorText.slice(0, POKEDEX_FLAVOR_TEXT_SNIPPET_LEN)}…`
          : flavorText;
      sampleNames.push(
        snippet.length > 0 ? `${categoryName} - ${snippet}` : categoryName,
      );
    }

    try {
      coverage.addClassified({
        start: table.tableStart,
        end: table.tableEndExclusive,
        probableClass: 'table',
        score: 0.92,
        provenance: `${POKEDEX_SYSTEM_DETECTOR_ID}#gPokedexEntries`,
        note: `Gen-3 gPokedexEntries (${String(table.entryCount)} entries × ${String(POKEDEX_ENTRY_STRUCT_SIZE_BYTES)} bytes)`,
      });
    } catch {
      // Overlap - skip.
    }

    // Confidence: vanilla FRLG has 411 entries (Hoenn dex + national).
    // Anything ≥300 is essentially certainly real.
    const confidence =
      table.entryCount >= 300 ? 0.95 : table.entryCount >= 200 ? 0.92 : 0.88;

    const decodedFlavorCount = sampleFlavorTexts.filter((t) => t.length > 0).length;
    return makeDetected({
      confidence,
      data: Object.freeze({
        pokedexTable: table,
        entryCount: table.entryCount,
        sampleCategoryNames: Object.freeze(sampleCategoryNames),
        sampleFlavorTexts: Object.freeze(sampleFlavorTexts),
        sampleNames: Object.freeze(sampleNames),
        sampleEntryFileOffsets: Object.freeze(sampleEntryFileOffsets),
        sampleDescriptionFileOffsets: Object.freeze(sampleDescriptionFileOffsets),
      }),
      evidence: [
        makeEvidence({
          kind: 'heuristic',
          summary: `Found gPokedexEntries at offset 0x${table.tableStart.toString(16)} (${String(table.entryCount)} entries, ${String(table.tableEndExclusive - table.tableStart)} bytes; decoded ${String(decodedFlavorCount)}/${String(sampleFlavorTexts.length)} sample flavor texts)`,
          weight: 1.0,
          detail: {
            tableStart: table.tableStart,
            tableEndExclusive: table.tableEndExclusive,
            entryCount: table.entryCount,
            sampleCategoryNames: sampleCategoryNames.slice(0, 5),
            sampleFlavorTextSnippets: sampleFlavorTexts
              .slice(0, 3)
              .map((t) => (t.length > 60 ? `${t.slice(0, 60)}…` : t)),
          },
        }),
      ],
    });
  },
};
