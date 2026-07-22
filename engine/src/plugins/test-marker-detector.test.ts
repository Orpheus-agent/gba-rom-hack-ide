import { describe, expect, it } from 'vitest';
import { CoverageMap } from '../coverage/index.js';
import { loadRomFromBytes } from '../rom/index.js';
import {
  TEST_MARKER_PLUGIN_DETECTOR_ID,
  TEST_MARKER_SIGNATURE,
  testMarkerPluginDetector,
} from './test-marker-detector.js';

function makeRom(bytes: Uint8Array) {
  return loadRomFromBytes({
    bytes,
    sourcePath: 'test://plugin-fixture',
    synthetic: true,
  });
}

describe('testMarkerPluginDetector', () => {
  it('exports the universal RomDetector contract (id + name + phase + detect)', () => {
    expect(testMarkerPluginDetector.id).toBe(TEST_MARKER_PLUGIN_DETECTOR_ID);
    expect(typeof testMarkerPluginDetector.name).toBe('string');
    expect(testMarkerPluginDetector.phase).toBe(13);
    expect(typeof testMarkerPluginDetector.detect).toBe('function');
  });

  it('returns not_detected when ROM contains no TEST_MARKER', () => {
    const bytes = new Uint8Array(0x1000); // all-zero ROM
    const rom = makeRom(bytes);
    const cov = new CoverageMap(bytes.length);
    const r = testMarkerPluginDetector.detect(rom, cov);
    expect(r.status).toBe('not_detected');
    if (r.status === 'not_detected') {
      expect(r.reason).toContain('No TEST_MARKER');
    }
  });

  it('returns not_detected (size) when ROM has fewer bytes than the signature', () => {
    // loadRomFromBytes requires ≥192 bytes (a valid GBA header),
    // so this test mocks a minimal RomImage with bytes shorter
    // than TEST_MARKER_SIGNATURE.length (8 bytes).
    const tinyBytes = new Uint8Array(4);
    const tinyRom = {
      bytes: tinyBytes,
      byteLength: 4,
      sha1: 'tiny',
      sourcePath: 'mock://tiny',
      corpusClass: null,
      synthetic: true,
    };
    const cov = new CoverageMap(4);
    const r = testMarkerPluginDetector.detect(tinyRom, cov);
    expect(r.status).toBe('not_detected');
    if (r.status === 'not_detected') {
      expect(r.reason).toContain('too small');
    }
  });

  it('finds a single TEST_MARKER match + registers plugin coverage', () => {
    const bytes = new Uint8Array(0x1000);
    bytes.set(TEST_MARKER_SIGNATURE, 0x100);
    const rom = makeRom(bytes);
    const cov = new CoverageMap(bytes.length);
    const r = testMarkerPluginDetector.detect(rom, cov);
    expect(r.status).toBe('detected');
    if (r.status === 'detected') {
      const d = r.data as { matchOffsets: number[]; bytesClassified: number };
      expect(d.matchOffsets).toEqual([0x100]);
      expect(d.bytesClassified).toBe(TEST_MARKER_SIGNATURE.length);
    }
    // Coverage was updated.
    const report = cov.report();
    const pluginRegions = report.regions.filter((r) => r.probableClass === 'plugin');
    expect(pluginRegions.length).toBe(1);
    expect(pluginRegions[0]?.start).toBe(0x100);
    expect(pluginRegions[0]?.end).toBe(0x100 + TEST_MARKER_SIGNATURE.length);
  });

  it('finds multiple non-overlapping TEST_MARKER matches', () => {
    const bytes = new Uint8Array(0x1000);
    bytes.set(TEST_MARKER_SIGNATURE, 0x100);
    bytes.set(TEST_MARKER_SIGNATURE, 0x500);
    bytes.set(TEST_MARKER_SIGNATURE, 0xa00);
    const rom = makeRom(bytes);
    const cov = new CoverageMap(bytes.length);
    const r = testMarkerPluginDetector.detect(rom, cov);
    expect(r.status).toBe('detected');
    if (r.status === 'detected') {
      const d = r.data as { matchOffsets: number[] };
      expect(d.matchOffsets).toEqual([0x100, 0x500, 0xa00]);
    }
  });

  it('result.data is frozen', () => {
    const bytes = new Uint8Array(0x100);
    bytes.set(TEST_MARKER_SIGNATURE, 0x10);
    const rom = makeRom(bytes);
    const cov = new CoverageMap(bytes.length);
    const r = testMarkerPluginDetector.detect(rom, cov);
    if (r.status === 'detected') {
      expect(Object.isFrozen(r.data)).toBe(true);
    }
  });
});
