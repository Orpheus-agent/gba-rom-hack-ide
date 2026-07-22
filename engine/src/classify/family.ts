/**
 * Family classification verdict.
 *
 * Per §15 P1 acceptance, every supported-family ROM gets a final
 * family/engine-kind classification with confidence + evidence - and
 * unknown-family input degrades gracefully with a clear evidenced
 * `family=unrecognized` report. This pure function consumes an
 * `IngestReport` produced by the orchestrator and combines the signals
 * from the three Phase 0+1 detectors into the typed `FamilyVerdict`:
 *
 *   - HEADER_FINGERPRINT_DETECTOR (Phase 0) - supplies the parsed game
 *     code + display name. Required: if it didn't reach `detected`, the
 *     verdict is `kind=unknown / family=unrecognized` because we don't
 *     have a header to anchor to.
 *
 *   - BINARY_FINGERPRINT_DETECTOR (Phase 1) - supplies signature DB
 *     match list. A strong match (confidence ≥ 0.7) drives the family +
 *     kind directly from the matched entry (vanilla/decomp/cfru/fork).
 *     Weaker matches contribute as evidence but don't override the
 *     fork-heuristic verdict.
 *
 *   - FORK_HEURISTIC_DETECTOR (Phase 1) - supplies structural divergence
 *     signals. When fork-heuristic is `detected` (totalScore ≥ 0.5) we
 *     report kind=fork even if a vanilla signature entry weakly matched
 *     (game-code-only matches scale to 0.425, well under the 0.5 fork
 *     threshold). Honest precedence: STRUCTURAL divergence wins over
 *     game-code-only signature matches.
 *
 * The verdict's evidence chain is the audit trail - each entry names
 * which detector contributed which signal, with the original weight.
 *
 * PD 1: every verdict has at least one evidence item + a non-empty
 * `family` string (`unrecognized` is a real value, not empty). PD 5: a
 * verdict can be reached via signature, heuristic, OR header-only paths
 * - no single source is required.
 */

import type { IngestReport } from '../ingest/index.js';
import {
  BINARY_FINGERPRINT_DETECTOR_ID,
  FORK_HEURISTIC_DETECTOR_ID,
  HEADER_FINGERPRINT_DETECTOR_ID,
  type HeaderFingerprintPayload,
  type RomFingerprint,
  type ForkHeuristicEvidence,
} from '../detectors/index.js';
import { canonicalForGameCode } from '../rom/canonical-headers.js';
import type { SignatureMatch } from '../signatures/index.js';

/**
 * Engine-kind enum the classifier emits. Mirrors the SignatureKind enum
 * the signature DB allows plus `unknown` for the unrecognized path.
 */
export type EngineKind = 'vanilla' | 'decomp' | 'cfru' | 'fork' | 'unknown';

export interface VerdictEvidenceItem {
  /** Which detector produced this contribution. */
  readonly source: string;
  /** One-line description of the signal. */
  readonly summary: string;
  /** Per-item weight in [0,1]. */
  readonly weight: number;
}

export interface FamilyVerdict {
  /**
   * Family label (e.g. "firered", "emerald", "unrecognized"). Always
   * non-empty (PD 1). For unknown game codes this is the literal
   * string "unrecognized".
   */
  readonly family: string;
  /** Engine kind enum. */
  readonly kind: EngineKind;
  /** Friendly display name for the verdict. */
  readonly displayName: string;
  /** Aggregated confidence in [0,1]. */
  readonly confidence: number;
  /** Which signal drove the verdict (audit-friendly). */
  readonly primarySignal:
    | 'signature_match'
    | 'fork_heuristic'
    | 'canonical_match'
    | 'header_only'
    | 'header_failure';
  /** Per-signal contributions sorted by descending weight. */
  readonly evidenceChain: ReadonlyArray<VerdictEvidenceItem>;
  /** Human-readable rationale combining the primary signal + key evidence. */
  readonly rationale: string;
}

/** Strong signature match threshold - directly drives family + kind. */
const STRONG_SIGNATURE_THRESHOLD = 0.7;
/** Fork heuristic detected threshold (matches fork-heuristic detector). */
const FORK_DETECTED_THRESHOLD = 0.5;

/**
 * Classify the ingest report into a per-ROM family verdict. Pure function:
 * no I/O, deterministic.
 */
export function classifyFamily(report: IngestReport): FamilyVerdict {
  const headerResult = findDetection<HeaderFingerprintPayload>(
    report,
    HEADER_FINGERPRINT_DETECTOR_ID,
  );
  const binaryResult = findDetection<RomFingerprint>(
    report,
    BINARY_FINGERPRINT_DETECTOR_ID,
  );
  const forkResult = findDetection<ForkHeuristicEvidence>(
    report,
    FORK_HEURISTIC_DETECTOR_ID,
  );

  // Branch 1: header didn't parse → unrecognized.
  if (headerResult === null || headerResult.status === 'not_detected') {
    return makeVerdict({
      family: 'unrecognized',
      kind: 'unknown',
      displayName: 'Unrecognized (no parseable GBA cartridge header)',
      confidence: 0,
      primarySignal: 'header_failure',
      evidenceChain: [
        {
          source: HEADER_FINGERPRINT_DETECTOR_ID,
          summary: 'GBA cartridge header did not parse - Phase 0 reported not_detected',
          weight: 1.0,
        },
      ],
      rationale:
        'Phase 0 header detector did not produce a parseable GBA cartridge header; no family classification possible.',
    });
  }

  const header =
    headerResult.status === 'detected' || headerResult.status === 'partial'
      ? headerResult.data
      : null;
  // Header in detected/partial branches always carries a payload - detected
  // carries HeaderFingerprintPayload (with .header), partial carries
  // HeaderPartialPayload (no .header field). Guard with the `header in`
  // narrow + the null check above.
  const parsedHeader =
    header !== null && typeof header === 'object' && 'header' in header
      ? (header as HeaderFingerprintPayload).header
      : null;
  if (parsedHeader === null) {
    return makeVerdict({
      family: 'unrecognized',
      kind: 'unknown',
      displayName: 'Unrecognized (corrupt header)',
      confidence: 0,
      primarySignal: 'header_failure',
      evidenceChain: [
        {
          source: HEADER_FINGERPRINT_DETECTOR_ID,
          summary: 'Phase 0 header returned partial (likely corrupt fixed marker); cannot classify',
          weight: 1.0,
        },
      ],
      rationale: 'Header parsed only partially; family classification deferred.',
    });
  }
  const gameCode = parsedHeader.gameCode;
  const canonical = canonicalForGameCode(gameCode);

  // Collect contributing evidence items as we go so the final verdict can cite them.
  const collectedEvidence: VerdictEvidenceItem[] = [];
  collectedEvidence.push({
    source: HEADER_FINGERPRINT_DETECTOR_ID,
    summary: `parsed game code ${gameCode}, title "${parsedHeader.internalTitle}"`,
    weight: 0.3,
  });

  // Read the binary-fingerprint signature matches (if any).
  const fingerprintData =
    binaryResult !== null &&
    (binaryResult.status === 'detected' || binaryResult.status === 'partial')
      ? binaryResult.data
      : null;
  const matches: ReadonlyArray<SignatureMatch> = fingerprintData?.signatureMatches ?? [];
  const topMatch = matches[0] ?? null;

  // Read the fork-heuristic result.
  const forkData =
    forkResult !== null && forkResult.status === 'detected'
      ? forkResult.data
      : null;
  const forkDetected = forkData !== null && forkResult!.confidence >= FORK_DETECTED_THRESHOLD;

  // Branch 2: STRONG signature match → drive verdict from signature entry.
  // Strong = confidence ≥ STRONG_SIGNATURE_THRESHOLD (i.e. sha1 hit, or
  // marker + game_code combo). Game-code-only matches scale to 0.425 and
  // fall through to branch 3.
  if (topMatch !== null && topMatch.confidence >= STRONG_SIGNATURE_THRESHOLD) {
    collectedEvidence.push({
      source: BINARY_FINGERPRINT_DETECTOR_ID,
      summary: `strong signature match: ${topMatch.entry.displayName} (kind=${topMatch.entry.kind}, scaled-confidence ${topMatch.confidence.toFixed(2)})`,
      weight: topMatch.confidence,
    });
    if (forkData !== null) {
      collectedEvidence.push({
        source: FORK_HEURISTIC_DETECTOR_ID,
        summary: `also reported divergence (totalDivergenceScore ${forkData.totalDivergenceScore.toFixed(2)})`,
        weight: forkResult!.confidence,
      });
    }
    return makeVerdict({
      family: topMatch.entry.family,
      kind: topMatch.entry.kind === 'unknown' ? 'unknown' : topMatch.entry.kind,
      displayName: topMatch.entry.displayName,
      confidence: topMatch.confidence,
      primarySignal: 'signature_match',
      evidenceChain: collectedEvidence,
      rationale: `Strong signature match against ${topMatch.entry.displayName} (kind=${topMatch.entry.kind}) at scaled-confidence ${topMatch.confidence.toFixed(2)}.`,
    });
  }

  // Branch 3: fork heuristic detected divergence → kind=fork.
  // Precedence: structural divergence wins over weak (game-code-only)
  // signature matches that would otherwise label this vanilla.
  if (forkDetected && canonical !== null) {
    collectedEvidence.push({
      source: FORK_HEURISTIC_DETECTOR_ID,
      summary: `structural fork divergence from canonical ${canonical.displayName} - totalDivergenceScore ${forkData!.totalDivergenceScore.toFixed(2)}`,
      weight: forkResult!.confidence,
    });
    for (const d of forkData!.divergences) {
      collectedEvidence.push({
        source: FORK_HEURISTIC_DETECTOR_ID,
        summary: `divergence (${d.kind}): ${d.description}`,
        weight: d.weight,
      });
    }
    if (topMatch !== null) {
      collectedEvidence.push({
        source: BINARY_FINGERPRINT_DETECTOR_ID,
        summary: `weak signature match (${topMatch.entry.displayName}, scaled-confidence ${topMatch.confidence.toFixed(2)}) noted but did not override structural divergence`,
        weight: topMatch.confidence,
      });
    }
    return makeVerdict({
      family: canonical.gameCode.toLowerCase() in CANONICAL_FAMILY_LABELS
        ? CANONICAL_FAMILY_LABELS[canonical.gameCode.toLowerCase()]!
        : canonical.gameCode.toLowerCase(),
      kind: 'fork',
      displayName: `${canonical.displayName} (custom fork)`,
      confidence: forkResult!.confidence,
      primarySignal: 'fork_heuristic',
      evidenceChain: collectedEvidence,
      rationale: `Fork heuristic detected structural divergence from canonical ${canonical.displayName} (totalDivergenceScore ${forkData!.totalDivergenceScore.toFixed(2)}). Treated as a fork even though the cart claims ${gameCode}.`,
    });
  }

  // Branch 4: canonical-matching cart (no signature, no fork divergence).
  // Conservative vanilla verdict - the ROM matches canonical shape on all
  // observed fields, but we have no positive signature confirmation
  // (because the operator hasn't supplied SHA-1s or build-markers yet).
  if (canonical !== null) {
    if (topMatch !== null) {
      // Weak signature match exists (game-code-only) AND canonical matches
      // AND no fork divergence - most reliable vanilla path we have.
      collectedEvidence.push({
        source: BINARY_FINGERPRINT_DETECTOR_ID,
        summary: `signature match: ${topMatch.entry.displayName} (kind=${topMatch.entry.kind}, game_code path, scaled-confidence ${topMatch.confidence.toFixed(2)})`,
        weight: topMatch.confidence,
      });
    }
    if (forkResult !== null && forkResult.status === 'not_detected') {
      collectedEvidence.push({
        source: FORK_HEURISTIC_DETECTOR_ID,
        summary: `no structural divergence from canonical ${canonical.displayName}`,
        weight: forkResult.confidence,
      });
    }
    const family = CANONICAL_FAMILY_LABELS[canonical.gameCode.toLowerCase()] ?? canonical.gameCode.toLowerCase();
    // Combine: 0.4 baseline (canonical-shape match) + signature contribution.
    const baseline = 0.4;
    const signatureBoost = topMatch !== null ? topMatch.confidence * 0.5 : 0;
    const combined = clampConfidence(baseline + signatureBoost);
    return makeVerdict({
      family,
      kind: topMatch?.entry.kind === 'vanilla' || topMatch === null ? 'vanilla' : topMatch.entry.kind,
      displayName: topMatch?.entry.displayName ?? `${canonical.displayName} (canonical shape, unconfirmed)`,
      confidence: combined,
      primarySignal: topMatch !== null ? 'signature_match' : 'canonical_match',
      evidenceChain: collectedEvidence,
      rationale:
        topMatch !== null
          ? `Game-code-only signature match against ${topMatch.entry.displayName} combined with canonical structural shape (no fork divergence).`
          : `Header matches canonical ${canonical.displayName} on title/size/version/maker; no signature DB entry available (operator can add a SHA-1 entry to /signatures/ to upgrade this to a strong match).`,
    });
  }

  // Branch 5: unknown game code (not in canonical seed table) + no signature match.
  // family=unrecognized but the header still parsed, so we report what we know.
  if (topMatch !== null) {
    collectedEvidence.push({
      source: BINARY_FINGERPRINT_DETECTOR_ID,
      summary: `signature match for unknown family: ${topMatch.entry.displayName} (kind=${topMatch.entry.kind})`,
      weight: topMatch.confidence,
    });
    return makeVerdict({
      family: topMatch.entry.family,
      kind: topMatch.entry.kind === 'unknown' ? 'unknown' : topMatch.entry.kind,
      displayName: topMatch.entry.displayName,
      confidence: topMatch.confidence,
      primarySignal: 'signature_match',
      evidenceChain: collectedEvidence,
      rationale: `Game code ${gameCode} is not in the canonical Gen-3 reference, but a signature DB entry matched.`,
    });
  }
  collectedEvidence.push({
    source: 'classify_family',
    summary: `game code ${gameCode} not in canonical reference and no signature DB entry matched`,
    weight: 1.0,
  });
  return makeVerdict({
    family: 'unrecognized',
    kind: 'unknown',
    displayName: `Unrecognized GBA cart (game code ${gameCode})`,
    confidence: 0.3,
    primarySignal: 'header_only',
    evidenceChain: collectedEvidence,
    rationale: `Header parsed (game code ${gameCode}, title "${parsedHeader.internalTitle}") but the code is not in the canonical Gen-3 Pokémon reference and no signature DB entry matched. Add a /signatures/*.json entry for this cart to enable recognition.`,
  });
}

/** Short, audit-friendly family labels per canonical game code. */
const CANONICAL_FAMILY_LABELS: Readonly<Record<string, string>> = {
  bpre: 'firered',
  bpge: 'leafgreen',
  bpee: 'emerald',
  axve: 'ruby',
  axpe: 'sapphire',
};

type FoundDetection<T> =
  | { status: 'not_detected'; confidence: number }
  | { status: 'detected' | 'partial'; confidence: number; data: T };

function findDetection<T>(report: IngestReport, detectorId: string): FoundDetection<T> | null {
  const row = report.detections.find((d) => d.detectorId === detectorId);
  if (row === undefined) return null;
  const det = row.detection;
  if (det.status === 'not_detected') {
    return { status: 'not_detected', confidence: det.confidence };
  }
  return { status: det.status, confidence: det.confidence, data: det.data as T };
}

function makeVerdict(args: {
  family: string;
  kind: EngineKind;
  displayName: string;
  confidence: number;
  primarySignal: FamilyVerdict['primarySignal'];
  evidenceChain: ReadonlyArray<VerdictEvidenceItem>;
  rationale: string;
}): FamilyVerdict {
  const sorted = [...args.evidenceChain].sort((a, b) => b.weight - a.weight);
  return Object.freeze({
    family: args.family,
    kind: args.kind,
    displayName: args.displayName,
    confidence: clampConfidence(args.confidence),
    primarySignal: args.primarySignal,
    evidenceChain: Object.freeze(sorted),
    rationale: args.rationale,
  });
}

function clampConfidence(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return Math.round(n * 1000) / 1000;
}
