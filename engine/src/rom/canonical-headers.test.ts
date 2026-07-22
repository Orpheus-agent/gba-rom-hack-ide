import { describe, expect, it } from 'vitest';
import { CANONICAL_GEN3_HEADERS, canonicalForGameCode } from './canonical-headers.js';

describe('canonical-headers', () => {
  it('exports exactly the 5 Gen-3 Pokémon families', () => {
    const codes = CANONICAL_GEN3_HEADERS.map((c) => c.gameCode).sort();
    expect(codes).toEqual(['AXPE', 'AXVE', 'BPEE', 'BPGE', 'BPRE']);
  });

  it('every entry carries title + size + version + maker', () => {
    for (const c of CANONICAL_GEN3_HEADERS) {
      expect(c.internalTitle.length).toBeGreaterThan(0);
      expect(c.makerCode).toBe('01');
      expect(c.canonicalSizesBytes.length).toBeGreaterThan(0);
      expect(c.canonicalSoftwareVersions.length).toBeGreaterThan(0);
    }
  });

  it('canonicalForGameCode returns the right entry for a known code', () => {
    const fr = canonicalForGameCode('BPRE');
    expect(fr).not.toBeNull();
    expect(fr?.displayName).toBe('Pokémon FireRed');
    expect(fr?.internalTitle).toBe('POKEMON FIRE');
    expect(fr?.canonicalSizesBytes).toContain(16 * 1024 * 1024);
  });

  it('canonicalForGameCode returns null for an unknown code', () => {
    expect(canonicalForGameCode('XYZW')).toBeNull();
    expect(canonicalForGameCode('ZZZZ')).toBeNull();
  });

  it('CANONICAL_GEN3_HEADERS is frozen (immutable)', () => {
    expect(Object.isFrozen(CANONICAL_GEN3_HEADERS)).toBe(true);
  });

  it('all canonical sizes are exactly 16 MiB for Gen-3', () => {
    const SIXTEEN_MIB = 16 * 1024 * 1024;
    for (const c of CANONICAL_GEN3_HEADERS) {
      for (const s of c.canonicalSizesBytes) {
        expect(s).toBe(SIXTEEN_MIB);
      }
    }
  });
});
