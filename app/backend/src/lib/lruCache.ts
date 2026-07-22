/**
 * Phase 9H - Shared LRU cache helper.
 *
 * Backed by `Map`'s insertion-order semantics: re-inserting a key
 * after access moves it to the end of the iteration order, so
 * popping `keys().next()` always evicts the least-recently-used
 * entry.
 *
 * Used by the per-project sprite endpoints (pokemon-sprite,
 * future trainer-sprite, portrait, OW-sprite) so they share one
 * eviction policy + one set of operational characteristics.
 *
 * Phase 4.2C inlined this logic inside pokemon-sprite.ts; Phase 9H
 * lifts it here so trainer-sprite etc. can reuse it without
 * copy-pasting + so the eviction strategy is testable in isolation.
 *
 * Concurrency: not thread-safe (Node single-threaded by default,
 * matches our usage). Eviction is O(1) for both get + set.
 */

export interface LruCacheOptions {
  readonly maxEntries: number;
  /** Optional human label surfaced in logs / metrics. */
  readonly label?: string;
}

export class LruCache<V> {
  private readonly map = new Map<string, V>();
  private readonly maxEntries: number;
  private readonly label: string;

  constructor(opts: LruCacheOptions) {
    if (opts.maxEntries <= 0) {
      throw new Error('LruCache: maxEntries must be > 0');
    }
    this.maxEntries = opts.maxEntries;
    this.label = opts.label ?? 'lru';
  }

  /** Returns the cached value + bumps it to most-recently-used.
   *  Returns undefined when missing. */
  get(key: string): V | undefined {
    const hit = this.map.get(key);
    if (hit === undefined) return undefined;
    // LRU bump - delete + re-insert to move to insertion-order tail.
    this.map.delete(key);
    this.map.set(key, hit);
    return hit;
  }

  /** Insert or update. Evicts the oldest entry when over the cap. */
  set(key: string, value: V): void {
    // If updating an existing key, delete-then-set so the order
    // reflects this update (mirrors get()'s bump semantics).
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.map.delete(oldest.value);
    }
  }

  /** Number of currently-cached entries. */
  get size(): number {
    return this.map.size;
  }

  /** Drop all entries. */
  clear(): void {
    this.map.clear();
  }

  /** True when the key has a live entry. */
  has(key: string): boolean {
    return this.map.has(key);
  }

  /** Human label, for logs / metrics surfaces. */
  get name(): string {
    return this.label;
  }
}
