/**
 * Gen-3 gMultichoiceLists detector - Phase O.3.
 *
 * Detects the gMultichoiceLists table referenced by the `multichoice`
 * script opcode (0x70). Each script multichoice instruction carries a
 * u8 listId that indexes into this table; each table entry points at a
 * MenuAction[] array whose strings are the visible choices ("YES",
 * "NO", "PIKACHU", etc.).
 *
 * Struct layout:
 *
 *   gMultichoiceLists[]: array of 8-byte entries
 *     u32 listPtr;      // ROM pointer to MenuAction[count]
 *     u8  count;        // number of choices (2..16 typical)
 *     u8  pad[3];       // zero-pad to 8-byte alignment
 *
 *   MenuAction (8 bytes):
 *     u32 textPtr;      // ROM pointer to a Gen-3 string
 *     u32 funcPtr;      // unused for editor purposes
 *
 * Per PD 5: structural - no magic constants. The anchor is a run of
 * plausible 8-byte entries where every listPtr points into ROM and the
 * pad bytes are exactly zero. Heuristic, but matches vanilla FRLG
 * (gMultichoiceLists @ 0x82FDA0, 62 entries) + Emerald + RSE.
 */

import { makeDetected, makeEvidence, makeNotDetected } from '../detection/index.js';
import type { Detection } from '../detection/index.js';
import type { CoverageMap } from '../coverage/index.js';
import type { RomImage } from '../rom/loader.js';
import type { RomDetector } from './types.js';
import {
  GBA_ROM_BASE_ADDRESS,
  GBA_ROM_END_ADDRESS_EXCLUSIVE,
} from '../pointers/index.js';
import { decodeString, STRING_TERMINATOR } from '../text/index.js';

export const MULTICHOICE_LISTS_SYSTEM_DETECTOR_ID = 'multichoice_lists_system';

/** Size in bytes of one gMultichoiceLists entry. */
const MULTICHOICE_LIST_ENTRY_BYTES = 8;
/** Size in bytes of one MenuAction. */
const MENU_ACTION_BYTES = 8;
/** Minimum plausible choices per list (e.g. "yes / no" is 2). */
const MIN_CHOICES_PER_LIST = 2;
/** Maximum plausible choices per list. */
const MAX_CHOICES_PER_LIST = 16;
/** Minimum consecutive valid entries to anchor a detection. */
const MIN_ANCHOR_RUN = 10;
/** Maximum table entries we'll walk after the anchor. */
const MAX_TABLE_ENTRIES = 256;
/** Maximum bytes to walk when decoding a single choice string. */
const MAX_CHOICE_TEXT_BYTES = 64;
/** Number of full lists to sample-decode for the editor preview. */
const SAMPLE_LIST_COUNT = 8;

export interface MultichoiceChoiceReport {
  /** Index within the parent list (0-based). */
  readonly choiceIndex: number;
  /** Decoded choice text (e.g. "YES", "NO"). */
  readonly text: string;
  /** File offset of the text bytes (descriptionPtr − GBA_ROM_BASE). */
  readonly textFileOffset: number;
}

export interface MultichoiceListReport {
  /** Index within gMultichoiceLists[] (= the script multichoice opcode's listId arg). */
  readonly listIndex: number;
  /** File offset of this list's 8-byte gMultichoiceLists entry. */
  readonly entryFileOffset: number;
  /** Choice count from the entry's count byte. */
  readonly count: number;
  /** Decoded choices (may be empty for entries whose textPtrs don't resolve). */
  readonly choices: ReadonlyArray<MultichoiceChoiceReport>;
}

export interface MultichoiceListsSystemReport {
  /** File offset of gMultichoiceLists[]. */
  readonly tableStart: number;
  /** Total entries in the table (after walking forward until a non-valid entry). */
  readonly entryCount: number;
  /** Decoded lists for the first N entries (capped at SAMPLE_LIST_COUNT). */
  readonly sampleLists: ReadonlyArray<MultichoiceListReport>;
}

function readU32LE(bytes: Uint8Array, off: number): number {
  return (
    (bytes[off]! | (bytes[off + 1]! << 8) | (bytes[off + 2]! << 16) | (bytes[off + 3]! << 24)) >>>
    0
  );
}

function pointerToFileOffset(ptr: number, romByteLength: number): number {
  if (ptr === 0) return -1;
  if (ptr < GBA_ROM_BASE_ADDRESS || ptr >= GBA_ROM_END_ADDRESS_EXCLUSIVE) return -1;
  const off = ptr - GBA_ROM_BASE_ADDRESS;
  return off >= 0 && off < romByteLength ? off : -1;
}

/** Validate the 8-byte entry at `off` has the shape of a gMultichoiceLists entry:
 *  ptr resolves into ROM, count in [2,16], padding bytes are zero. */
function isValidListEntry(
  bytes: Uint8Array,
  off: number,
): { listPtr: number; count: number } | null {
  if (off + MULTICHOICE_LIST_ENTRY_BYTES > bytes.length) return null;
  const listPtr = readU32LE(bytes, off);
  if (pointerToFileOffset(listPtr, bytes.length) < 0) return null;
  const count = bytes[off + 4]!;
  if (count < MIN_CHOICES_PER_LIST || count > MAX_CHOICES_PER_LIST) return null;
  // Pad bytes MUST be zero. This is the strongest discriminator.
  if (bytes[off + 5] !== 0 || bytes[off + 6] !== 0 || bytes[off + 7] !== 0) return null;
  // The listPtr's MenuAction[count] must fit in ROM.
  const listFileOff = listPtr - GBA_ROM_BASE_ADDRESS;
  if (listFileOff + count * MENU_ACTION_BYTES > bytes.length) return null;
  // Probe: first MenuAction's textPtr should also be a valid ROM ptr.
  const firstTextPtr = readU32LE(bytes, listFileOff);
  if (pointerToFileOffset(firstTextPtr, bytes.length) < 0) return null;
  return { listPtr, count };
}

/** Decode the choices for a single list entry. */
function decodeList(
  bytes: Uint8Array,
  entryFileOffset: number,
  listIndex: number,
): MultichoiceListReport | null {
  const v = isValidListEntry(bytes, entryFileOffset);
  if (v === null) return null;
  const listFileOff = v.listPtr - GBA_ROM_BASE_ADDRESS;
  const choices: MultichoiceChoiceReport[] = [];
  for (let i = 0; i < v.count; i++) {
    const actionOff = listFileOff + i * MENU_ACTION_BYTES;
    const textPtr = readU32LE(bytes, actionOff);
    const textOff = pointerToFileOffset(textPtr, bytes.length);
    if (textOff < 0) continue;
    // Verify terminator within reach.
    let foundTerminator = false;
    const scanLimit = Math.min(textOff + MAX_CHOICE_TEXT_BYTES, bytes.length);
    for (let j = textOff; j < scanLimit; j++) {
      if (bytes[j] === STRING_TERMINATOR) {
        foundTerminator = true;
        break;
      }
    }
    if (!foundTerminator) continue;
    const text = decodeString(bytes, textOff, MAX_CHOICE_TEXT_BYTES);
    choices.push({ choiceIndex: i, text, textFileOffset: textOff });
  }
  return Object.freeze({
    listIndex,
    entryFileOffset,
    count: v.count,
    choices: Object.freeze(choices),
  });
}

/** Scan for a run of MIN_ANCHOR_RUN consecutive valid entries; return file
 *  offset of the FIRST entry in the anchor (= candidate table start). */
function findTableStart(bytes: Uint8Array): number | null {
  // Each gMultichoiceLists entry is 8-byte aligned (the table starts on
  // a 4-byte boundary since u32 ptr leads). Walk every 4 bytes for speed.
  const stride = 4;
  for (let off = 0xc0; off + MIN_ANCHOR_RUN * MULTICHOICE_LIST_ENTRY_BYTES <= bytes.length; off += stride) {
    let run = 0;
    for (let i = 0; i < MIN_ANCHOR_RUN; i++) {
      if (isValidListEntry(bytes, off + i * MULTICHOICE_LIST_ENTRY_BYTES) === null) break;
      run++;
    }
    if (run >= MIN_ANCHOR_RUN) {
      return off;
    }
  }
  return null;
}

/** Walk forward from `tableStart` until a non-valid entry, capped at
 *  MAX_TABLE_ENTRIES. */
function countTableEntries(bytes: Uint8Array, tableStart: number): number {
  let i = 0;
  while (
    i < MAX_TABLE_ENTRIES &&
    isValidListEntry(bytes, tableStart + i * MULTICHOICE_LIST_ENTRY_BYTES) !== null
  ) {
    i++;
  }
  return i;
}

export const multichoiceListsSystemDetector: RomDetector<MultichoiceListsSystemReport> = {
  id: MULTICHOICE_LISTS_SYSTEM_DETECTOR_ID,
  name: 'Multichoice Lists (Gen-3 gMultichoiceLists structural scan)',
  phase: 9,
  detect(rom: RomImage, coverage: CoverageMap): Detection<MultichoiceListsSystemReport> {
    const minBytes = 0xc0 + MIN_ANCHOR_RUN * MULTICHOICE_LIST_ENTRY_BYTES;
    if (rom.byteLength < minBytes) {
      return makeNotDetected({
        confidence: 1.0,
        evidence: [
          makeEvidence({
            kind: 'heuristic',
            summary: `ROM is ${String(rom.byteLength)} bytes - too small to host a ≥${String(MIN_ANCHOR_RUN)}-entry gMultichoiceLists`,
            weight: 1.0,
          }),
        ],
        reason: 'ROM too small to scan for Gen-3 gMultichoiceLists table',
      });
    }

    const tableStart = findTableStart(rom.bytes);
    if (tableStart === null) {
      return makeNotDetected({
        confidence: 0.85,
        evidence: [
          makeEvidence({
            kind: 'heuristic',
            summary: `scanned ${String(rom.byteLength)} bytes for a run of ≥${String(MIN_ANCHOR_RUN)} valid gMultichoiceLists entries (each {ROM ptr, count 2..16, zero-pad bytes ×3}) - none found`,
            weight: 1.0,
          }),
        ],
        reason:
          'No Gen-3 gMultichoiceLists table found - either non-Pokémon ROM or multichoice system rewritten',
      });
    }

    const entryCount = countTableEntries(rom.bytes, tableStart);
    const sampleCap = Math.min(SAMPLE_LIST_COUNT, entryCount);
    const sampleLists: MultichoiceListReport[] = [];
    for (let i = 0; i < sampleCap; i++) {
      const entryOff = tableStart + i * MULTICHOICE_LIST_ENTRY_BYTES;
      const decoded = decodeList(rom.bytes, entryOff, i);
      if (decoded !== null) sampleLists.push(decoded);
    }

    const tableEndExclusive = tableStart + entryCount * MULTICHOICE_LIST_ENTRY_BYTES;
    try {
      coverage.addClassified({
        start: tableStart,
        end: tableEndExclusive,
        probableClass: 'table',
        score: 0.88,
        provenance: `${MULTICHOICE_LISTS_SYSTEM_DETECTOR_ID}#gMultichoiceLists`,
        note: `Gen-3 gMultichoiceLists (${String(entryCount)} entries × ${String(MULTICHOICE_LIST_ENTRY_BYTES)} bytes)`,
      });
    } catch {
      // Overlap - skip.
    }

    const confidence = entryCount >= 50 ? 0.93 : entryCount >= 20 ? 0.9 : 0.85;
    const decodedChoiceCount = sampleLists.reduce((n, l) => n + l.choices.length, 0);
    return makeDetected({
      confidence,
      data: Object.freeze({
        tableStart,
        entryCount,
        sampleLists: Object.freeze(sampleLists),
      }),
      evidence: [
        makeEvidence({
          kind: 'heuristic',
          summary: `Found gMultichoiceLists at offset 0x${tableStart.toString(16)} (${String(entryCount)} lists, ${String(decodedChoiceCount)} sample choices decoded from first ${String(sampleCap)} entries)`,
          weight: 1.0,
          detail: {
            tableStart,
            entryCount,
            sampleListSummaries: sampleLists
              .slice(0, 5)
              .map((l) => `list[${String(l.listIndex)}]: ${String(l.choices.length)}/${String(l.count)} choices (${l.choices.map((c) => c.text).slice(0, 3).join(', ')})`),
          },
        }),
      ],
    });
  },
};
