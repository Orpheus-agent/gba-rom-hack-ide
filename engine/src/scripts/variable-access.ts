/**
 * Gen-3 variable / flag access detection (P7-T1).
 *
 * Classifies script-engine opcodes as flag/variable read or write
 * operations BY NAME (matched against the signature-DB opcodeNames
 * table from P6-T6). The detection works for any cart whose signature
 * provides the well-known pret/pokefirered + pret/pokeemerald opcode
 * names - vanilla, decomp, hack, fork.
 *
 * PD 5: no baked opcode INDICES - the classifier accepts a name
 * string and returns its access kind. Whether opcode 41 is `setflag`
 * (FireRed) or opcode 0xE3 (a hack remapping) doesn't matter to this
 * module; the signature DB resolves the index → name mapping.
 *
 * PD 12: the opcode names are CC0 identifiers from public decomp
 * source (pret/pokefirered/src/scrcmd.c), not copyrighted ROM bytes.
 *
 * Honest scope: this module classifies the GAME-SCRIPT-engine var/flag
 * opcodes. It does NOT walk handler ARM/Thumb code to detect raw
 * memory accesses that bypass the script engine (those need Phase 10
 * runtime introspection).
 */

import type { WalkedScriptBody } from './bytecode-walker.js';

/** Discriminator for what an opcode does w.r.t. variables/flags. */
export type VariableAccessKind = 'sets_flag' | 'reads_flag';

/** Well-known pret/pokefirered + pret/pokeemerald opcode names that
 *  WRITE a variable or flag (per `src/scrcmd.c`). */
const SETS_FLAG_NAMES: ReadonlySet<string> = new Set([
  // Variable writes
  'setvar',
  'addvar',
  'subvar',
  'copyvar',
  'setorcopyvar',
  // Flag (bit) writes
  'setflag',
  'clearflag',
]);

/** Well-known opcode names that READ a variable or flag for branching. */
const READS_FLAG_NAMES: ReadonlySet<string> = new Set([
  // Flag reads
  'checkflag',
  // Variable reads (compares all read at least one var; only the
  // `_var_*` variants reliably target a script-visible variable)
  'compare_var_to_value',
  'compare_var_to_var',
]);

/**
 * Classify an opcode name as a flag/var write, read, or neither.
 * Returns null for unknown or non-variable-access opcodes.
 */
export function classifyOpcodeVariableAccess(
  opcodeName: string | undefined,
): VariableAccessKind | null {
  if (opcodeName === undefined || opcodeName === '') return null;
  if (SETS_FLAG_NAMES.has(opcodeName)) return 'sets_flag';
  if (READS_FLAG_NAMES.has(opcodeName)) return 'reads_flag';
  return null;
}

export interface VariableAccessSite {
  /** ROM file offset of the opcode byte. */
  readonly opcodeOffset: number;
  /** The opcode's name (always set - only named opcodes can be classified). */
  readonly opcodeName: string;
  /** Index in the dispatch table. */
  readonly opcodeIndex: number;
  /** Access kind. */
  readonly accessKind: VariableAccessKind;
  /** The variable id read from the opcode's first u16 argbyte pair.
   *  Null when the opcode has fewer than 2 argbytes (e.g. a misnamed
   *  opcode that has 0 args). */
  readonly variableId: number | null;
}

/**
 * Walk a WalkedScriptBody's opcodes, identify every variable/flag
 * access site, return the list. variableId is read as a little-endian
 * u16 from the first 2 argbytes (Gen-3 var/flag ids are u16; the engine
 * uses ScriptReadHalfword for them).
 *
 * `opcodeNames` is the same sparse table consumed by the decompile
 * renderer (P6-T5/T6) - typically sourced from the matched signature
 * entry's opcodeNames. Unnamed opcodes are skipped (per PD 4 - no
 * faked classifications).
 */
export function detectVariableAccessSites(
  walked: WalkedScriptBody,
  opcodeNames: ReadonlyArray<string | undefined>,
): ReadonlyArray<VariableAccessSite> {
  const sites: VariableAccessSite[] = [];
  for (const opcode of walked.opcodes) {
    const name = opcodeNames[opcode.opcodeIndex];
    const accessKind = classifyOpcodeVariableAccess(name);
    if (accessKind === null) continue;
    let variableId: number | null = null;
    if (opcode.argBytes.length >= 2) {
      const lo = opcode.argBytes[0] ?? 0;
      const hi = opcode.argBytes[1] ?? 0;
      variableId = (lo | (hi << 8)) >>> 0;
    }
    sites.push(
      Object.freeze({
        opcodeOffset: opcode.opcodeOffset,
        opcodeName: name as string,
        opcodeIndex: opcode.opcodeIndex,
        accessKind,
        variableId,
      }),
    );
  }
  return Object.freeze(sites);
}
