import { describe, expect, it } from 'vitest';
import type { ProjectManifest, ScriptStep } from '@rom-editor/shared';
import { emptyManifest } from '@rom-editor/shared';
import { assessAllMechanics } from './mechanicDetectors';

function step(id: string, kind: ScriptStep['kind'] = 'raw'): ScriptStep {
  return { id, kind, params: { macro: 'noop', args: [] } };
}

describe('assessAllMechanics', () => {
  it('reports vanilla for every detector on an empty manifest', () => {
    const r = assessAllMechanics(emptyManifest('/tmp/x', '2026-05-16T00:00:00Z'));
    expect(r).toHaveLength(4);
    for (const d of r) {
      expect(d.present).toBe(false);
      expect(d.severity).toBe('vanilla');
      expect(d.signature).toEqual([]);
    }
  });

  it('detects starter_selection when birch script labels are present', () => {
    const base = emptyManifest('/tmp/x', '2026-05-16T00:00:00Z');
    const m: ProjectManifest = {
      ...base,
      scriptSteps: [
        step('LittlerootTown_BirchsLab_EventScript_StartChoice#0', 'dialogue'),
        step('LittlerootTown_BirchsLab_EventScript_StartChoice#1'),
        step('Birch_StarterChoice_Treecko#0', 'dialogue'),
      ],
    };
    const r = assessAllMechanics(m);
    const starter = r.find((d) => d.id === 'starter_selection');
    expect(starter?.present).toBe(true);
    expect(starter?.severity).toBe('detected');
    expect(starter?.signature).toContain('LittlerootTown_BirchsLab_EventScript_StartChoice');
    expect(starter?.signature).toContain('Birch_StarterChoice_Treecko');
  });

  it('marks starter_selection partial when only one matching script exists', () => {
    const base = emptyManifest('/tmp/x', '2026-05-16T00:00:00Z');
    const m: ProjectManifest = {
      ...base,
      scriptSteps: [step('LittlerootTown_BirchHelp#0')],
    };
    const r = assessAllMechanics(m);
    const starter = r.find((d) => d.id === 'starter_selection');
    expect(starter?.present).toBe(true);
    expect(starter?.severity).toBe('partial');
  });

  it('detects difficulty_system from FLAG_/VAR_ identifiers', () => {
    const base = emptyManifest('/tmp/x', '2026-05-16T00:00:00Z');
    const m: ProjectManifest = {
      ...base,
      flags: [
        { id: 'FLAG_DIFFICULTY_HARD', name: 'FLAG_DIFFICULTY_HARD', scope: 'global', defaultValue: false, description: null, engineValue: '0x801' },
        { id: 'FLAG_NUZLOCKE', name: 'FLAG_NUZLOCKE', scope: 'global', defaultValue: false, description: null, engineValue: '0x802' },
        { id: 'FLAG_VISITED_TOWN', name: 'FLAG_VISITED_TOWN', scope: 'global', defaultValue: false, description: null, engineValue: '0x803' },
      ],
      variables: [
        { id: 'VAR_RANDOMIZER_SEED', name: 'VAR_RANDOMIZER_SEED', scope: 'global', defaultValue: 0, description: null, engineValue: '0x4001' },
      ],
    };
    const r = assessAllMechanics(m);
    const diff = r.find((d) => d.id === 'difficulty_system');
    expect(diff?.present).toBe(true);
    expect(diff?.severity).toBe('detected');
    expect(diff?.signature).toEqual(
      expect.arrayContaining(['FLAG_DIFFICULTY_HARD', 'FLAG_NUZLOCKE', 'VAR_RANDOMIZER_SEED']),
    );
    expect(diff?.signature).not.toContain('FLAG_VISITED_TOWN');
  });

  it('detects evolution_flags from FLAG_RECEIVED_* prefix', () => {
    const base = emptyManifest('/tmp/x', '2026-05-16T00:00:00Z');
    const m: ProjectManifest = {
      ...base,
      flags: Array.from({ length: 6 }, (_, i) => ({
        id: `FLAG_RECEIVED_MON_${i}`,
        name: `FLAG_RECEIVED_MON_${i}`,
        scope: 'global' as const,
        defaultValue: false,
        description: null,
        engineValue: `0x9${i}0`,
      })),
    };
    const r = assessAllMechanics(m);
    const evo = r.find((d) => d.id === 'evolution_flags');
    expect(evo?.present).toBe(true);
    expect(evo?.severity).toBe('detected'); // 6 ≥ 5 threshold
    expect(evo?.signature).toHaveLength(6);
  });

  it('detects encounter_variants from maps with multiple tables', () => {
    const base = emptyManifest('/tmp/x', '2026-05-16T00:00:00Z');
    const m: ProjectManifest = {
      ...base,
      encounterTables: [
        { id: 'route1_grass', name: 'route1_grass', mapId: 'Route1', type: 'grass', encounterRate: 30, slots: [] },
        { id: 'route1_water', name: 'route1_water', mapId: 'Route1', type: 'water', encounterRate: 10, slots: [] },
        { id: 'route2_grass', name: 'route2_grass', mapId: 'Route2', type: 'grass', encounterRate: 30, slots: [] },
      ],
    };
    const r = assessAllMechanics(m);
    const enc = r.find((d) => d.id === 'encounter_variants');
    expect(enc?.present).toBe(true);
    expect(enc?.signature.join('|')).toContain('Route1 (2 tables)');
    expect(enc?.signature.join('|')).not.toContain('Route2');
  });

  it('returns vanilla for evolution_flags when no FLAG_RECEIVED_* exist', () => {
    const base = emptyManifest('/tmp/x', '2026-05-16T00:00:00Z');
    const m: ProjectManifest = {
      ...base,
      flags: [
        { id: 'FLAG_SOMETHING', name: 'FLAG_SOMETHING', scope: 'global', defaultValue: false, description: null, engineValue: '0x800' },
      ],
    };
    const r = assessAllMechanics(m);
    const evo = r.find((d) => d.id === 'evolution_flags');
    expect(evo?.present).toBe(false);
    expect(evo?.severity).toBe('vanilla');
  });
});
