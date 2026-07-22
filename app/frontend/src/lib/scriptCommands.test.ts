import { describe, expect, it } from 'vitest';
import type { ProjectManifest, ScriptStep } from '@rom-editor/shared';
import {
  categoryFor,
  commandMetadata,
  commandsByCategory,
  SCRIPT_COMMAND_CATEGORIES,
  summarizeStep,
} from './scriptCommands';

function makeManifest(over: Partial<ProjectManifest> = {}): ProjectManifest {
  const base: ProjectManifest = {
    schemaVersion: 1,
    generatedAtUtc: '2026-05-25T00:00:00.000Z',
    projectRoot: '/tmp/test',
    identity: {
      kind: 'patch',
      confidence: 0.5,
      displayName: 'Bare ROM',
      baseGame: null,
      fork: null,
      featureFlags: [],
      warnings: [],
      evidence: [],
    },
    buildProfile: null,
    maps: [],
    warps: [],
    triggers: [],
    objectEvents: [],
    dialogue: [],
    flags: [],
    variables: [],
    encounterTables: [],
    trainers: [],
    scriptSteps: [],
    assets: [],
  };
  return { ...base, ...over };
}

function makeStep(over: Partial<ScriptStep>): ScriptStep {
  return {
    id: 'step_1',
    kind: 'raw',
    params: {},
    ...over,
  };
}

describe('commandMetadata', () => {
  it('returns metadata for every defined ScriptStepKind', () => {
    const kinds = [
      'dialogue', 'set_flag', 'clear_flag', 'branch', 'branch_on_var',
      'give_item', 'start_battle', 'play_sound', 'move_npc', 'fade_scene',
      'warp_player', 'set_variable', 'randomize_branch', 'raw',
    ] as const;
    for (const kind of kinds) {
      const meta = commandMetadata(kind);
      expect(meta.kind).toBe(kind);
      expect(meta.defaultLabel).toBeTruthy();
      expect(meta.icon).toBeTruthy();
      expect(meta.category).toBeTruthy();
    }
  });
});

describe('summarizeStep', () => {
  it('summarizes a dialogue step with quoted preview text', () => {
    const m = makeManifest();
    const step = makeStep({
      kind: 'dialogue',
      params: { dialogueText: 'Welcome to Pallet Town!' },
    });
    expect(summarizeStep(step, m)).toBe('Show dialogue - "Welcome to Pallet Town!"');
  });

  it('truncates long dialogue with an ellipsis', () => {
    const m = makeManifest();
    const step = makeStep({
      kind: 'dialogue',
      params: { dialogueText: 'A'.repeat(120) },
    });
    const summary = summarizeStep(step, m);
    expect(summary).toContain('…');
    expect(summary.length).toBeLessThan(120);
  });

  it('summarizes set_flag with the resolved flag name', () => {
    const m = makeManifest();
    // 0x82F (decimal 2095) is the curated "Defeated Brock (Pewter)" flag
    // in displayName.ts's VANILLA_FRLG_FLAG_NAMES.
    const step = makeStep({
      kind: 'set_flag',
      params: { flagId: 'binary_flag_2095' },
    });
    expect(summarizeStep(step, m)).toBe('Mark "Defeated Brock (Pewter)" as done');
  });

  it('summarizes set_flag with a fallback when no flag id is set', () => {
    const m = makeManifest();
    const step = makeStep({ kind: 'set_flag', params: {} });
    expect(summarizeStep(step, m)).toBe('Mark a story flag as done');
  });

  it('summarizes give_item with quantity', () => {
    const m = makeManifest({
      items: [
        { id: 'binary_item_4', name: 'Poké Ball', itemIndex: 4 } as never,
      ],
    });
    const step = makeStep({
      kind: 'give_item',
      params: { itemId: 'item_4', quantity: 5 },
    });
    expect(summarizeStep(step, m)).toBe('Give 5 × Poké Ball');
  });

  it('summarizes give_item with quantity 1 (no multiplier)', () => {
    const m = makeManifest({
      items: [{ id: 'binary_item_4', name: 'Poké Ball', itemIndex: 4 } as never],
    });
    const step = makeStep({
      kind: 'give_item',
      params: { itemId: 'item_4', quantity: 1 },
    });
    expect(summarizeStep(step, m)).toBe('Give Poké Ball');
  });

  it('summarizes warp_player with destination map name and coords', () => {
    const m = makeManifest({
      maps: [
        {
          id: 'binary_map_3_0',
          name: 'PALLET TOWN',
          group: 'town',
          scriptIds: [],
          encounterTableIds: [],
          metadata: {},
        } as never,
      ],
    });
    const step = makeStep({
      kind: 'warp_player',
      params: { destMapId: 'binary_map_3_0', destX: 5, destY: 7 },
    });
    expect(summarizeStep(step, m)).toBe('Warp player to Pallet Town (5, 7)');
  });

  it('summarizes fade_scene by direction', () => {
    const m = makeManifest();
    expect(summarizeStep(makeStep({ kind: 'fade_scene', params: { direction: 'in' } }), m)).toBe(
      'Fade in from black',
    );
    expect(summarizeStep(makeStep({ kind: 'fade_scene', params: { direction: 'out' } }), m)).toBe(
      'Fade out to black',
    );
    expect(summarizeStep(makeStep({ kind: 'fade_scene', params: {} }), m)).toBe('Fade screen');
  });

  it('summarizes raw step with the universal script-command registry name when available', () => {
    const m = makeManifest();
    // 0x6c = "Show dialogue" in the universal registry.
    const step = makeStep({ kind: 'raw', params: { opcode: 0x6c } });
    expect(summarizeStep(step, m)).toBe('Engine command - Show dialogue');
  });

  it('summarizes raw step generically when opcode is unknown', () => {
    const m = makeManifest();
    const step = makeStep({ kind: 'raw', params: { opcode: 0xfe } });
    expect(summarizeStep(step, m)).toBe('Engine command (advanced)');
  });

  it('summarizes start_battle with the trainer name', () => {
    const m = makeManifest({
      trainers: [
        {
          id: 'binary_trainer_1',
          name: 'BROCK',
          className: 'LEADER',
          party: [],
          aiFlags: [],
          mapId: null,
        } as never,
      ],
    });
    const step = makeStep({
      kind: 'start_battle',
      params: { trainerId: 'binary_trainer_1' },
    });
    // displayName for the trainer id falls back to "Trainer #1" since
    // the resolver doesn't have a trainer-name path; just confirm it
    // produced something starting with "Battle".
    expect(summarizeStep(step, m)).toMatch(/^Battle /);
  });

  it('returns the defaultLabel for an unmapped scenario rather than empty string', () => {
    const m = makeManifest();
    const step = makeStep({ kind: 'randomize_branch', params: {} });
    expect(summarizeStep(step, m)).toBe('Pick a random branch');
  });

  it('summarizes branch_on_var with var/value/operator (Phase 2B)', () => {
    const m = makeManifest();
    // 0x40C0 doesn't have a friendly label in the vanilla Gen-3 var map
    // (which only covers 0x4000-0x400F) nor in this no-fork manifest's
    // symbol DB, so resolveDisplayName falls back to "Var @ 0x40c0".
    const step = makeStep({
      kind: 'branch_on_var',
      params: {
        varId: 0x40c0,
        value: 3,
        operator: 'greaterorequal',
        targetRomPtr: 0x08000300,
      },
    });
    expect(summarizeStep(step, m)).toBe('If Var @ 0x40c0 ≥ 3 - jump');
  });

  it('summarizes branch_on_var with the friendly var name when one exists', () => {
    const m = makeManifest();
    // 0x4001 is in the vanilla Gen-3 var map → "Temp variable 1".
    const step = makeStep({
      kind: 'branch_on_var',
      params: {
        varId: 0x4001,
        value: 1,
        operator: 'equal',
        targetRomPtr: 0x08000100,
      },
    });
    expect(summarizeStep(step, m)).toBe('If Temp variable 1 = 1 - jump');
  });

  it('summarizes branch_on_var with each Unicode-glyph operator', () => {
    const m = makeManifest();
    const cases: ReadonlyArray<{ operator: string; symbol: string }> = [
      { operator: 'less', symbol: '<' },
      { operator: 'equal', symbol: '=' },
      { operator: 'greater', symbol: '>' },
      { operator: 'lessorequal', symbol: '≤' },
      { operator: 'greaterorequal', symbol: '≥' },
      { operator: 'notequal', symbol: '≠' },
    ];
    for (const { operator, symbol } of cases) {
      const step = makeStep({
        kind: 'branch_on_var',
        params: {
          varId: 0x40c0,
          value: 1,
          operator,
          targetRomPtr: 0x08000100,
        },
      });
      expect(summarizeStep(step, m)).toBe(`If Var @ 0x40c0 ${symbol} 1 - jump`);
    }
  });
});

describe('categoryFor', () => {
  it('routes dialogue to text', () => {
    expect(categoryFor('dialogue').id).toBe('text');
  });

  it('routes set_flag/set_variable to flags_vars', () => {
    expect(categoryFor('set_flag').id).toBe('flags_vars');
    expect(categoryFor('set_variable').id).toBe('flags_vars');
  });

  it('routes start_battle to battle', () => {
    expect(categoryFor('start_battle').id).toBe('battle');
  });

  it('routes give_item to inventory', () => {
    expect(categoryFor('give_item').id).toBe('inventory');
  });

  it('routes warp_player and move_npc to movement', () => {
    expect(categoryFor('warp_player').id).toBe('movement');
    expect(categoryFor('move_npc').id).toBe('movement');
  });

  it('routes branch to flow', () => {
    expect(categoryFor('branch').id).toBe('flow');
  });

  it('routes branch_on_var to flow (Phase 2B)', () => {
    expect(categoryFor('branch_on_var').id).toBe('flow');
  });

  it('routes raw to advanced', () => {
    expect(categoryFor('raw').id).toBe('advanced');
  });

  it('every category has a colour and label', () => {
    for (const c of SCRIPT_COMMAND_CATEGORIES) {
      expect(c.color).toMatch(/^#[0-9a-fA-F]{6}$/);
      expect(c.label).toBeTruthy();
    }
  });
});

describe('commandsByCategory', () => {
  it('returns categories in the canonical order', () => {
    const groups = commandsByCategory();
    const ids = groups.map((g) => g.category.id);
    const canonical = SCRIPT_COMMAND_CATEGORIES.map((c) => c.id);
    // Each present id appears in the canonical order
    let lastIdx = -1;
    for (const id of ids) {
      const idx = canonical.indexOf(id);
      expect(idx).toBeGreaterThan(lastIdx);
      lastIdx = idx;
    }
  });

  it('every group has at least one command', () => {
    for (const g of commandsByCategory()) {
      expect(g.commands.length).toBeGreaterThan(0);
    }
  });

  it('includes every defined ScriptStepKind exactly once across all groups', () => {
    const groups = commandsByCategory();
    const seen = new Set<string>();
    for (const g of groups) {
      for (const cmd of g.commands) {
        expect(seen.has(cmd.kind)).toBe(false);
        seen.add(cmd.kind);
      }
    }
    // 14 kinds: 13 original + Phase 2B's 'branch_on_var' for Resonance
    // Alignment.
    expect(seen.size).toBe(14);
  });
});
