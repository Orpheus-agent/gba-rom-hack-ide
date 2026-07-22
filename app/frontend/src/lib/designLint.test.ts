import { describe, expect, it } from 'vitest';
import type { ProjectManifest, ScriptStep } from '@rom-editor/shared';
import { emptyManifest } from '@rom-editor/shared';
import { runDesignLint } from './designLint';

function step(id: string, kind: ScriptStep['kind'], params: Record<string, unknown>): ScriptStep {
  return { id, kind, params };
}

describe('runDesignLint', () => {
  it('returns zero findings on an empty manifest', () => {
    const r = runDesignLint(emptyManifest('/tmp/x', '2026-05-16T00:00:00Z'));
    expect(r.findings).toEqual([]);
    expect(r.countsBySeverity.warn).toBe(0);
    expect(r.countsBySeverity.info).toBe(0);
  });

  it('flags orphan_dialogue for a DialogueNode with no caller', () => {
    const base = emptyManifest('/tmp/x', '2026-05-16T00:00:00Z');
    const m: ProjectManifest = {
      ...base,
      dialogue: [
        { id: 'Text_NoOneCalls', name: 'Text_NoOneCalls', speakerName: null, portraitAssetId: null, text: 'hi', choices: [] },
      ],
    };
    const r = runDesignLint(m);
    expect(r.findings.find((f) => f.ruleId === 'orphan_dialogue')?.entityId).toBe('Text_NoOneCalls');
  });

  it('does NOT flag a dialogue that is referenced by a script step OR a dialogue choice', () => {
    const base = emptyManifest('/tmp/x', '2026-05-16T00:00:00Z');
    const m: ProjectManifest = {
      ...base,
      dialogue: [
        { id: 'Text_Called', name: 'Text_Called', speakerName: null, portraitAssetId: null, text: 'hi', choices: [] },
        {
          id: 'Text_Linked',
          name: 'Text_Linked',
          speakerName: null,
          portraitAssetId: null,
          text: 'linked',
          choices: [],
        },
        {
          id: 'Text_WithChoice',
          name: 'Text_WithChoice',
          speakerName: null,
          portraitAssetId: null,
          text: 'choose',
          choices: [{ label: 'A', nextDialogueId: 'Text_Linked', setsFlagIds: [] }],
        },
      ],
      scriptSteps: [
        step('S#0', 'dialogue', { macro: 'msgbox', args: ['Text_Called'], text: 'Text_Called' }),
      ],
    };
    const r = runDesignLint(m);
    const orphans = r.findings.filter((f) => f.ruleId === 'orphan_dialogue').map((f) => f.entityId);
    expect(orphans).not.toContain('Text_Called');
    expect(orphans).not.toContain('Text_Linked');
    // Text_WithChoice has no caller and no choice points to it, so it IS orphan.
    expect(orphans).toContain('Text_WithChoice');
  });

  it('flags unused_flag for a Flag with zero references across object events / script steps / choices', () => {
    const base = emptyManifest('/tmp/x', '2026-05-16T00:00:00Z');
    const m: ProjectManifest = {
      ...base,
      flags: [
        { id: 'FLAG_USED', name: 'FLAG_USED', scope: 'global', defaultValue: false, description: null, engineValue: '0x800' },
        { id: 'FLAG_DEAD', name: 'FLAG_DEAD', scope: 'global', defaultValue: false, description: null, engineValue: '0x801' },
      ],
      scriptSteps: [
        step('S#0', 'set_flag', { macro: 'setflag', args: ['FLAG_USED'], flag: 'FLAG_USED' }),
      ],
    };
    const r = runDesignLint(m);
    const unused = r.findings.filter((f) => f.ruleId === 'unused_flag').map((f) => f.entityId);
    expect(unused).toEqual(['FLAG_DEAD']);
  });

  it('flags orphan_asset for an Asset with no references', () => {
    const base = emptyManifest('/tmp/x', '2026-05-16T00:00:00Z');
    const m: ProjectManifest = {
      ...base,
      assets: [
        { id: 'asset_used', name: 'asset_used', kind: 'tileset', relativePath: 'graphics/tilesets/used.png', metadata: {} },
        { id: 'asset_orphan', name: 'asset_orphan', kind: 'ui_graphic', relativePath: 'graphics/misc/orphan.png', metadata: {} },
      ],
      maps: [
        {
          id: 'Town', name: 'Town', group: 'town',
          dimensions: { width: 10, height: 10 },
          tilesetIds: ['asset_used'], warpIds: [], scriptIds: [], objectEventIds: [], encounterTableIds: [],
          musicId: null, metadata: {},
        },
      ],
    };
    const r = runDesignLint(m);
    const orphans = r.findings.filter((f) => f.ruleId === 'orphan_asset').map((f) => f.entityId);
    expect(orphans).toEqual(['asset_orphan']);
  });

  it('flags empty_trigger and decorative_object correctly', () => {
    const base = emptyManifest('/tmp/x', '2026-05-16T00:00:00Z');
    const m: ProjectManifest = {
      ...base,
      triggers: [
        { id: 'trig_empty', name: 'trig_empty', kind: 'on_enter', mapId: 'Town', coord: { x: 0, y: 0 }, conditionExpression: null, scriptStepIds: [] },
        { id: 'trig_with_steps', name: 'trig_with_steps', kind: 'on_enter', mapId: 'Town', coord: { x: 0, y: 1 }, conditionExpression: null, scriptStepIds: ['S#0'] },
      ],
      objectEvents: [
        { id: 'obj_decorative', name: 'obj_decorative', mapId: 'Town', coord: { x: 1, y: 1 }, elevation: 0, kind: 'npc', graphicsId: null, movementType: null, scriptId: null, flagId: null, trainerType: null, metadata: {} },
        { id: 'obj_real', name: 'obj_real', mapId: 'Town', coord: { x: 1, y: 2 }, elevation: 0, kind: 'npc', graphicsId: null, movementType: null, scriptId: 'someScript', flagId: null, trainerType: null, metadata: {} },
      ],
    };
    const r = runDesignLint(m);
    expect(r.findings.filter((f) => f.ruleId === 'empty_trigger').map((f) => f.entityId)).toEqual(['trig_empty']);
    expect(r.findings.filter((f) => f.ruleId === 'decorative_object').map((f) => f.entityId)).toEqual(['obj_decorative']);
    // decorative_object is info-severity, not warn
    expect(r.findings.find((f) => f.entityId === 'obj_decorative')?.severity).toBe('info');
  });

  it('reports correct severity + rule counts in the aggregated report', () => {
    const base = emptyManifest('/tmp/x', '2026-05-16T00:00:00Z');
    const m: ProjectManifest = {
      ...base,
      flags: [{ id: 'FLAG_X', name: 'FLAG_X', scope: 'global', defaultValue: false, description: null, engineValue: '0x800' }],
      triggers: [{ id: 't', name: 't', kind: 'on_enter', mapId: null, coord: null, conditionExpression: null, scriptStepIds: [] }],
      objectEvents: [{ id: 'o', name: 'o', mapId: 'M', coord: { x: 0, y: 0 }, elevation: 0, kind: 'npc', graphicsId: null, movementType: null, scriptId: null, flagId: null, trainerType: null, metadata: {} }],
    };
    const r = runDesignLint(m);
    expect(r.countsBySeverity.warn).toBe(2); // unused_flag + empty_trigger
    expect(r.countsBySeverity.info).toBe(1); // decorative_object
    expect(r.countsByRule.unused_flag).toBe(1);
    expect(r.countsByRule.empty_trigger).toBe(1);
    expect(r.countsByRule.decorative_object).toBe(1);
  });
});
