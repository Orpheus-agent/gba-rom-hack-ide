/**
 * Phase 6.1 - conservative mapType → MapGroup mapping tests.
 *
 * The historical mapping bucketed bytes 5 (UNDERWATER) and 6 (OCEAN_ROUTE)
 * as 'dungeon' and 'route' respectively. That guess was wrong often enough
 * for CFRU+DPE ROMs - which sometimes write non-vanilla bytes in the
 * mapType field - that we now only recognise unambiguous vanilla pret
 * values. Everything else falls through to 'unknown'; the vanilla-truth
 * overlay (Phase 6.5) supplies the real categorisation per-(bank,num)
 * on modernised ROMs.
 */
import { describe, expect, it } from 'vitest';
import { mapTypeToMapGroup } from './binary-rom-registry.js';

describe('mapTypeToMapGroup (Phase 6.1 - conservative)', () => {
  it('buckets MAP_TYPE_TOWN (1) → town', () => {
    expect(mapTypeToMapGroup(1)).toBe('town');
  });

  it('buckets MAP_TYPE_CITY (2) → town', () => {
    expect(mapTypeToMapGroup(2)).toBe('town');
  });

  it('buckets MAP_TYPE_ROUTE (3) → route', () => {
    expect(mapTypeToMapGroup(3)).toBe('route');
  });

  it('buckets MAP_TYPE_UNDERGROUND (4) → cave', () => {
    expect(mapTypeToMapGroup(4)).toBe('cave');
  });

  it('buckets MAP_TYPE_INDOOR (8) → interior', () => {
    expect(mapTypeToMapGroup(8)).toBe('interior');
  });

  it('buckets MAP_TYPE_SECRET_BASE (9) → interior', () => {
    expect(mapTypeToMapGroup(9)).toBe('interior');
  });

  it('declines to guess MAP_TYPE_NONE (0)', () => {
    expect(mapTypeToMapGroup(0)).toBe('unknown');
  });

  it('declines to guess MAP_TYPE_UNDERWATER (5) - was wrongly bucketed as dungeon', () => {
    // Pre-Phase-6.1 this returned 'dungeon'. UNDERWATER is RSE-only and
    // never appears in vanilla FRLG, so the historical mapping was just
    // a guess at what CFRU might mean with this byte.
    expect(mapTypeToMapGroup(5)).toBe('unknown');
  });

  it('declines to guess MAP_TYPE_OCEAN_ROUTE (6) - was wrongly bucketed as route', () => {
    // Pre-Phase-6.1 this returned 'route'. OCEAN_ROUTE is RSE-only in
    // vanilla pret enum. The overlay supplies the right answer for any
    // FRLG water route (Routes 19, 20, 21) per its actual (bank, num).
    expect(mapTypeToMapGroup(6)).toBe('unknown');
  });

  it('declines to guess MAP_TYPE_UNKNOWN (7)', () => {
    expect(mapTypeToMapGroup(7)).toBe('unknown');
  });

  it('declines to guess CFRU-style out-of-range bytes (10, 32, 255)', () => {
    expect(mapTypeToMapGroup(10)).toBe('unknown');
    expect(mapTypeToMapGroup(32)).toBe('unknown');
    expect(mapTypeToMapGroup(255)).toBe('unknown');
  });
});
