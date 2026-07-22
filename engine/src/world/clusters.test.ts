import { describe, expect, it } from 'vitest';
import { RelationshipGraphBuilder } from '../graph/index.js';
import { findMapClusters } from './clusters.js';

/**
 * Helper: build a graph with maps + warp chains linking them.
 *
 * `links` array entries: { fromMap, toMap } - emits a `warp` node + has_event
 * edge (from→warp) + warp_to edge (warp→to). Uses synthetic offsets.
 *
 * `connections` array entries: { fromMap, toMap } - emits a `connects_to`
 * edge to mark exterior adjacency.
 */
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

describe('findMapClusters', () => {
  it('returns empty for an empty graph', () => {
    const graph = new RelationshipGraphBuilder().build();
    expect(findMapClusters(graph)).toEqual([]);
  });

  it('returns one cluster per isolated map (singletons by default)', () => {
    const graph = buildGraph({ maps: ['map:a', 'map:b', 'map:c'], links: [] });
    const clusters = findMapClusters(graph);
    expect(clusters).toHaveLength(3);
    for (const c of clusters) expect(c.mapIds).toHaveLength(1);
  });

  it('groups two maps connected by one warp into one cluster', () => {
    const graph = buildGraph({
      maps: ['map:a', 'map:b'],
      links: [{ fromMap: 'map:a', toMap: 'map:b' }],
    });
    const clusters = findMapClusters(graph);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.mapIds).toEqual(['map:a', 'map:b']);
  });

  it('groups 4 maps in a chain (a→b→c→d) into one cluster', () => {
    const graph = buildGraph({
      maps: ['map:a', 'map:b', 'map:c', 'map:d'],
      links: [
        { fromMap: 'map:a', toMap: 'map:b' },
        { fromMap: 'map:b', toMap: 'map:c' },
        { fromMap: 'map:c', toMap: 'map:d' },
      ],
    });
    const clusters = findMapClusters(graph);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.mapIds).toEqual(['map:a', 'map:b', 'map:c', 'map:d']);
  });

  it('keeps separate clusters separate', () => {
    const graph = buildGraph({
      maps: ['map:a', 'map:b', 'map:c', 'map:d'],
      links: [
        { fromMap: 'map:a', toMap: 'map:b' },
        { fromMap: 'map:c', toMap: 'map:d' },
      ],
    });
    const clusters = findMapClusters(graph);
    expect(clusters).toHaveLength(2);
    expect(clusters.map((c) => c.mapIds)).toContainEqual(['map:a', 'map:b']);
    expect(clusters.map((c) => c.mapIds)).toContainEqual(['map:c', 'map:d']);
  });

  it('orders clusters descending by member count, ties by id', () => {
    const graph = buildGraph({
      maps: ['map:a', 'map:b', 'map:c', 'map:d', 'map:e'],
      links: [
        { fromMap: 'map:a', toMap: 'map:b' },
        { fromMap: 'map:c', toMap: 'map:d' },
        { fromMap: 'map:d', toMap: 'map:e' },
      ],
    });
    const clusters = findMapClusters(graph);
    expect(clusters).toHaveLength(2);
    expect(clusters[0]?.mapIds).toHaveLength(3); // larger first
    expect(clusters[1]?.mapIds).toHaveLength(2);
  });

  it('counts internal warps per cluster', () => {
    const graph = buildGraph({
      maps: ['map:a', 'map:b', 'map:c'],
      links: [
        { fromMap: 'map:a', toMap: 'map:b' }, // warp 0
        { fromMap: 'map:b', toMap: 'map:a' }, // warp 1 (back-link)
        { fromMap: 'map:b', toMap: 'map:c' }, // warp 2
      ],
    });
    const clusters = findMapClusters(graph);
    expect(clusters[0]?.internalWarpCount).toBe(3);
  });

  it('honors minClusterSize filter', () => {
    const graph = buildGraph({ maps: ['map:a', 'map:b'], links: [] });
    expect(findMapClusters(graph, { minClusterSize: 2 })).toHaveLength(0);
    expect(findMapClusters(graph, { minClusterSize: 1 })).toHaveLength(2);
  });

  it('rejects invalid minClusterSize', () => {
    const graph = new RelationshipGraphBuilder().build();
    expect(() => findMapClusters(graph, { minClusterSize: 0 })).toThrow();
    expect(() => findMapClusters(graph, { minClusterSize: -1 })).toThrow();
  });

  it('result objects are frozen', () => {
    const graph = buildGraph({
      maps: ['map:a', 'map:b'],
      links: [{ fromMap: 'map:a', toMap: 'map:b' }],
    });
    const clusters = findMapClusters(graph);
    expect(Object.isFrozen(clusters[0])).toBe(true);
    expect(Object.isFrozen(clusters[0]?.mapIds)).toBe(true);
  });

  it('follows BOTH outgoing AND incoming warp chains', () => {
    // a → b (only); test the reverse-traversal from b's incoming warp.
    const graph = buildGraph({
      maps: ['map:a', 'map:b'],
      links: [{ fromMap: 'map:a', toMap: 'map:b' }],
    });
    const clusters = findMapClusters(graph);
    // Starting BFS from map:a OR map:b should yield the same single cluster.
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.mapIds.length).toBe(2);
  });
});
