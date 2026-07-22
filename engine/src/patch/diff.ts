/**
 * IPS record diff producer - Phase 13 P13-T1.
 *
 * Given an `original` byte buffer and a `modified` byte buffer of
 * the SAME length, produce a list of IPS records that, when applied
 * to `original`, yield `modified`. Coalesces adjacent differing
 * bytes into single literal records (up to IPS_MAX_LITERAL_LENGTH);
 * detects long runs of the same byte and emits RLE records when
 * they cross the break-even threshold (IPS_RLE_BREAK_EVEN_LENGTH).
 *
 * Growing patches are supported (`modified.length > original.length`):
 * trailing bytes of `modified` beyond `original` are always
 * considered "different" (since `original` has no byte at that offset),
 * so they fall into diff runs and become IPS records. The IPS format
 * supports growing patches directly via per-record offsets exceeding
 * the base ROM size - `applyIps` already grows the output buffer to
 * `max(record.end)`. Shrinking patches (`modified.length <
 * original.length`) are not meaningful in IPS (the spec has no "erase"
 * record) and remain an error.
 *
 * Determinism: records are emitted in ascending offset order, never
 * overlap, and never have zero length.
 */

import {
  IPS_MAX_LITERAL_LENGTH,
  IPS_MAX_RLE_LENGTH,
  IPS_RESERVED_EOF_OFFSET,
  IPS_RLE_BREAK_EVEN_LENGTH,
  IpsFormatError,
  type IpsRecord,
} from './ips.js';

export interface ProduceIpsRecordsOptions {
  /** Minimum run length to emit as an RLE record instead of literal.
   *  Default: IPS_RLE_BREAK_EVEN_LENGTH (8 bytes). */
  readonly rleThreshold?: number;
}

/** Produce IPS records that transform `original` → `modified`. */
export function produceIpsRecords(
  original: Uint8Array,
  modified: Uint8Array,
  opts?: ProduceIpsRecordsOptions,
): ReadonlyArray<IpsRecord> {
  if (modified.length < original.length) {
    throw new IpsFormatError(
      `produceIpsRecords cannot shrink ROMs (IPS has no erase record); got original=${String(original.length)} modified=${String(modified.length)}`,
    );
  }
  // Note: we DON'T error on buffers > IPS_MAX_OFFSET+1 here. The
  // encoder enforces per-record offset bounds. A 16 MiB ROM is
  // patchable for offsets 0..IPS_MAX_OFFSET; the trailing few bytes
  // (≥ 0x454F46 collision range or > 0xFFFFFE) simply can't be
  // included in IPS records. Throwing upfront prevents legitimate
  // patches of the addressable portion.
  const rleThreshold = Math.max(2, opts?.rleThreshold ?? IPS_RLE_BREAK_EVEN_LENGTH);
  const records: IpsRecord[] = [];
  // Helper: read original[i] safely. Past `original.length` (growing
  // patch case), return a sentinel that ALWAYS differs from any
  // possible `modified[i]` so the byte enters a diff run.
  const NOT_PRESENT = -1;
  const origByte = (i: number): number => (i < original.length ? original[i]! : NOT_PRESENT);

  let i = 0;
  while (i < modified.length) {
    if (modified[i] === origByte(i)) {
      i++;
      continue;
    }
    // Difference begins at i. Find the extent of the differing run.
    let runEnd = i;
    while (runEnd < modified.length && modified[runEnd] !== origByte(runEnd)) {
      runEnd++;
    }
    // Now process [i, runEnd) - could be one literal, possibly with
    // RLE sub-runs inside.
    let cursor = i;
    while (cursor < runEnd) {
      // Skip "EOF"-collision offsets by splitting the record. If the
      // record would start at the reserved 0x454F46 offset, emit a
      // 1-byte literal that ends at 0x454F46+1 instead.
      if (cursor === IPS_RESERVED_EOF_OFFSET) {
        records.push(
          Object.freeze({
            kind: 'literal' as const,
            offset: cursor,
            data: modified.slice(cursor, cursor + 1),
          }),
        );
        cursor += 1;
        continue;
      }
      // Detect an RLE-worthy run starting at `cursor`.
      const rleByte = modified[cursor]!;
      let rleEnd = cursor;
      while (
        rleEnd < runEnd &&
        modified[rleEnd] === rleByte &&
        rleEnd - cursor < IPS_MAX_RLE_LENGTH
      ) {
        rleEnd++;
      }
      const rleLength = rleEnd - cursor;
      if (rleLength >= rleThreshold) {
        records.push(
          Object.freeze({
            kind: 'rle' as const,
            offset: cursor,
            rleLength,
            byte: rleByte,
          }),
        );
        cursor = rleEnd;
        continue;
      }
      // Else, emit a literal record up to the next RLE-worthy run OR
      // the end of the differing run OR IPS_MAX_LITERAL_LENGTH.
      let literalEnd = cursor;
      while (
        literalEnd < runEnd &&
        literalEnd - cursor < IPS_MAX_LITERAL_LENGTH
      ) {
        // Stop if we hit a long enough run of identical bytes
        // (RLE candidate ahead - let the next loop iteration handle it).
        const nextByte = modified[literalEnd]!;
        let runFwd = literalEnd;
        while (
          runFwd < runEnd &&
          modified[runFwd] === nextByte &&
          runFwd - literalEnd < rleThreshold
        ) {
          runFwd++;
        }
        if (runFwd - literalEnd >= rleThreshold) break;
        literalEnd++;
      }
      // Ensure the literal record doesn't include the reserved EOF
      // offset position INSIDE its span - split it if so.
      if (
        cursor < IPS_RESERVED_EOF_OFFSET &&
        literalEnd > IPS_RESERVED_EOF_OFFSET
      ) {
        literalEnd = IPS_RESERVED_EOF_OFFSET;
      }
      records.push(
        Object.freeze({
          kind: 'literal' as const,
          offset: cursor,
          data: modified.slice(cursor, literalEnd),
        }),
      );
      cursor = literalEnd;
    }
    i = runEnd;
  }
  return Object.freeze(records);
}
