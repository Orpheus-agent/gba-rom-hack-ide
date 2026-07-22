import { describe, expect, it } from 'vitest';
import { CoverageMap } from '../coverage/index.js';
import { GBA_ROM_BASE_ADDRESS } from '../pointers/index.js';
import { buildSyntheticRom } from '../fixtures/synthetic-rom.js';
import { loadRomFromBytes } from '../rom/loader.js';
import { headerFingerprintDetector } from '../detectors/header-fingerprint.js';
import {
  forkHeuristicDetector,
  makeBinaryFingerprintDetector,
  pointerNetworkDetector,
} from '../detectors/index.js';
import type { SignatureDb } from '../signatures/loader.js';
import { ingestRom } from '../ingest/orchestrator.js';
import { buildRelationshipGraph } from './builder.js';

const EMPTY_DB: SignatureDb = Object.freeze({
  allEntries: [],
  byGameCode: new Map(),
  bySha1: new Map(),
  bySizeBytes: new Map(),
  markerEntries: [],
  loadedFiles: [],
  fileErrors: [],
});

async function ingestSynthWithPointerTable() {
  // 64 KB ROM with a valid header + 32-entry pointer table at 0x100.
  const buf = Buffer.alloc(64 * 1024);
  buf.write('TEST', 0xa0, 'ascii');
  buf.write('ZZZZ', 0xac, 'ascii');
  buf.write('00', 0xb0, 'ascii');
  buf[0xb2] = 0x96;
  // Plant 32 pointers all targeting offset 0x800.
  for (let i = 0; i < 32; i++) {
    buf.writeUInt32LE((GBA_ROM_BASE_ADDRESS + 0x800) >>> 0, 0x200 + i * 4);
  }
  const rom = loadRomFromBytes({ bytes: buf });
  const report = await ingestRom({
    rom,
    detectors: [
      headerFingerprintDetector,
      makeBinaryFingerprintDetector({ db: EMPTY_DB }),
      forkHeuristicDetector,
      pointerNetworkDetector,
    ],
  });
  return report;
}

describe('buildRelationshipGraph', () => {
  it('always includes the family_verdict node', async () => {
    const rom = buildSyntheticRom({ gameCode: 'BPRE', title: 'POKEMON FIRE', romSize: 16 * 1024 * 1024 });
    const cov = new CoverageMap(rom.byteLength);
    void cov;
    const report = await ingestRom({
      rom,
      detectors: [
        headerFingerprintDetector,
        makeBinaryFingerprintDetector({ db: EMPTY_DB }),
        forkHeuristicDetector,
      ],
    });
    const g = buildRelationshipGraph({ report });
    expect(g.nodesByKind('family_verdict')).toHaveLength(1);
    const v = g.nodesByKind('family_verdict')[0];
    expect(v?.id.startsWith('family_verdict:')).toBe(true);
    expect(v?.detail?.family).toBeDefined();
  });

  it('populates rom_region nodes + points_to edges from pointer-network hotspots', async () => {
    const report = await ingestSynthWithPointerTable();
    const g = buildRelationshipGraph({ report });
    const romRegions = g.nodesByKind('rom_region');
    // 1 target hotspot + up to MAX_SOURCES_PER_HOTSPOT (20) sources.
    expect(romRegions.length).toBeGreaterThanOrEqual(2);
    const target = romRegions.find((n) => n.id === 'rom_region:0x00000800');
    expect(target).toBeDefined();
    const pointsToEdges = g.edgesByKind('points_to');
    expect(pointsToEdges.length).toBeGreaterThan(0);
    for (const e of pointsToEdges) {
      expect(e.to).toBe('rom_region:0x00000800');
    }
  });

  it('every edge carries confidence in [0,1] and non-empty provenance (PD acceptance)', async () => {
    const report = await ingestSynthWithPointerTable();
    const g = buildRelationshipGraph({ report });
    for (const e of g.allEdges()) {
      expect(e.confidence).toBeGreaterThanOrEqual(0);
      expect(e.confidence).toBeLessThanOrEqual(1);
      expect(e.provenance.length).toBeGreaterThan(0);
    }
  });

  it('every node has a non-empty provenance', async () => {
    const report = await ingestSynthWithPointerTable();
    const g = buildRelationshipGraph({ report });
    for (const n of g.allNodes()) {
      expect(n.provenance.length).toBeGreaterThan(0);
    }
  });

  it('caps hotspot nodes at 10 + per-hotspot sources at 20', async () => {
    // Build a ROM with 15 hotspots each having 50 inbound pointers.
    const buf = Buffer.alloc(256 * 1024);
    buf.write('TEST', 0xa0, 'ascii');
    buf.write('ZZZZ', 0xac, 'ascii');
    buf.write('00', 0xb0, 'ascii');
    buf[0xb2] = 0x96;
    let off = 0x200;
    for (let h = 0; h < 15; h++) {
      const target = 0x1000 + h * 0x100;
      for (let i = 0; i < 50; i++) {
        buf.writeUInt32LE((GBA_ROM_BASE_ADDRESS + target) >>> 0, off);
        off += 8; // spaced so they're not a single "table"
      }
    }
    const rom = loadRomFromBytes({ bytes: buf });
    const report = await ingestRom({
      rom,
      detectors: [
        headerFingerprintDetector,
        makeBinaryFingerprintDetector({ db: EMPTY_DB }),
        forkHeuristicDetector,
        pointerNetworkDetector,
      ],
    });
    const g = buildRelationshipGraph({ report });
    // Hotspot target nodes: capped at 10. Other source nodes additional.
    const targets = g
      .nodesByKind('rom_region')
      .filter((n) => (n.detail?.referenceCount as number | undefined) !== undefined);
    expect(targets.length).toBeLessThanOrEqual(10);
    // Each kept target's incoming edges capped at 20.
    for (const t of targets) {
      const incoming = g.incoming(t.id);
      expect(incoming.length).toBeLessThanOrEqual(20);
    }
  });

  it('reachable: family_verdict is reachable from a signature_match when both exist', () => {
    // Synthesize a minimal report by hand to control signature matches.
    const fakeReport = {
      rom: { sha1: 'abc', byteLength: 1024, sourcePath: null, corpusClass: null, synthetic: true },
      detections: [
        {
          detectorId: 'gba_header_fingerprint',
          detectorName: 'h',
          phase: 0,
          runtimeMs: 0,
          detection: {
            status: 'detected' as const,
            confidence: 0.9 as never,
            evidence: [{ kind: 'signature' as const, summary: 's', weight: 1 }],
            data: {
              header: {
                gameCode: 'BPRE',
                internalTitle: 'POKEMON FIRE',
                makerCode: '01',
                softwareVersion: 0,
                knownGame: 'Pokémon FireRed',
                fixedMarkerValid: true as const,
              },
              display: 'x',
              romSha1: 'abc',
            },
          },
        },
        {
          detectorId: 'binary_fingerprint',
          detectorName: 'bf',
          phase: 1,
          runtimeMs: 0,
          detection: {
            status: 'detected' as const,
            confidence: 0.9 as never,
            evidence: [{ kind: 'signature' as const, summary: 's', weight: 1 }],
            data: {
              romSha1: 'abc',
              byteLength: 1024,
              sizeClass: 'odd',
              header: {
                gameCode: 'BPRE',
                internalTitle: 'POKEMON FIRE',
                makerCode: '01',
                softwareVersion: 0,
                knownGame: 'Pokémon FireRed',
                fixedMarkerValid: true,
              },
              signatureMatches: [
                {
                  entry: {
                    id: 'firered-family',
                    displayName: 'FireRed family',
                    family: 'firered',
                    kind: 'vanilla',
                    sources: [],
                    confidenceWhenMatched: 1.0,
                  },
                  reasons: [{ kind: 'sha1' as const, detail: 'm' }],
                  confidence: 0.95,
                },
              ],
              heuristicHints: [],
            },
          },
        },
      ],
      coverage: {
        romSize: 1024,
        classifiedBytes: 0,
        unknownScoredBytes: 0,
        unaccountedBytes: 1024,
        classifiedPct: 0,
        unknownScoredPct: 0,
        unaccountedPct: 100,
        regionCount: 0,
        regions: [],
      },
      summary: { detectedCount: 2, partialCount: 0, notDetectedCount: 0, totalDetectors: 2 },
    };
    const g = buildRelationshipGraph({ report: fakeReport as unknown as Parameters<typeof buildRelationshipGraph>[0]['report'] });
    const sig = g.nodesByKind('signature_match');
    expect(sig.length).toBe(1);
    const verdict = g.nodesByKind('family_verdict')[0];
    expect(verdict).toBeDefined();
    const reach = g.reachable({ startId: sig[0]!.id });
    expect(reach.has(verdict!.id)).toBe(true);
  });

  it('produces an empty-edge graph when no detector data is available', () => {
    const minimalReport = {
      rom: { sha1: 'x', byteLength: 256, sourcePath: null, corpusClass: null, synthetic: true },
      detections: [],
      coverage: {
        romSize: 256,
        classifiedBytes: 0,
        unknownScoredBytes: 0,
        unaccountedBytes: 256,
        classifiedPct: 0,
        unknownScoredPct: 0,
        unaccountedPct: 100,
        regionCount: 0,
        regions: [],
      },
      summary: { detectedCount: 0, partialCount: 0, notDetectedCount: 0, totalDetectors: 0 },
    };
    const g = buildRelationshipGraph({ report: minimalReport as unknown as Parameters<typeof buildRelationshipGraph>[0]['report'] });
    // No detector data → only the family_verdict node (with header_failure).
    expect(g.nodeCount).toBeGreaterThanOrEqual(1);
    expect(g.edgeCount).toBe(0);
  });
});
