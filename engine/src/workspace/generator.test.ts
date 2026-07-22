import { describe, expect, it } from 'vitest';
import { RelationshipGraphBuilder } from '../graph/graph.js';
import type { IngestReport } from '../ingest/index.js';
import { generateWorkspace } from './generator.js';

/** Build a synthetic IngestReport for testing the generator. */
function makeReport(args?: {
  detections?: IngestReport['detections'];
  coverage?: Partial<IngestReport['coverage']>;
}): IngestReport {
  return Object.freeze({
    rom: Object.freeze({
      sha1: 'aaaa1111bbbb2222cccc3333dddd4444eeee5555',
      byteLength: 16 * 1024 * 1024,
      sourcePath: 'test://fixture',
      corpusClass: null,
      synthetic: true,
    }),
    detections: args?.detections ?? Object.freeze([]),
    coverage: Object.freeze({
      romSize: 16 * 1024 * 1024,
      classifiedBytes: 1000,
      unknownScoredBytes: 500,
      unaccountedBytes: 0,
      classifiedPct: 99.9,
      unknownScoredPct: 0.05,
      unaccountedPct: 0,
      regionCount: 3,
      regions: Object.freeze([]),
      ...(args?.coverage ?? {}),
    }),
    summary: Object.freeze({
      detectedCount: 0,
      partialCount: 0,
      notDetectedCount: 0,
    }),
  });
}

describe('generateWorkspace - top-level shape', () => {
  it('returns a frozen WorkspaceModel with all required sections', () => {
    const graph = new RelationshipGraphBuilder().build();
    const w = generateWorkspace({
      report: makeReport(),
      graph,
      nowIsoUtc: '2026-05-17T00:00:00.000Z',
    });
    expect(Object.isFrozen(w)).toBe(true);
    expect(w.generatedAtUtc).toBe('2026-05-17T00:00:00.000Z');
    expect(w.identity.sha1).toBe('aaaa1111bbbb2222cccc3333dddd4444eeee5555');
    expect(w.worldGraph.mapNodeIds.length).toBe(0);
    expect(w.assetBrowser.totalAssetCount).toBe(0);
    expect(w.runtimeSystems.present).toBe(false);
    expect(w.featureDetection.detectors.length).toBe(0);
  });
});

describe('generateWorkspace - identity', () => {
  it('uses provided familyVerdict when given', () => {
    const w = generateWorkspace({
      report: makeReport(),
      graph: new RelationshipGraphBuilder().build(),
      familyVerdict: {
        family: 'firered',
        confidence: 0.95,
        matchedSignatures: ['firered-bpre-1.0'],
      },
    });
    expect(w.identity.familyVerdict.family).toBe('firered');
    expect(w.identity.familyVerdict.confidence).toBe(0.95);
    expect(w.identity.familyVerdict.matchedSignatures).toEqual(['firered-bpre-1.0']);
  });

  it('defaults to "unrecognized" family when no verdict provided', () => {
    const w = generateWorkspace({
      report: makeReport(),
      graph: new RelationshipGraphBuilder().build(),
    });
    expect(w.identity.familyVerdict.family).toBe('unrecognized');
  });

  it('header + headerDisplay are null when no header-fingerprint detection (UW-1-T1)', () => {
    const w = generateWorkspace({
      report: makeReport(),
      graph: new RelationshipGraphBuilder().build(),
    });
    expect(w.identity.header).toBeNull();
    expect(w.identity.headerDisplay).toBeNull();
  });

  it('lifts header + headerDisplay from header-fingerprint detection when present (UW-1-T1)', () => {
    const detection: IngestReport['detections'] = Object.freeze([
      Object.freeze({
        detectorId: 'gba_header_fingerprint',
        detectorName: 'GBA Cartridge Header Fingerprint',
        phase: 0,
        runtimeMs: 1,
        detection: Object.freeze({
          status: 'detected' as const,
          confidence: 1.0,
          evidence: Object.freeze([
            Object.freeze({
              kind: 'parsed_field' as const,
              summary: 'header parsed cleanly',
              weight: 1.0,
            }),
          ]),
          data: Object.freeze({
            header: Object.freeze({
              internalTitle: 'POKEMON FIRE',
              gameCode: 'BPRE',
              makerCode: '01',
              softwareVersion: 0,
              knownGame: 'Pokémon FireRed',
              fixedMarkerValid: true as const,
            }),
            display: 'Pokémon FireRed - BPRE (POKEMON FIRE) v0',
            romSha1: 'aaaa1111bbbb2222cccc3333dddd4444eeee5555',
          }),
        }),
      }),
    ]);
    const w = generateWorkspace({
      report: makeReport({ detections: detection }),
      graph: new RelationshipGraphBuilder().build(),
    });
    expect(w.identity.header).not.toBeNull();
    expect(w.identity.header?.gameCode).toBe('BPRE');
    expect(w.identity.header?.internalTitle).toBe('POKEMON FIRE');
    expect(w.identity.header?.knownGame).toBe('Pokémon FireRed');
    expect(w.identity.header?.fixedMarkerValid).toBe(true);
    expect(w.identity.headerDisplay).toBe('Pokémon FireRed - BPRE (POKEMON FIRE) v0');
  });

  it('memoryLayout populates header + body for a 16 MiB ROM (UW-1-T1)', () => {
    const w = generateWorkspace({
      report: makeReport(),
      graph: new RelationshipGraphBuilder().build(),
    });
    expect(w.identity.memoryLayout.romSize).toBe(16 * 1024 * 1024);
    expect(w.identity.memoryLayout.headerOffset).toBe(0);
    expect(w.identity.memoryLayout.headerLength).toBe(0xc0);
    expect(w.identity.memoryLayout.bodyOffset).toBe(0xc0);
    expect(w.identity.memoryLayout.bodyLength).toBe(16 * 1024 * 1024 - 0xc0);
  });

  it('pointerTables + compressionRegions are null when no detection (UW-1-T2)', () => {
    const w = generateWorkspace({
      report: makeReport(),
      graph: new RelationshipGraphBuilder().build(),
    });
    expect(w.identity.pointerTables).toBeNull();
    expect(w.identity.compressionRegions).toBeNull();
  });

  it('lifts pointerTables inventory from pointer_network detection (UW-1-T2)', () => {
    const detection: IngestReport['detections'] = Object.freeze([
      Object.freeze({
        detectorId: 'pointer_network',
        detectorName: 'Pointer Network',
        phase: 2,
        runtimeMs: 5,
        detection: Object.freeze({
          status: 'detected' as const,
          confidence: 0.9,
          evidence: Object.freeze([
            Object.freeze({
              kind: 'heuristic' as const,
              summary: 'pointer-network summary',
              weight: 1.0,
            }),
          ]),
          data: Object.freeze({
            pointerCount: 123,
            tables: Object.freeze([
              Object.freeze({ start: 0x800000, endExclusive: 0x800080, length: 32, entries: [] }),
              Object.freeze({ start: 0x900000, endExclusive: 0x900020, length: 8, entries: [] }),
              Object.freeze({ start: 0xa00000, endExclusive: 0xa00040, length: 16, entries: [] }),
            ]),
            tableBytesCovered: 224,
            topHotspots: Object.freeze([]),
            clusterTargetCount: 12,
          }),
        }),
      }),
    ]);
    const w = generateWorkspace({
      report: makeReport({ detections: detection }),
      graph: new RelationshipGraphBuilder().build(),
    });
    expect(w.identity.pointerTables).not.toBeNull();
    expect(w.identity.pointerTables?.totalPointerCount).toBe(123);
    expect(w.identity.pointerTables?.tableCount).toBe(3);
    expect(w.identity.pointerTables?.tableBytesCovered).toBe(224);
    expect(w.identity.pointerTables?.clusterTargetCount).toBe(12);
    // Largest tables sorted desc by length: 32, 16, 8
    expect(w.identity.pointerTables?.largestTables[0]?.length).toBe(32);
    expect(w.identity.pointerTables?.largestTables[0]?.offset).toBe(0x800000);
    expect(w.identity.pointerTables?.largestTables[1]?.length).toBe(16);
    expect(w.identity.pointerTables?.largestTables[2]?.length).toBe(8);
  });

  it('lifts compressionRegions inventory from compression_format detection (UW-1-T2)', () => {
    const detection: IngestReport['detections'] = Object.freeze([
      Object.freeze({
        detectorId: 'compression_format',
        detectorName: 'Compression Format',
        phase: 2,
        runtimeMs: 8,
        detection: Object.freeze({
          status: 'detected' as const,
          confidence: 0.95,
          evidence: Object.freeze([
            Object.freeze({
              kind: 'heuristic' as const,
              summary: 'LZ77 + entropy summary',
              weight: 1.0,
            }),
          ]),
          data: Object.freeze({
            lz77Blocks: Object.freeze([
              Object.freeze({ start: 0x400000, compressedLength: 100, uncompressedSize: 256, endExclusive: 0x400064 }),
              Object.freeze({ start: 0x410000, compressedLength: 500, uncompressedSize: 1024, endExclusive: 0x4101f4 }),
            ]),
            lz77BytesCovered: 600,
            probableCompressionRegions: Object.freeze([
              Object.freeze({ start: 0x500000, endExclusive: 0x501000, peakEntropy: 7.5 }),
            ]),
            probableCompressionBytesScored: 4096,
          }),
        }),
      }),
    ]);
    const w = generateWorkspace({
      report: makeReport({ detections: detection }),
      graph: new RelationshipGraphBuilder().build(),
    });
    expect(w.identity.compressionRegions).not.toBeNull();
    expect(w.identity.compressionRegions?.confirmedLz77BlockCount).toBe(2);
    expect(w.identity.compressionRegions?.confirmedLz77BytesCovered).toBe(600);
    expect(w.identity.compressionRegions?.probableCompressionRegionCount).toBe(1);
    expect(w.identity.compressionRegions?.probableCompressionBytesScored).toBe(4096);
    // Largest LZ77 blocks sorted desc by compressedLength: 500, 100
    expect(w.identity.compressionRegions?.largestLz77Blocks[0]?.compressedSize).toBe(500);
    expect(w.identity.compressionRegions?.largestLz77Blocks[0]?.offset).toBe(0x410000);
    expect(w.identity.compressionRegions?.largestLz77Blocks[1]?.compressedSize).toBe(100);
  });

  it('memoryLayout body length floors at 0 for ROMs smaller than header (defensive)', () => {
    const report: IngestReport = {
      ...makeReport(),
      rom: {
        sha1: 'tinytestrom',
        byteLength: 100, // smaller than 0xC0 (192)
        sourcePath: 'test://tiny',
        corpusClass: null,
        synthetic: true,
      },
    };
    const w = generateWorkspace({
      report,
      graph: new RelationshipGraphBuilder().build(),
    });
    expect(w.identity.memoryLayout.romSize).toBe(100);
    expect(w.identity.memoryLayout.bodyLength).toBe(0);
  });
});

describe('generateWorkspace - world graph', () => {
  it('summarizes maps with outgoing edge counts', () => {
    const b = new RelationshipGraphBuilder();
    b.addNode({ id: 'map:m1', kind: 'map', label: 'Town 1', provenance: 't' });
    b.addNode({ id: 'warp:w1', kind: 'warp', provenance: 't' });
    b.addNode({ id: 'map:m2', kind: 'map', label: 'Town 2', provenance: 't' });
    b.addEdge({
      id: 'has_event:m1->w1',
      from: 'map:m1',
      to: 'warp:w1',
      kind: 'has_event',
      confidence: 0.9,
      provenance: 't',
    });
    b.addEdge({
      id: 'connects_to:m1->m2',
      from: 'map:m1',
      to: 'map:m2',
      kind: 'connects_to',
      confidence: 0.9,
      provenance: 't',
    });
    const w = generateWorkspace({ report: makeReport(), graph: b.build() });
    expect(w.worldGraph.mapNodeIds.length).toBe(2);
    expect(w.worldGraph.warpNodeIds.length).toBe(1);
    const m1 = w.worldGraph.mapSummaries.find((s) => s.mapNodeId === 'map:m1');
    expect(m1?.label).toBe('Town 1');
    expect(m1?.outgoingConnectionCount).toBe(1);
    expect(m1?.hasEventCount).toBe(1);
  });
});

describe('generateWorkspace - mechanic inventory', () => {
  it('surfaces species/trainer/encounter_table nodes with detail', () => {
    const b = new RelationshipGraphBuilder();
    b.addNode({
      id: 'species:0',
      kind: 'species',
      label: 'species[0]',
      provenance: 't',
      detail: { speciesIndex: 0, baseHP: 45 },
    });
    b.addNode({
      id: 'trainer:0',
      kind: 'trainer',
      label: 'trainer[0]',
      provenance: 't',
      detail: { trainerIndex: 0, trainerName: 'RED' },
    });
    b.addNode({
      id: 'encounter_table:0x700000',
      kind: 'encounter_table',
      provenance: 't',
      detail: { mapGroup: 0, mapNum: 0 },
    });
    const w = generateWorkspace({ report: makeReport(), graph: b.build() });
    expect(w.mechanicInventory.species.length).toBe(1);
    expect(w.mechanicInventory.species[0]?.detail.baseHP).toBe(45);
    expect(w.mechanicInventory.trainers.length).toBe(1);
    expect(w.mechanicInventory.encounterTables.length).toBe(1);
  });
});

describe('generateWorkspace - asset browser', () => {
  it('buckets assets by sub-kind + pre-computes consumerNodeIds', () => {
    const b = new RelationshipGraphBuilder();
    b.addNode({
      id: 'music_track:song_1',
      kind: 'music_track',
      provenance: 't',
    });
    b.addNode({
      id: 'asset:voiceGroup:0x100',
      kind: 'asset',
      provenance: 't',
      detail: { assetKind: 'voiceGroup' },
    });
    b.addNode({
      id: 'asset:tileset:0x200',
      kind: 'asset',
      provenance: 't',
      detail: { assetType: 'tileset' },
    });
    b.addEdge({
      id: 'uses_asset:song_1->vg',
      from: 'music_track:song_1',
      to: 'asset:voiceGroup:0x100',
      kind: 'uses_asset',
      confidence: 0.9,
      provenance: 't',
    });
    const w = generateWorkspace({ report: makeReport(), graph: b.build() });
    expect(w.assetBrowser.totalAssetCount).toBe(2);
    expect(Object.keys(w.assetBrowser.bySubKind).sort()).toEqual(['tileset', 'voiceGroup']);
    expect(w.assetBrowser.bySubKind.voiceGroup?.[0]?.consumerNodeIds).toEqual(['music_track:song_1']);
  });
});

describe('generateWorkspace - runtime systems', () => {
  it('marks present: false when no runtimeReport provided', () => {
    const w = generateWorkspace({
      report: makeReport(),
      graph: new RelationshipGraphBuilder().build(),
    });
    expect(w.runtimeSystems.present).toBe(false);
    expect(w.runtimeSystems.traces.length).toBe(0);
  });

  it('surfaces traces + findings when runtimeReport is provided', () => {
    const w = generateWorkspace({
      report: makeReport(),
      graph: new RelationshipGraphBuilder().build(),
      runtimeReport: {
        traces: [
          {
            entrypointOffset: 0x600600,
            executedOpcodeCount: 4,
            traceEvents: [],
            endState: { flags: new Map(), vars: new Map(), stoppedAtPc: 0, executedCount: 4 },
            bodyByteLength: 12,
          },
        ],
        totalOpcodesExecuted: 4,
        totalTraceEvents: 8,
        observedFlagIds: [0x4001],
        observedVariableIds: [],
        validationFindings: [
          {
            assumptionClass: 'flag_write_then_read',
            writerScriptOffset: 0x600600,
            readerScriptOffset: 0x600600,
            flagId: 0x4001,
            verdict: 'confirmed',
          },
        ],
      },
    });
    expect(w.runtimeSystems.present).toBe(true);
    expect(w.runtimeSystems.traces.length).toBe(1);
    expect(w.runtimeSystems.validationFindings[0]?.verdict).toBe('confirmed');
    expect(w.runtimeSystems.observedFlagIds).toEqual([0x4001]);
  });
});

describe('generateWorkspace - feature detection', () => {
  it('summarizes per-detector status', () => {
    const w = generateWorkspace({
      report: makeReport({
        detections: [
          {
            detectorId: 'foo',
            detectorName: 'Foo Detector',
            phase: 5,
            runtimeMs: 12,
            detection: {
              status: 'detected',
              confidence: 0.9,
              evidence: [],
              data: {},
            },
          },
        ],
      }),
      graph: new RelationshipGraphBuilder().build(),
    });
    expect(w.featureDetection.detectors.length).toBe(1);
    expect(w.featureDetection.detectors[0]?.status).toBe('detected');
  });
});
