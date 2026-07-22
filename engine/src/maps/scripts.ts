/**
 * Gen-3 MapScripts table parser.
 *
 * Each map's MapHeader has a `mapScriptsPointer` (offset 0x08) that
 * points at a flat in-ROM array of variable-length `MapScript` entries
 * terminated by a single zero byte (type = MAP_SCRIPT_NONE).
 *
 * Per pret/pokefirered + pret/pokeemerald, the entry layout is:
 *
 *   struct MapScript {
 *     u8 mapScriptType;       // 0x00 - 1..7 (see ScriptType list)
 *     u32 scriptPtr;          // 0x01 - packed (NOT 4-byte aligned)
 *   };
 *
 * Entry size is 5 bytes (NOT 8) - the GameFreak macros emit packed
 * bytes via `.byte` + `.4byte`. The terminator is a single `.byte 0`
 * (1 byte). Total table size = N*5 + 1 bytes for N script entries.
 *
 * Script types in Gen-3:
 *   1 - MAP_SCRIPT_ON_LOAD            (runs when entering the map)
 *   2 - MAP_SCRIPT_ON_FRAME_TABLE     (var-conditional; scriptPtr → sub-table)
 *   3 - MAP_SCRIPT_ON_TRANSITION      (between-map transition)
 *   4 - MAP_SCRIPT_ON_WARP_INTO_MAP_TABLE (var-conditional; scriptPtr → sub-table)
 *   5 - MAP_SCRIPT_ON_RESUME          (after returning from menu/battle)
 *   6 - MAP_SCRIPT_ON_DIVE_WARP (Emerald) / ON_RETURN_TO_FIELD (FireRed)
 *   7 - MAP_SCRIPT_ON_RETURN_TO_FIELD (Emerald) / ON_DIVE_WARP (FireRed)
 *
 * PD 5 honored: structural-only. Works on any Gen-3 cart. Sub-table
 * walking (types 2 and 4) is left for a later iteration - for now we
 * emit the entry-level script with `scriptPtr` and `type` so the graph
 * can show "this map has 3 on-load / on-transition / on-resume scripts."
 */

import { GBA_ROM_BASE_ADDRESS } from '../pointers/index.js';

/** Bytes per packed MapScript entry (NOT padded - `.byte` + `.4byte`). */
export const MAP_SCRIPT_ENTRY_SIZE_BYTES = 5;
/** Sentinel terminator byte (type=0 = MAP_SCRIPT_NONE). */
export const MAP_SCRIPT_TERMINATOR = 0;
/** Highest plausible mapScriptType. Vanilla Gen-3 uses 1..7. */
export const MAP_SCRIPT_TYPE_MAX = 7;
/** Cap on entries per table - vanilla maps have ≤ 5; this absurdly-
 *  generous cap handles any hack. */
export const MAP_SCRIPTS_MAX_ENTRIES = 256;

export type MapScriptTypeName =
  | 'ON_LOAD'
  | 'ON_FRAME_TABLE'
  | 'ON_TRANSITION'
  | 'ON_WARP_INTO_MAP_TABLE'
  | 'ON_RESUME'
  | 'ON_DIVE_WARP_OR_RETURN_TO_FIELD_6'
  | 'ON_RETURN_TO_FIELD_OR_DIVE_WARP_7';

/** Map type byte → semantic name. The vanilla mapping of bytes 6/7 is
 *  game-dependent (FireRed swaps them vs. Emerald), so we encode both
 *  possibilities in the disambiguation name rather than baking a family
 *  assumption. */
export const MAP_SCRIPT_TYPE_NAMES: Readonly<Record<number, MapScriptTypeName>> = Object.freeze({
  1: 'ON_LOAD',
  2: 'ON_FRAME_TABLE',
  3: 'ON_TRANSITION',
  4: 'ON_WARP_INTO_MAP_TABLE',
  5: 'ON_RESUME',
  6: 'ON_DIVE_WARP_OR_RETURN_TO_FIELD_6',
  7: 'ON_RETURN_TO_FIELD_OR_DIVE_WARP_7',
});

export interface MapScriptEntry {
  /** mapScriptType byte (1..7). */
  readonly type: number;
  /** Semantic name for the type. */
  readonly typeName: MapScriptTypeName;
  /** Script pointer's file offset (target inside the ROM), or null if
   *  the encoded pointer was NULL (raw 0). Types 2 and 4 typically
   *  point to a sub-table; types 1/3/5/6/7 typically point to a script. */
  readonly scriptOffset: number | null;
  /** Raw 32-bit value of the script pointer (for evidence). */
  readonly rawScriptAddress: number;
  /** File offset of this entry's first byte (the type byte). */
  readonly entryFileOffset: number;
}

export interface MapScriptsParsed {
  /** File offset of the table (the first entry, or the terminator if empty). */
  readonly tableFileOffset: number;
  /** File offset one past the terminator byte. */
  readonly tableEndExclusive: number;
  /** Number of script entries parsed (sentinel excluded). */
  readonly entryCount: number;
  /** Each parsed entry, in table order. */
  readonly entries: ReadonlyArray<MapScriptEntry>;
}

export type MapScriptsParseFailure =
  | { kind: 'too_short'; bytesAvailable: number }
  | { kind: 'implausible_type'; entryIndex: number; observed: number; max: number }
  | { kind: 'invalid_script_pointer'; entryIndex: number; rawAddress: number }
  | { kind: 'no_terminator_within_cap'; observed: number };

export type MapScriptsParseResult =
  | { ok: true; scripts: MapScriptsParsed }
  | { ok: false; failure: MapScriptsParseFailure };

/**
 * Parse a MapScripts table starting at `offset`. The table is a flat
 * array of 5-byte packed entries terminated by a single zero byte.
 *
 * Returns ok=true on a clean parse:
 *   - 0+ valid entries (each `type ∈ 1..7`, `scriptPtr` is NULL or a
 *     valid in-ROM pointer)
 *   - Terminator byte (type=0) found within cap
 */
export function parseMapScripts(bytes: Uint8Array, offset: number): MapScriptsParseResult {
  if (offset < 0 || offset >= bytes.length) {
    return {
      ok: false,
      failure: { kind: 'too_short', bytesAvailable: Math.max(0, bytes.length - offset) },
    };
  }

  const entries: MapScriptEntry[] = [];
  let cursor = offset;
  while (entries.length <= MAP_SCRIPTS_MAX_ENTRIES) {
    if (cursor >= bytes.length) {
      return {
        ok: false,
        failure: { kind: 'too_short', bytesAvailable: bytes.length - offset },
      };
    }
    const type = bytes[cursor] ?? 0;
    if (type === MAP_SCRIPT_TERMINATOR) {
      cursor += 1;
      return {
        ok: true,
        scripts: Object.freeze({
          tableFileOffset: offset,
          tableEndExclusive: cursor,
          entryCount: entries.length,
          entries: Object.freeze(entries),
        }),
      };
    }
    if (type > MAP_SCRIPT_TYPE_MAX) {
      return {
        ok: false,
        failure: {
          kind: 'implausible_type',
          entryIndex: entries.length,
          observed: type,
          max: MAP_SCRIPT_TYPE_MAX,
        },
      };
    }

    // Need 5 bytes total for this entry (1 type + 4 pointer).
    if (cursor + MAP_SCRIPT_ENTRY_SIZE_BYTES > bytes.length) {
      return {
        ok: false,
        failure: { kind: 'too_short', bytesAvailable: bytes.length - cursor },
      };
    }

    const rawAddress = readUint32Le(bytes, cursor + 1);
    let scriptOffset: number | null;
    if (rawAddress === 0) {
      // NULL is legal for some hacks / placeholder entries
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

    const typeName = MAP_SCRIPT_TYPE_NAMES[type] ?? 'ON_LOAD'; // unreachable
    entries.push(
      Object.freeze({
        type,
        typeName,
        scriptOffset,
        rawScriptAddress: rawAddress,
        entryFileOffset: cursor,
      }),
    );
    cursor += MAP_SCRIPT_ENTRY_SIZE_BYTES;
  }

  return {
    ok: false,
    failure: { kind: 'no_terminator_within_cap', observed: entries.length },
  };
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
