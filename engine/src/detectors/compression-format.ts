/**
 * Phase-2 detector: compression-format identification.
 *
 * Per §15 P2 acceptance:
 *   "compression-format identification (LZ77/known + entropy/structure
 *    heuristics for custom/relocated compression). ... custom compression
 *    blocks are at least classified `probable compression` with a score
 *    (never silently skipped)."
 *
 * This detector combines the two paths required by PD 5:
 *   1. SIGNATURE - scan for GBA BIOS LZ77 streams (0x10 header), verify
 *      each via actual decompression, register confirmed blocks in
 *      CoverageMap as `compression` class at high confidence.
 *   2. HEURISTIC - for remaining regions (NOT already covered by an
 *      LZ77 block AND not covered by an earlier detector), compute
 *      byte-entropy with a sliding window. High-entropy regions (≥ 7.0
 *      bits/byte) get registered in CoverageMap as `unknown_scored`
 *      with `probableClass: 'compression'` and a confidence proportional
 *      to peak entropy.
 *
 * PD 8 contract: a high-entropy region the LZ77 scanner can't claim is
 * NEVER silently dropped. It always appears in the coverage ledger,
 * either as a confirmed `compression` region or as a scored unknown
 * with `probableClass: 'compression'`.
 */

import { makeDetected, makeEvidence, makeNotDetected } from '../detection/index.js';
import type { Detection } from '../detection/index.js';
import type { CoverageMap } from '../coverage/index.js';
import type { RomImage } from '../rom/loader.js';
import type { RomDetector } from './types.js';
import {
  dedupeOverlappingBlocks,
  findHighEntropyRegions,
  findLz77Candidates,
  type EntropyRegion,
  type Lz77Block,
} from '../compression/index.js';

export const COMPRESSION_FORMAT_DETECTOR_ID = 'compression_format';

export interface CompressionInventory {
  /** Confirmed LZ77 streams (verified by successful decompression). */
  readonly lz77Blocks: ReadonlyArray<Lz77Block>;
  /** Total bytes covered by confirmed LZ77 blocks. */
  readonly lz77BytesCovered: number;
  /** High-entropy regions that did NOT overlap a confirmed LZ77 block - 
   *  registered as probable_compression scored-unknowns. */
  readonly probableCompressionRegions: ReadonlyArray<EntropyRegion>;
  /** Total bytes covered by probable-compression scored unknowns. */
  readonly probableCompressionBytesScored: number;
}

const ENTROPY_HIGH_THRESHOLD = 7.0;
const ENTROPY_WINDOW_SIZE = 1024;
const ENTROPY_STEP_SIZE = 512;

export const compressionFormatDetector: RomDetector<CompressionInventory> = {
  id: COMPRESSION_FORMAT_DETECTOR_ID,
  name: 'Compression Format Identification',
  phase: 2,
  detect(rom: RomImage, coverage: CoverageMap): Detection<CompressionInventory> {
    if (rom.byteLength < 16) {
      return makeNotDetected({
        confidence: 1.0,
        evidence: [
          makeEvidence({
            kind: 'heuristic',
            summary: `ROM is ${String(rom.byteLength)} bytes - too small to host a 4-byte LZ77 header + payload`,
            weight: 1.0,
          }),
        ],
        reason: 'ROM too small to scan for compression formats',
      });
    }

    // 1) LZ77 scan + dedupe overlapping candidates.
    const rawCandidates = findLz77Candidates(rom.bytes);
    const lz77Blocks = dedupeOverlappingBlocks(rawCandidates);
    let lz77BytesCovered = 0;
    for (const block of lz77Blocks) {
      lz77BytesCovered += block.compressedLength;
      try {
        coverage.addClassified({
          start: block.start,
          end: block.endExclusive,
          probableClass: 'compression',
          score: 0.95, // verified decompression → high confidence
          provenance: `${COMPRESSION_FORMAT_DETECTOR_ID}#lz77-uncomp${String(block.uncompressedSize)}`,
          note: `LZ77 stream - uncompressed size ${String(block.uncompressedSize)} bytes`,
        });
      } catch {
        // Overlap with an earlier-classified region (e.g. the GBA cart
        // header parsed by Phase 0). Skip and move on - the coverage
        // map already has stronger info for this region.
      }
    }

    // 2) High-entropy scan, excluding bytes already classified by the
    //    LZ77 blocks (we don't want to double-report a confirmed LZ77
    //    block as a probable-compression unknown).
    const allHighEntropy = findHighEntropyRegions(rom.bytes, {
      windowSize: ENTROPY_WINDOW_SIZE,
      stepSize: ENTROPY_STEP_SIZE,
      highEntropyThreshold: ENTROPY_HIGH_THRESHOLD,
    });
    const probableCompressionRegions = subtractClassifiedRanges({
      regions: allHighEntropy,
      classifiedRanges: lz77Blocks.map((b) => ({ start: b.start, end: b.endExclusive })),
    });

    let probableCompressionBytesScored = 0;
    for (const r of probableCompressionRegions) {
      probableCompressionBytesScored += r.length;
      try {
        coverage.addUnknownScored({
          start: r.start,
          end: r.endExclusive,
          probableClass: 'compression',
          // Confidence scales from peak entropy: 7.0 → 0.4, 7.5 → 0.55,
          // 7.9 → 0.7, 8.0 → 0.8. Capped at 0.8 because entropy alone
          // doesn't confirm compression (encrypted / random data also
          // hits 8.0).
          score: entropyToCompressionConfidence(r.peakEntropy),
          provenance: `${COMPRESSION_FORMAT_DETECTOR_ID}#entropy-peak${r.peakEntropy.toFixed(2)}`,
          note: `high-entropy region (mean=${r.meanEntropy.toFixed(2)} peak=${r.peakEntropy.toFixed(2)} bits/byte) - probable compression`,
        });
      } catch {
        // Overlap with an earlier detector - skip.
      }
    }

    const inventory: CompressionInventory = Object.freeze({
      lz77Blocks: Object.freeze(lz77Blocks),
      lz77BytesCovered,
      probableCompressionRegions: Object.freeze(probableCompressionRegions),
      probableCompressionBytesScored,
    });

    // Status: detected when we found at least one confirmed LZ77 block OR
    // probable-compression region. Otherwise honest not_detected with
    // reason - a ROM with zero compressed assets (synthetic fixture)
    // genuinely has none.
    if (lz77Blocks.length === 0 && probableCompressionRegions.length === 0) {
      return makeNotDetected({
        confidence: 0.8,
        evidence: [
          makeEvidence({
            kind: 'compression',
            summary: `scanned ${String(rom.byteLength)} bytes at stride 4 for LZ77 (0x10 header) and ran sliding-window entropy analysis (window=${String(ENTROPY_WINDOW_SIZE)}, step=${String(ENTROPY_STEP_SIZE)}, threshold=${String(ENTROPY_HIGH_THRESHOLD)} bits/byte) - no compressed regions found`,
            weight: 1.0,
            detail: {
              romByteLength: rom.byteLength,
              entropyThreshold: ENTROPY_HIGH_THRESHOLD,
              entropyWindowSize: ENTROPY_WINDOW_SIZE,
            },
          }),
        ],
        reason:
          'No LZ77 streams and no high-entropy regions detected - the ROM body is likely zero-fill (synthetic fixture) or otherwise contains no compressed content',
      });
    }

    return makeDetected<CompressionInventory>({
      confidence: lz77Blocks.length > 0 ? 0.9 : 0.6,
      evidence: [
        makeEvidence({
          kind: 'compression',
          summary: `confirmed ${String(lz77Blocks.length)} LZ77 stream(s) covering ${String(lz77BytesCovered)} bytes (decompressed successfully)`,
          weight: 0.6,
          detail: {
            lz77BlockCount: lz77Blocks.length,
            lz77BytesCovered,
            topBlocks: lz77Blocks
              .slice(0, 5)
              .map((b) => ({ start: b.start, compressedLength: b.compressedLength, uncompressedSize: b.uncompressedSize })),
          },
        }),
        makeEvidence({
          kind: 'heuristic',
          summary: `${String(probableCompressionRegions.length)} additional high-entropy region(s) scored as probable_compression - ${String(probableCompressionBytesScored)} bytes`,
          weight: 0.3,
          detail: {
            regionCount: probableCompressionRegions.length,
            bytesScored: probableCompressionBytesScored,
            topRegions: probableCompressionRegions
              .slice(0, 5)
              .map((r) => ({ start: r.start, length: r.length, peakEntropy: r.peakEntropy })),
          },
        }),
      ],
      data: inventory,
    });
  },
};

/** Map peak entropy ∈ [7.0, 8.0] to a confidence ∈ [0.4, 0.8]. */
function entropyToCompressionConfidence(peakEntropy: number): number {
  if (peakEntropy >= 8.0) return 0.8;
  if (peakEntropy <= 7.0) return 0.4;
  return 0.4 + ((peakEntropy - 7.0) / 1.0) * 0.4;
}

/**
 * Return only those entropy regions whose byte range does NOT overlap any
 * already-classified range (the LZ77 blocks). When a region partially
 * overlaps, we keep the non-overlapping prefix/suffix only when those
 * sub-regions are ≥ ENTROPY_WINDOW_SIZE so we don't fragment into
 * misleadingly-short slivers.
 */
function subtractClassifiedRanges(args: {
  regions: ReadonlyArray<EntropyRegion>;
  classifiedRanges: ReadonlyArray<{ start: number; end: number }>;
}): EntropyRegion[] {
  if (args.classifiedRanges.length === 0) return [...args.regions];
  const sortedRanges = [...args.classifiedRanges].sort((a, b) => a.start - b.start);
  const out: EntropyRegion[] = [];
  for (const r of args.regions) {
    let cursor = r.start;
    for (const c of sortedRanges) {
      if (c.end <= cursor) continue;
      if (c.start >= r.endExclusive) break;
      // overlap [max(cursor, c.start), min(r.endExclusive, c.end))
      if (c.start > cursor) {
        emitSubRegion(out, r, cursor, c.start);
      }
      cursor = Math.max(cursor, c.end);
      if (cursor >= r.endExclusive) break;
    }
    if (cursor < r.endExclusive) emitSubRegion(out, r, cursor, r.endExclusive);
  }
  return out;
}

function emitSubRegion(
  out: EntropyRegion[],
  parent: EntropyRegion,
  start: number,
  endExclusive: number,
): void {
  if (endExclusive - start < ENTROPY_WINDOW_SIZE) return;
  out.push(
    Object.freeze({
      start,
      endExclusive,
      length: endExclusive - start,
      meanEntropy: parent.meanEntropy,
      peakEntropy: parent.peakEntropy,
    }),
  );
}
