/**
 * Phase 9H - LruCache tests.
 */

import { describe, expect, it } from 'vitest';
import { LruCache } from './lruCache.js';

describe('LruCache', () => {
  it('throws when maxEntries <= 0', () => {
    expect(() => new LruCache({ maxEntries: 0 })).toThrow();
    expect(() => new LruCache({ maxEntries: -1 })).toThrow();
  });

  it('stores + retrieves up to maxEntries values', () => {
    const c = new LruCache<number>({ maxEntries: 3 });
    c.set('a', 1);
    c.set('b', 2);
    c.set('c', 3);
    expect(c.get('a')).toBe(1);
    expect(c.get('b')).toBe(2);
    expect(c.get('c')).toBe(3);
    expect(c.size).toBe(3);
  });

  it('evicts the least-recently-used entry when over cap', () => {
    const c = new LruCache<number>({ maxEntries: 3 });
    c.set('a', 1);
    c.set('b', 2);
    c.set('c', 3);
    c.set('d', 4); // 'a' (oldest) gets evicted
    expect(c.get('a')).toBeUndefined();
    expect(c.get('b')).toBe(2);
    expect(c.get('c')).toBe(3);
    expect(c.get('d')).toBe(4);
    expect(c.size).toBe(3);
  });

  it('get() bumps the entry to most-recently-used', () => {
    const c = new LruCache<number>({ maxEntries: 3 });
    c.set('a', 1);
    c.set('b', 2);
    c.set('c', 3);
    // Bump 'a' - now 'b' is the oldest.
    void c.get('a');
    c.set('d', 4); // evicts 'b'
    expect(c.get('b')).toBeUndefined();
    expect(c.get('a')).toBe(1);
    expect(c.get('c')).toBe(3);
    expect(c.get('d')).toBe(4);
  });

  it('set() on an existing key updates value + bumps to MRU', () => {
    const c = new LruCache<number>({ maxEntries: 3 });
    c.set('a', 1);
    c.set('b', 2);
    c.set('c', 3);
    c.set('a', 100); // 'a' updates + becomes MRU
    c.set('d', 4); // evicts 'b' (now LRU)
    expect(c.get('a')).toBe(100);
    expect(c.get('b')).toBeUndefined();
    expect(c.get('c')).toBe(3);
    expect(c.get('d')).toBe(4);
  });

  it('has() does not bump the entry', () => {
    const c = new LruCache<number>({ maxEntries: 3 });
    c.set('a', 1);
    c.set('b', 2);
    c.set('c', 3);
    expect(c.has('a')).toBe(true);
    // 'a' is still the oldest - check by inserting 'd' which should evict 'a'.
    c.set('d', 4);
    expect(c.get('a')).toBeUndefined();
  });

  it('clear() empties the cache', () => {
    const c = new LruCache<number>({ maxEntries: 3 });
    c.set('a', 1);
    c.set('b', 2);
    c.clear();
    expect(c.size).toBe(0);
    expect(c.get('a')).toBeUndefined();
  });

  it('handles cap = 1 (always one entry, instant eviction)', () => {
    const c = new LruCache<number>({ maxEntries: 1 });
    c.set('a', 1);
    c.set('b', 2);
    expect(c.get('a')).toBeUndefined();
    expect(c.get('b')).toBe(2);
    expect(c.size).toBe(1);
  });

  it('exposes label via name', () => {
    const c = new LruCache<number>({ maxEntries: 1, label: 'sprite-cache' });
    expect(c.name).toBe('sprite-cache');
  });
});
