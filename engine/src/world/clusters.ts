/**
 * Map-cluster identifier - connected-components over the warp graph.
 *
 * §15 Phase 5 requires reconstructing world hierarchy: multi-floor
 * buildings (Silph-Co-class) as one semantic entity, town +
 * connected-interior groupings, etc. The first step is identifying
 * which `map` nodes form clusters via `warp_to` edges.
 *
 * This module is a PURE graph algorithm over the relationship graph
 * built in Phase 4. It walks every `map` node, follows `warp_to` edges
 * in both directions (warps are inherently bidirectional - a door
 * connects two rooms), and groups maps into connected components.
 *
 * Algorithm: BFS from each unvisited `map` node, traversing through
 * any `warp` node that bridges two maps. The graph already encodes
 * map → warp → destination_map via the `has_event` (map→warp) +
 * `warp_to` (warp→destinationMap) edge chain, so we walk:
 *   map.outgoing(has_event)  → warp
 *   warp.outgoing(warp_to)    → destination map
 * AND traverse the reverse direction so a destination_map's warps that
 * point INTO this cluster are also followed.
 *
 * Time complexity: O(N + E) where N = maps + warps, E = edges touching them.
 * Typical Gen-3 cart: ~500 maps + ~5000 warps → completes in milliseconds.
 */

import type { RelationshipGraph } from '../graph/index.js';

export interface MapCluster {
  /** Stable id for the cluster (= sorted member ids joined by '|'). */
  readonly id: string;
  /** Ordered set of map node ids in this cluster (ascending). */
  readonly mapIds: ReadonlyArray<string>;
  /** Number of `warp` nodes that link maps within this cluster. */
  readonly internalWarpCount: number;
}

export interface FindMapClustersOptions {
  /** Minimum cluster size to surface. Singletons (1 map) are often
   *  not useful for hierarchy reconstruction, but tests sometimes
   *  want them. Default 1 (include singletons; building-inference
   *  layer filters further). */
  readonly minClusterSize?: number;
}

/**
 * Run connected-components over the warp graph. Returns clusters in
 * descending order by member count (largest first), ties broken by
 * the smallest map id ascending.
 */
export function findMapClusters(
  graph: RelationshipGraph,
  opts?: FindMapClustersOptions,
): MapCluster[] {
  const minClusterSize = opts?.minClusterSize ?? 1;
  if (!Number.isInteger(minClusterSize) || minClusterSize < 1) {
    throw new Error(
      `minClusterSize must be a positive integer, got ${String(minClusterSize)}`,
    );
  }

  const allMaps = graph.nodesByKind('map').map((n) => n.id).sort();
  const visited = new Set<string>();
  const clusters: MapCluster[] = [];

  for (const startId of allMaps) {
    if (visited.has(startId)) continue;
    const cluster = bfsCluster(graph, startId, visited);
    if (cluster.mapIds.length < minClusterSize) continue;
    clusters.push(cluster);
  }

  // Sort: descending by size, ties → ascending by first map id.
  clusters.sort((a, b) => {
    if (a.mapIds.length !== b.mapIds.length) return b.mapIds.length - a.mapIds.length;
    return (a.mapIds[0] ?? '').localeCompare(b.mapIds[0] ?? '');
  });
  return clusters;
}

/**
 * BFS expansion from `startMapId` walking outgoing AND incoming warp
 * chains. Returns the cluster + records visited map ids.
 */
function bfsCluster(
  graph: RelationshipGraph,
  startMapId: string,
  visited: Set<string>,
): MapCluster {
  const memberMaps = new Set<string>();
  const warpsSeen = new Set<string>();
  const queue: string[] = [startMapId];
  memberMaps.add(startMapId);
  visited.add(startMapId);

  while (queue.length > 0) {
    const mapId = queue.shift()!;

    // Outgoing: map → warp (has_event) → dest map (warp_to)
    for (const outEdge of graph.outgoing(mapId)) {
      if (outEdge.kind !== 'has_event') continue;
      const detail = outEdge.detail as { eventType?: string } | undefined;
      if (detail?.eventType !== 'warp') continue;
      const warpId = outEdge.to;
      warpsSeen.add(warpId);
      for (const wEdge of graph.outgoing(warpId)) {
        if (wEdge.kind !== 'warp_to') continue;
        const destMap = wEdge.to;
        if (!visited.has(destMap)) {
          visited.add(destMap);
          memberMaps.add(destMap);
          queue.push(destMap);
        }
      }
    }

    // Incoming: warps from other maps targeting this map (warp_to)
    for (const inEdge of graph.incoming(mapId)) {
      if (inEdge.kind !== 'warp_to') continue;
      const sourceWarp = inEdge.from;
      warpsSeen.add(sourceWarp);
      // The warp's source map is the parent of the has_event edge into the warp.
      for (const wIn of graph.incoming(sourceWarp)) {
        if (wIn.kind !== 'has_event') continue;
        const detail = wIn.detail as { eventType?: string } | undefined;
        if (detail?.eventType !== 'warp') continue;
        const sourceMap = wIn.from;
        if (!visited.has(sourceMap)) {
          visited.add(sourceMap);
          memberMaps.add(sourceMap);
          queue.push(sourceMap);
        }
      }
    }
  }

  const sortedIds = Array.from(memberMaps).sort();
  return Object.freeze({
    id: sortedIds.join('|'),
    mapIds: Object.freeze(sortedIds),
    internalWarpCount: warpsSeen.size,
  });
}
