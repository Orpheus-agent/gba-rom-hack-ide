/**
 * Building inference - multi-floor / interior-cluster recognition.
 *
 * §15 P5 Silph-Co acceptance: "a multi-floor building (Silph-Co-class)
 * reconstructs as one semantic building entity with floor relationships,
 * warp graph, elevator system, and progression dependencies."
 *
 * Heuristic (structural, no baked map IDs - PD 5):
 *
 *   A `MapCluster` (warp-connected component) is a BUILDING when:
 *     1. It has ≥ 2 maps (a single map is not a building).
 *     2. None of its member maps have `connects_to` edges leaving the
 *        cluster (a real building's floors don't have exterior tile-
 *        adjacency to anything outside - only warps connect them to
 *        the world). A town + interior cluster fails this - the town
 *        has connects_to edges to neighbouring routes/towns.
 *
 * Result: a `Building` record per qualifying cluster, naming the
 * member maps as "floors" (insertion order = warp-graph discovery
 * order, which approximates floor-number ordering in vanilla carts
 * where map-table indices were assigned bottom-floor-first).
 *
 * Pure function - no I/O, deterministic for a given graph snapshot.
 */

import type { RelationshipGraph } from '../graph/index.js';
import type { MapCluster } from './clusters.js';

export interface Building {
  /** Stable id: `building:<sortedMapIds joined by ','>`. */
  readonly id: string;
  /** Member map ids ordered by map-header offset (≈ floor order). */
  readonly floorMapIds: ReadonlyArray<string>;
  /** Convenience: number of floors. */
  readonly floorCount: number;
  /** Total warp nodes internal to this building. */
  readonly internalWarpCount: number;
}

/**
 * Decide whether each `cluster` is a building, return the buildings.
 * Clusters that fail the test (singletons, or have outbound
 * `connects_to` edges) are excluded.
 */
export function inferBuildings(
  graph: RelationshipGraph,
  clusters: ReadonlyArray<MapCluster>,
): Building[] {
  const buildings: Building[] = [];
  for (const cluster of clusters) {
    if (cluster.mapIds.length < 2) continue;
    if (hasExternalConnections(graph, cluster)) continue;
    buildings.push(makeBuilding(cluster));
  }
  return buildings;
}

function hasExternalConnections(graph: RelationshipGraph, cluster: MapCluster): boolean {
  const memberSet = new Set<string>(cluster.mapIds);
  for (const mapId of cluster.mapIds) {
    // Outgoing `connects_to` edges: if any target is outside this
    // cluster, the cluster is town-like (has tile-adjacent maps),
    // not building-like.
    for (const e of graph.outgoing(mapId)) {
      if (e.kind !== 'connects_to') continue;
      if (!memberSet.has(e.to)) return true;
    }
    // Same for incoming `connects_to` (a neighbour pointing into this
    // cluster also indicates exterior adjacency).
    for (const e of graph.incoming(mapId)) {
      if (e.kind !== 'connects_to') continue;
      if (!memberSet.has(e.from)) return true;
    }
  }
  return false;
}

function makeBuilding(cluster: MapCluster): Building {
  return Object.freeze({
    id: `building:${cluster.mapIds.join(',')}`,
    floorMapIds: Object.freeze([...cluster.mapIds]),
    floorCount: cluster.mapIds.length,
    internalWarpCount: cluster.internalWarpCount,
  });
}
