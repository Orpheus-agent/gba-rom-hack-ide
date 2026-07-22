/**
 * Signature matcher.
 *
 * Pure function: given a ROM's identity (sha1, byteLength, gameCode if
 * parsed) + bytes + a SignatureDb, return the list of matching entries
 * with PER-ENTRY match-reason evidence.
 *
 * Matching rules:
 *   - SHA-1 exact match → strong match (the bytes ARE this entry).
 *   - Game code + size match → moderate match.
 *   - Game code alone → weak match (most hacks keep their parent's code).
 *   - Build-marker (any byte pattern at a specific offset) → independent
 *     match-type, can combine with other signals.
 *
 * Match output carries the reasons in a typed form so the binary-fingerprint
 * detector can put concrete evidence into Detection.evidence rather than
 * synthesizing it.
 */

import type { SignatureDb } from './loader.js';
import type { BuildMarker, SignatureEntry } from './schema.js';

export type MatchReasonKind =
  | 'sha1'
  | 'game_code'
  | 'size_bytes'
  | 'build_marker';

export interface MatchReason {
  readonly kind: MatchReasonKind;
  readonly detail: string;
}

export interface SignatureMatch {
  readonly entry: SignatureEntry;
  readonly reasons: ReadonlyArray<MatchReason>;
  /** Aggregated confidence from the entry's `confidenceWhenMatched` scaled
   * by how STRONG the match is (sha1 = 1.0×, gameCode-only = 0.5×, etc.). */
  readonly confidence: number;
}

export interface MatchSignaturesArgs {
  readonly rom: { readonly sha1: string; readonly byteLength: number; readonly bytes: Uint8Array };
  readonly gameCode: string | null;
  readonly db: SignatureDb;
}

/**
 * Match `rom` + `gameCode` against `db`. Returns matches sorted by
 * confidence DESC. Empty array is a valid (and meaningful) outcome - 
 * "no signature matched" is a positive heuristic signal in itself.
 */
export function matchSignatures(args: MatchSignaturesArgs): ReadonlyArray<SignatureMatch> {
  const candidates = new Map<string, { entry: SignatureEntry; reasons: MatchReason[] }>();

  // 1) SHA-1 - strongest.
  const sha1Matches = args.db.bySha1.get(args.rom.sha1.toLowerCase());
  if (sha1Matches) {
    for (const e of sha1Matches) {
      record(candidates, e, { kind: 'sha1', detail: `ROM sha1 ${args.rom.sha1} listed in signature` });
    }
  }

  // 2) Game code.
  if (args.gameCode !== null) {
    const gcMatches = args.db.byGameCode.get(args.gameCode);
    if (gcMatches) {
      for (const e of gcMatches) {
        record(candidates, e, {
          kind: 'game_code',
          detail: `cartridge game code ${args.gameCode} listed in signature`,
        });
      }
    }
  }

  // 3) Size bytes - only meaningful when combined with another signal, but
  //    we record it so the detector can show "all of: game_code + size_bytes".
  const sizeMatches = args.db.bySizeBytes.get(args.rom.byteLength);
  if (sizeMatches) {
    for (const e of sizeMatches) {
      record(candidates, e, {
        kind: 'size_bytes',
        detail: `ROM size ${String(args.rom.byteLength)} bytes matches signature`,
      });
    }
  }

  // 4) Build markers - iterate the (typically small) markerEntries list and
  //    check ALL markers per entry.
  for (const e of args.db.markerEntries) {
    if (!e.buildMarkers) continue;
    const allHit = e.buildMarkers.every((m) => markerMatches(args.rom.bytes, m));
    if (allHit) {
      const markersLabel = e.buildMarkers
        .map((m) => m.label ?? `pattern@0x${m.offset.toString(16).toUpperCase()}`)
        .join(', ');
      record(candidates, e, {
        kind: 'build_marker',
        detail: `all ${String(e.buildMarkers.length)} build markers matched: ${markersLabel}`,
      });
    }
  }

  // Score + sort.
  const matches: SignatureMatch[] = [];
  for (const c of candidates.values()) {
    const conf = scoreMatch(c.entry, c.reasons);
    matches.push(Object.freeze({
      entry: c.entry,
      reasons: Object.freeze([...c.reasons]),
      confidence: conf,
    }));
  }
  matches.sort((a, b) => b.confidence - a.confidence);
  return Object.freeze(matches);
}

function record(
  m: Map<string, { entry: SignatureEntry; reasons: MatchReason[] }>,
  entry: SignatureEntry,
  reason: MatchReason,
): void {
  const existing = m.get(entry.id);
  if (existing === undefined) {
    m.set(entry.id, { entry, reasons: [reason] });
  } else {
    existing.reasons.push(reason);
  }
}

function markerMatches(bytes: Uint8Array, marker: BuildMarker): boolean {
  const magicHex = marker.magic.toUpperCase();
  if (magicHex.length % 2 !== 0) return false;
  const magicBytes = new Uint8Array(magicHex.length / 2);
  for (let i = 0; i < magicHex.length; i += 2) {
    const byte = parseInt(magicHex.substring(i, i + 2), 16);
    if (Number.isNaN(byte)) return false;
    magicBytes[i / 2] = byte;
  }
  if (marker.offset + magicBytes.length > bytes.length) return false;
  for (let i = 0; i < magicBytes.length; i++) {
    if (bytes[marker.offset + i] !== magicBytes[i]) return false;
  }
  return true;
}

/**
 * Aggregate the entry's `confidenceWhenMatched` against how strong the
 * combined reasons are. SHA-1 alone is treated as full strength; everything
 * else scales down so a multi-reason match outscores a single-reason match.
 *
 * Match-strength multiplier (applied to confidenceWhenMatched):
 *   - includes sha1                 → 1.00
 *   - build_marker + game_code      → 0.95
 *   - build_marker alone            → 0.85
 *   - game_code + size_bytes        → 0.70
 *   - game_code alone               → 0.50
 *   - size_bytes alone              → 0.20  (too weak to mean much by itself)
 */
function scoreMatch(entry: SignatureEntry, reasons: ReadonlyArray<MatchReason>): number {
  const kinds = new Set(reasons.map((r) => r.kind));
  let strength: number;
  if (kinds.has('sha1')) {
    strength = 1.0;
  } else if (kinds.has('build_marker') && kinds.has('game_code')) {
    strength = 0.95;
  } else if (kinds.has('build_marker')) {
    strength = 0.85;
  } else if (kinds.has('game_code') && kinds.has('size_bytes')) {
    strength = 0.7;
  } else if (kinds.has('game_code')) {
    strength = 0.5;
  } else if (kinds.has('size_bytes')) {
    strength = 0.2;
  } else {
    strength = 0.0;
  }
  return clampConfidence(entry.confidenceWhenMatched * strength);
}

function clampConfidence(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return Math.round(n * 1000) / 1000; // 3-decimal precision
}
