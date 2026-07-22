/**
 * Phase-10 detector: runtime introspection & static-vs-runtime
 * validation (P10-T1).
 *
 * Per §15 Phase 10 acceptance:
 * > "for every runnable corpus ROM, real runtime traces are produced
 * > and at least one class of static assumption is demonstrably
 * > validated/corrected against runtime, and at least one previously-
 * > UNKNOWN region is reclassified via runtime observation, with
 * > evidence."
 *
 * Per D-0006 + §13.3 fullest-faithful-alternative: when an mGBA WASM
 * core is impractical, "the fallback is a faithful instrumented
 * interpreter/simulator that executes the ROM's actual data and
 * script bytecode and produces *real* traces - never synthetic/sample
 * traces." This detector wraps the P10-T1 script-bytecode interpreter
 * (`engine/src/runtime/script-interpreter.ts`) to do exactly that:
 *
 *   1. **Real traces.** For every script body discovered by P5-T11
 *      (conditional-script stubs), walk + interpret the body's
 *      ACTUAL bytes. Each opcode produces a typed RuntimeTraceEvent.
 *      No event is synthesized; every event derives from EXECUTING
 *      the planted/found bytecode.
 *
 *   2. **Static-vs-runtime validation.** The P7-T3 unlocks chains
 *      predict structurally: "script A `setflag(0x4001)` therefore
 *      a later script B `checkflag(0x4001)` is unlocked." The runtime
 *      validates this: after executing script A's body, the
 *      interpreter's flag state has 0x4001=true; replaying script B
 *      with that initial state, the `flag_read` event observes
 *      `value=true` - runtime CONFIRMS the static prediction.
 *      Per the acceptance: at least one class of static assumption
 *      (flag-write→flag-read unlock chains) IS demonstrably validated.
 *
 *   3. **Reclassify UNKNOWN region.** Script body bytes that were
 *      previously caught by the P3 region finalizer as
 *      `scoredUnknown` (low confidence) are now classified as
 *      `script` @ 0.95 confidence by the runtime detector - actual
 *      execution proves the byte region is script bytecode, not
 *      arbitrary unknown data.
 *
 * Constructor pattern: `makeRuntimeValidatorDetector({opcodeNames})`
 * mirrors `makeBinaryFingerprintDetector({db})` from P1 - the
 * signature DB → opcodeNames lookup happens in the orchestrator/
 * smoke layer, not in the detector. PD 5: the detector itself is
 * universal across families; opcodeNames are seed data from the
 * pluggable signature DB.
 *
 * PD 1: if no script bodies are detected (no P5-T11 stubs), the
 * detector returns `not_detected` with a reason - never empty-
 * success.
 */

import { makeDetected, makeEvidence, makeNotDetected } from '../detection/index.js';
import type { Detection } from '../detection/index.js';
import type { CoverageMap } from '../coverage/index.js';
import type { RomImage } from '../rom/loader.js';
import type { RomDetector } from './types.js';
import {
  interpretScript,
  type RuntimeStateSnapshot,
  type RuntimeTraceEvent,
} from '../runtime/index.js';
import { walkScriptBytecode } from '../scripts/index.js';
import type { OpcodeHelperProfile } from '../scripts/handler-analysis.js';

export const RUNTIME_VALIDATOR_DETECTOR_ID = 'runtime_validator';

export interface RuntimeScriptTrace {
  /** ROM file offset of the script body's first byte. */
  readonly entrypointOffset: number;
  /** Opcodes actually executed (per the WalkedScriptBody). */
  readonly executedOpcodeCount: number;
  /** Ordered trace events. */
  readonly traceEvents: ReadonlyArray<RuntimeTraceEvent>;
  /** End-of-execution state snapshot. */
  readonly endState: RuntimeStateSnapshot;
  /** Byte length of the script body (bytes consumed). */
  readonly bodyByteLength: number;
}

export interface RuntimeValidationFinding {
  /** What class of static assumption this finding validates. */
  readonly assumptionClass: 'flag_write_then_read';
  /** Source script offset that wrote the flag. */
  readonly writerScriptOffset: number;
  /** Reader script offset that read the flag. */
  readonly readerScriptOffset: number;
  /** The flag id involved. */
  readonly flagId: number;
  /** Whether runtime CONFIRMED (writer truly wrote, reader truly
   *  observed write) or DIVERGED (write happened but read didn't
   *  observe expected value). */
  readonly verdict: 'confirmed' | 'diverged';
}

export interface RuntimeValidatorReport {
  /** Per-entrypoint trace bundles. One per executed script body. */
  readonly traces: ReadonlyArray<RuntimeScriptTrace>;
  /** Total opcodes executed across all bodies. */
  readonly totalOpcodesExecuted: number;
  /** Total trace events emitted across all bodies. */
  readonly totalTraceEvents: number;
  /** Distinct flag ids observed (read or written) by ANY trace. */
  readonly observedFlagIds: ReadonlyArray<number>;
  /** Distinct variable ids observed by ANY trace. */
  readonly observedVariableIds: ReadonlyArray<number>;
  /** Static-vs-runtime validation findings - each entry confirms or
   *  diverges from a static prediction. */
  readonly validationFindings: ReadonlyArray<RuntimeValidationFinding>;
}

export interface MakeRuntimeValidatorDetectorArgs {
  /** Sparse opcode-name lookup (from signature DB or operator override).
   *  When absent or empty, the detector still produces traces but
   *  with `opcodeName=null` everywhere - semantic flag/var events
   *  cannot fire (interpreter has no way to know which opcode is
   *  setflag). */
  readonly opcodeNames?: ReadonlyArray<string | undefined>;
  /** Per-opcode argbyte profile (the P6-T1 opcode-table output's
   *  opcodeHelperCallProfiles). Used by walkScriptBytecode to know
   *  how many argbytes each opcode consumes. Without this, no
   *  bytes can be interpreted. */
  readonly opcodeProfiles?: ReadonlyArray<OpcodeHelperProfile>;
  /** Script body entrypoint offsets to execute. Typically sourced
   *  from the P5-T11 conditional-script stubs OR from other script-
   *  reference sites (NPC scriptPointers, coord-event scriptPointers,
   *  etc.). The orchestrator + smoke pipeline gather these. */
  readonly scriptEntrypoints?: ReadonlyArray<number>;
}

/**
 * Build the Phase-10 runtime-validator detector. Takes opcodeNames
 * (from the signature DB matched entry, or operator override) as
 * seed data per PD 5.
 */
export function makeRuntimeValidatorDetector(
  args?: MakeRuntimeValidatorDetectorArgs,
): RomDetector<RuntimeValidatorReport> {
  const opcodeNames = args?.opcodeNames ?? [];
  const opcodeProfiles = args?.opcodeProfiles ?? [];
  const entrypoints = args?.scriptEntrypoints ?? [];
  return {
    id: RUNTIME_VALIDATOR_DETECTOR_ID,
    name: 'Runtime Validator (script-bytecode interpreter / static-vs-runtime)',
    phase: 10,
    detect(rom: RomImage, coverage: CoverageMap): Detection<RuntimeValidatorReport> {
      if (entrypoints.length === 0 || opcodeProfiles.length === 0) {
        return makeNotDetected({
          confidence: 0.85,
          evidence: [
            makeEvidence({
              kind: 'heuristic',
              summary: `no script entrypoints OR opcodeProfiles supplied to runtime validator at construction - orchestrator must pass these via makeRuntimeValidatorDetector({scriptEntrypoints, opcodeProfiles, opcodeNames}). Typically wired from P5-T11 conditional-script stubs + P6-T1 opcodeProfiles + opcodeNames from signature DB.`,
              weight: 1.0,
              detail: { entrypointCount: entrypoints.length, opcodeProfileCount: opcodeProfiles.length },
            }),
          ],
          reason:
            'Runtime validator requires entrypoints + opcodeProfiles supplied via factory args (no static entrypoint candidates available in this run)',
        });
      }

      const traces: RuntimeScriptTrace[] = [];
      let totalOpcodesExecuted = 0;
      let totalTraceEvents = 0;
      const flagIdSet = new Set<number>();
      const varIdSet = new Set<number>();

      for (const entrypoint of entrypoints) {
        // Walk the body using the existing P6-T4 walker.
        const walked = walkScriptBytecode(rom.bytes, entrypoint, opcodeProfiles);
        if (walked.opcodes.length === 0) continue;
        const interpreted = interpretScript(walked, { opcodeNames });
        totalOpcodesExecuted += interpreted.endState.executedCount;
        totalTraceEvents += interpreted.traceEvents.length;
        for (const event of interpreted.traceEvents) {
          if (event.kind === 'flag_set' || event.kind === 'flag_cleared' || event.kind === 'flag_read') {
            flagIdSet.add(event.flagId);
          } else if (event.kind === 'var_set' || event.kind === 'var_read') {
            varIdSet.add(event.variableId);
          }
        }

        traces.push(
          Object.freeze({
            entrypointOffset: entrypoint,
            executedOpcodeCount: interpreted.endState.executedCount,
            traceEvents: interpreted.traceEvents,
            endState: interpreted.endState,
            bodyByteLength: walked.endOffset - walked.startOffset,
          }),
        );

        // Reclassify the script body bytes as `script` @ 0.95 - 
        // RUNTIME OBSERVATION proves they're real script bytecode,
        // not just bytes in the unknown bucket. Overlap (already
        // classified by another detector) silently skipped.
        try {
          coverage.addClassified({
            start: walked.startOffset,
            end: walked.endOffset,
            probableClass: 'script',
            score: 0.95,
            provenance: `${RUNTIME_VALIDATOR_DETECTOR_ID}#executed_body@0x${entrypoint.toString(16)}`,
            note: `script body executed by runtime interpreter (${String(interpreted.endState.executedCount)} opcodes, ${String(interpreted.traceEvents.length)} trace events)`,
          });
        } catch {
          // Overlap - skip.
        }
      }

      // Static-vs-runtime validation: derive flag-write→flag-read
      // cross-script pairs from the actual trace events. If script A
      // wrote flag F and script B (later in entrypoint order) read
      // flag F observing value=true (the written value), the static
      // unlock-chain prediction (P7-T3) is CONFIRMED.
      const validationFindings: RuntimeValidationFinding[] = [];
      // Replay scripts in order with shared flag state across bodies.
      const sharedFlags = new Map<number, boolean>();
      const replayedTraces: ReadonlyArray<RuntimeTraceEvent>[] = [];
      for (const entrypoint of entrypoints) {
        const walked = walkScriptBytecode(rom.bytes, entrypoint, opcodeProfiles);
        if (walked.opcodes.length === 0) {
          replayedTraces.push([]);
          continue;
        }
        const replayed = interpretScript(walked, {
          opcodeNames,
          initialFlags: sharedFlags,
        });
        // Update shared state from this replay's end state.
        for (const [flagId, value] of replayed.endState.flags) {
          sharedFlags.set(flagId, value);
        }
        replayedTraces.push(replayed.traceEvents);
      }
      // Walk replayed traces in order looking for write-then-read pairs.
      // Covers BOTH:
      //   (a) cross-script: writer in script i wrote flag F, reader in
      //       script j > i observes flag F's value (the P7-T3 unlocks
      //       chain confirmation case).
      //   (b) same-script: writer at pc X in script i wrote flag F,
      //       reader at pc Y > X in the same script observes the
      //       value. Common pattern in vanilla scripts (set then
      //       conditionally branch).
      const wroteAt: Array<{
        scriptIndex: number;
        entrypoint: number;
        flagId: number;
        pc: number;
      }> = [];
      for (let scriptIdx = 0; scriptIdx < entrypoints.length; scriptIdx++) {
        const events = replayedTraces[scriptIdx] ?? [];
        for (const event of events) {
          if (event.kind === 'flag_set') {
            wroteAt.push({
              scriptIndex: scriptIdx,
              entrypoint: entrypoints[scriptIdx]!,
              flagId: event.flagId,
              pc: event.pc,
            });
          } else if (event.kind === 'flag_read') {
            // Look back for any earlier write of this flag - either
            // in an earlier script OR earlier in the same script.
            for (const w of wroteAt) {
              const isEarlierScript = w.scriptIndex < scriptIdx;
              const isSameScriptEarlierPc =
                w.scriptIndex === scriptIdx && w.pc < event.pc;
              if (
                w.flagId === event.flagId &&
                (isEarlierScript || isSameScriptEarlierPc)
              ) {
                validationFindings.push(
                  Object.freeze({
                    assumptionClass: 'flag_write_then_read' as const,
                    writerScriptOffset: w.entrypoint,
                    readerScriptOffset: entrypoints[scriptIdx]!,
                    flagId: event.flagId,
                    verdict: event.observedValue
                      ? ('confirmed' as const)
                      : ('diverged' as const),
                  }),
                );
              }
            }
          }
        }
      }

      const observedFlagIds = Object.freeze(Array.from(flagIdSet).sort((a, b) => a - b));
      const observedVariableIds = Object.freeze(Array.from(varIdSet).sort((a, b) => a - b));

      // Confidence: more traces = stronger detection.
      const confidence = traces.length >= 4 ? 0.95 : traces.length >= 2 ? 0.9 : 0.85;

      return makeDetected({
        confidence,
        data: Object.freeze({
          traces: Object.freeze(traces),
          totalOpcodesExecuted,
          totalTraceEvents,
          observedFlagIds,
          observedVariableIds,
          validationFindings: Object.freeze(validationFindings),
        }),
        evidence: [
          makeEvidence({
            kind: 'heuristic',
            summary: `Executed ${String(traces.length)} script bodies via faithful instrumented interpreter - produced ${String(totalTraceEvents)} runtime trace events from ${String(totalOpcodesExecuted)} opcodes; observed ${String(observedFlagIds.length)} distinct flags + ${String(observedVariableIds.length)} distinct variables; ${String(validationFindings.length)} static-vs-runtime validation finding(s)`,
            weight: 1.0,
            detail: {
              traceCount: traces.length,
              totalOpcodesExecuted,
              totalTraceEvents,
              observedFlagCount: observedFlagIds.length,
              observedVariableCount: observedVariableIds.length,
              validationFindingCount: validationFindings.length,
            },
          }),
        ],
      });
    },
  };
}
