/**
 * Walked-script decompile renderer (P6-T5).
 *
 * Converts a `WalkedScriptBody` (from P6-T4 `walkScriptBytecode`) into
 * a human-readable multi-line string. Without a semantic opcode-name
 * table, opcodes render as `op_<index>`; when an optional
 * `opcodeNames[]` array is supplied (corpus signature, operator-
 * provided override, or future P6-T6 inference output), each opcode's
 * name is looked up by index with `op_<index>` as the fallback for
 * sparse / out-of-range entries.
 *
 * Format (default):
 *
 *   00600600: op_8()
 *   00600601: op_9()
 *   00600602: op_0(arg0=0xAA, arg1=0xBB)
 *   00600605: op_10()
 *   00600606: op_5(arg0=0xCC, arg1=0xDD)
 *   ; stopped: invalid_opcode @ 0x00600609
 *
 * PD 4: no fakery - when no names are known, the renderer shows the
 * raw opcode index. PD 5: no engine-version baking - the opcode-name
 * source is the caller's optional table, never compiled-in.
 */

import type { WalkedScriptBody } from './bytecode-walker.js';

export interface RenderWalkedBodyOptions {
  /** Optional sparse opcode-name lookup. `opcodeNames[index] ??
   *  ('op_' + index)`. Useful when corpus signatures or operator
   *  overrides provide semantic names. */
  readonly opcodeNames?: ReadonlyArray<string | undefined>;
  /** Whether to prefix each line with the opcode's ROM file offset
   *  rendered as 8 hex digits. Default true. */
  readonly addressColumn?: boolean;
  /** Argument-byte rendering format. Default 'hex'. */
  readonly argFormat?: 'hex' | 'dec';
}

/** Render a `WalkedScriptBody` as multi-line decompile text. */
export function renderWalkedBody(
  walked: WalkedScriptBody,
  opts?: RenderWalkedBodyOptions,
): string {
  const addressColumn = opts?.addressColumn ?? true;
  const argFormat = opts?.argFormat ?? 'hex';
  const opcodeNames = opts?.opcodeNames;

  const lines: string[] = [];
  for (const opcode of walked.opcodes) {
    const name =
      opcodeNames?.[opcode.opcodeIndex] ?? `op_${String(opcode.opcodeIndex)}`;
    const argParts: string[] = [];
    for (let i = 0; i < opcode.argBytes.length; i++) {
      const byte = opcode.argBytes[i]!;
      const valueStr =
        argFormat === 'hex'
          ? `0x${byte.toString(16).toUpperCase().padStart(2, '0')}`
          : String(byte);
      argParts.push(`arg${String(i)}=${valueStr}`);
    }
    const callLine = `${name}(${argParts.join(', ')})`;
    if (addressColumn) {
      const addr = opcode.opcodeOffset
        .toString(16)
        .toUpperCase()
        .padStart(8, '0');
      lines.push(`${addr}: ${callLine}`);
    } else {
      lines.push(callLine);
    }
  }

  const endAddr = walked.endOffset
    .toString(16)
    .toUpperCase()
    .padStart(8, '0');
  lines.push(`; stopped: ${walked.stoppedReason} @ 0x${endAddr}`);

  return lines.join('\n');
}
