import { describe, expect, it } from 'vitest';
import { CoverageMap } from '../coverage/index.js';
import { buildSyntheticRom } from '../fixtures/synthetic-rom.js';
import { loadRomFromBytes } from '../rom/loader.js';
import {
  FORK_HEURISTIC_DETECTOR_ID,
  forkHeuristicDetector,
  type ForkHeuristicEvidence,
} from './fork-heuristic.js';

const SIXTEEN_MIB = 16 * 1024 * 1024;
const THIRTY_TWO_MIB = 32 * 1024 * 1024;

describe('forkHeuristicDetector', () => {
  it('has stable id, name, phase=1', () => {
    expect(forkHeuristicDetector.id).toBe(FORK_HEURISTIC_DETECTOR_ID);
    expect(forkHeuristicDetector.phase).toBe(1);
    expect(forkHeuristicDetector.name.length).toBeGreaterThan(0);
  });

  it('returns not_detected for a perfectly canonical FireRed-shaped ROM', async () => {
    const rom = buildSyntheticRom({
      title: 'POKEMON FIRE',
      gameCode: 'BPRE',
      makerCode: '01',
      softwareVersion: 0,
      romSize: SIXTEEN_MIB,
    });
    const cov = new CoverageMap(rom.byteLength);
    const r = await forkHeuristicDetector.detect(rom, cov);
    expect(r.status).toBe('not_detected');
    if (r.status === 'not_detected') {
      expect(r.reason).toContain('appears vanilla');
      expect(r.confidence).toBeGreaterThan(0.5);
    }
  });

  it('returns DETECTED with title divergence (hack-style rebranded title)', async () => {
    const rom = buildSyntheticRom({
      title: 'POKE UNBOUND',
      gameCode: 'BPRE',
      makerCode: '01',
      softwareVersion: 0,
      romSize: SIXTEEN_MIB,
    });
    const cov = new CoverageMap(rom.byteLength);
    const r = await forkHeuristicDetector.detect(rom, cov);
    expect(r.status).toBe('detected');
    if (r.status === 'detected') {
      const payload = r.data as ForkHeuristicEvidence;
      expect(payload.divergences.some((d) => d.kind === 'title')).toBe(true);
      expect(payload.canonicalDisplayName).toBe('Pokémon FireRed');
      expect(r.confidence).toBeGreaterThanOrEqual(0.5);
    }
  });

  it('returns DETECTED with size divergence (32 MiB hack on BPRE)', async () => {
    const rom = buildSyntheticRom({
      title: 'POKEMON FIRE',
      gameCode: 'BPRE',
      makerCode: '01',
      softwareVersion: 0,
      romSize: THIRTY_TWO_MIB,
    });
    const cov = new CoverageMap(rom.byteLength);
    const r = await forkHeuristicDetector.detect(rom, cov);
    expect(r.status).toBe('partial');
    // 32 MiB size alone is weight 0.4 - below the 0.5 detected threshold,
    // so this is a partial. The partial-with-data still proves divergence.
    if (r.status === 'partial') {
      const payload = r.data as ForkHeuristicEvidence;
      expect(payload.divergences.some((d) => d.kind === 'size')).toBe(true);
    }
  });

  it('size + title divergence pushes confidence over the detected threshold', async () => {
    const rom = buildSyntheticRom({
      title: 'POKE UNBOUND',
      gameCode: 'BPRE',
      makerCode: '01',
      softwareVersion: 0,
      romSize: THIRTY_TWO_MIB,
    });
    const cov = new CoverageMap(rom.byteLength);
    const r = await forkHeuristicDetector.detect(rom, cov);
    expect(r.status).toBe('detected');
    if (r.status === 'detected') {
      const payload = r.data as ForkHeuristicEvidence;
      expect(payload.divergences.map((d) => d.kind).sort()).toEqual(['size', 'title']);
      // title (0.5) + size (0.4) = 0.9.
      expect(payload.totalDivergenceScore).toBeCloseTo(0.9, 2);
      expect(r.confidence).toBeCloseTo(0.9, 2);
    }
  });

  it('returns PARTIAL with weak signal (non-zero software version only)', async () => {
    const rom = buildSyntheticRom({
      title: 'POKEMON FIRE',
      gameCode: 'BPRE',
      makerCode: '01',
      softwareVersion: 7, // 7 is not in canonical [0, 1]
      romSize: SIXTEEN_MIB,
    });
    const cov = new CoverageMap(rom.byteLength);
    const r = await forkHeuristicDetector.detect(rom, cov);
    expect(r.status).toBe('partial');
    if (r.status === 'partial') {
      const payload = r.data as ForkHeuristicEvidence;
      expect(payload.divergences.map((d) => d.kind)).toEqual(['software_version']);
      expect(payload.totalDivergenceScore).toBeCloseTo(0.15, 2);
    }
  });

  it('returns not_detected for an unknown (non-Pokémon) game code', async () => {
    const rom = buildSyntheticRom({
      title: 'NOT POKEMON',
      gameCode: 'XYZW',
      makerCode: '99',
      softwareVersion: 0,
      romSize: SIXTEEN_MIB,
    });
    const cov = new CoverageMap(rom.byteLength);
    const r = await forkHeuristicDetector.detect(rom, cov);
    expect(r.status).toBe('not_detected');
    if (r.status === 'not_detected') {
      expect(r.reason).toContain('out of scope');
    }
  });

  it('returns not_detected when GBA header does not parse (defers to Phase 0)', async () => {
    const rom = loadRomFromBytes({ bytes: Buffer.alloc(1024, 0) });
    const cov = new CoverageMap(rom.byteLength);
    const r = await forkHeuristicDetector.detect(rom, cov);
    expect(r.status).toBe('not_detected');
    if (r.status === 'not_detected') {
      expect(r.reason).toContain('cannot run fork heuristic');
    }
  });

  it('detects maker_code divergence', async () => {
    const rom = buildSyntheticRom({
      title: 'POKEMON FIRE',
      gameCode: 'BPRE',
      makerCode: '99',
      softwareVersion: 0,
      romSize: SIXTEEN_MIB,
    });
    const cov = new CoverageMap(rom.byteLength);
    const r = await forkHeuristicDetector.detect(rom, cov);
    expect(r.status).toBe('partial');
    if (r.status === 'partial') {
      const payload = r.data as ForkHeuristicEvidence;
      expect(payload.divergences.some((d) => d.kind === 'maker_code')).toBe(true);
    }
  });

  it('every result kind carries ≥1 evidence item (PD 1)', async () => {
    const cases = [
      // detected
      buildSyntheticRom({ title: 'CUSTOM', gameCode: 'BPRE', makerCode: '01', romSize: THIRTY_TWO_MIB }),
      // partial
      buildSyntheticRom({ title: 'POKEMON FIRE', gameCode: 'BPRE', makerCode: '01', softwareVersion: 7, romSize: SIXTEEN_MIB }),
      // not_detected (canonical)
      buildSyntheticRom({ title: 'POKEMON FIRE', gameCode: 'BPRE', makerCode: '01', softwareVersion: 0, romSize: SIXTEEN_MIB }),
      // not_detected (unknown code)
      buildSyntheticRom({ title: 'X', gameCode: 'XYZW', makerCode: '99', romSize: SIXTEEN_MIB }),
    ];
    for (const rom of cases) {
      const cov = new CoverageMap(rom.byteLength);
      const r = await forkHeuristicDetector.detect(rom, cov);
      expect(r.evidence.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('does NOT write to coverage (this detector classifies SHAPE, not bytes)', async () => {
    const rom = buildSyntheticRom({ gameCode: 'BPRE', title: 'POKEMON FIRE', romSize: SIXTEEN_MIB });
    const cov = new CoverageMap(rom.byteLength);
    await forkHeuristicDetector.detect(rom, cov);
    expect(cov.report().classifiedBytes).toBe(0);
  });

  it('reports totalDivergenceScore == sum of individual weights', async () => {
    const rom = buildSyntheticRom({
      title: 'POKE UNBOUND',
      gameCode: 'BPRE',
      makerCode: '99',
      softwareVersion: 7,
      romSize: THIRTY_TWO_MIB,
    });
    const cov = new CoverageMap(rom.byteLength);
    const r = await forkHeuristicDetector.detect(rom, cov);
    expect(r.status).toBe('detected');
    if (r.status === 'detected') {
      const payload = r.data as ForkHeuristicEvidence;
      // title(0.5) + size(0.4) + version(0.15) + maker(0.25) = 1.3 → capped to 1.0 at confidence
      expect(payload.totalDivergenceScore).toBeCloseTo(1.3, 2);
      expect(r.confidence).toBe(1);
    }
  });
});
