/**
 * Phase-1 detector: structural fork heuristic.
 *
 * Per §15 P1 acceptance + §6.4 pillar 1 (Discover, don't assume), this is
 * the PD 5 heuristic-only path for recognizing custom-built ROMs WITHOUT
 * requiring a signature DB entry. It works by comparing the parsed
 * cartridge header + the ROM's actual size against the canonical Nintendo
 * reference for that game code:
 *
 *   - SIZE divergence - vanilla FireRed is 16 MiB; a 32 MiB ROM claiming
 *     BPRE has been expanded (a hallmark of heavy hacks like Unbound).
 *   - TITLE divergence - vanilla FireRed's internal title is exactly
 *     "POKEMON FIRE"; a ROM with "POKEMON UNBOND" or any other variant
 *     has been rebranded (most hacks rewrite this).
 *   - VERSION anomaly - vanilla cart software-versions are documented
 *     small integers (0/1/2 depending on the release); a non-canonical
 *     version is a strong hack signal.
 *   - UNKNOWN game code - a cart whose code isn't in the seed table is
 *     either a non-Pokémon GBA cart OR a custom fork that rewrote its
 *     code. Cannot be reported as a Pokémon fork by this detector - the
 *     detector returns not_detected with that reason (caller can route
 *     through other detectors).
 *
 * Result semantics:
 *   - `detected` - confidence ≥ 0.5 of fork: at least one strong
 *                       divergence signal (title differs OR size differs).
 *   - `partial` - some divergence but weaker (e.g. non-zero
 *                       softwareVersion on an otherwise canonical cart).
 *   - `not_detected` - cart matches canonical entry on all observed
 *                       fields → looks vanilla. ALSO not_detected when
 *                       the cart's game code isn't in the canonical
 *                       reference set (this detector only opines on
 *                       known families).
 *
 * Importantly: this detector does NOT claim "this is CFRU" or "this is a
 * decomp build" - those require signature-DB matches against framework-
 * specific markers (the binary-fingerprint detector does that already).
 * This detector claims "this differs from the canonical vanilla cart" /
 * "this looks like a custom build." Phase 1's classifier (P1-T3) combines
 * this signal with signature-DB matches to produce the final family +
 * kind verdict.
 */

import { makeDetected, makeEvidence, makeNotDetected, makePartial } from '../detection/index.js';
import type { Detection } from '../detection/index.js';
import type { CoverageMap } from '../coverage/index.js';
import { parseGbaHeader, type GbaHeader } from '../rom/header.js';
import {
  canonicalForGameCode,
  type CanonicalGen3Header,
} from '../rom/canonical-headers.js';
import type { RomImage } from '../rom/loader.js';
import type { RomDetector } from './types.js';

export const FORK_HEURISTIC_DETECTOR_ID = 'fork_heuristic';

export type DivergenceKind = 'title' | 'size' | 'software_version' | 'maker_code';

export interface DivergenceSignal {
  readonly kind: DivergenceKind;
  /** Human-readable description with the observed vs canonical values. */
  readonly description: string;
  /** Per-signal weight in [0,1] reflecting how strongly this divergence
   *  implies a fork (title rewrite = strong; non-zero version = weak). */
  readonly weight: number;
}

export interface ForkHeuristicEvidence {
  readonly gameCode: string;
  readonly canonicalDisplayName: string;
  readonly observedTitle: string;
  readonly observedSizeBytes: number;
  readonly observedSoftwareVersion: number;
  readonly observedMakerCode: string;
  readonly divergences: ReadonlyArray<DivergenceSignal>;
  /** Sum of divergence weights - caller can use this as a fork-likelihood
   *  score (0 = no divergence, larger = more divergent). */
  readonly totalDivergenceScore: number;
}

/** Per-signal weights when present. Multiple signals are additive. */
const WEIGHT_TITLE = 0.5;        // rewriting the title is the most common hack-marker
const WEIGHT_SIZE = 0.4;         // size expansion is a strong structural signal
const WEIGHT_VERSION = 0.15;     // non-canonical version is suggestive but weak
const WEIGHT_MAKER = 0.25;       // non-Nintendo maker code on a Pokémon cart is suspect

export const forkHeuristicDetector: RomDetector<ForkHeuristicEvidence> = {
  id: FORK_HEURISTIC_DETECTOR_ID,
  name: 'Fork Heuristic (canonical divergence)',
  phase: 1,
  detect(rom: RomImage, _coverage: CoverageMap): Detection<ForkHeuristicEvidence> {
    const parsed = parseGbaHeader(rom.bytes);
    if (!parsed.ok) {
      // Defer cleanly - Phase 0 owns header failure reporting.
      return makeNotDetected({
        confidence: 0.95,
        evidence: [
          makeEvidence({
            kind: 'heuristic',
            summary: `Phase 0 header detector already reported header failure (${parsed.failure.kind})`,
            weight: 1.0,
            detail: { headerFailureKind: parsed.failure.kind },
          }),
        ],
        reason: 'cannot run fork heuristic without a parseable GBA cartridge header',
      });
    }

    const header = parsed.header;
    const canonical = canonicalForGameCode(header.gameCode);

    if (canonical === null) {
      // Game code not in the seed table - this detector can't opine on
      // whether it's a Pokémon fork. Other Phase 1 detectors (signature
      // DB matches, etc.) take over. This is a HONEST not_detected, not
      // an empty-success.
      return makeNotDetected({
        confidence: 0.9,
        evidence: [
          makeEvidence({
            kind: 'heuristic',
            summary: `game code ${header.gameCode} is not in the canonical Gen-3 Pokémon reference set`,
            weight: 1.0,
            detail: { gameCode: header.gameCode },
          }),
        ],
        reason: `fork heuristic only applies to known Pokémon Gen-3 game codes (BPRE / BPGE / BPEE / AXVE / AXPE); observed code ${header.gameCode} is out of scope for this detector`,
      });
    }

    const divergences = computeDivergences({
      header,
      sizeBytes: rom.byteLength,
      canonical,
    });
    const totalScore = divergences.reduce((acc, d) => acc + d.weight, 0);

    const ev: ReturnType<typeof makeEvidence>[] = [
      makeEvidence({
        kind: 'heuristic',
        summary: `cart claims game code ${header.gameCode} - canonical reference is "${canonical.internalTitle}", maker ${canonical.makerCode}, ${String(canonical.canonicalSizesBytes[0]! / (1024 * 1024))} MiB, version ${canonical.canonicalSoftwareVersions.join('/')}`,
        weight: 0.3,
        detail: {
          gameCode: canonical.gameCode,
          canonicalDisplayName: canonical.displayName,
          canonicalSizesBytes: canonical.canonicalSizesBytes,
          canonicalSoftwareVersions: canonical.canonicalSoftwareVersions,
        },
      }),
    ];
    for (const d of divergences) {
      ev.push(
        makeEvidence({
          kind: 'heuristic',
          summary: `divergence (${d.kind}, weight ${d.weight.toFixed(2)}): ${d.description}`,
          weight: d.weight,
          detail: { kind: d.kind, weight: d.weight },
        }),
      );
    }

    const data: ForkHeuristicEvidence = Object.freeze({
      gameCode: header.gameCode,
      canonicalDisplayName: canonical.displayName,
      observedTitle: header.internalTitle,
      observedSizeBytes: rom.byteLength,
      observedSoftwareVersion: header.softwareVersion,
      observedMakerCode: header.makerCode,
      divergences: Object.freeze([...divergences]),
      totalDivergenceScore: Math.round(totalScore * 1000) / 1000,
    });

    // Confidence reflects how strongly we believe this is a fork
    // (NOT how confident we are about the detection mechanics - those
    // are 1.0 since the comparisons are deterministic).
    //
    // - 0 divergence signals → not_detected (confidence reports we're
    //   sure it ISN'T a fork: high = sure vanilla; low = unsure).
    // - any divergence ≥ WEIGHT_TITLE = 0.5 OR ≥ WEIGHT_SIZE = 0.4
    //   → detected. We pick 0.5 as the detected threshold so the strongest
    //   single signal (title) trips it on its own.
    // - smaller-only divergences → partial.
    if (divergences.length === 0) {
      return makeNotDetected({
        confidence: 0.85,
        evidence: ev,
        reason: `ROM matches canonical ${canonical.displayName} on title, size, software version, and maker code - appears vanilla (or a binary-identical-shape build)`,
      });
    }
    const cappedScore = Math.min(1, totalScore);
    if (cappedScore >= 0.5) {
      return makeDetected<ForkHeuristicEvidence>({
        confidence: cappedScore,
        evidence: ev,
        data,
      });
    }
    return makePartial<ForkHeuristicEvidence>({
      confidence: cappedScore,
      evidence: ev,
      data,
      partialReason: `weak divergence from canonical ${canonical.displayName} (total signal weight ${cappedScore.toFixed(2)} < 0.5 detected threshold) - could be a minor revision, a custom build, or just a non-standard dump`,
    });
  },
};

function computeDivergences(args: {
  header: GbaHeader;
  sizeBytes: number;
  canonical: CanonicalGen3Header;
}): DivergenceSignal[] {
  const out: DivergenceSignal[] = [];

  if (args.header.internalTitle !== args.canonical.internalTitle) {
    out.push({
      kind: 'title',
      description: `observed internal title "${args.header.internalTitle}" differs from canonical "${args.canonical.internalTitle}"`,
      weight: WEIGHT_TITLE,
    });
  }

  if (!args.canonical.canonicalSizesBytes.includes(args.sizeBytes)) {
    out.push({
      kind: 'size',
      description: `observed ROM size ${String(args.sizeBytes)} bytes is not in canonical size set [${args.canonical.canonicalSizesBytes.join(', ')}]`,
      weight: WEIGHT_SIZE,
    });
  }

  if (!args.canonical.canonicalSoftwareVersions.includes(args.header.softwareVersion)) {
    out.push({
      kind: 'software_version',
      description: `observed software version ${String(args.header.softwareVersion)} is not in canonical version set [${args.canonical.canonicalSoftwareVersions.join(', ')}]`,
      weight: WEIGHT_VERSION,
    });
  }

  if (args.header.makerCode !== args.canonical.makerCode) {
    out.push({
      kind: 'maker_code',
      description: `observed maker code "${args.header.makerCode}" differs from canonical "${args.canonical.makerCode}"`,
      weight: WEIGHT_MAKER,
    });
  }

  return out;
}
