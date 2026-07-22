/**
 * Gen-3 script-engine opcode-table scanner - `gScriptCmdTable` discovery.
 *
 * Per pret/pokefirered's `src/scrcmd.c` + pret/pokeemerald's equivalent,
 * the Gen-3 script interpreter dispatches script bytecode via a flat
 * in-ROM array of function pointers:
 *
 *   typedef bool8 (*ScrCmdFunc)(struct ScriptContext *);
 *   const ScrCmdFunc gScriptCmdTable[] = {
 *     ScrCmd_nop,           // opcode 0x00
 *     ScrCmd_nop1,          // opcode 0x01
 *     ScrCmd_end,           // opcode 0x02
 *     ScrCmd_return,        // opcode 0x03
 *     ScrCmd_call,          // opcode 0x04
 *     ...                   // ~229 in vanilla FireRed; ~227 in Emerald; ~250+ in CFRU
 *   };
 *
 * Each entry is a 4-byte ROM pointer. The array's length is the
 * engine's opcode count. The handlers themselves are Thumb-mode ARM
 * routines whose first 2 bytes match a `push` instruction (the
 * conventional function prologue): `0xB4XX` (push {regs}) or `0xB5XX`
 * (push {regs, lr}).
 *
 * Detection (PD 5: structural-only):
 *  - Scan at 4-byte stride.
 *  - At each candidate, greedy-walk 4-byte slots; each must be a valid
 *    ROM pointer whose 2-byte target prefix matches the Thumb push
 *    pattern (mask 0xFE00 == 0xB400, covering 0xB400-0xB5FF).
 *  - Require ≥ `minOpcodesInTable` consecutive valid entries (default
 *    64, the smallest plausible Gen-3 opcode count - even a heavily-
 *    stripped engine retains the core ~30 opcodes; we set 64 to
 *    reject random pointer-table false positives).
 *  - First convincing run wins.
 *
 * The Thumb bit (low bit set on function pointers per AAPCS) is NOT
 * typically present in compiled `gScriptCmdTable` arrays - the linker
 * stores raw addresses and the runtime BX instruction adds the Thumb
 * bit. So we accept both 4-byte-aligned pointers (raw) and
 * thumb-tagged pointers (lsb=1).
 *
 * Performance: ~30–80 ms on a 16 MiB ROM. The per-candidate fast-
 * reject path is the bytes-at-target check (1 u16 read + 1 mask).
 */

import { GBA_ROM_BASE_ADDRESS } from '../pointers/index.js';

/** Bytes per opcode-table entry (one ROM pointer). */
export const SCRIPT_OPCODE_TABLE_ENTRY_SIZE_BYTES = 4;
/** Minimum opcodes required to claim a run is the script opcode table.
 *  Lower than the vanilla ~229 to support heavily-stripped engines
 *  while still being structurally unambiguous. */
export const SCRIPT_OPCODE_TABLE_MIN_ENTRIES = 64;
/** Cap on entries walked per candidate. Vanilla maxes ~229; absurdly-
 *  generous cap handles any hack. */
export const SCRIPT_OPCODE_TABLE_MAX_ENTRIES = 1024;

export interface ScriptOpcodeTable {
  /** ROM file offset of the table start (opcode 0's handler pointer). */
  readonly tableStart: number;
  /** Exclusive end offset (= tableStart + opcodeCount × 4). */
  readonly tableEndExclusive: number;
  /** Number of opcodes in the table. */
  readonly opcodeCount: number;
  /** File offset of each handler function (the target of each pointer).
   *  `handlerOffsets[i]` = handler for opcode i. The Thumb-bit
   *  low-bit-set IS stripped here - these are clean file offsets. */
  readonly handlerOffsets: ReadonlyArray<number>;
  /** True if at least one pointer had its low bit set (Thumb tag),
   *  which is unusual for the script table; flags potential hack-style
   *  function-pointer encoding. */
  readonly anyThumbTaggedPointer: boolean;
}

export interface ScanScriptOpcodeTableOptions {
  /** Minimum opcodes required to claim a run. Default 64. */
  readonly minOpcodesInTable?: number;
  /** Cap on entries walked per candidate. Default 1024. */
  readonly maxOpcodesInTable?: number;
}

/**
 * Find the script-engine opcode dispatch table structurally. Returns
 * null when no convincing run of ROM-pointer-to-Thumb-prologue entries
 * exists.
 */
export function scanScriptOpcodeTable(
  bytes: Uint8Array,
  opts?: ScanScriptOpcodeTableOptions,
): ScriptOpcodeTable | null {
  const minOpcodesInTable = opts?.minOpcodesInTable ?? SCRIPT_OPCODE_TABLE_MIN_ENTRIES;
  const maxOpcodesInTable = opts?.maxOpcodesInTable ?? SCRIPT_OPCODE_TABLE_MAX_ENTRIES;
  if (!Number.isInteger(minOpcodesInTable) || minOpcodesInTable < 1) {
    throw new Error(
      `minOpcodesInTable must be a positive integer, got ${String(minOpcodesInTable)}`,
    );
  }
  if (
    !Number.isInteger(maxOpcodesInTable) ||
    maxOpcodesInTable < minOpcodesInTable
  ) {
    throw new Error(
      `maxOpcodesInTable must be >= minOpcodesInTable, got ${String(maxOpcodesInTable)}`,
    );
  }

  const stride = 4;
  const limit = bytes.length - SCRIPT_OPCODE_TABLE_ENTRY_SIZE_BYTES;
  for (let candidateStart = 0; candidateStart <= limit; candidateStart += stride) {
    const handlerOffsets: number[] = [];
    let anyThumbTaggedPointer = false;
    let cursor = candidateStart;

    while (handlerOffsets.length < maxOpcodesInTable) {
      if (cursor + SCRIPT_OPCODE_TABLE_ENTRY_SIZE_BYTES > bytes.length) break;
      const raw = readUint32Le(bytes, cursor);
      // Strip the Thumb tag if present (low bit set).
      const isThumbTagged = (raw & 1) === 1;
      const cleanAddr = raw & ~1;
      const high = (cleanAddr >>> 24) & 0xff;
      if (high !== 0x08 && high !== 0x09) break;
      const target = (cleanAddr - GBA_ROM_BASE_ADDRESS) >>> 0;
      if (target >= bytes.length - 1) break;
      // Read first 2 bytes at target as a u16 - must match Thumb push
      // prologue pattern (0xB4xx or 0xB5xx).
      const prologue = readUint16Le(bytes, target);
      if ((prologue & 0xfe00) !== 0xb400) break;
      handlerOffsets.push(target);
      if (isThumbTagged) anyThumbTaggedPointer = true;
      cursor += SCRIPT_OPCODE_TABLE_ENTRY_SIZE_BYTES;
    }

    if (handlerOffsets.length >= minOpcodesInTable) {
      return Object.freeze({
        tableStart: candidateStart,
        tableEndExclusive: cursor,
        opcodeCount: handlerOffsets.length,
        handlerOffsets: Object.freeze(handlerOffsets),
        anyThumbTaggedPointer,
      });
    }
  }
  return null;
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
