/**
 * Cross-script `unlocks` chain derivation (P7-T3).
 *
 * For every `variable` node in the relationship graph, find the set
 * of distinct writers (sources of incoming `sets_flag` edges) and
 * the set of distinct readers (sources of incoming `reads_flag` AND
 * `gates_on` edges). The cross product (writer, reader) where
 * writer ≠ reader represents a causal chain: writing the variable
 * unlocks any script that subsequently reads/gates-on it.
 *
 * Emits as `unlocks` typed edges (already declared in EdgeKind).
 *
 * Honest scope: this is the STATIC chain derivation - it captures
 * every (writer, reader) pair without resolving execution-order or
 * actually-reachable runtime sequences (those require Phase 10
 * runtime tracing). PD 4: every chain is documented with the
 * via-variable id + reader-edge-kind on the edge detail so consumers
 * can interpret whether the chain is a flag-gate ("setflag X →
 * script gated_on X") or a compare-branch ("setvar X → script
 * compare_var_to_value X").
 *
 * PD 5: derivation is purely from graph structure (already-emitted
 * sets_flag/reads_flag/gates_on edges from P5-T11 + P7-T1). No
 * baked variable-id → meaning table.
 */

import type { RelationshipGraph } from '../graph/graph.js';

/** One derived unlock chain. */
export interface UnlockChain {
  /** Node id of the WRITER (the script that wrote the variable). */
  readonly writerNodeId: string;
  /** Node id of the READER (the script that reads / gates on the variable). */
  readonly readerNodeId: string;
  /** Node id of the variable that mediates the chain. */
  readonly viaVariableNodeId: string;
  /** Numeric variable id parsed from the variable node's detail.varId. */
  readonly viaVariableId: number | null;
  /** The reader's edge kind: 'reads_flag' (compare/checkflag site) or
   *  'gates_on' (P5-T11 conditional-stub gate). When the SAME writer
   *  →reader pair shows up in both incoming-edge kinds for the same
   *  variable, we emit ONE unlock with kind='reads_flag' (more
   *  specific). */
  readonly readerEdgeKind: 'reads_flag' | 'gates_on';
}

/**
 * Walk every `variable` node in the graph + derive (writer, reader)
 * unlock chains via shared variables. Excludes self-loops. Order-
 * stable: variables sorted by id, writers within a variable sorted
 * by id, readers within a writer sorted by id.
 */
export function deriveUnlockChains(graph: RelationshipGraph): ReadonlyArray<UnlockChain> {
  const chains: UnlockChain[] = [];
  const variables = graph
    .allNodes()
    .filter((n) => n.kind === 'variable')
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  for (const variable of variables) {
    const incoming = graph.incoming(variable.id);
    const writers = new Set<string>();
    // reader source-id → preferred edgeKind ('reads_flag' wins over 'gates_on'
    // when both are present from the same source).
    const readers = new Map<string, 'reads_flag' | 'gates_on'>();
    for (const e of incoming) {
      if (e.kind === 'sets_flag') {
        writers.add(e.from);
      } else if (e.kind === 'reads_flag') {
        readers.set(e.from, 'reads_flag');
      } else if (e.kind === 'gates_on') {
        // Only set if not already present (reads_flag wins).
        if (!readers.has(e.from)) readers.set(e.from, 'gates_on');
      }
    }
    const viaVariableId =
      typeof variable.detail?.varId === 'number' ? variable.detail.varId : null;
    const sortedWriters = Array.from(writers).sort();
    const sortedReaders = Array.from(readers.entries()).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    for (const writerNodeId of sortedWriters) {
      for (const [readerNodeId, readerEdgeKind] of sortedReaders) {
        if (writerNodeId === readerNodeId) continue; // self-loop
        chains.push(
          Object.freeze({
            writerNodeId,
            readerNodeId,
            viaVariableNodeId: variable.id,
            viaVariableId,
            readerEdgeKind,
          }),
        );
      }
    }
  }
  return Object.freeze(chains);
}
