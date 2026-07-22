import { describe, expect, it } from 'vitest';
import { matchSignatures } from './matcher.js';
import type { SignatureDb } from './loader.js';
import type { SignatureEntry } from './schema.js';

function fakeDb(entries: SignatureEntry[]): SignatureDb {
  const byGameCode = new Map<string, SignatureEntry[]>();
  const bySha1 = new Map<string, SignatureEntry[]>();
  const bySizeBytes = new Map<number, SignatureEntry[]>();
  const markerEntries: SignatureEntry[] = [];
  for (const e of entries) {
    e.gameCodes?.forEach((c) => {
      const a = byGameCode.get(c) ?? [];
      a.push(e);
      byGameCode.set(c, a);
    });
    e.sha1?.forEach((h) => {
      const a = bySha1.get(h.toLowerCase()) ?? [];
      a.push(e);
      bySha1.set(h.toLowerCase(), a);
    });
    e.sizeBytes?.forEach((s) => {
      const a = bySizeBytes.get(s) ?? [];
      a.push(e);
      bySizeBytes.set(s, a);
    });
    if (e.buildMarkers && e.buildMarkers.length > 0) markerEntries.push(e);
  }
  return Object.freeze({
    allEntries: Object.freeze([...entries]),
    byGameCode,
    bySha1,
    bySizeBytes,
    markerEntries,
    loadedFiles: [],
    fileErrors: [],
  });
}

const FIRERED: SignatureEntry = {
  id: 'firered',
  displayName: 'FireRed',
  family: 'firered',
  kind: 'vanilla',
  gameCodes: ['BPRE'],
  sources: ['x'],
  confidenceWhenMatched: 0.85,
};

const FIRERED_v1_0_DUMP: SignatureEntry = {
  id: 'firered-v1-0-usa',
  displayName: 'FireRed v1.0 USA',
  family: 'firered',
  kind: 'vanilla',
  gameCodes: ['BPRE'],
  sha1: ['1111111111111111111111111111111111111111'],
  sizeBytes: [16777216],
  sources: ['x'],
  confidenceWhenMatched: 0.95,
};

const CFRU: SignatureEntry = {
  id: 'cfru-marker',
  displayName: 'CFRU framework',
  family: 'cfru',
  kind: 'cfru',
  gameCodes: ['BPRE'],
  buildMarkers: [
    {
      offset: 0x100,
      magic: '4346525500', // "CFRU\0"
      label: 'CFRU framework magic',
    },
  ],
  sources: ['x'],
  confidenceWhenMatched: 0.9,
};

describe('matchSignatures', () => {
  function rom(args: { sha1?: string; size?: number; bytes?: Uint8Array }) {
    return {
      sha1: args.sha1 ?? 'deadbeef'.repeat(5),
      byteLength: args.size ?? 16777216,
      bytes: args.bytes ?? Buffer.alloc(0),
    };
  }

  it('returns an empty list when DB is empty', () => {
    const db = fakeDb([]);
    expect(matchSignatures({ rom: rom({}), gameCode: 'BPRE', db })).toEqual([]);
  });

  it('returns one match for gameCode-only (scaled to 0.5×)', () => {
    const db = fakeDb([FIRERED]);
    const matches = matchSignatures({
      rom: rom({ size: 999 /* not in any sizeBytes */ }),
      gameCode: 'BPRE',
      db,
    });
    expect(matches).toHaveLength(1);
    expect(matches[0]?.entry.id).toBe('firered');
    expect(matches[0]?.reasons.map((r) => r.kind)).toEqual(['game_code']);
    expect(matches[0]?.confidence).toBeCloseTo(0.85 * 0.5, 3);
  });

  it('returns sha1 match at 1.0 strength (overrides game_code+size)', () => {
    const db = fakeDb([FIRERED_v1_0_DUMP]);
    const matches = matchSignatures({
      rom: rom({ sha1: '1111111111111111111111111111111111111111', size: 16777216 }),
      gameCode: 'BPRE',
      db,
    });
    expect(matches).toHaveLength(1);
    expect(matches[0]?.reasons.map((r) => r.kind).sort()).toEqual([
      'game_code',
      'sha1',
      'size_bytes',
    ]);
    // Includes sha1 → strength 1.0 → confidence = 0.95.
    expect(matches[0]?.confidence).toBe(0.95);
  });

  it('returns game_code + size_bytes at 0.7× when sha1 misses', () => {
    const db = fakeDb([FIRERED_v1_0_DUMP]);
    const matches = matchSignatures({
      rom: rom({ sha1: 'not-the-hash', size: 16777216 }),
      gameCode: 'BPRE',
      db,
    });
    expect(matches).toHaveLength(1);
    expect(matches[0]?.confidence).toBeCloseTo(0.95 * 0.7, 3);
  });

  it('returns build_marker match when marker bytes hit', () => {
    const db = fakeDb([CFRU]);
    const bytes = Buffer.alloc(0x200);
    // Plant the CFRU magic "CFRU\0" at offset 0x100.
    Buffer.from([0x43, 0x46, 0x52, 0x55, 0x00]).copy(bytes, 0x100);
    const matches = matchSignatures({
      rom: rom({ size: 0x200, bytes }),
      gameCode: 'BPRE',
      db,
    });
    // Two reasons should hit: game_code (BPRE) + build_marker.
    expect(matches).toHaveLength(1);
    const kinds = matches[0]?.reasons.map((r) => r.kind);
    expect(kinds).toContain('build_marker');
    expect(kinds).toContain('game_code');
    // build_marker + game_code → 0.95 strength.
    expect(matches[0]?.confidence).toBeCloseTo(0.9 * 0.95, 3);
  });

  it('does NOT match when marker bytes are absent', () => {
    const db = fakeDb([CFRU]);
    const bytes = Buffer.alloc(0x200, 0);
    const matches = matchSignatures({
      rom: rom({ size: 0x200, bytes }),
      gameCode: 'BPRE',
      db,
    });
    // game_code still hits (CFRU also lists BPRE), but build_marker does not.
    expect(matches[0]?.reasons.map((r) => r.kind)).toEqual(['game_code']);
  });

  it('returns multiple distinct entries ordered by confidence DESC', () => {
    const db = fakeDb([FIRERED, FIRERED_v1_0_DUMP]);
    const matches = matchSignatures({
      rom: rom({ sha1: '1111111111111111111111111111111111111111', size: 16777216 }),
      gameCode: 'BPRE',
      db,
    });
    expect(matches[0]?.entry.id).toBe('firered-v1-0-usa'); // includes sha1 → 0.95
    expect(matches[1]?.entry.id).toBe('firered'); // game_code only → 0.425
    expect(matches[0]?.confidence).toBeGreaterThan(matches[1]?.confidence ?? 0);
  });

  it('returns nothing when gameCode is null and DB has only game-code entries', () => {
    const db = fakeDb([FIRERED]);
    expect(matchSignatures({ rom: rom({}), gameCode: null, db })).toEqual([]);
  });

  it('marker that runs past end-of-bytes safely does not match', () => {
    const db = fakeDb([CFRU]);
    const bytes = Buffer.alloc(0x50); // smaller than marker offset 0x100
    const matches = matchSignatures({
      rom: rom({ size: 0x50, bytes }),
      gameCode: 'XXXX',
      db,
    });
    expect(matches).toEqual([]);
  });
});
