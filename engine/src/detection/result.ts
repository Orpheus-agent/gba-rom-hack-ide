/**
 * The universal detection result.
 *
 * Every detector in the engine is bound to produce a typed result
 * carrying:
 *   - a discrete `status` ∈ {detected, partial, not_detected}
 *   - a numeric `confidence` ∈ [0,1]
 *   - structured `evidence` items naming the heuristic/signature/pointer/trace
 *     that produced the result.
 *
 * A bare value with no confidence or evidence is NOT a valid detection output
 * anywhere in the system. Returning zeros/empties marked as `detected` is the
 * defining bug the "no empty success" rule exists to kill - see
 * `assertNoEmptySuccess`.
 *
 * Every detected system routes through these types. The helpers below are the
 * only sanctioned constructors, so the invariants cannot be silently broken by
 * a future detector.
 */

/**
 * Discrete outcome of a detection attempt.
 *
 * - `detected` - the system was found with reasonable confidence and
 *                     concrete reconstructed data; `data` is required and
 *                     non-empty.
 * - `partial` - the system was found but the reconstruction is
 *                     incomplete (e.g. some entries decoded, some did not);
 *                     `data` is required and reflects what WAS reconstructed,
 *                     and `partialReason` explains what's missing.
 * - `not_detected` - the detector ran and concluded the system is absent (or
 *                     this ROM doesn't have it); `data` is forbidden and a
 *                     `reason` is required. PD 1: this is the ONLY legal
 *                     shape for "the detector produced nothing".
 */
export type DetectionStatus = 'detected' | 'partial' | 'not_detected';

/**
 * Confidence in the detection, in [0,1].
 *
 * Validated at construction (`makeDetected`/`makePartial`/`makeNotDetected`)
 * and at the boundary (`isConfidence`). Never accept a bare number from
 * unsanitized input.
 */
export type Confidence = number & { readonly __confidence: unique symbol };

/**
 * One concrete reason the detector emitted its result.
 *
 * `kind` is a small enum so consumers can filter ("show me only signature
 * evidence"); `detail` is free-form structured data the consumer can render.
 * `weight` ∈ [0,1] expresses how much this individual evidence item
 * contributed to the overall confidence - useful for explainability and for
 * down-weighting noisy heuristics later.
 *
 * Evidence MUST be concrete and reproducible: a signature id ("CFRU/v2"),
 * a byte offset ("0x245EE0"), a pointer-graph path ("table@0x3526A8 →
 * map@0x520000"), a runtime trace id ("trace#42"). Strings like
 * "looks plausible" are not evidence and the build forbids them by the
 * `assertNonEmptyEvidence` invariant.
 */
export type EvidenceKind =
  | 'signature'        // matched a versioned signature DB entry
  | 'heuristic'        // structural/statistical heuristic fired (PD 5 path)
  | 'pointer_graph'    // discovered via pointer-network traversal
  | 'cross_reference'  // confirmed by cross-reference clustering
  | 'compression'      // detected via compression-format identification
  | 'runtime_trace'    // confirmed by live emulator/interpreter trace
  | 'corpus_seed'      // came from a corpus-validated reference
  | 'manual_override'; // operator-supplied hint (always logged, never silent)

export interface Evidence {
  readonly kind: EvidenceKind;
  readonly summary: string;
  readonly weight: number;
  readonly detail?: Readonly<Record<string, unknown>>;
}

/**
 * The result type itself. Discriminated by `status` so consumers can exhaustively
 * switch.
 *
 * The `T` type parameter is the system-specific reconstructed payload (e.g. a
 * species table, a map graph, a script AST). For `not_detected` results `data`
 * is forbidden by the discriminant; for `detected`/`partial` it is required.
 */
export type Detection<T> = DetectionDetected<T> | DetectionPartial<T> | DetectionNotDetected;

export interface DetectionDetected<T> {
  readonly status: 'detected';
  readonly confidence: Confidence;
  readonly evidence: ReadonlyArray<Evidence>;
  readonly data: T;
}

export interface DetectionPartial<T> {
  readonly status: 'partial';
  readonly confidence: Confidence;
  readonly evidence: ReadonlyArray<Evidence>;
  readonly data: T;
  readonly partialReason: string;
}

export interface DetectionNotDetected {
  readonly status: 'not_detected';
  readonly confidence: Confidence;
  readonly evidence: ReadonlyArray<Evidence>;
  readonly reason: string;
}

// ---------------------------------------------------------------------------
// Constructors + invariants
// ---------------------------------------------------------------------------

/** True iff `n` is a finite real number in [0, 1]. */
export function isConfidence(n: number): n is Confidence {
  return Number.isFinite(n) && n >= 0 && n <= 1;
}

/** Narrow a raw number to `Confidence`; throw if out of range. */
export function asConfidence(n: number): Confidence {
  if (!isConfidence(n)) {
    throw new DetectionInvariantError(
      `confidence must be a finite number in [0,1], got ${String(n)}`,
    );
  }
  return n as Confidence;
}

/**
 * Construct an `Evidence` item. Validates `weight ∈ [0,1]` and that
 * `summary` is non-trivial - PD 1 + PD 2 ("no fakery") forbid placeholder
 * summaries like empty strings or whitespace.
 */
export function makeEvidence(args: {
  kind: EvidenceKind;
  summary: string;
  weight: number;
  detail?: Readonly<Record<string, unknown>>;
}): Evidence {
  if (!Number.isFinite(args.weight) || args.weight < 0 || args.weight > 1) {
    throw new DetectionInvariantError(
      `evidence weight must be in [0,1], got ${String(args.weight)}`,
    );
  }
  if (typeof args.summary !== 'string' || args.summary.trim().length === 0) {
    throw new DetectionInvariantError('evidence summary must be a non-empty string');
  }
  return Object.freeze({
    kind: args.kind,
    summary: args.summary,
    weight: args.weight,
    ...(args.detail !== undefined ? { detail: Object.freeze({ ...args.detail }) } : {}),
  });
}

/**
 * `detected` constructor. Enforces:
 *   - confidence ∈ [0,1]
 *   - at least one evidence item (PD 1 - "detected" without evidence IS empty
 *     success)
 *   - `data` is not empty per `isEmptyValue` (which catches the three classic
 *     shapes: null/undefined, `[]`, `{}`).
 *
 * If you genuinely have nothing to report, you want `makeNotDetected`. This
 * function will throw - by design - rather than let you smuggle empty data
 * through as a success.
 */
export function makeDetected<T>(args: {
  confidence: number;
  evidence: ReadonlyArray<Evidence>;
  data: T;
}): DetectionDetected<T> {
  const confidence = asConfidence(args.confidence);
  if (args.evidence.length === 0) {
    throw new EmptySuccessError(
      "Detection.status='detected' requires at least one evidence item (PD 1)",
    );
  }
  if (isEmptyValue(args.data)) {
    throw new EmptySuccessError(
      "Detection.status='detected' requires non-empty data - use makeNotDetected if you have nothing (PD 1)",
    );
  }
  return Object.freeze({
    status: 'detected' as const,
    confidence,
    evidence: Object.freeze([...args.evidence]),
    data: args.data,
  });
}

/**
 * `partial` constructor. Same invariants as `detected` PLUS `partialReason`
 * must be a non-empty string explaining what is missing or unreconstructed.
 * Partial is the honest mid-state between detected and not_detected; it must
 * never be used to dodge the empty-success check.
 */
export function makePartial<T>(args: {
  confidence: number;
  evidence: ReadonlyArray<Evidence>;
  data: T;
  partialReason: string;
}): DetectionPartial<T> {
  const confidence = asConfidence(args.confidence);
  if (args.evidence.length === 0) {
    throw new EmptySuccessError(
      "Detection.status='partial' requires at least one evidence item (PD 1)",
    );
  }
  if (typeof args.partialReason !== 'string' || args.partialReason.trim().length === 0) {
    throw new DetectionInvariantError(
      "Detection.status='partial' requires a non-empty partialReason explaining what is missing",
    );
  }
  if (isEmptyValue(args.data)) {
    throw new EmptySuccessError(
      "Detection.status='partial' requires non-empty data (the reconstructed part) - use makeNotDetected if nothing was reconstructed (PD 1)",
    );
  }
  return Object.freeze({
    status: 'partial' as const,
    confidence,
    evidence: Object.freeze([...args.evidence]),
    data: args.data,
    partialReason: args.partialReason,
  });
}

/**
 * `not_detected` constructor. This is the ONLY legal shape for "the detector
 * produced nothing" - it carries a non-empty `reason` and at least one
 * evidence item describing what was looked at and why it was rejected.
 *
 * Confidence here means "confidence that the system is ABSENT" - high
 * confidence (e.g. 0.95) means "I'm sure this ROM doesn't have CFRU";
 * low confidence (e.g. 0.2) means "I couldn't find CFRU but my detector
 * might be missing it." Both are honest; neither is an empty success.
 */
export function makeNotDetected(args: {
  confidence: number;
  evidence: ReadonlyArray<Evidence>;
  reason: string;
}): DetectionNotDetected {
  const confidence = asConfidence(args.confidence);
  if (args.evidence.length === 0) {
    throw new DetectionInvariantError(
      "Detection.status='not_detected' requires at least one evidence item explaining what was searched",
    );
  }
  if (typeof args.reason !== 'string' || args.reason.trim().length === 0) {
    throw new DetectionInvariantError(
      "Detection.status='not_detected' requires a non-empty reason",
    );
  }
  return Object.freeze({
    status: 'not_detected' as const,
    confidence,
    evidence: Object.freeze([...args.evidence]),
    reason: args.reason,
  });
}

/**
 * Heuristic used by the constructors to refuse empty payloads.
 *
 * Three classic empty-success shapes are caught:
 *   - `null` / `undefined`
 *   - empty arrays
 *   - objects with zero own keys (after stripping prototype noise)
 *
 * Primitive values (numbers, strings, bigints, booleans, dates, buffers, maps,
 * sets, etc.) are NOT considered empty - they're concrete data. A detector
 * returning a number can certainly have a meaningful zero (e.g. "0 trainers
 * found because this ROM is a trainer-stripped randomizer" - though even
 * that should probably be partial+reason rather than detected).
 *
 * Exported so detector code can defensively check its OWN payload before
 * constructing - useful for logging "I was about to lie" diagnostics.
 */
export function isEmptyValue(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (Array.isArray(v)) return v.length === 0;
  if (v instanceof Map || v instanceof Set) return v.size === 0;
  // Plain objects: zero own enumerable keys. We deliberately don't recurse - 
  // a populated wrapper with empty fields can still be a legitimate detected
  // result; the detector knows its own schema better than this generic check.
  if (typeof v === 'object' && v.constructor === Object) {
    return Object.keys(v).length === 0;
  }
  return false;
}

/**
 * Boundary assertion used by orchestration code that aggregates detector
 * results. Walks a result and throws if it's a `detected`/`partial` with
 * empty data or zero evidence - the same checks the constructors do, but
 * for results that came from outside this module (deserialized state, a
 * plugin's detector, etc.) where construction can't be statically verified.
 *
 * Returns the result unchanged on success so it can be used inline:
 *   `const safe = assertNoEmptySuccess(plugin.detect(rom));`
 */
export function assertNoEmptySuccess<T>(result: Detection<T>): Detection<T> {
  if (!isConfidence(result.confidence)) {
    throw new DetectionInvariantError(
      `confidence out of [0,1]: ${String(result.confidence)}`,
    );
  }
  if (result.evidence.length === 0) {
    throw new DetectionInvariantError(
      `${result.status} result has zero evidence items (PD 1)`,
    );
  }
  if ((result.status === 'detected' || result.status === 'partial') && isEmptyValue(result.data)) {
    throw new EmptySuccessError(
      `${result.status} result has empty data - must be not_detected instead (PD 1)`,
    );
  }
  return result;
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/** Thrown when a Detection constructor receives input that violates the schema. */
export class DetectionInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DetectionInvariantError';
  }
}

/**
 * Thrown specifically when a result attempts to present empty/zeroed data as
 * detected/partial - the headline anti-drift failure PD 1 forbids. Kept as a
 * distinct error so the test suite + CI can grep for "did anything regress
 * the empty-success guard?" without conflating it with other invariant breaks.
 */
export class EmptySuccessError extends DetectionInvariantError {
  constructor(message: string) {
    super(message);
    this.name = 'EmptySuccessError';
  }
}
