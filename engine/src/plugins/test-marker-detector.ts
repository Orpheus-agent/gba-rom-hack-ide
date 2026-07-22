/**
 * Test-marker plugin detector - Phase 13 P13-T2.
 *
 * Per §15 Phase 13 acceptance:
 * > "a new family/engine/opcode/structure can be added purely via
 * > plugin/schema/signature (demonstrated by a test plugin) with no
 * > FireRed/Emerald assumption as the sole path anywhere (grep-
 * > verified)."
 *
 * This module IS that demonstration plugin. It:
 *
 *   1. Implements the universal `RomDetector<T>` interface from
 *      `engine/src/detectors/types.ts` - the SAME contract every
 *      core detector implements. Plugins extend the engine by
 *      conforming to this interface; no core changes needed.
 *
 *   2. Scans the ROM for a hypothetical 8-byte signature
 *      `TEST_MARKER_SIGNATURE` (ASCII "TESTPLUG"). This is a
 *      contrived structure - chosen specifically to demonstrate the
 *      plugin pattern, not to detect any real Gen-3 system. The
 *      signature is unambiguous (ASCII bytes that don't appear in
 *      normal Gen-3 data) so the detector is deterministic.
 *
 *   3. Registers detected regions in the shared CoverageMap as
 *      `probableClass: 'plugin'` (a custom probableClass extension
 * - `ProbableClass` admits arbitrary strings via the escape
 *      hatch on the type union). This proves plugins can add new
 *      coverage classes without core changes.
 *
 *   4. Returns a typed `Detection<TestMarkerReport>` per the
 *      universal contract.
 *
 * PD 5: this plugin has zero FireRed/Emerald assumption. It works
 * on ANY ROM where the literal byte sequence "TESTPLUG" appears.
 * The plugin's logic does not consult the signature DB nor depend
 * on family classification. By construction it is the proof that
 * the engine's detector layer is universally extensible.
 *
 * PD 1: when no TEST_MARKER is found, the detector returns
 * `not_detected` with a reason - never an empty-success.
 *
 * Future plugin patterns (P13-T3+) demonstrate:
 *   - Adding a new NodeKind via graph-builder extension (currently
 *     graph types are declared in `graph/types.ts`; a real plugin
 *     architecture would let plugins extend the union dynamically
 *     or use a "plugin_node" generic kind).
 *   - Adding a new signature DB entry by dropping a JSON file in
 *     `/signatures/<family>/<version>.json` - already supported
 *     by the existing D-0007 hot-loadable signature DB.
 *   - Adding a new EdgeKind - same pattern as NodeKind.
 *
 * The test-marker plugin demonstrates the BASE pattern (universal
 * detector contract); extensions build on it.
 */

import { makeDetected, makeEvidence, makeNotDetected } from '../detection/index.js';
import type { Detection } from '../detection/index.js';
import type { CoverageMap } from '../coverage/index.js';
import type { RomImage } from '../rom/loader.js';
import type { RomDetector } from '../detectors/types.js';

export const TEST_MARKER_PLUGIN_DETECTOR_ID = 'plugin_test_marker';

/** The 8-byte signature this plugin looks for: ASCII "TESTPLUG".
 *  Typed arrays cannot be Object.freeze'd ("Cannot freeze array
 *  buffer views with elements"); callers should treat this as
 *  read-only by convention. */
export const TEST_MARKER_SIGNATURE: Readonly<Uint8Array> = new Uint8Array([
  0x54, 0x45, 0x53, 0x54, 0x50, 0x4c, 0x55, 0x47,
]);

export interface TestMarkerReport {
  /** File offsets where the signature was found. */
  readonly matchOffsets: ReadonlyArray<number>;
  /** Total bytes registered to coverage (= matchOffsets.length × 8). */
  readonly bytesClassified: number;
}

/**
 * Plugin detector. Scans for occurrences of TEST_MARKER_SIGNATURE in
 * `rom.bytes`. Each match is registered as `probableClass: 'plugin'`
 * coverage. Returns a typed `Detection<TestMarkerReport>` with
 * matched offsets.
 */
export const testMarkerPluginDetector: RomDetector<TestMarkerReport> = {
  id: TEST_MARKER_PLUGIN_DETECTOR_ID,
  name: 'Test Marker Plugin (P13-T2 plugin extensibility demo)',
  // Plugins can declare any phase; this one is "Phase 13" since
  // it's the P13-T2 demonstration.
  phase: 13,
  detect(rom: RomImage, coverage: CoverageMap): Detection<TestMarkerReport> {
    const sig = TEST_MARKER_SIGNATURE;
    const bytes = rom.bytes;
    if (bytes.length < sig.length) {
      return makeNotDetected({
        confidence: 1.0,
        evidence: [
          makeEvidence({
            kind: 'heuristic',
            summary: `ROM is ${String(bytes.length)} bytes - too small to host the ${String(sig.length)}-byte TEST_MARKER signature`,
            weight: 1.0,
          }),
        ],
        reason: 'ROM too small to scan for TEST_MARKER signature',
      });
    }

    const matchOffsets: number[] = [];
    // Simple per-byte linear scan. Sufficient for the demo; a real
    // plugin scanning a hot signature would use Boyer-Moore or KMP.
    outer: for (let i = 0; i <= bytes.length - sig.length; i++) {
      for (let j = 0; j < sig.length; j++) {
        if (bytes[i + j] !== sig[j]) continue outer;
      }
      matchOffsets.push(i);
      // Skip past this match to avoid overlap.
      i += sig.length - 1;
    }

    if (matchOffsets.length === 0) {
      return makeNotDetected({
        confidence: 0.95,
        evidence: [
          makeEvidence({
            kind: 'heuristic',
            summary: `scanned ${String(bytes.length)} bytes for ASCII "TESTPLUG" signature - none found`,
            weight: 1.0,
            detail: { romByteLength: bytes.length, signatureLength: sig.length },
          }),
        ],
        reason: 'No TEST_MARKER signature present in this ROM',
      });
    }

    // Register every match as `plugin` coverage. The `ProbableClass`
    // type admits arbitrary strings via the escape hatch on the
    // union, so plugins can introduce their own classes without
    // touching the coverage module's enum.
    let bytesClassified = 0;
    for (const offset of matchOffsets) {
      try {
        coverage.addClassified({
          start: offset,
          end: offset + sig.length,
          probableClass: 'plugin',
          score: 1.0,
          provenance: `${TEST_MARKER_PLUGIN_DETECTOR_ID}#match@0x${offset.toString(16)}`,
          note: `TEST_MARKER signature instance`,
        });
        bytesClassified += sig.length;
      } catch {
        // Overlap with another detector (or another match in this
        // detector if the signature were self-overlapping) - skip.
      }
    }

    return makeDetected({
      confidence: 0.95,
      data: Object.freeze({
        matchOffsets: Object.freeze([...matchOffsets]),
        bytesClassified,
      }),
      evidence: [
        makeEvidence({
          kind: 'heuristic',
          summary: `Found ${String(matchOffsets.length)} TEST_MARKER signature instance(s) - registered ${String(bytesClassified)} bytes as 'plugin' coverage class`,
          weight: 1.0,
          detail: {
            matchOffsets: matchOffsets.map((o) => `0x${o.toString(16)}`),
            bytesClassified,
          },
        }),
      ],
    });
  },
};
