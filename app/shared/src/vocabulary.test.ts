import { describe, expect, it } from 'vitest';
import { emptyManifest } from './manifest.js';

describe('emptyManifest', () => {
  it('returns a valid empty canonical manifest with all collections present', () => {
    const m = emptyManifest('/tmp/example', '2026-05-16T00:00:00Z');
    expect(m.schemaVersion).toBe(1);
    expect(m.projectRoot).toBe('/tmp/example');
    expect(m.generatedAtUtc).toBe('2026-05-16T00:00:00Z');
    expect(m.identity.kind).toBe('unknown');
    expect(m.identity.confidence).toBe(0);
    expect(Array.isArray(m.maps)).toBe(true);
    expect(m.maps.length).toBe(0);
    expect(Array.isArray(m.warps)).toBe(true);
    expect(Array.isArray(m.triggers)).toBe(true);
    expect(Array.isArray(m.objectEvents)).toBe(true);
    expect(Array.isArray(m.dialogue)).toBe(true);
    expect(Array.isArray(m.flags)).toBe(true);
    expect(Array.isArray(m.variables)).toBe(true);
    expect(Array.isArray(m.encounterTables)).toBe(true);
    expect(Array.isArray(m.trainers)).toBe(true);
    expect(Array.isArray(m.scriptSteps)).toBe(true);
    expect(Array.isArray(m.assets)).toBe(true);
  });
});
