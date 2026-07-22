/**
 * Gen-3 MapScriptStub array parser - conditional script sub-tables.
 *
 * MapScripts entries with `type == 2` (ON_FRAME_TABLE) or `type == 4`
 * (ON_WARP_INTO_MAP_TABLE) don't point directly at a script - they
 * point at a *sub-table* of `MapScriptStub` records, each gating an
 * actual script on a (variable, value) predicate check. Per
 * pret/pokefirered + pret/pokeemerald, the stub is:
 *
 *   struct MapScriptStub {
 *     u16 varCheck;     // 0x00 - variable id (sentinel = 0)
 *     u16 valueCheck;   // 0x02 - required value
 *     u32 scriptPtr;    // 0x04 - script to run when varCheck == valueCheck
 *   };
 *
 * The sub-table is terminated by `varCheck == 0` (2-byte sentinel - the
 * surrounding 6 bytes of the "would-be entry" are uninitialized garbage
 * because the macros only emit `.2byte 0`).
 *
 * Coverage extent: from the first entry's offset through the sentinel's
 * 2 bytes, i.e. `offset + entryCount*8 + 2` bytes.
 *
 * PD 5: structural detection. Validates scriptPtr is NULL or a valid
 * in-ROM address. The varCheck and valueCheck bytes have no useful
 * structural constraint beyond "not the sentinel" (varCheck != 0 to
 * count as an entry).
 */

import { GBA_ROM_BASE_ADDRESS } from '../pointers/index.js';

/** Bytes per MapScriptStub entry (`{u16, u16, u32}` packed). */
export const MAP_SCRIPT_STUB_SIZE_BYTES = 8;
/** Bytes for the table terminator (`u16 0` sentinel). */
export const MAP_SCRIPT_STUB_TERMINATOR_SIZE_BYTES = 2;
/** Cap on entries per sub-table (vanilla maps have ≤ 8; this absurdly-
 *  generous cap handles any hack). */
export const MAP_SCRIPT_STUBS_MAX_ENTRIES = 256;

export interface MapScriptStub {
  readonly varCheck: number;
  readonly valueCheck: number;
  /** scriptPtr file offset (NULL = null). */
  readonly scriptOffset: number | null;
  /** Raw 32-bit script pointer value (for evidence). */
  readonly rawScriptAddress: number;
  /** File offset of this entry's first byte. */
  readonly entryFileOffset: number;
}

export interface ConditionalScriptTable {
  /** Start offset of the sub-table (the first entry's first byte). */
  readonly tableFileOffset: number;
  /** Exclusive end offset (after the 2-byte sentinel). */
  readonly tableEndExclusive: number;
  /** Number of stub entries parsed (sentinel excluded). */
  readonly entryCount: number;
  /** Each parsed stub, in table order. */
  readonly entries: ReadonlyArray<MapScriptStub>;
}

export type ConditionalScriptTableParseFailure =
  | { kind: 'too_short'; bytesAvailable: number }
  | { kind: 'invalid_script_pointer'; entryIndex: number; rawAddress: number }
  | { kind: 'no_terminator_within_cap'; observed: number };

export type ConditionalScriptTableParseResult =
  | { ok: true; table: ConditionalScriptTable }
  | { ok: false; failure: ConditionalScriptTableParseFailure };

/**
 * Parse a MapScriptStub sub-table starting at `offset`. Returns ok=true
 * when 0+ valid stubs are followed by a `varCheck == 0` sentinel.
 */
export function parseConditionalScriptTable(
  bytes: Uint8Array,
  offset: number,
): ConditionalScriptTableParseResult {
  if (offset < 0 || offset + MAP_SCRIPT_STUB_TERMINATOR_SIZE_BYTES > bytes.length) {
    return {
      ok: false,
      failure: { kind: 'too_short', bytesAvailable: Math.max(0, bytes.length - offset) },
    };
  }

  const entries: MapScriptStub[] = [];
  let cursor = offset;
  while (entries.length <= MAP_SCRIPT_STUBS_MAX_ENTRIES) {
    // Need at least 2 bytes to check the varCheck terminator.
    if (cursor + MAP_SCRIPT_STUB_TERMINATOR_SIZE_BYTES > bytes.length) {
      return {
        ok: false,
        failure: { kind: 'too_short', bytesAvailable: bytes.length - cursor },
      };
    }
    const varCheck = readUint16Le(bytes, cursor);
    if (varCheck === 0) {
      // Sentinel - the surrounding 6 bytes are uninitialized garbage
      // by spec; only the 2-byte sentinel is part of the table.
      cursor += MAP_SCRIPT_STUB_TERMINATOR_SIZE_BYTES;
      return {
        ok: true,
        table: Object.freeze({
          tableFileOffset: offset,
          tableEndExclusive: cursor,
          entryCount: entries.length,
          entries: Object.freeze(entries),
        }),
      };
    }

    // Non-sentinel entry - need 8 bytes total.
    if (cursor + MAP_SCRIPT_STUB_SIZE_BYTES > bytes.length) {
      return {
        ok: false,
        failure: { kind: 'too_short', bytesAvailable: bytes.length - cursor },
      };
    }
    const valueCheck = readUint16Le(bytes, cursor + 0x02);
    const rawAddress = readUint32Le(bytes, cursor + 0x04);
    let scriptOffset: number | null;
    if (rawAddress === 0) {
      scriptOffset = null;
    } else {
      const high = (rawAddress >>> 24) & 0xff;
      if (high !== 0x08 && high !== 0x09) {
        return {
          ok: false,
          failure: {
            kind: 'invalid_script_pointer',
            entryIndex: entries.length,
            rawAddress,
          },
        };
      }
      const target = rawAddress - GBA_ROM_BASE_ADDRESS;
      if (target < 0 || target >= bytes.length) {
        return {
          ok: false,
          failure: {
            kind: 'invalid_script_pointer',
            entryIndex: entries.length,
            rawAddress,
          },
        };
      }
      scriptOffset = target;
    }

    entries.push(
      Object.freeze({
        varCheck,
        valueCheck,
        scriptOffset,
        rawScriptAddress: rawAddress,
        entryFileOffset: cursor,
      }),
    );
    cursor += MAP_SCRIPT_STUB_SIZE_BYTES;
  }

  return {
    ok: false,
    failure: { kind: 'no_terminator_within_cap', observed: entries.length },
  };
}

function readUint16Le(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8)) >>> 0;
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
