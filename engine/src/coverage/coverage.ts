/**
 * ROM-coverage metric infrastructure.
 *
 * ROM coverage is defined as the fraction of ROM bytes that are either
 * confidently classified into a known system OR explicitly enumerated as
 * scored UNKNOWN regions. It must be reported, must be monotone
 * non-decreasing across a run, and everything not covered counts as
 * `unaccounted` - a regression metric that has to trend to zero.
 *
 * The invariant this module exists to enforce: no byte region is ever
 * silently ignored. Every region either gets classified into one of the
 * known region kinds or gets recorded explicitly as `UNKNOWN` with a
 * probable class + score. Bytes that are neither classified nor
 * scored-unknown fall into `unaccounted`, and `assertMonotoneCoverage`
 * refuses to let a run regress.
 *
 * The class is byte-range bookkeeping over a ROM of known size:
 *
 *   addClassified(0x00000000, 0x000000C0, 'header')         // 192 cartridge header bytes
 *   addClassified(0x00245EE0, 0x00248064, 'species_table')  // 411 species × 11 bytes
 *   addUnknown   (0x00800000, 0x00801000, 'probable_compression', 0.6)
 *   report()
 *     → { romSize, classified, unknownScored, unaccounted, percentages, regions }
 *
 * Overlapping or contradictory regions are surfaced as `OverlapError` rather
 * than silently merged - silently merging would hide bugs in the upstream
 * detector that emitted them (e.g. a stride-inference detector that overshot).
 */

/**
 * One probable class for the §15 Phase-3 region classifier. Exhaustive list
 * matches the verbatim categories in §15 P3:
 *   "probable script / graphics / table / event-data / pointer-network /
 *    compression / AI / unknown-executable"
 *
 * Additional categories (`header`, `audio_table`, `species_table`, etc.) are
 * permitted as more specific subclasses - the type accepts free-form strings
 * to avoid baking detector internals into the coverage layer (PD 5: signature
 * DB / engine extensibility). At the same time, the well-known classes get
 * named constants so consumers can switch on them exhaustively for the common
 * case and reach the long tail when needed.
 */
export type ProbableClass =
  | 'header'
  | 'script'
  | 'graphics'
  | 'table'
  | 'event_data'
  | 'pointer_network'
  | 'compression'
  | 'audio'
  | 'ai_data'
  | 'unknown_executable'
  | 'unknown'
  | (string & { readonly __escapeHatch?: never });

/**
 * A classified or scored-unknown region of the ROM.
 *
 * Half-open `[start, end)` byte range. `end > start` always.
 *
 * `kind`:
 *  - `classified` - the detector confidently identified this region as
 *                        `probableClass`. `score` is the confidence ∈ (0,1].
 *  - `unknown_scored` - the detector couldn't classify but emitted a
 *                        probable-class guess with a confidence score; this is
 *                        the PD 8 explicit-account mechanism for regions that
 *                        would otherwise be silently ignored.
 *
 * `provenance` names the detector + the iteration that produced this region - 
 * useful for diff-debugging when coverage regresses (a regression is supposed
 * to be impossible per §9.7 but we log provenance precisely so that when it
 * happens, the culprit is one query away).
 */
export type RegionKind = 'classified' | 'unknown_scored';

export interface CoverageRegion {
  readonly start: number;
  readonly end: number;
  readonly kind: RegionKind;
  readonly probableClass: ProbableClass;
  readonly score: number;
  readonly provenance: string;
  readonly note?: string;
}

/**
 * Top-level report. All quantities in bytes (counts) and proportions (percent
 * = 0..100, two-decimal precision).
 *
 * `regions` is the underlying sorted-by-start list so consumers can dump a
 * visualization (which they SHOULD, per PD 8: "classified+scored+grouped+
 * visualized").
 */
export interface CoverageReport {
  readonly romSize: number;
  readonly classifiedBytes: number;
  readonly unknownScoredBytes: number;
  readonly unaccountedBytes: number;
  readonly classifiedPct: number;
  readonly unknownScoredPct: number;
  readonly unaccountedPct: number;
  readonly regionCount: number;
  /** Sorted by `start` ascending. Never overlapping (overlaps throw on insert). */
  readonly regions: ReadonlyArray<CoverageRegion>;
}

/** Thrown when the caller adds a region that overlaps an existing region. */
export class OverlapError extends Error {
  constructor(
    message: string,
    readonly newRegion: { start: number; end: number },
    readonly existingRegion: CoverageRegion,
  ) {
    super(message);
    this.name = 'OverlapError';
  }
}

/** Thrown when the caller passes structurally-bad input (negative start, etc.). */
export class CoverageInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CoverageInvariantError';
  }
}

/**
 * Mutable coverage accumulator for one ROM.
 *
 * Designed for the natural iterative shape of detection: a phase starts with
 * a `CoverageMap` initialized to the ROM size, each detector calls
 * `addClassified` or `addUnknownScored` as it identifies regions, and at the
 * end the orchestrator calls `report()` and writes the row into `COVERAGE.md`.
 *
 * To enforce monotone non-decreasing coverage across iterations (the §9.1
 * invariant), persist the report, then build a fresh `CoverageMap` next
 * iteration and compare percentages - `assertMonotoneCoverage` does this check.
 */
export class CoverageMap {
  readonly romSize: number;
  private readonly regions: CoverageRegion[] = [];

  constructor(romSize: number) {
    if (!Number.isInteger(romSize) || romSize <= 0) {
      throw new CoverageInvariantError(
        `romSize must be a positive integer, got ${String(romSize)}`,
      );
    }
    this.romSize = romSize;
  }

  /**
   * Add a confidently-classified region. `score ∈ (0,1]` (zero confidence
   * isn't "classified"; use `addUnknownScored` for low-confidence guesses).
   */
  addClassified(args: {
    start: number;
    end: number;
    probableClass: ProbableClass;
    score: number;
    provenance: string;
    note?: string;
  }): CoverageRegion {
    return this.insert({ ...args, kind: 'classified', minScoreExclusive: 0 });
  }

  /**
   * Add a region where the detector COULDN'T classify but emitted a probable-
   * class guess with a confidence score. `score ∈ [0,1]` - zero is allowed
   * here (you may genuinely have no idea, only know "something is there").
   *
   * This is the PD 8 mechanism: any byte region the detection pipeline can't
   * place into a known system MUST be added here so it ends up scored-unknown
   * rather than silently dropping into `unaccounted`.
   */
  addUnknownScored(args: {
    start: number;
    end: number;
    probableClass: ProbableClass;
    score: number;
    provenance: string;
    note?: string;
  }): CoverageRegion {
    return this.insert({ ...args, kind: 'unknown_scored', minScoreExclusive: -1 });
  }

  /**
   * Synthesize a single `unknown_scored` region covering every byte not yet
   * accounted for. Convenience for the end-of-phase Exit-Gate code path:
   * call this after running all classifiers, with `provenance` like
   * "phase-3-finalize-iteration-42", to guarantee `unaccountedBytes === 0`.
   * If there's nothing left, returns an empty array.
   *
   * Returns the regions it added so the caller can log them.
   *
   * Intentionally NOT called automatically: PD 8 wants explicit accounting,
   * and a phase that quietly auto-blankets the unaccounted tail would obscure
   * the very gap §9.7 wants visible.
   */
  blanketUnaccountedAsUnknown(args: {
    probableClass: ProbableClass;
    score: number;
    provenance: string;
    note?: string;
  }): CoverageRegion[] {
    const gaps = this.findUnaccountedGaps();
    const added: CoverageRegion[] = [];
    for (const g of gaps) {
      added.push(
        this.addUnknownScored({
          start: g.start,
          end: g.end,
          probableClass: args.probableClass,
          score: args.score,
          provenance: args.provenance,
          ...(args.note !== undefined ? { note: args.note } : {}),
        }),
      );
    }
    return added;
  }

  /** Snapshot the current report. Pure - does not mutate. */
  report(): CoverageReport {
    let classifiedBytes = 0;
    let unknownScoredBytes = 0;
    for (const r of this.regions) {
      const size = r.end - r.start;
      if (r.kind === 'classified') classifiedBytes += size;
      else unknownScoredBytes += size;
    }
    const unaccountedBytes = this.romSize - classifiedBytes - unknownScoredBytes;
    return Object.freeze({
      romSize: this.romSize,
      classifiedBytes,
      unknownScoredBytes,
      unaccountedBytes,
      classifiedPct: round2(toPct(classifiedBytes, this.romSize)),
      unknownScoredPct: round2(toPct(unknownScoredBytes, this.romSize)),
      unaccountedPct: round2(toPct(unaccountedBytes, this.romSize)),
      regionCount: this.regions.length,
      regions: Object.freeze([...this.regions]),
    });
  }

  /** All gaps between sorted regions plus head/tail gaps. Half-open ranges. */
  findUnaccountedGaps(): Array<{ start: number; end: number }> {
    const gaps: Array<{ start: number; end: number }> = [];
    let cursor = 0;
    for (const r of this.regions) {
      if (r.start > cursor) gaps.push({ start: cursor, end: r.start });
      cursor = r.end;
    }
    if (cursor < this.romSize) gaps.push({ start: cursor, end: this.romSize });
    return gaps;
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  private insert(args: {
    start: number;
    end: number;
    kind: RegionKind;
    probableClass: ProbableClass;
    score: number;
    provenance: string;
    note?: string;
    /**
     * `score > minScoreExclusive` must hold. For `classified` this is 0
     * (zero score isn't classified). For `unknown_scored` this is -1
     * (effectively, any non-negative score is OK including exactly zero).
     */
    minScoreExclusive: number;
  }): CoverageRegion {
    this.validateRange(args.start, args.end);
    this.validateScore(args.score, args.minScoreExclusive);
    this.validateProvenance(args.provenance);
    const overlap = this.findOverlap(args.start, args.end);
    if (overlap) {
      throw new OverlapError(
        `region [${hex(args.start)}, ${hex(args.end)}) overlaps existing ` +
          `[${hex(overlap.start)}, ${hex(overlap.end)}) (${overlap.probableClass}, ` +
          `provenance="${overlap.provenance}")`,
        { start: args.start, end: args.end },
        overlap,
      );
    }
    const region: CoverageRegion = Object.freeze({
      start: args.start,
      end: args.end,
      kind: args.kind,
      probableClass: args.probableClass,
      score: args.score,
      provenance: args.provenance,
      ...(args.note !== undefined ? { note: args.note } : {}),
    });
    this.insertSorted(region);
    return region;
  }

  private validateRange(start: number, end: number): void {
    if (!Number.isInteger(start) || start < 0) {
      throw new CoverageInvariantError(`region.start must be a non-negative integer, got ${String(start)}`);
    }
    if (!Number.isInteger(end) || end <= start) {
      throw new CoverageInvariantError(
        `region.end must be a positive integer greater than start, got start=${String(start)} end=${String(end)}`,
      );
    }
    if (end > this.romSize) {
      throw new CoverageInvariantError(
        `region.end (${hex(end)}) exceeds romSize (${hex(this.romSize)})`,
      );
    }
  }

  private validateScore(score: number, minScoreExclusive: number): void {
    if (!Number.isFinite(score) || score < 0 || score > 1) {
      throw new CoverageInvariantError(`region.score must be in [0,1], got ${String(score)}`);
    }
    if (score <= minScoreExclusive) {
      throw new CoverageInvariantError(
        `region.score must be > ${String(minScoreExclusive)} for this region kind, got ${String(score)}`,
      );
    }
  }

  private validateProvenance(provenance: string): void {
    if (typeof provenance !== 'string' || provenance.trim().length === 0) {
      throw new CoverageInvariantError('region.provenance must be a non-empty string');
    }
  }

  private findOverlap(start: number, end: number): CoverageRegion | null {
    // Linear scan is fine - region counts are O(thousands) per ROM, well
    // under the 100k where a sorted-array binary search would matter.
    for (const r of this.regions) {
      if (start < r.end && end > r.start) return r;
    }
    return null;
  }

  private insertSorted(region: CoverageRegion): void {
    // Tiny binary search to keep `regions` sorted by `start`. Linear is fine
    // at our scale but binary is the same complexity to write and stays fast
    // if region counts ever blow up.
    let lo = 0;
    let hi = this.regions.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const item = this.regions[mid];
      if (item !== undefined && item.start < region.start) lo = mid + 1;
      else hi = mid;
    }
    this.regions.splice(lo, 0, region);
  }
}

// ---------------------------------------------------------------------------
// Cross-iteration invariants
// ---------------------------------------------------------------------------

/**
 * Verify monotone-non-decreasing coverage across two snapshots of the SAME
 * ROM. Enforces §9.1 "romCoveragePct per corpus class is monotone non-
 * decreasing; a decrease = corruption, investigate." Compares the sum of
 * classified + unknown_scored bytes (i.e., accounted-for bytes) rather than
 * just classified, because re-classifying a region from `unknown_scored` to
 * `classified` is a legitimate improvement that doesn't change the total
 * accounted figure.
 *
 * Returns `null` on pass; returns a description of the regression on fail.
 * Caller is expected to log + halt per §9.1.
 */
export function assertMonotoneCoverage(
  previous: CoverageReport,
  current: CoverageReport,
): null | { reason: string; deltaBytes: number; deltaPct: number } {
  if (previous.romSize !== current.romSize) {
    return {
      reason: `romSize changed: ${previous.romSize} → ${current.romSize} (different ROM?)`,
      deltaBytes: current.romSize - previous.romSize,
      deltaPct: 0,
    };
  }
  const prevAcc = previous.classifiedBytes + previous.unknownScoredBytes;
  const currAcc = current.classifiedBytes + current.unknownScoredBytes;
  if (currAcc < prevAcc) {
    return {
      reason: `accounted-for coverage regressed: ${prevAcc} → ${currAcc} bytes`,
      deltaBytes: currAcc - prevAcc,
      deltaPct: round2(toPct(currAcc - prevAcc, current.romSize)),
    };
  }
  return null;
}

/**
 * Format a `CoverageReport` as a one-line append for `COVERAGE.md`. Stable,
 * grep-friendly format matching the §9.7 spec:
 *   `- <UTC> <romClass> classified=<x%> scoredUnknown=<y%> unaccounted=<z%>`
 *
 * Caller supplies the corpus class label (e.g. `"vanilla"`, `"heavyHack"`)
 * and the timestamp - keeps the formatter pure and trivial to test.
 */
export function formatCoverageLogLine(args: {
  utcIso: string;
  romClass: string;
  report: CoverageReport;
}): string {
  if (typeof args.utcIso !== 'string' || args.utcIso.trim().length === 0) {
    throw new CoverageInvariantError('utcIso must be a non-empty ISO-8601 string');
  }
  if (typeof args.romClass !== 'string' || args.romClass.trim().length === 0) {
    throw new CoverageInvariantError('romClass must be a non-empty string');
  }
  const { classifiedPct, unknownScoredPct, unaccountedPct } = args.report;
  return (
    `- ${args.utcIso} ${args.romClass} classified=${classifiedPct.toFixed(2)}% ` +
    `scoredUnknown=${unknownScoredPct.toFixed(2)}% unaccounted=${unaccountedPct.toFixed(2)}%`
  );
}

// ---------------------------------------------------------------------------
// Tiny helpers
// ---------------------------------------------------------------------------

function toPct(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return (part / whole) * 100;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function hex(n: number): string {
  return `0x${n.toString(16).toUpperCase()}`;
}
