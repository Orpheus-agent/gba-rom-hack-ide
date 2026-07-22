import type { ProjectIdentity } from '@rom-editor/shared';
import { decompDetector } from './decomp.js';
import { patchDetector } from './patch.js';
import type { ProjectDetector } from './types.js';

export { decompDetector, patchDetector };
export type { ProjectDetector, DetectorResult } from './types.js';

/** Confidence threshold a detector must reach to qualify its kind. */
const CLASSIFY_THRESHOLD = 0.4;

/**
 * Aggregates per-kind detector results into a final ProjectIdentity. Combines
 * decomp + patch into 'hybrid' when both clear the threshold, picks the higher
 * one otherwise, and reports 'unknown' (with a helpful warning) when neither
 * does.
 *
 * The orchestrator never returns confidence > the strongest underlying signal,
 * and always surfaces concrete evidence so the operator can confirm or correct.
 */
export async function detectProject(
  projectRoot: string,
  detectors: ReadonlyArray<ProjectDetector> = [decompDetector, patchDetector],
): Promise<ProjectIdentity> {
  const results = await Promise.all(
    detectors.map(async (d) => ({ kind: d.kind, result: await d.detect(projectRoot) })),
  );

  const decomp = results.find((r) => r.kind === 'decomp')?.result;
  const patch = results.find((r) => r.kind === 'patch')?.result;
  const decompC = decomp?.confidence ?? 0;
  const patchC = patch?.confidence ?? 0;

  const decompPasses = decompC >= CLASSIFY_THRESHOLD;
  const patchPasses = patchC >= CLASSIFY_THRESHOLD;

  if (decompPasses && patchPasses && decomp && patch) {
    return {
      kind: 'hybrid',
      confidence: Math.max(decompC, patchC),
      displayName: `Hybrid: ${decomp.displayName} + ${patch.displayName}`,
      baseGame: decomp.baseGame ?? patch.baseGame,
      fork: decomp.fork ?? patch.fork,
      featureFlags: [...decomp.featureFlags, ...patch.featureFlags],
      warnings: [...decomp.warnings, ...patch.warnings],
      evidence: [...decomp.evidence, ...patch.evidence],
      ...(patch.romBinary ? { romBinary: patch.romBinary } : {}),
      ...(patch.romHeader ? { romHeader: patch.romHeader } : {}),
      ...(patch.romStructure ? { romStructure: patch.romStructure } : {}),
      ...(patch.detectedSubsystems ? { detectedSubsystems: patch.detectedSubsystems } : {}),
      ...(patch.coverageSummary ? { coverageSummary: patch.coverageSummary } : {}),
      ...(patch.upgradeOffer ? { upgradeOffer: patch.upgradeOffer } : {}),
      ...(patch.modernizedBy ? { modernizedBy: patch.modernizedBy } : {}),
      ...(patch.overlaySafe ? { overlaySafe: patch.overlaySafe } : {}),
    };
  }

  if (decompPasses && decompC >= patchC && decomp) {
    return {
      kind: 'decomp',
      confidence: decompC,
      displayName: decomp.displayName,
      baseGame: decomp.baseGame,
      fork: decomp.fork,
      featureFlags: decomp.featureFlags,
      warnings: decomp.warnings,
      evidence: decomp.evidence,
    };
  }

  if (patchPasses && patch) {
    return {
      kind: 'patch',
      confidence: patchC,
      displayName: patch.displayName,
      baseGame: patch.baseGame,
      fork: patch.fork,
      featureFlags: patch.featureFlags,
      warnings: patch.warnings,
      evidence: patch.evidence,
      ...(patch.romBinary ? { romBinary: patch.romBinary } : {}),
      ...(patch.romHeader ? { romHeader: patch.romHeader } : {}),
      ...(patch.romStructure ? { romStructure: patch.romStructure } : {}),
      ...(patch.detectedSubsystems ? { detectedSubsystems: patch.detectedSubsystems } : {}),
      ...(patch.coverageSummary ? { coverageSummary: patch.coverageSummary } : {}),
      ...(patch.upgradeOffer ? { upgradeOffer: patch.upgradeOffer } : {}),
      ...(patch.modernizedBy ? { modernizedBy: patch.modernizedBy } : {}),
      ...(patch.overlaySafe ? { overlaySafe: patch.overlaySafe } : {}),
    };
  }

  // Below threshold on all detectors → unknown, but surface what each detector
  // saw so the operator can fix the workspace shape.
  const aggregatedEvidence = results.flatMap((r) => r.result.evidence);
  return {
    kind: 'unknown',
    confidence: 0,
    displayName: 'Unknown project',
    baseGame: null,
    fork: null,
    featureFlags: [],
    warnings: [
      'No decomp or patch indicators reached the classification threshold. Please confirm this is a valid project root - the editor needs either a buildable Gen-3 decomp source tree (Makefile + src/ + a known linker script) or a patch workspace (.ips/.ups/.bps files, optionally with a .gba base ROM).',
    ],
    evidence: aggregatedEvidence,
  };
}
