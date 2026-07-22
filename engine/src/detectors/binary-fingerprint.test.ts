import { describe, expect, it } from 'vitest';
import { CoverageMap } from '../coverage/index.js';
import { buildSyntheticRom } from '../fixtures/synthetic-rom.js';
import { loadRomFromBytes } from '../rom/loader.js';
import type { SignatureDb } from '../signatures/loader.js';
import type { SignatureEntry } from '../signatures/schema.js';
import {
  BINARY_FINGERPRINT_DETECTOR_ID,
  makeBinaryFingerprintDetector,
  type RomFingerprint,
} from './binary-fingerprint.js';

function fakeDb(entries: SignatureEntry[]): SignatureDb {
  const byGameCode = new Map<string, SignatureEntry[]>();
  for (const e of entries) {
    for (const c of e.gameCodes ?? []) {
      const a = byGameCode.get(c) ?? [];
      a.push(e);
      byGameCode.set(c, a);
    }
  }
  return Object.freeze({
    allEntries: Object.freeze([...entries]),
    byGameCode,
    bySha1: new Map(),
    bySizeBytes: new Map(),
    markerEntries: [],
    loadedFiles: [],
    fileErrors: [],
  });
}

const EMPTY_DB: SignatureDb = Object.freeze({
  allEntries: [],
  byGameCode: new Map(),
  bySha1: new Map(),
  bySizeBytes: new Map(),
  markerEntries: [],
  loadedFiles: [],
  fileErrors: [],
});

describe('binaryFingerprintDetector', () => {
  it('has stable id, name, phase=1', () => {
    const det = makeBinaryFingerprintDetector({ db: EMPTY_DB });
    expect(det.id).toBe(BINARY_FINGERPRINT_DETECTOR_ID);
    expect(det.phase).toBe(1);
    expect(det.name.length).toBeGreaterThan(0);
  });

  it('returns detected when a strong signature matches (gameCode confidence ≥ 0.5)', async () => {
    const rom = buildSyntheticRom({
      title: 'POKEMON FIRE',
      gameCode: 'BPRE',
      makerCode: '01',
      softwareVersion: 0,
      romSize: 16 * 1024 * 1024,
    });
    const db = fakeDb([
      {
        id: 'firered-family',
        displayName: 'FireRed',
        family: 'firered',
        kind: 'vanilla',
        gameCodes: ['BPRE'],
        sources: ['x'],
        confidenceWhenMatched: 1.0, // → 0.5 after game_code-only scaling = at threshold
      },
    ]);
    const det = makeBinaryFingerprintDetector({ db });
    const cov = new CoverageMap(rom.byteLength);
    const r = await det.detect(rom, cov);
    expect(r.status).toBe('detected');
    if (r.status === 'detected') {
      const payload = r.data as RomFingerprint;
      expect(payload.signatureMatches).toHaveLength(1);
      expect(payload.signatureMatches[0]?.entry.family).toBe('firered');
      expect(payload.sizeClass).toBe('16MiB');
      expect(payload.heuristicHints.length).toBeGreaterThan(0);
    }
  });

  it('returns partial when no signature matches (universal-contract proof)', async () => {
    const rom = buildSyntheticRom({
      title: 'UNKNOWN',
      gameCode: 'ZZZZ',
      makerCode: 'ZZ',
      softwareVersion: 0,
      romSize: 16 * 1024 * 1024,
    });
    const det = makeBinaryFingerprintDetector({ db: EMPTY_DB });
    const cov = new CoverageMap(rom.byteLength);
    const r = await det.detect(rom, cov);
    expect(r.status).toBe('partial');
    if (r.status === 'partial') {
      const payload = r.data as RomFingerprint;
      expect(payload.signatureMatches).toEqual([]);
      expect(payload.romSha1).toBe(rom.sha1);
      expect(payload.sizeClass).toBe('16MiB');
      // PD 1: data is non-empty, partialReason is non-empty.
      expect(r.partialReason).toContain('no signature');
    }
  });

  it('returns not_detected when GBA header does not parse (defers to Phase 0)', async () => {
    const rom = loadRomFromBytes({ bytes: Buffer.alloc(1024, 0) }); // no 0x96 marker
    const det = makeBinaryFingerprintDetector({ db: EMPTY_DB });
    const cov = new CoverageMap(rom.byteLength);
    const r = await det.detect(rom, cov);
    expect(r.status).toBe('not_detected');
    if (r.status === 'not_detected') {
      expect(r.reason).toContain('cannot fingerprint');
    }
  });

  it('classifies size into known GBA tiers', async () => {
    const sizes: Array<[number, string]> = [
      [4 * 1024 * 1024, '4MiB'],
      [8 * 1024 * 1024, '8MiB'],
      [16 * 1024 * 1024, '16MiB'],
      [32 * 1024 * 1024, '32MiB'],
      [12 * 1024 * 1024, 'odd'],
      [256 * 1024, 'sub-4MiB'],
    ];
    const det = makeBinaryFingerprintDetector({ db: EMPTY_DB });
    for (const [size, want] of sizes) {
      const rom = buildSyntheticRom({ romSize: size, gameCode: 'ZZZZ' });
      const cov = new CoverageMap(rom.byteLength);
      const r = await det.detect(rom, cov);
      expect(r.status).toBe('partial');
      if (r.status === 'partial') {
        const payload = r.data as RomFingerprint;
        expect(payload.sizeClass).toBe(want);
      }
    }
  });

  it('reports heuristic hints including entropy sample', async () => {
    const rom = buildSyntheticRom({ romSize: 16 * 1024 * 1024, gameCode: 'BPRE' });
    const det = makeBinaryFingerprintDetector({ db: EMPTY_DB });
    const cov = new CoverageMap(rom.byteLength);
    const r = await det.detect(rom, cov);
    if (r.status !== 'detected' && r.status !== 'partial') throw new Error('expected detected/partial');
    const payload = r.data as RomFingerprint;
    expect(payload.heuristicHints.some((h) => h.includes('entropy'))).toBe(true);
  });

  it('every detection result carries ≥1 evidence item (PD 1)', async () => {
    const rom = buildSyntheticRom({ romSize: 1024, gameCode: 'XYZW' });
    const det = makeBinaryFingerprintDetector({ db: EMPTY_DB });
    const cov = new CoverageMap(rom.byteLength);
    const r = await det.detect(rom, cov);
    expect(r.evidence.length).toBeGreaterThanOrEqual(1);
  });

  it('does NOT write to coverage (Phase 1 fingerprint covers no specific bytes)', async () => {
    // The Phase 0 header detector owns the 0..0xC0 region. The Phase 1
    // binary fingerprint summarizes IDENTITY, not specific bytes.
    const rom = buildSyntheticRom({ romSize: 1024, gameCode: 'BPRE' });
    const det = makeBinaryFingerprintDetector({ db: EMPTY_DB });
    const cov = new CoverageMap(rom.byteLength);
    await det.detect(rom, cov);
    expect(cov.report().classifiedBytes).toBe(0);
  });
});
