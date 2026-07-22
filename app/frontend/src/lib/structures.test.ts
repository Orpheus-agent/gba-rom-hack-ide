import { describe, expect, it } from 'vitest';
import {
  externalWarps,
  inferStructures,
  structureContaining,
} from './structures';
import type {
  MapNode,
  ProjectManifest,
  Warp,
} from '@rom-editor/shared';

function makeMap(
  id: string,
  name: string,
  group: MapNode['group'] = 'interior',
): MapNode {
  return {
    id,
    name,
    group,
    dimensions: { width: 10, height: 10 },
    tilesetIds: [],
    warpIds: [],
    scriptIds: [],
    objectEventIds: [],
    encounterTableIds: [],
    musicId: null,
    metadata: {},
  };
}

function makeWarp(id: string, from: string, to: string): Warp {
  return {
    id,
    fromMapId: from,
    fromCoord: { x: 0, y: 0 },
    toMapId: to,
    toCoord: { x: 0, y: 0 },
  } as Warp;
}

function makeManifest(overrides: Partial<ProjectManifest>): ProjectManifest {
  return {
    schemaVersion: 1,
    generatedAtUtc: '2026-05-18T00:00:00Z',
    projectRoot: '/abs/test',
    identity: {
      kind: 'decomp',
      confidence: 1,
      displayName: 'test',
      baseGame: null,
      fork: null,
      featureFlags: [],
      warnings: [],
      evidence: [],
    },
    buildProfile: null,
    maps: [],
    warps: [],
    triggers: [],
    objectEvents: [],
    dialogue: [],
    flags: [],
    variables: [],
    encounterTables: [],
    trainers: [],
    scriptSteps: [],
    assets: [],
    ...overrides,
  } as ProjectManifest;
}

describe('inferStructures (Phase R.2)', () => {
  it('returns empty when fewer than 2 clusterable maps', () => {
    expect(inferStructures(makeManifest({}))).toEqual([]);
    expect(
      inferStructures(makeManifest({ maps: [makeMap('m1', 'Silph Co. 1F')] })),
    ).toEqual([]);
  });

  it('clusters Silph Co. floors that share a prefix AND are warp-connected', () => {
    const maps: MapNode[] = [
      makeMap('m1', 'Silph Co. 1F'),
      makeMap('m2', 'Silph Co. 2F'),
      makeMap('m3', 'Silph Co. 3F'),
    ];
    const warps: Warp[] = [
      makeWarp('w12', 'm1', 'm2'),
      makeWarp('w23', 'm2', 'm3'),
    ];
    const structs = inferStructures(makeManifest({ maps, warps }));
    expect(structs.length).toBe(1);
    // splitNameTokens treats both "." and "_" as separators, so the
    // resolved cluster name drops the trailing period.
    expect(structs[0]?.name).toBe('Silph Co');
    expect(structs[0]?.memberIds.length).toBe(3);
    expect(structs[0]?.internalWarpCount).toBe(2);
  });

  it('does NOT cluster floors that share prefix but lack warps', () => {
    const maps: MapNode[] = [
      makeMap('m1', 'Silph Co. 1F'),
      makeMap('m2', 'Silph Co. 2F'),
    ];
    expect(inferStructures(makeManifest({ maps, warps: [] }))).toEqual([]);
  });

  it('does NOT cluster maps with only a single-token prefix (Route 1 + Route 2)', () => {
    const maps: MapNode[] = [
      makeMap('m1', 'Route 1', 'route'),
      makeMap('m2', 'Route 2', 'route'),
    ];
    expect(inferStructures(makeManifest({ maps }))).toEqual([]);
  });

  it('does NOT cluster town maps even with name prefixes (towns are standalone)', () => {
    const maps: MapNode[] = [
      makeMap('m1', 'Pallet Town', 'town'),
      makeMap('m2', 'Pallet House', 'town'),
    ];
    expect(inferStructures(makeManifest({ maps }))).toEqual([]);
  });

  it('separates structures by group (interior + cave with same name do not merge)', () => {
    const maps: MapNode[] = [
      makeMap('m1', 'Mt Moon B1F', 'cave'),
      makeMap('m2', 'Mt Moon B2F', 'cave'),
      makeMap('m3', 'Mt Moon Lobby', 'interior'),
    ];
    const warps: Warp[] = [
      makeWarp('w12', 'm1', 'm2'),
      makeWarp('w13', 'm1', 'm3'),
    ];
    const structs = inferStructures(makeManifest({ maps, warps }));
    // Cave cluster is 2 members; interior is alone → no cluster.
    expect(structs.length).toBe(1);
    expect(structs[0]?.group).toBe('cave');
    expect(structs[0]?.memberIds).toEqual(['m1', 'm2']);
  });

  it('handles underscore-separated decomp-style names', () => {
    const maps: MapNode[] = [
      makeMap('m1', 'POKEMON_MANSION_1F'),
      makeMap('m2', 'POKEMON_MANSION_2F'),
      makeMap('m3', 'POKEMON_MANSION_B1F'),
    ];
    const warps: Warp[] = [
      makeWarp('w12', 'm1', 'm2'),
      makeWarp('w13', 'm1', 'm3'),
    ];
    const structs = inferStructures(makeManifest({ maps, warps }));
    expect(structs.length).toBe(1);
    expect(structs[0]?.name).toMatch(/POKEMON MANSION/);
    expect(structs[0]?.memberIds.length).toBe(3);
  });

  it('sorts results largest-first', () => {
    const maps: MapNode[] = [
      makeMap('a1', 'Building A 1F'),
      makeMap('a2', 'Building A 2F'),
      makeMap('b1', 'Tower B 1F'),
      makeMap('b2', 'Tower B 2F'),
      makeMap('b3', 'Tower B 3F'),
      makeMap('b4', 'Tower B 4F'),
    ];
    const warps: Warp[] = [
      makeWarp('wa', 'a1', 'a2'),
      makeWarp('wb1', 'b1', 'b2'),
      makeWarp('wb2', 'b2', 'b3'),
      makeWarp('wb3', 'b3', 'b4'),
    ];
    const structs = inferStructures(makeManifest({ maps, warps }));
    expect(structs.length).toBe(2);
    expect(structs[0]?.memberIds.length).toBe(4); // Tower B first
    expect(structs[1]?.memberIds.length).toBe(2); // Building A second
  });
});

describe('structureContaining', () => {
  it('returns the structure for a member map id', () => {
    const maps: MapNode[] = [
      makeMap('m1', 'Silph Co. 1F'),
      makeMap('m2', 'Silph Co. 2F'),
    ];
    const warps: Warp[] = [makeWarp('w', 'm1', 'm2')];
    const structs = inferStructures(makeManifest({ maps, warps }));
    expect(structureContaining(structs, 'm2')?.name).toBe('Silph Co');
  });

  it('returns null for a non-member map id', () => {
    expect(structureContaining([], 'm1')).toBeNull();
  });
});

describe('externalWarps', () => {
  it('returns warps crossing into/out of the structure', () => {
    const maps: MapNode[] = [
      makeMap('m1', 'Silph Co. 1F'),
      makeMap('m2', 'Silph Co. 2F'),
      makeMap('outside', 'Saffron City', 'town'),
    ];
    const warps: Warp[] = [
      makeWarp('w12', 'm1', 'm2'), // internal
      makeWarp('wInOut', 'outside', 'm1'), // external (in)
      makeWarp('wOut', 'm2', 'outside'), // external (out)
    ];
    const structs = inferStructures(makeManifest({ maps, warps }));
    const ext = externalWarps(warps, structs[0]!);
    expect(ext.map((w) => w.id).sort()).toEqual(['wInOut', 'wOut']);
  });
});
