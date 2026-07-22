/**
 * Phase 0 Exit-Gate smoke test.
 *
 * This test proves end-to-end that:
 *
 *   (a) a corpus ROM can be LOADED (loader → RomImage)
 *   (b) the ORCHESTRATOR runs all registered detectors and produces a
 *       report in which NO system reports empty-as-success - every result
 *       is either real data (detected/partial) OR a typed not_detected with
 *       reason
 *   (c) a COVERAGE FIGURE is computed (the GBA cartridge header is at least
 *       fully accounted for)
 *
 * The test exercises three input shapes:
 *   1. A labeled synthetic structural fixture (B-0001 route-around when
 *      operator-supplied corpus is empty) - proves the pipeline works on
 *      bytes the engine generated itself.
 *   2. Every operator-supplied ROM under /corpus/ (zero or more - if zero
 *      this branch is a noop and the test reports it explicitly).
 *   3. A malformed input that proves the empty-success guard fires at the
 *      orchestrator boundary even when a hand-rolled detector tries to
 *      smuggle empty data through.
 *
 * If this test passes, Phase 0 Exit Gate is satisfied for the smoke-test
 * criterion.
 */

import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CoverageMap, formatCoverageLogLine } from '../coverage/index.js';
import { walkCorpus } from '../corpus/index.js';
import {
  asConfidence,
  makeEvidence,
  type Detection,
} from '../detection/index.js';
import { headerFingerprintDetector } from '../detectors/header-fingerprint.js';
import type { RomDetector } from '../detectors/types.js';
import { buildSyntheticRom } from '../fixtures/synthetic-rom.js';
import { loadRomFromPath } from '../rom/loader.js';
import { GBA_HEADER_LENGTH } from '../rom/header.js';
import { OrchestratorPDViolation, ingestRom } from './orchestrator.js';

// Resolve /corpus/ relative to the engine source root regardless of where
// vitest is invoked from. __filename is /engine/src/ingest/smoke.test.ts;
// three .. takes us to /engine, then ../corpus is the Project Root corpus.
const __filename = fileURLToPath(import.meta.url);
const PROJECT_CORPUS_DIR = path.resolve(path.dirname(__filename), '..', '..', '..', 'corpus');

/** The Phase-0 detector registry - only the header fingerprint at this phase. */
const PHASE_0_DETECTORS: ReadonlyArray<RomDetector<unknown>> = [headerFingerprintDetector];

/**
 * Universal post-conditions every IngestReport must satisfy by Phase 0's
 * spec. Re-used across the synthetic + corpus tests so the contract is
 * checked uniformly.
 */
function assertUniversalContract(report: Awaited<ReturnType<typeof ingestRom>>): void {
  // (b) - every detection result MUST be one of the three legal shapes
  // with a real reason/evidence, no empty-success path.
  for (const r of report.detections) {
    expect(r.detection.evidence.length).toBeGreaterThanOrEqual(1);
    expect(r.detection.confidence).toBeGreaterThanOrEqual(0);
    expect(r.detection.confidence).toBeLessThanOrEqual(1);
    if (r.detection.status === 'detected' || r.detection.status === 'partial') {
      // data must be non-empty - checked by assertNoEmptySuccess but we
      // re-assert here so the smoke test itself documents the contract.
      const data: unknown = r.detection.data;
      const isEmptyObject = data !== null && typeof data === 'object' && Object.keys(data as object).length === 0;
      const isEmptyArray = Array.isArray(data) && data.length === 0;
      expect(data).not.toBeNull();
      expect(data).not.toBeUndefined();
      expect(isEmptyObject).toBe(false);
      expect(isEmptyArray).toBe(false);
    } else {
      expect(r.detection.reason.length).toBeGreaterThan(0);
    }
  }
  // (c) - coverage figure is real; header bytes are classified
  // (the header-fingerprint detector either classifies them at score=1.0
  // for detected or score=0.5 for partial). At minimum, classifiedBytes
  // ≥ GBA_HEADER_LENGTH whenever the detector reached the marker check
  // (i.e. ROM is at least 192 bytes).
  if (report.rom.byteLength >= GBA_HEADER_LENGTH) {
    expect(report.coverage.classifiedBytes).toBeGreaterThanOrEqual(GBA_HEADER_LENGTH);
  }
  expect(
    report.coverage.classifiedBytes +
      report.coverage.unknownScoredBytes +
      report.coverage.unaccountedBytes,
  ).toBe(report.rom.byteLength);
}

describe('Phase 0 - end-to-end ingest smoke test (universal contract proof)', () => {
  it('synthetic structural fixture: ingest reports detected header + coverage ≥ 192 bytes', async () => {
    // B-0001 route-around: when /corpus/ is empty, the synthetic fixture
    // stands in. Labeled `synthetic: true` so reports differentiate it.
    const rom = buildSyntheticRom({
      title: 'PHASE0SMOKE',
      gameCode: 'ZZZZ',
      makerCode: 'ZZ',
      softwareVersion: 0,
      romSize: 16 * 1024 * 1024, // 16 MiB
    });
    expect(rom.synthetic).toBe(true);

    const report = await ingestRom({ rom, detectors: PHASE_0_DETECTORS });

    // (a) loaded
    expect(report.rom.byteLength).toBe(16 * 1024 * 1024);
    expect(report.rom.sha1).toMatch(/^[0-9a-f]{40}$/);
    expect(report.rom.synthetic).toBe(true);

    // (b) detection roundup is non-empty + universal contract holds
    expect(report.detections).toHaveLength(1);
    const headerResult = report.detections[0];
    expect(headerResult?.detection.status).toBe('detected');
    assertUniversalContract(report);

    // (c) coverage figure is real; header bytes accounted for
    expect(report.coverage.classifiedBytes).toBe(GBA_HEADER_LENGTH);
    expect(report.coverage.unaccountedBytes).toBe(16 * 1024 * 1024 - GBA_HEADER_LENGTH);
    expect(report.coverage.unknownScoredBytes).toBe(0);

    // Emit a log line in the §9.7 format so the smoke can be inspected
    // visually if needed. (Console output here is captured by vitest.)
    const line = formatCoverageLogLine({
      utcIso: new Date().toISOString(),
      romClass: 'synthetic',
      report: report.coverage,
    });
    expect(line).toContain('classified=');
  });

  it('synthetic structural fixture with CORRUPT marker: ingest reports partial (NOT detected, NOT empty success)', async () => {
    const rom = buildSyntheticRom({
      title: 'CORRUPT',
      gameCode: 'BPRE',
      makerCode: '01',
      softwareVersion: 0,
      romSize: 1024,
      validFixedMarker: false,
    });
    const report = await ingestRom({ rom, detectors: PHASE_0_DETECTORS });
    expect(report.detections[0]?.detection.status).toBe('partial');
    assertUniversalContract(report);
    // The partial-detection still REGISTERS the header region (at lower score).
    expect(report.coverage.classifiedBytes).toBe(GBA_HEADER_LENGTH);
  });

  it('orchestrator REJECTS a hand-rolled empty-success detector (PD 1 boundary guard fires)', async () => {
    const liar: RomDetector<unknown[]> = {
      id: 'phase_0_liar',
      name: 'Phase 0 Liar (test fixture)',
      phase: 0,
      detect() {
        return {
          status: 'detected',
          confidence: asConfidence(0.99),
          evidence: [makeEvidence({ kind: 'heuristic', summary: 'shouldnt pass', weight: 1.0 })],
          data: {},
        } as unknown as Detection<unknown[]>;
      },
    };
    const rom = buildSyntheticRom({ romSize: 1024 });
    await expect(ingestRom({ rom, detectors: [liar] })).rejects.toBeInstanceOf(OrchestratorPDViolation);
  });

  it('operator-supplied corpus: every .gba under /corpus/<class>/ passes the universal contract', async () => {
    const walk = await walkCorpus({ rootDir: PROJECT_CORPUS_DIR });

    if (walk.entries.length === 0) {
      // B-0001 route-around. Honestly report; do NOT fake success.
      // The synthetic test above + the rest of the smoke prove the
      // pipeline; this branch becomes meaningful once the operator drops
      // ROMs into /corpus/.
      console.warn(
        `[smoke] /corpus/ is empty - corpus universality is being validated by ` +
          `synthetic fixture only (B-0001 routed). Operator-supplied ROMs strengthen ` +
          `this gate when present at /corpus/<class>/.`,
      );
      expect(walk.suppliedClasses).toEqual([]);
      expect(walk.missingKnownClasses.length).toBeGreaterThan(0);
      return;
    }

    // Operator HAS supplied corpus ROMs - every one of them must pass.
    const lines: string[] = [];
    for (const entry of walk.entries) {
      const rom = await loadRomFromPath({ filePath: entry.path, corpusClass: entry.corpusClass });
      const report = await ingestRom({ rom, detectors: PHASE_0_DETECTORS });
      assertUniversalContract(report);
      lines.push(
        formatCoverageLogLine({
          utcIso: new Date().toISOString(),
          romClass: entry.corpusClass ?? 'unclassified',
          report: report.coverage,
        }),
      );
    }
    expect(lines.length).toBe(walk.entries.length);
  });

  it('an empty detector registry still produces a valid report (no false-positives)', async () => {
    const rom = buildSyntheticRom({ romSize: 1024 });
    const report = await ingestRom({ rom, detectors: [] });
    expect(report.detections).toHaveLength(0);
    expect(report.coverage.classifiedBytes).toBe(0);
    // 1024 bytes wholly unaccounted - that's an honest report, not a failure.
    expect(report.coverage.unaccountedBytes).toBe(1024);
  });

  it('CoverageMap monotone-non-decreasing invariant exists at the type level (already unit-tested)', () => {
    // This is a meta-test: Phase 0's coverage infrastructure is real and
    // proven by the per-module tests. We assert here that the symbol is
    // reachable from the smoke-test surface to document the dependency.
    expect(typeof CoverageMap).toBe('function');
  });
});
