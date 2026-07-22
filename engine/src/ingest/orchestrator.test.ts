import { describe, expect, it } from 'vitest';
import { CoverageMap } from '../coverage/index.js';
import {
  asConfidence,
  makeDetected,
  makeEvidence,
  makeNotDetected,
  type Detection,
} from '../detection/index.js';
import { loadRomFromBytes, type RomImage } from '../rom/loader.js';
import type { RomDetector } from '../detectors/types.js';
import { OrchestratorPDViolation, ingestRom } from './orchestrator.js';

function tinyRom(): RomImage {
  return loadRomFromBytes({ bytes: Buffer.alloc(256, 0x00) });
}

/* Helpers - minimal detectors for orchestrator-only behavior. */

const okDetector: RomDetector<{ ok: true }> = {
  id: 'ok',
  name: 'OK Detector',
  phase: 1,
  detect(_rom, cov) {
    cov.addClassified({
      start: 0,
      end: 16,
      probableClass: 'header',
      score: 1.0,
      provenance: 'ok',
    });
    return makeDetected({
      confidence: 0.9,
      evidence: [makeEvidence({ kind: 'signature', summary: 'always', weight: 1.0 })],
      data: { ok: true },
    });
  },
};

const notDetectedDetector: RomDetector<never> = {
  id: 'absent',
  name: 'Absent Detector',
  phase: 1,
  detect() {
    return makeNotDetected({
      confidence: 0.8,
      evidence: [makeEvidence({ kind: 'signature', summary: 'searched, none found', weight: 1.0 })],
      reason: 'system not present in this ROM',
    });
  },
};

const throwingDetector: RomDetector<never> = {
  id: 'thrower',
  name: 'Throwing Detector',
  phase: 1,
  detect() {
    throw new Error('something went wrong inside the detector');
  },
};

/**
 * A detector that hand-rolls an invalid Detection (bypassing the safe
 * constructors) so we can prove the orchestrator's boundary guard fires.
 */
const liarDetector: RomDetector<unknown[]> = {
  id: 'liar',
  name: 'PD-1-Violating Detector',
  phase: 1,
  detect() {
    return {
      status: 'detected',
      confidence: asConfidence(0.9),
      evidence: [makeEvidence({ kind: 'heuristic', summary: 'plausible', weight: 1.0 })],
      data: [],
    } as unknown as Detection<unknown[]>;
  },
};

describe('ingestRom', () => {
  it('runs detectors in declared order and reports each result', async () => {
    const report = await ingestRom({ rom: tinyRom(), detectors: [okDetector, notDetectedDetector] });
    expect(report.detections).toHaveLength(2);
    expect(report.detections[0]?.detectorId).toBe('ok');
    expect(report.detections[1]?.detectorId).toBe('absent');
  });

  it('aggregates summary counts', async () => {
    const report = await ingestRom({ rom: tinyRom(), detectors: [okDetector, notDetectedDetector] });
    expect(report.summary.detectedCount).toBe(1);
    expect(report.summary.notDetectedCount).toBe(1);
    expect(report.summary.partialCount).toBe(0);
    expect(report.summary.totalDetectors).toBe(2);
  });

  it('shares one CoverageMap across detectors and reports the final coverage', async () => {
    const report = await ingestRom({ rom: tinyRom(), detectors: [okDetector] });
    expect(report.coverage.classifiedBytes).toBe(16);
    expect(report.coverage.romSize).toBe(256);
  });

  it('boundary-asserts PD 1 and throws OrchestratorPDViolation on empty-success', async () => {
    await expect(ingestRom({ rom: tinyRom(), detectors: [liarDetector] })).rejects.toBeInstanceOf(
      OrchestratorPDViolation,
    );
    try {
      await ingestRom({ rom: tinyRom(), detectors: [liarDetector] });
    } catch (e) {
      const err = e as OrchestratorPDViolation;
      expect(err.detectorId).toBe('liar');
    }
  });

  it('converts an unhandled detector throw into a typed not_detected (not a crash)', async () => {
    const report = await ingestRom({ rom: tinyRom(), detectors: [throwingDetector] });
    expect(report.detections).toHaveLength(1);
    expect(report.detections[0]?.detection.status).toBe('not_detected');
    if (report.detections[0]?.detection.status === 'not_detected') {
      expect(report.detections[0]?.detection.reason).toContain('threw');
    }
  });

  it('records per-detector runtime in milliseconds', async () => {
    const report = await ingestRom({ rom: tinyRom(), detectors: [okDetector] });
    expect(report.detections[0]?.runtimeMs).toBeGreaterThanOrEqual(0);
    expect(typeof report.detections[0]?.runtimeMs).toBe('number');
  });

  it('produces a frozen, immutable report', async () => {
    const report = await ingestRom({ rom: tinyRom(), detectors: [okDetector] });
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.rom)).toBe(true);
    expect(Object.isFrozen(report.summary)).toBe(true);
    expect(Object.isFrozen(report.detections)).toBe(true);
  });

  it('passes ROM identity (sha1, sourcePath, synthetic, corpusClass) through to the report', async () => {
    const rom = loadRomFromBytes({
      bytes: Buffer.alloc(256, 0xaa),
      sourcePath: '/test/path.gba',
      corpusClass: 'vanilla',
      synthetic: false,
    });
    const report = await ingestRom({ rom, detectors: [okDetector] });
    expect(report.rom.sha1).toBe(rom.sha1);
    expect(report.rom.sourcePath).toBe('/test/path.gba');
    expect(report.rom.corpusClass).toBe('vanilla');
    expect(report.rom.synthetic).toBe(false);
  });

  it('runs zero detectors cleanly (empty registry)', async () => {
    const report = await ingestRom({ rom: tinyRom(), detectors: [] });
    expect(report.detections).toHaveLength(0);
    expect(report.summary.totalDetectors).toBe(0);
    expect(report.coverage.classifiedBytes).toBe(0);
    expect(report.coverage.unaccountedBytes).toBe(256);
  });

  it('preserves CoverageMap monotonicity invariant: classifying detectors only grow coverage', async () => {
    const cov = new CoverageMap(256);
    cov.addClassified({
      start: 0,
      end: 8,
      probableClass: 'a',
      score: 1,
      provenance: 'p',
    });
    const before = cov.report().classifiedBytes;
    // The orchestrator creates its OWN CoverageMap - confirm by running a
    // detector that classifies 16 bytes and showing the report's
    // classifiedBytes equals exactly that, not the 8 from this external map.
    const report = await ingestRom({ rom: tinyRom(), detectors: [okDetector] });
    expect(before).toBe(8);
    expect(report.coverage.classifiedBytes).toBe(16);
  });
});
