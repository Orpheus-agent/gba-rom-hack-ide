import { describe, expect, it } from 'vitest';
import { buildSyntheticRom } from '../fixtures/synthetic-rom.js';
import { loadRomFromBytes } from '../rom/loader.js';
import { headerFingerprintDetector } from '../detectors/header-fingerprint.js';
import {
  forkHeuristicDetector,
  makeBinaryFingerprintDetector,
} from '../detectors/index.js';
import { ingestRom } from '../ingest/orchestrator.js';
import type { SignatureDb } from '../signatures/loader.js';
import type { SignatureEntry } from '../signatures/schema.js';
import { classifyFamily } from './family.js';

function makeDb(entries: SignatureEntry[]): SignatureDb {
  const byGameCode = new Map<string, SignatureEntry[]>();
  const bySha1 = new Map<string, SignatureEntry[]>();
  const bySizeBytes = new Map<number, SignatureEntry[]>();
  const markerEntries: SignatureEntry[] = [];
  for (const e of entries) {
    for (const c of e.gameCodes ?? []) {
      const a = byGameCode.get(c) ?? [];
      a.push(e);
      byGameCode.set(c, a);
    }
    for (const h of e.sha1 ?? []) {
      const a = bySha1.get(h.toLowerCase()) ?? [];
      a.push(e);
      bySha1.set(h.toLowerCase(), a);
    }
    for (const s of e.sizeBytes ?? []) {
      const a = bySizeBytes.get(s) ?? [];
      a.push(e);
      bySizeBytes.set(s, a);
    }
    if (e.buildMarkers && e.buildMarkers.length > 0) markerEntries.push(e);
  }
  return Object.freeze({
    allEntries: Object.freeze([...entries]),
    byGameCode,
    bySha1,
    bySizeBytes,
    markerEntries,
    loadedFiles: [],
    fileErrors: [],
  });
}

const EMPTY_DB: SignatureDb = makeDb([]);
const SIXTEEN_MIB = 16 * 1024 * 1024;
const THIRTY_TWO_MIB = 32 * 1024 * 1024;

async function ingestFor(rom: ReturnType<typeof buildSyntheticRom>, db: SignatureDb) {
  const detectors = [
    headerFingerprintDetector,
    makeBinaryFingerprintDetector({ db }),
    forkHeuristicDetector,
  ];
  return ingestRom({ rom, detectors });
}

describe('classifyFamily', () => {
  it('Branch 1: header fails → unrecognized / unknown / header_failure', async () => {
    const rom = loadRomFromBytes({ bytes: Buffer.alloc(1024, 0) }); // no 0x96 marker
    const report = await ingestFor(rom, EMPTY_DB);
    const verdict = classifyFamily(report);
    expect(verdict.family).toBe('unrecognized');
    expect(verdict.kind).toBe('unknown');
    expect(verdict.primarySignal).toBe('header_failure');
    expect(verdict.evidenceChain.length).toBeGreaterThanOrEqual(1);
  });

  it('Branch 2: strong SHA-1 signature match → drives family + kind directly', async () => {
    const rom = buildSyntheticRom({
      title: 'POKEMON FIRE',
      gameCode: 'BPRE',
      makerCode: '01',
      softwareVersion: 0,
      romSize: SIXTEEN_MIB,
    });
    const db = makeDb([
      {
        id: 'firered-v1-0-usa',
        displayName: 'Pokémon FireRed v1.0 (USA)',
        family: 'firered',
        kind: 'vanilla',
        gameCodes: ['BPRE'],
        sha1: [rom.sha1], // SHA-1 hit → strength 1.0 → confidence = 0.95
        sources: ['x'],
        confidenceWhenMatched: 0.95,
      },
    ]);
    const report = await ingestFor(rom, db);
    const verdict = classifyFamily(report);
    expect(verdict.family).toBe('firered');
    expect(verdict.kind).toBe('vanilla');
    expect(verdict.primarySignal).toBe('signature_match');
    expect(verdict.confidence).toBeCloseTo(0.95, 2);
    expect(verdict.displayName).toContain('FireRed');
  });

  it('Branch 2: strong CFRU build-marker match → kind=cfru (recognition pipeline proof)', async () => {
    // Build a synthetic ROM that carries a CFRU-style marker at a chosen offset.
    // Marker = bytes 0x43 0x46 0x52 0x55 0x00 ("CFRU\0") at offset 0x1000.
    const bytes = Buffer.alloc(SIXTEEN_MIB, 0);
    // Plant a valid GBA header first.
    bytes.write('POKEMON FIRE', 0xa0, 'ascii');
    bytes.write('BPRE', 0xac, 'ascii');
    bytes.write('01', 0xb0, 'ascii');
    bytes[0xb2] = 0x96;
    bytes[0xbc] = 0;
    // Plant the CFRU marker.
    Buffer.from([0x43, 0x46, 0x52, 0x55, 0x00]).copy(bytes, 0x1000);
    const rom = loadRomFromBytes({ bytes });

    const db = makeDb([
      {
        id: 'cfru-marker-test',
        displayName: 'CFRU framework (test signature)',
        family: 'cfru-firered',
        kind: 'cfru',
        gameCodes: ['BPRE'],
        buildMarkers: [
          {
            offset: 0x1000,
            magic: '4346525500',
            label: 'CFRU framework magic',
          },
        ],
        sources: ['synthetic test entry'],
        confidenceWhenMatched: 0.95,
      },
    ]);

    const report = await ingestFor(rom, db);
    const verdict = classifyFamily(report);
    // Marker + game_code combo → strength 0.95 × 0.95 ≈ 0.9 → above
    // STRONG_SIGNATURE_THRESHOLD (0.7) → kind=cfru is driven by the signature.
    expect(verdict.kind).toBe('cfru');
    expect(verdict.family).toBe('cfru-firered');
    expect(verdict.primarySignal).toBe('signature_match');
    expect(verdict.confidence).toBeGreaterThanOrEqual(0.7);
  });

  it('Branch 2: strong decomp build-marker match → kind=decomp', async () => {
    // Same pattern, simulating a pret decomp build marker.
    const bytes = Buffer.alloc(SIXTEEN_MIB, 0);
    bytes.write('POKEMON FIRE', 0xa0, 'ascii');
    bytes.write('BPRE', 0xac, 'ascii');
    bytes.write('01', 0xb0, 'ascii');
    bytes[0xb2] = 0x96;
    bytes[0xbc] = 0;
    // Plant a decomp-style marker at an unused offset.
    Buffer.from([0x70, 0x72, 0x65, 0x74, 0x00]).copy(bytes, 0x2000); // "pret\0"
    const rom = loadRomFromBytes({ bytes });

    const db = makeDb([
      {
        id: 'pret-decomp-test',
        displayName: 'pret/pokefirered decomp build (test signature)',
        family: 'pokefirered',
        kind: 'decomp',
        gameCodes: ['BPRE'],
        buildMarkers: [
          {
            offset: 0x2000,
            magic: '7072657400',
            label: 'pret toolchain marker',
          },
        ],
        sources: ['synthetic test entry'],
        confidenceWhenMatched: 0.9,
      },
    ]);

    const report = await ingestFor(rom, db);
    const verdict = classifyFamily(report);
    expect(verdict.kind).toBe('decomp');
    expect(verdict.family).toBe('pokefirered');
    expect(verdict.primarySignal).toBe('signature_match');
  });

  it('Branch 3: fork heuristic detected → kind=fork even when weak signature says vanilla', async () => {
    const rom = buildSyntheticRom({
      title: 'POKE UNBOUND', // title divergence (weight 0.5)
      gameCode: 'BPRE',
      makerCode: '01',
      softwareVersion: 0,
      romSize: THIRTY_TWO_MIB, // size divergence (weight 0.4)
    });
    // DB only has a game-code-only entry for BPRE - scaled-confidence 0.425,
    // below the STRONG_SIGNATURE_THRESHOLD of 0.7. The classifier should
    // prefer the fork heuristic's structural divergence.
    const db = makeDb([
      {
        id: 'firered-family',
        displayName: 'Pokémon FireRed (BPRE) family',
        family: 'firered',
        kind: 'vanilla',
        gameCodes: ['BPRE'],
        sources: ['x'],
        confidenceWhenMatched: 0.85,
      },
    ]);
    const report = await ingestFor(rom, db);
    const verdict = classifyFamily(report);
    expect(verdict.kind).toBe('fork'); // critical: NOT misreported as vanilla
    expect(verdict.family).toBe('firered');
    expect(verdict.primarySignal).toBe('fork_heuristic');
    expect(verdict.rationale).toContain('Fork heuristic detected');
  });

  it('Branch 4: canonical + weak signature, no divergence → vanilla', async () => {
    const rom = buildSyntheticRom({
      title: 'POKEMON FIRE',
      gameCode: 'BPRE',
      makerCode: '01',
      softwareVersion: 0,
      romSize: SIXTEEN_MIB,
    });
    const db = makeDb([
      {
        id: 'firered-family',
        displayName: 'Pokémon FireRed (BPRE) family',
        family: 'firered',
        kind: 'vanilla',
        gameCodes: ['BPRE'],
        sources: ['x'],
        confidenceWhenMatched: 0.85,
      },
    ]);
    const report = await ingestFor(rom, db);
    const verdict = classifyFamily(report);
    expect(verdict.kind).toBe('vanilla');
    expect(verdict.family).toBe('firered');
    // Game-code-only signature → primarySignal=signature_match (weak match
    // still drives family label) but kind is vanilla and no fork.
    expect(verdict.primarySignal).toBe('signature_match');
  });

  it('Branch 4: canonical + NO signature, no divergence → vanilla (low confidence)', async () => {
    const rom = buildSyntheticRom({
      title: 'POKEMON EMER',
      gameCode: 'BPEE',
      makerCode: '01',
      softwareVersion: 0,
      romSize: SIXTEEN_MIB,
    });
    const report = await ingestFor(rom, EMPTY_DB);
    const verdict = classifyFamily(report);
    expect(verdict.kind).toBe('vanilla');
    expect(verdict.family).toBe('emerald');
    expect(verdict.primarySignal).toBe('canonical_match');
    expect(verdict.rationale).toContain('canonical');
  });

  it('Branch 5: unknown game code + signature match → drives family from signature', async () => {
    const rom = buildSyntheticRom({
      title: 'CUSTOM CART',
      gameCode: 'XYZW', // not in canonical reference
      makerCode: '99',
      softwareVersion: 0,
      romSize: SIXTEEN_MIB,
    });
    const db = makeDb([
      {
        id: 'custom-xyzw',
        displayName: 'Custom XYZW cart',
        family: 'custom-xyzw',
        kind: 'fork',
        gameCodes: ['XYZW'],
        sha1: [rom.sha1],
        sources: ['synthetic'],
        confidenceWhenMatched: 0.9,
      },
    ]);
    const report = await ingestFor(rom, db);
    const verdict = classifyFamily(report);
    expect(verdict.family).toBe('custom-xyzw');
    expect(verdict.kind).toBe('fork');
    expect(verdict.primarySignal).toBe('signature_match');
  });

  it('Branch 5: unknown game code + no signature → unrecognized (header_only)', async () => {
    const rom = buildSyntheticRom({
      title: 'CUSTOM CART',
      gameCode: 'XYZW',
      makerCode: '99',
      softwareVersion: 0,
      romSize: SIXTEEN_MIB,
    });
    const report = await ingestFor(rom, EMPTY_DB);
    const verdict = classifyFamily(report);
    expect(verdict.family).toBe('unrecognized');
    expect(verdict.kind).toBe('unknown');
    expect(verdict.primarySignal).toBe('header_only');
    expect(verdict.rationale).toContain('not in the canonical');
  });

  it('every verdict has non-empty family + ≥1 evidence item + rationale (PD 1)', async () => {
    const cases = [
      // Branch 1: header fails
      loadRomFromBytes({ bytes: Buffer.alloc(1024, 0) }),
      // Branch 3: fork
      buildSyntheticRom({ title: 'POKE UNBOUND', gameCode: 'BPRE', makerCode: '01', romSize: THIRTY_TWO_MIB }),
      // Branch 4: vanilla
      buildSyntheticRom({ title: 'POKEMON FIRE', gameCode: 'BPRE', makerCode: '01', romSize: SIXTEEN_MIB }),
      // Branch 5: unknown
      buildSyntheticRom({ title: 'CUSTOM', gameCode: 'XYZW', makerCode: '99', romSize: SIXTEEN_MIB }),
    ];
    for (const rom of cases) {
      const report = await ingestFor(rom, EMPTY_DB);
      const verdict = classifyFamily(report);
      expect(verdict.family.length).toBeGreaterThan(0);
      expect(verdict.evidenceChain.length).toBeGreaterThanOrEqual(1);
      expect(verdict.rationale.length).toBeGreaterThan(0);
      expect(verdict.confidence).toBeGreaterThanOrEqual(0);
      expect(verdict.confidence).toBeLessThanOrEqual(1);
    }
  });

  it('verdict is frozen + evidenceChain is sorted by descending weight', async () => {
    const rom = buildSyntheticRom({
      title: 'POKEMON FIRE',
      gameCode: 'BPRE',
      makerCode: '01',
      romSize: SIXTEEN_MIB,
    });
    const report = await ingestFor(rom, EMPTY_DB);
    const verdict = classifyFamily(report);
    expect(Object.isFrozen(verdict)).toBe(true);
    expect(Object.isFrozen(verdict.evidenceChain)).toBe(true);
    for (let i = 1; i < verdict.evidenceChain.length; i++) {
      expect(verdict.evidenceChain[i - 1]!.weight).toBeGreaterThanOrEqual(
        verdict.evidenceChain[i]!.weight,
      );
    }
  });

  it('CFRU + fork divergence: strong CFRU signature wins over fork heuristic', async () => {
    // ROM has BOTH a CFRU marker AND structural fork divergence (title +
    // size). The signature match is "stronger" (CFRU magic at known offset
    // + game code = combined strength 0.95) so it drives the verdict.
    const bytes = Buffer.alloc(THIRTY_TWO_MIB, 0);
    bytes.write('POKE UNBOUND', 0xa0, 'ascii');
    bytes.write('BPRE', 0xac, 'ascii');
    bytes.write('01', 0xb0, 'ascii');
    bytes[0xb2] = 0x96;
    Buffer.from([0x43, 0x46, 0x52, 0x55, 0x00]).copy(bytes, 0x1000);
    const rom = loadRomFromBytes({ bytes });

    const db = makeDb([
      {
        id: 'cfru-strong',
        displayName: 'CFRU framework',
        family: 'cfru-firered',
        kind: 'cfru',
        gameCodes: ['BPRE'],
        buildMarkers: [
          { offset: 0x1000, magic: '4346525500', label: 'CFRU magic' },
        ],
        sources: ['synthetic'],
        confidenceWhenMatched: 0.95,
      },
    ]);
    const report = await ingestFor(rom, db);
    const verdict = classifyFamily(report);
    // CFRU signature wins because (marker + game_code) at 0.95 ≥ STRONG_SIGNATURE_THRESHOLD
    expect(verdict.kind).toBe('cfru');
    expect(verdict.family).toBe('cfru-firered');
  });
});
