/**
 * Gen-3 script variable role inference (P7-T2).
 *
 * Classifies a script-engine variable by its usage pattern, derived
 * from the set of edges incoming to its graph node (`sets_flag` /
 * `reads_flag` / `gates_on`) and the opcode names that drove those
 * edges (from the matched signature DB).
 *
 * Two orthogonal axes:
 *  - KIND: flag-bit (accessed only via setflag/clearflag/checkflag)
 *    vs multi-value-var (accessed via setvar/addvar/compare_var_to_*).
 *  - ACTIVITY: write-only / read-only / progression-gate / read-write.
 *
 * The combined `VariableRole` is the cross-product. Roles drive UI
 * grouping ("show me all progression flags this hack adds") and
 * downstream Phase-7 semantic inference ("variable Vx is set by
 * script Sa, then gated-on by script Sb - Vx is the cause of Sb").
 *
 * PD 5: classifications are derived from observed graph edges + opcode
 * names from the signature DB, never from a baked variable-id → role
 * lookup table.
 */

/** Names of opcodes that operate on bit-flags (not multi-value vars). */
const FLAG_BIT_OP_NAMES: ReadonlySet<string> = new Set([
  'setflag',
  'clearflag',
  'checkflag',
]);

/** Names of opcodes that operate on multi-value u16 vars. */
const MULTI_VALUE_OP_NAMES: ReadonlySet<string> = new Set([
  'setvar',
  'addvar',
  'subvar',
  'copyvar',
  'setorcopyvar',
  'compare_var_to_value',
  'compare_var_to_var',
]);

/** Edge kinds that a variable is a target of, in this analysis. */
export type VariableIncomingEdgeKind = 'sets_flag' | 'reads_flag' | 'gates_on';

/** Aggregated profile of accesses to a single variable. */
export interface VariableUsageProfile {
  /** Total sets_flag edges incoming. */
  readonly setsCount: number;
  /** Total reads_flag edges incoming. */
  readonly readsCount: number;
  /** Total gates_on edges incoming. */
  readonly gatesCount: number;
  /** Count of edges where the source opcode is in FLAG_BIT_OP_NAMES. */
  readonly flagBitOpCount: number;
  /** Count of edges where the source opcode is in MULTI_VALUE_OP_NAMES. */
  readonly multiValueOpCount: number;
  /** Unique opcode names observed across all accesses. Sorted for
   *  determinism. */
  readonly opcodeNames: ReadonlyArray<string>;
}

/** Discriminated role classification. UNREFERENCED means no edges
 *  incoming - shouldn't happen if the variable node only exists when
 *  referenced, but defensive. */
export type VariableRole =
  | 'FLAG_BIT_WRITE_ONLY'
  | 'FLAG_BIT_READ_ONLY'
  | 'FLAG_BIT_PROGRESSION_GATE'
  | 'FLAG_BIT_READ_WRITE'
  | 'MULTI_VALUE_WRITE_ONLY'
  | 'MULTI_VALUE_READ_ONLY'
  | 'MULTI_VALUE_PROGRESSION_GATE'
  | 'MULTI_VALUE_READ_WRITE'
  | 'MIXED_KIND'
  | 'UNREFERENCED';

/** One access record contributed by an incoming edge to the variable. */
export interface VariableAccessRecord {
  readonly edgeKind: VariableIncomingEdgeKind;
  /** Opcode name from the edge's detail (undefined for `gates_on` edges
   *  emitted by P5-T11 - those come from a stub-table predicate, not
   *  from an opcode). */
  readonly opcodeName?: string;
}

/**
 * Aggregate a list of `VariableAccessRecord`s into a usage profile.
 * Counts each edge once; classifies each by FLAG_BIT vs MULTI_VALUE
 * based on opcode name (gates_on edges contribute to gatesCount but
 * NOT to flagBitOpCount/multiValueOpCount since they don't have a
 * read/write opcode behind them).
 */
export function aggregateVariableUsage(
  records: ReadonlyArray<VariableAccessRecord>,
): VariableUsageProfile {
  let setsCount = 0;
  let readsCount = 0;
  let gatesCount = 0;
  let flagBitOpCount = 0;
  let multiValueOpCount = 0;
  const names = new Set<string>();
  for (const r of records) {
    if (r.edgeKind === 'sets_flag') setsCount += 1;
    else if (r.edgeKind === 'reads_flag') readsCount += 1;
    else if (r.edgeKind === 'gates_on') gatesCount += 1;
    if (r.opcodeName !== undefined) {
      names.add(r.opcodeName);
      if (FLAG_BIT_OP_NAMES.has(r.opcodeName)) flagBitOpCount += 1;
      else if (MULTI_VALUE_OP_NAMES.has(r.opcodeName)) multiValueOpCount += 1;
    }
  }
  return Object.freeze({
    setsCount,
    readsCount,
    gatesCount,
    flagBitOpCount,
    multiValueOpCount,
    opcodeNames: Object.freeze(Array.from(names).sort()),
  });
}

/**
 * Derive a `VariableRole` from a usage profile. The KIND axis (flag-
 * bit vs multi-value) is determined by which set of opcode names was
 * observed; the ACTIVITY axis (write-only/read-only/progression-gate/
 * read-write) is from set/read/gate counts. Mixed-kind variables
 * (accessed via BOTH flag-bit AND multi-value opcodes) are flagged as
 * MIXED_KIND - typically indicates a hack that overloads a bit-flag id
 * onto a u16 variable address (or vice-versa) and warrants attention.
 */
export function classifyVariableRole(profile: VariableUsageProfile): VariableRole {
  const { setsCount, readsCount, gatesCount, flagBitOpCount, multiValueOpCount } = profile;

  if (setsCount === 0 && readsCount === 0 && gatesCount === 0) {
    return 'UNREFERENCED';
  }
  // Kind discriminator
  let kind: 'FLAG_BIT' | 'MULTI_VALUE' | 'MIXED';
  if (flagBitOpCount > 0 && multiValueOpCount > 0) kind = 'MIXED';
  else if (flagBitOpCount > 0) kind = 'FLAG_BIT';
  else if (multiValueOpCount > 0) kind = 'MULTI_VALUE';
  else kind = 'FLAG_BIT'; // only gates_on edges → bias to FLAG_BIT (gates check single bit conventionally)
  if (kind === 'MIXED') return 'MIXED_KIND';

  // Activity discriminator
  const hasWrites = setsCount > 0;
  const hasReads = readsCount > 0 || gatesCount > 0; // gates_on IS a read
  const hasGates = gatesCount > 0;

  let activity: 'WRITE_ONLY' | 'READ_ONLY' | 'PROGRESSION_GATE' | 'READ_WRITE';
  if (hasGates && hasWrites) activity = 'PROGRESSION_GATE';
  else if (hasWrites && !hasReads) activity = 'WRITE_ONLY';
  else if (!hasWrites && hasReads) activity = 'READ_ONLY';
  else activity = 'READ_WRITE';

  // Compose
  if (kind === 'FLAG_BIT') {
    return `FLAG_BIT_${activity}` as VariableRole;
  }
  return `MULTI_VALUE_${activity}` as VariableRole;
}
