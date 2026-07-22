import { describe, expect, it } from 'vitest';
import { clusterCrossReferences, toSortedHotspots } from './clusters.js';
import type { RomPointer } from './discovery.js';

function ptr(sourceOffset: number, targetOffset: number): RomPointer {
  return { sourceOffset, targetOffset, rawAddress: 0x08000000 + targetOffset };
}

describe('clusterCrossReferences', () => {
  it('returns empty Map for no pointers', () => {
    expect(clusterCrossReferences([]).size).toBe(0);
  });

  it('groups pointers by targetOffset', () => {
    const ptrs = [ptr(0, 100), ptr(4, 100), ptr(8, 200), ptr(12, 200), ptr(16, 200)];
    const clusters = clusterCrossReferences(ptrs);
    expect(clusters.size).toBe(2);
    expect(clusters.get(100)?.referenceCount).toBe(2);
    expect(clusters.get(200)?.referenceCount).toBe(3);
  });

  it('preserves the source list per target', () => {
    const a = ptr(0, 50);
    const b = ptr(4, 50);
    const c = ptr(8, 50);
    const clusters = clusterCrossReferences([a, b, c]);
    const cluster = clusters.get(50);
    expect(cluster?.sources).toHaveLength(3);
    expect(cluster?.sources.map((p) => p.sourceOffset)).toEqual([0, 4, 8]);
  });

  it('returned cluster + sources arrays are frozen', () => {
    const clusters = clusterCrossReferences([ptr(0, 100)]);
    const c = clusters.get(100)!;
    expect(Object.isFrozen(c)).toBe(true);
    expect(Object.isFrozen(c.sources)).toBe(true);
  });
});

describe('toSortedHotspots', () => {
  it('sorts by descending referenceCount', () => {
    const ptrs = [
      ptr(0, 100),
      ptr(4, 200), ptr(8, 200),
      ptr(12, 300), ptr(16, 300), ptr(20, 300),
    ];
    const sorted = toSortedHotspots(clusterCrossReferences(ptrs));
    expect(sorted.map((c) => c.targetOffset)).toEqual([300, 200, 100]);
    expect(sorted.map((c) => c.referenceCount)).toEqual([3, 2, 1]);
  });

  it('breaks ties by ascending target offset (deterministic)', () => {
    const ptrs = [
      ptr(0, 500), ptr(4, 500),
      ptr(8, 100), ptr(12, 100),
      ptr(16, 300), ptr(20, 300),
    ];
    const sorted = toSortedHotspots(clusterCrossReferences(ptrs));
    expect(sorted.map((c) => c.targetOffset)).toEqual([100, 300, 500]);
  });

  it('empty input → empty array', () => {
    expect(toSortedHotspots(new Map())).toEqual([]);
  });
});
