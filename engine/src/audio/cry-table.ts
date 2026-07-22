/**
 * Gen-3 gCryTable - structural detection of the Pokémon cry table.
 *
 * Per pret/pokefirered `include/sound.h`, each entry of `gCryTable` is a
 * SAPPY-engine `struct ToneData` instance (12 bytes), one per species:
 *
 *   struct ToneData {        // 12 bytes
 *     u8  type;              // 0x00 - wave format (0x00=PCM, 0x80=compressed PCM)
 *     u8  key;               // 0x01 - base note (0-127)
 *     u8  length;            // 0x02 - typically 0 (length comes from wav payload)
 *     u8  panSweep;          // 0x03 - typically 0
 *     u32 wav;               // 0x04 - pointer to PCM data in ROM (or 0 = silent)
 *     u8  attack;            // 0x08 - ADSR envelope
 *     u8  decay;             // 0x09
 *     u8  sustain;           // 0x0A
 *     u8  release;           // 0x0B
 *   };
 *
 * The table sits in ROM as a contiguous array of these 12-byte structs,
 * indexed by species number. Vanilla Gen-3 carts have ~411 species
 * (incl. dummy slots); expansion-framework hacks (DexNav / pokeemerald-
 * expansion) extend it beyond 1000.
 *
 * Detection approach (PD 5 - no baked offsets, universal across all
 * Gen-3 family carts incl. heavy hacks that have relocated the table):
 *  - 4-byte stride anchor scan over the ROM (the table is u32-aligned).
 *  - At each candidate offset, greedy-walk consecutive 12-byte entries.
 *  - Per-entry validity:
 *      • byte 0 (type) in {0x00, 0x80} - PCM or compressed PCM
 *      • bytes [4..8] (wav ptr) either NULL or a valid ROM-space pointer
 *      • envelope bytes [8..12] each < 128 (ADSR params are 7-bit)
 *  - Reject anchor unless the first ANCHOR_CONFIRMATION_ENTRIES
 *    consecutive entries all validate.
 *  - Once anchored, continue walking until validation fails N times in
 *    a row OR the MAX entry cap is reached.
 *  - Accept the run as the cry table iff ≥ MIN_VALID_ENTRIES survived.
 *
 * Per PD 1: typed failure kinds; no empty-success.
 * Per PD 12: detected entries carry their wav-pointer offsets so the
 *   editor can surface them as inspectable audio targets.
 */

import { GBA_ROM_BASE_ADDRESS, GBA_ROM_END_ADDRESS_EXCLUSIVE } from '../pointers/index.js';

/** Bytes per cry-table entry (SAPPY struct ToneData). */
export const CRY_ENTRY_SIZE_BYTES = 12;

/** Minimum consecutive valid entries to confirm an anchor candidate. */
export const CRY_TABLE_ANCHOR_CONFIRMATION_ENTRIES = 10;

/** Minimum valid entries in a run to claim it's the cry table.
 *  Gen-3 vanilla has ~411 species; we accept ≥150 to allow for partial
 *  reads / heavy-trim hacks. Below this, false-positive risk is high. */
export const CRY_TABLE_MIN_VALID_ENTRIES = 150;

/** Cap on entries walked per candidate (expansion hacks can hit ~1100). */
export const CRY_TABLE_MAX_ENTRIES = 2048;

/** Wav-pointer types we accept (0x00 = PCM unsigned, 0x80 = compressed PCM). */
const VALID_TONE_TYPES: ReadonlySet<number> = new Set([0x00, 0x80]);

export interface CryTableEntryView {
  /** ROM file offset of THIS 12-byte entry. */
  readonly entryOffset: number;
  /** 0-based index within the cry table. */
  readonly index: number;
  /** type byte (0x00 PCM or 0x80 compressed PCM). */
  readonly type: number;
  /** Wav-data ROM file offset (NULL if entry is silent). */
  readonly wavOffset: number | null;
  /** Wav-data raw GBA address as it appeared in the entry. */
  readonly wavRawAddress: number;
}

export interface CryTableLocation {
  /** ROM file offset where the cry table starts. */
  readonly tableOffset: number;
  /** Exclusive end offset (tableOffset + validEntries * 12). */
  readonly tableEndExclusive: number;
  /** Number of consecutive valid entries that anchored the table. */
  readonly validEntries: number;
  /** First N entries decoded (capped at 16 for preview UI). */
  readonly samplePreview: ReadonlyArray<CryTableEntryView>;
}

function readUint32Le(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) |
      ((bytes[offset + 1] ?? 0) << 8) |
      ((bytes[offset + 2] ?? 0) << 16) |
      ((bytes[offset + 3] ?? 0) << 24)) >>>
    0
  );
}

/**
 * Validate a single 12-byte cry-table entry. Returns the wav file offset
 * (null if NULL ptr is allowed for silent species) on success, or
 * `'invalid'` on failure.
 *
 * Validity:
 *   - byte 0 (type) in VALID_TONE_TYPES
 *   - bytes [4..8] (wav GBA addr) either 0 OR (high byte in {0x08,0x09}
 *     AND resolved file offset within romByteLength)
 *   - envelope bytes [8..11] each < 128 (ADSR are 7-bit unsigned)
 */
function validateCryEntry(
  bytes: Uint8Array,
  offset: number,
  romByteLength: number,
): { ok: true; wavOffset: number | null; wavRawAddress: number; type: number } | { ok: false } {
  if (offset + CRY_ENTRY_SIZE_BYTES > bytes.length) return { ok: false };
  const type = bytes[offset] ?? 0;
  if (!VALID_TONE_TYPES.has(type)) return { ok: false };

  const wavRaw = readUint32Le(bytes, offset + 4);
  let wavOffset: number | null;
  if (wavRaw === 0) {
    wavOffset = null;
  } else {
    if (wavRaw < GBA_ROM_BASE_ADDRESS || wavRaw >= GBA_ROM_END_ADDRESS_EXCLUSIVE) {
      return { ok: false };
    }
    const fileOffset = wavRaw - GBA_ROM_BASE_ADDRESS;
    if (fileOffset < 0 || fileOffset >= romByteLength) return { ok: false };
    wavOffset = fileOffset;
  }

  const attack = bytes[offset + 8] ?? 0;
  const decay = bytes[offset + 9] ?? 0;
  const sustain = bytes[offset + 10] ?? 0;
  const release = bytes[offset + 11] ?? 0;
  if (attack >= 128 || decay >= 128 || sustain >= 128 || release >= 128) {
    return { ok: false };
  }

  return { ok: true, wavOffset, wavRawAddress: wavRaw, type };
}

/**
 * Anchor-confirm a candidate: the first ANCHOR_CONFIRMATION_ENTRIES
 * consecutive 12-byte entries starting at `candidateOffset` must all
 * validate.
 */
function confirmAnchor(
  bytes: Uint8Array,
  candidateOffset: number,
  romByteLength: number,
): boolean {
  for (let i = 0; i < CRY_TABLE_ANCHOR_CONFIRMATION_ENTRIES; i++) {
    const result = validateCryEntry(
      bytes,
      candidateOffset + i * CRY_ENTRY_SIZE_BYTES,
      romByteLength,
    );
    if (!result.ok) return false;
  }
  return true;
}

/**
 * Once anchored, greedy-walk forward from `tableStart` collecting valid
 * entries until we hit MAX_CONSECUTIVE_BAD invalid entries in a row OR
 * the entry cap is reached. Returns the entry views.
 */
function walkTable(
  bytes: Uint8Array,
  tableStart: number,
  romByteLength: number,
): CryTableEntryView[] {
  const MAX_CONSECUTIVE_BAD = 3;
  const entries: CryTableEntryView[] = [];
  let consecutiveBad = 0;

  for (let i = 0; i < CRY_TABLE_MAX_ENTRIES; i++) {
    const entryOffset = tableStart + i * CRY_ENTRY_SIZE_BYTES;
    const result = validateCryEntry(bytes, entryOffset, romByteLength);
    if (!result.ok) {
      consecutiveBad++;
      if (consecutiveBad >= MAX_CONSECUTIVE_BAD) break;
      continue;
    }
    consecutiveBad = 0;
    entries.push(
      Object.freeze({
        entryOffset,
        index: entries.length,
        type: result.type,
        wavOffset: result.wavOffset,
        wavRawAddress: result.wavRawAddress,
      }),
    );
  }
  return entries;
}

/**
 * Scan the ROM for gCryTable. Returns null if no convincing run is
 * found.
 *
 * Strategy:
 *  - 4-byte stride anchor scan (table is u32-aligned).
 *  - Skip the cartridge header region (offsets < 0xC0).
 *  - First anchor-confirmed candidate that produces ≥ MIN_VALID_ENTRIES
 *    on the forward walk wins.
 */
export function findCryTable(bytes: Uint8Array): CryTableLocation | null {
  const limit = bytes.length - CRY_TABLE_ANCHOR_CONFIRMATION_ENTRIES * CRY_ENTRY_SIZE_BYTES;
  if (limit <= 0xc0) return null;

  // Anchor scan at 4-byte stride.
  for (let candidate = 0xc0; candidate <= limit; candidate += 4) {
    if (!confirmAnchor(bytes, candidate, bytes.length)) continue;
    const entries = walkTable(bytes, candidate, bytes.length);
    if (entries.length < CRY_TABLE_MIN_VALID_ENTRIES) continue;

    return Object.freeze({
      tableOffset: candidate,
      tableEndExclusive: candidate + entries.length * CRY_ENTRY_SIZE_BYTES,
      validEntries: entries.length,
      samplePreview: Object.freeze(entries.slice(0, 16)),
    });
  }
  return null;
}
