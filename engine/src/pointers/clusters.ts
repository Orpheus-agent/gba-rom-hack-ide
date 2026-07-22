/**
 * Cross-reference clustering.
 *
 * Many discovered pointers point at the SAME target - a frequently-
 * referenced data structure (e.g. a global table or function entry
 * point) shows up dozens or hundreds of times in the pointer network.
 * The cluster {target → [sources...]} is the inverse of the pointer
 * list and is exactly what Phase 4's relationship graph (§15) and the
 * "find all references to X" navigator UI need.
 *
 * Pure function over a RomPointer[]. Returns a Map sorted by descending
 * reference count via the `toSortedHotspots()` helper.
 */

import type { RomPointer } from './discovery.js';

export interface CrossReferenceCluster {
  /** The target offset (file-relative) being referenced. */
  readonly targetOffset: number;
  /** All source pointers whose `targetOffset` matches. */
  readonly sources: ReadonlyArray<RomPointer>;
  /** Convenience: sources.length. */
  readonly referenceCount: number;
}

/**
 * Build the {target → sources} cluster map. O(n) in the pointer count.
 *
 * Returns an unsorted Map. Use `toSortedHotspots()` for a descending-
 * by-reference-count list when reporting "hottest" targets.
 */
export function clusterCrossReferences(
  pointers: ReadonlyArray<RomPointer>,
): Map<number, CrossReferenceCluster> {
  const accum = new Map<number, RomPointer[]>();
  for (const p of pointers) {
    const arr = accum.get(p.targetOffset);
    if (arr === undefined) accum.set(p.targetOffset, [p]);
    else arr.push(p);
  }
  const out = new Map<number, CrossReferenceCluster>();
  for (const [target, sources] of accum) {
    out.set(
      target,
      Object.freeze({
        targetOffset: target,
        sources: Object.freeze([...sources]),
        referenceCount: sources.length,
      }),
    );
  }
  return out;
}

/**
 * Return clusters sorted by descending reference count, ties broken by
 * ascending target offset (stable across runs).
 */
export function toSortedHotspots(
  clusters: ReadonlyMap<number, CrossReferenceCluster>,
): CrossReferenceCluster[] {
  return Array.from(clusters.values()).sort((a, b) => {
    if (b.referenceCount !== a.referenceCount) return b.referenceCount - a.referenceCount;
    return a.targetOffset - b.targetOffset;
  });
}
