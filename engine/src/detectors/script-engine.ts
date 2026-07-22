/**
 * Phase-6 detector: script-engine opcode-table discovery (P6-T1).
 *
 * Per §15 Phase 6, the script engine needs full introspection: opcode +
 * command-table discovery, entrypoints, control flow, decompiled
 * representation. This detector is the first step - discovering the
 * `gScriptCmdTable` (the flat array of function pointers indexed by
 * opcode byte). Subsequent P6 tasks decode script bytecode using
 * `handlerOffsets[opcode]` to identify which command runs at each
 * position in a script body.
 *
 * Coverage contribution: the opcode-table bytes (opcodeCount × 4) are
 * registered as `pointer_network` class at confidence 0.9. The handler
 * functions themselves are ARM/Thumb code (separate concern - they
 * appear in the `unknown_executable` class via Phase 3 finalizer for
 * any region not otherwise classified).
 *
 * PD 5: structural-only - `scanScriptOpcodeTable` finds the table by
 * validating runs of ROM-pointer-to-Thumb-prologue entries. Works on
 * any Gen-3 cart whose script engine retains the dispatch-table
 * dispatch pattern (vanilla, decomp, CFRU, typical forks).
 */

import { makeDetected, makeEvidence, makeNotDetected } from '../detection/index.js';
import type { Detection } from '../detection/index.js';
import type { CoverageMap } from '../coverage/index.js';
import type { RomImage } from '../rom/loader.js';
import type { RomDetector } from './types.js';
import {
  SCRIPT_OPCODE_TABLE_ENTRY_SIZE_BYTES,
  SCRIPT_OPCODE_TABLE_MIN_ENTRIES,
  analyzeScriptHandlers,
  helperCallHistogram,
  inferOpcodeHelperProfiles,
  scanScriptOpcodeTable,
  type CommonHelperFunction,
  type OpcodeHelperProfile,
  type ScriptOpcodeTable,
} from '../scripts/index.js';

export const SCRIPT_ENGINE_DETECTOR_ID = 'script_engine';

/** P6-T6: structural classification of the script-engine size.
 *  - `undersized`         opcodeCount < 100 - heavily-stripped engine
 *    (vanilla Gen-3 ranges from 200-230 opcodes; <100 means either a
 *    custom rewritten engine or our scanner caught a false positive)
 *  - `vanilla-range`      100 ≤ opcodeCount ≤ 230 - matches all vanilla
 *    Gen-3 carts (FireRed ~229, Emerald ~227, Ruby/Sapphire ~227)
 *  - `extended`           231 ≤ opcodeCount ≤ 300 - likely CFRU or
 *    sibling framework that adds ~30-70 opcodes for hack mechanics
 *  - `heavily-extended`   opcodeCount > 300 - heavily customized engine
 *    (Unbound, Radical Red, or custom-fork that doubles/tripled the
 *    opcode set) */
export type ScriptEngineKind = 'undersized' | 'vanilla-range' | 'extended' | 'heavily-extended';

export interface ScriptEngineReport {
  /** The discovered opcode dispatch table. */
  readonly opcodeTable: ScriptOpcodeTable;
  /** Convenience mirror of opcodeTable.opcodeCount. */
  readonly opcodeCount: number;
  /** Structural classification derived purely from opcodeCount - 
   *  flags CFRU/extended engines without baking specific carts. */
  readonly engineKind: ScriptEngineKind;
  /** P6-T2: top-N most-frequently-called BL targets across all handler
   *  functions. The top entries are very likely the engine's
   *  `ScriptReadByte` / `ScriptReadHalfword` / `ScriptReadWord` helpers
   *  (called by every argument-consuming opcode handler) - the
   *  foundation for per-opcode argcount inference in subsequent P6 tasks. */
  readonly commonHelperFunctions: ReadonlyArray<CommonHelperFunction>;
  /** P6-T3: per-opcode helper-call profile. `opcodeHelperCallProfiles
   *  [opcodeIndex]` gives the handler's call-counts against the top-3
   *  helpers - the structural foundation for per-opcode argcount
   *  inference (byte/halfword/word discrimination is left to a later
   *  semantic/corpus-signature pass). */
  readonly opcodeHelperCallProfiles: ReadonlyArray<OpcodeHelperProfile>;
  /** P6-T3: aggregate histogram of opcodes by `totalHelperCalls` bucket.
   *  E.g. `{"0": 56, "2": 8}` means 56 opcodes call 0 top-helpers and
   *  8 opcodes call 2 top-helpers. Reveals the engine's argcount
   *  distribution shape. */
  readonly helperCallHistogram: Readonly<Record<string, number>>;
}

export const scriptEngineDetector: RomDetector<ScriptEngineReport> = {
  id: SCRIPT_ENGINE_DETECTOR_ID,
  name: 'Script Engine (Gen-3 gScriptCmdTable scanner)',
  phase: 6,
  detect(rom: RomImage, coverage: CoverageMap): Detection<ScriptEngineReport> {
    if (
      rom.byteLength <
      SCRIPT_OPCODE_TABLE_MIN_ENTRIES * SCRIPT_OPCODE_TABLE_ENTRY_SIZE_BYTES
    ) {
      return makeNotDetected({
        confidence: 1.0,
        evidence: [
          makeEvidence({
            kind: 'heuristic',
            summary: `ROM is ${String(rom.byteLength)} bytes - too small to host a ≥${String(SCRIPT_OPCODE_TABLE_MIN_ENTRIES)}-entry script opcode table`,
            weight: 1.0,
          }),
        ],
        reason: 'ROM too small to scan for Gen-3 script opcode table',
      });
    }

    const opcodeTable = scanScriptOpcodeTable(rom.bytes);
    if (opcodeTable === null) {
      return makeNotDetected({
        confidence: 0.85,
        evidence: [
          makeEvidence({
            kind: 'heuristic',
            summary: `scanned ${String(rom.byteLength)} bytes for a run of ≥${String(SCRIPT_OPCODE_TABLE_MIN_ENTRIES)} ROM-pointer-to-Thumb-prologue entries - none found`,
            weight: 1.0,
            detail: {
              romByteLength: rom.byteLength,
              minOpcodesRequired: SCRIPT_OPCODE_TABLE_MIN_ENTRIES,
            },
          }),
        ],
        reason:
          'No Gen-3 script opcode table found - either the ROM is non-Gen-3, the script engine has been rewritten with a non-dispatch-table architecture, or the table moved to a region where consecutive entries no longer point at Thumb function prologues',
      });
    }

    try {
      coverage.addClassified({
        start: opcodeTable.tableStart,
        end: opcodeTable.tableEndExclusive,
        probableClass: 'pointer_network',
        score: 0.9,
        provenance: `${SCRIPT_ENGINE_DETECTOR_ID}#gScriptCmdTable`,
        note: `Gen-3 gScriptCmdTable (${String(opcodeTable.opcodeCount)} opcodes${opcodeTable.anyThumbTaggedPointer ? ', some thumb-tagged' : ''})`,
      });
    } catch {
      // Overlap with an earlier pointer-network hotspot - skip.
    }

    // Confidence scales with opcode count. Vanilla FireRed has ~229
    // opcodes; Emerald ~227; CFRU ~250+. A run of 200+ is essentially
    // certain to be the real table; 64-100 is plausible (heavily-
    // stripped engines); 100-200 strong.
    const confidence =
      opcodeTable.opcodeCount >= 200
        ? 0.95
        : opcodeTable.opcodeCount >= 100
          ? 0.9
          : 0.8;

    // P6-T2: analyze each handler's Thumb BL calls to identify common
    // helper functions (ScriptReadByte/Halfword/Word et al.).
    const handlersAnalysis = analyzeScriptHandlers(
      rom.bytes,
      opcodeTable.handlerOffsets,
    );

    // P6-T3: per-opcode helper-call profile using the top-3 helpers.
    const top3HelperOffsets = handlersAnalysis.commonHelperFunctions
      .slice(0, 3)
      .map((h) => h.offset);
    const opcodeHelperCallProfiles = inferOpcodeHelperProfiles(
      rom.bytes,
      opcodeTable.handlerOffsets,
      top3HelperOffsets,
    );
    const callHistogram = helperCallHistogram(opcodeHelperCallProfiles);

    const engineKind: ScriptEngineKind =
      opcodeTable.opcodeCount < 100
        ? 'undersized'
        : opcodeTable.opcodeCount <= 230
          ? 'vanilla-range'
          : opcodeTable.opcodeCount <= 300
            ? 'extended'
            : 'heavily-extended';

    return makeDetected({
      confidence,
      data: Object.freeze({
        opcodeTable,
        opcodeCount: opcodeTable.opcodeCount,
        engineKind,
        commonHelperFunctions: handlersAnalysis.commonHelperFunctions,
        opcodeHelperCallProfiles,
        helperCallHistogram: callHistogram,
      }),
      evidence: [
        makeEvidence({
          kind: 'heuristic',
          summary: `Found gScriptCmdTable at offset 0x${opcodeTable.tableStart.toString(16)} (${String(opcodeTable.opcodeCount)} opcodes, engineKind=${engineKind}${handlersAnalysis.commonHelperFunctions.length > 0 ? `; top helper called ${String(handlersAnalysis.commonHelperFunctions[0]?.callCount)} times across ${String(handlersAnalysis.commonHelperFunctions[0]?.callerCount)} handlers` : ''})`,
          weight: 1.0,
          detail: {
            tableStart: opcodeTable.tableStart,
            tableEndExclusive: opcodeTable.tableEndExclusive,
            opcodeCount: opcodeTable.opcodeCount,
            engineKind,
            anyThumbTaggedPointer: opcodeTable.anyThumbTaggedPointer,
            commonHelperCount: handlersAnalysis.commonHelperFunctions.length,
            helperCallHistogram: callHistogram,
          },
        }),
      ],
    });
  },
};
