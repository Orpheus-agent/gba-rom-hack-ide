import { describe, expect, it } from 'vitest';
import { RelationshipGraphBuilder } from '../graph/index.js';
import { findMapClusters } from './clusters.js';
import { inferBuildings } from './buildings.js';

function buildGraph(args: {
  maps: ReadonlyArray<string>;
  links: ReadonlyArray<{ fromMap: string; toMap: string }>;
  connections?: ReadonlyArray<{ fromMap: string; toMap: string }>;
}) {
  const builder = new RelationshipGraphBuilder();
  for (const m of args.maps) {
    builder.addNode({ id: m, kind: 'map', provenance: 'test' });
  }
  let warpCounter = 0;
  for (const link of args.links) {
    const warpId = `warp:test-${String(warpCounter++)}`;
    builder.addNode({ id: warpId, kind: 'warp', provenance: 'test' });
    builder.addEdge({
      id: `has_event:${link.fromMap}->${warpId}`,
      from: link.fromMap,
      to: warpId,
      kind: 'has_event',
      confidence: 1,
      provenance: 'test',
      detail: { eventType: 'warp' },
    });
    builder.addEdge({
      id: `warp_to:${warpId}->${link.toMap}`,
      from: warpId,
      to: link.toMap,
      kind: 'warp_to',
      confidence: 1,
      provenance: 'test',
    });
  }
  for (const conn of args.connections ?? []) {
    builder.addEdge({
      id: `connects_to:${conn.fromMap}->${conn.toMap}`,
      from: conn.fromMap,
      to: conn.toMap,
      kind: 'connects_to',
      confidence: 1,
      provenance: 'test',
    });
  }
  return builder.build();
}

describe('inferBuildings', () => {
  it('returns empty for no clusters', () => {
    expect(inferBuildings(new RelationshipGraphBuilder().build(), [])).toEqual([]);
  });

  it('rejects singleton clusters', () => {
    const graph = buildGraph({ maps: ['map:a'], links: [] });
    const clusters = findMapClusters(graph);
    expect(inferBuildings(graph, clusters)).toEqual([]);
  });

  it('accepts a 3-floor building (warp-linked, no exterior connects_to)', () => {
    const graph = buildGraph({
      maps: ['map:floor1', 'map:floor2', 'map:floor3'],
      links: [
        { fromMap: 'map:floor1', toMap: 'map:floor2' },
        { fromMap: 'map:floor2', toMap: 'map:floor3' },
      ],
    });
    const buildings = inferBuildings(graph, findMapClusters(graph));
    expect(buildings).toHaveLength(1);
    expect(buildings[0]?.floorCount).toBe(3);
    expect(buildings[0]?.floorMapIds).toEqual(['map:floor1', 'map:floor2', 'map:floor3']);
  });

  it('rejects a cluster with external connects_to edges (town + interior pattern)', () => {
    const graph = buildGraph({
      maps: ['map:town', 'map:house', 'map:route'],
      links: [{ fromMap: 'map:town', toMap: 'map:house' }],
      connections: [{ fromMap: 'map:town', toMap: 'map:route' }], // exterior!
    });
    const buildings = inferBuildings(graph, findMapClusters(graph));
    // map:town has a connects_to to map:route (outside its warp cluster) →
    // the cluster fails the building heuristic.
    expect(buildings).toHaveLength(0);
  });

  it('accepts multiple disjoint buildings in one ROM', () => {
    const graph = buildGraph({
      maps: [
        'map:silphF1',
        'map:silphF2',
        'map:silphF3',
        'map:silphF4',
        'map:houseF1',
        'map:houseF2',
      ],
      links: [
        { fromMap: 'map:silphF1', toMap: 'map:silphF2' },
        { fromMap: 'map:silphF2', toMap: 'map:silphF3' },
        { fromMap: 'map:silphF3', toMap: 'map:silphF4' },
        { fromMap: 'map:houseF1', toMap: 'map:houseF2' },
      ],
    });
    const buildings = inferBuildings(graph, findMapClusters(graph));
    expect(buildings).toHaveLength(2);
    const floorCounts = buildings.map((b) => b.floorCount).sort();
    expect(floorCounts).toEqual([2, 4]);
  });

  it('building id is deterministic + freezes the floorMapIds', () => {
    const graph = buildGraph({
      maps: ['map:a', 'map:b'],
      links: [{ fromMap: 'map:a', toMap: 'map:b' }],
    });
    const buildings = inferBuildings(graph, findMapClusters(graph));
    expect(buildings[0]?.id).toBe('building:map:a,map:b');
    expect(Object.isFrozen(buildings[0]?.floorMapIds)).toBe(true);
  });

  it('reports internalWarpCount matching cluster', () => {
    const graph = buildGraph({
      maps: ['map:a', 'map:b'],
      links: [
        { fromMap: 'map:a', toMap: 'map:b' },
        { fromMap: 'map:b', toMap: 'map:a' },
      ],
    });
    const buildings = inferBuildings(graph, findMapClusters(graph));
    expect(buildings[0]?.internalWarpCount).toBe(2);
  });

  it('rejects a cluster when INCOMING connects_to points into it from outside', () => {
    const graph = buildGraph({
      maps: ['map:int1', 'map:int2', 'map:ext'],
      links: [{ fromMap: 'map:int1', toMap: 'map:int2' }],
      connections: [{ fromMap: 'map:ext', toMap: 'map:int1' }],
    });
    const buildings = inferBuildings(graph, findMapClusters(graph));
    expect(buildings).toHaveLength(0);
  });
});
