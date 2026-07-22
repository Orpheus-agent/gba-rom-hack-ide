import { describe, expect, it } from 'vitest';
import { performance } from 'node:perf_hooks';
import {
  emptyManifest,
  type DialogueNode,
  type Flag,
  type MapNode,
  type ObjectEvent,
  type PluginManifest,
  type ProjectManifest,
  type ScriptStep,
  type Trigger,
  type Variable,
  type Warp,
} from '@rom-editor/shared';
import { runDesignLint } from './designLint';
import { findEntityReferences } from './entityReferences';
import { runPluginValidators } from './pluginValidators';

// Phase 12 criterion 2 - "stable under large hack projects" - frontend
// analyses (lint, dependencies, plugin validators) must scale linearly +
// fast enough that opening a tab on a large project still feels instant.
// These budgets are deliberately tight: lint is read-only and runs on every
// LintView mount; refs runs on every Dependencies dropdown change.

function buildLargeManifest(): ProjectManifest {
  const base = emptyManifest('/abs/path', '2026-05-16T00:00:00Z');

  const N_MAPS = 200;
  const OBJ_PER_MAP = 8;
  const WARP_PER_MAP = 4;
  const DIALOGUE_PER_MAP = 6;
  const SCRIPT_PER_MAP = 12;
  const FLAGS = 500;
  const VARS = 100;

  const maps: MapNode[] = [];
  const objectEvents: ObjectEvent[] = [];
  const warps: Warp[] = [];
  const triggers: Trigger[] = [];
  const dialogue: DialogueNode[] = [];
  const scriptSteps: ScriptStep[] = [];

  for (let i = 0; i < N_MAPS; i++) {
    const mapId = `MAP_${i}`;
    const mapWarps = Array.from({ length: WARP_PER_MAP }, (_, k) => ({
      id: `${mapId}_warp_${k}`,
      name: `${mapId}_warp_${k}`,
      fromMapId: mapId,
      fromCoord: { x: k, y: 0 },
      toMapId: `MAP_${(i + 1) % N_MAPS}`,
      toCoord: { x: 0, y: 0 },
    }));
    warps.push(...mapWarps);

    const mapObjects = Array.from({ length: OBJ_PER_MAP }, (_, k) => ({
      id: `${mapId}_obj_${k}`,
      name: `${mapId}_obj_${k}`,
      mapId,
      coord: { x: k, y: 5 },
      elevation: 3,
      kind: 'npc' as const,
      graphicsId: 'gfx_npc',
      movementType: 'NO_MOVEMENT',
      scriptId: `${mapId}_obj_${k}_script`,
      flagId: k === 0 ? `FLAG_${i % FLAGS}` : null,
      trainerType: null,
      metadata: {},
    }));
    objectEvents.push(...mapObjects);

    const mapDialogue = Array.from({ length: DIALOGUE_PER_MAP }, (_, k) => ({
      id: `${mapId}_text_${k}`,
      name: `${mapId}_text_${k}`,
      speakerName: null,
      portraitAssetId: null,
      text: `Map ${i} text ${k}${k === 5 ? ' TODO finalize' : ''}`,
      choices: [],
    }));
    dialogue.push(...mapDialogue);

    const mapTrigger: Trigger = {
      id: `${mapId}_trigger_0`,
      name: `${mapId}_trigger_0`,
      kind: 'on_enter',
      mapId,
      coord: { x: 5, y: 5 },
      conditionExpression: null,
      scriptStepIds: Array.from({ length: SCRIPT_PER_MAP }, (_, k) => `${mapId}_script_${k}`),
    };
    triggers.push(mapTrigger);

    for (let k = 0; k < SCRIPT_PER_MAP; k++) {
      scriptSteps.push({
        id: `${mapId}_script_${k}`,
        kind: k % 3 === 0 ? 'dialogue' : k % 3 === 1 ? 'set_flag' : 'raw',
        params: {
          macro: k % 3 === 0 ? 'msgbox' : k % 3 === 1 ? 'setflag' : 'noop',
          args: k % 3 === 0 ? [`${mapId}_text_${k % DIALOGUE_PER_MAP}`] : [],
          ...(k % 3 === 0 ? { text: `${mapId}_text_${k % DIALOGUE_PER_MAP}` } : {}),
          ...(k % 3 === 1 ? { flag: `FLAG_${i % FLAGS}` } : {}),
        },
      });
    }

    maps.push({
      id: mapId,
      name: mapId,
      group: 'town',
      dimensions: { width: 20, height: 20 },
      tilesetIds: [],
      warpIds: mapWarps.map((w) => w.id),
      scriptIds: [],
      objectEventIds: mapObjects.map((o) => o.id),
      encounterTableIds: [],
      musicId: null,
      metadata: {},
    });
  }

  const flags: Flag[] = Array.from({ length: FLAGS }, (_, i) => ({
    id: `FLAG_${i}`,
    name: `FLAG_${i}`,
    scope: 'global',
    defaultValue: false,
    description: null,
    engineValue: `0x${(0x900 + i).toString(16)}`,
  }));

  const variables: Variable[] = Array.from({ length: VARS }, (_, i) => ({
    id: `VAR_${i}`,
    name: `VAR_${i}`,
    scope: 'global',
    defaultValue: 0,
    description: null,
    engineValue: `0x${(0x4000 + i).toString(16)}`,
  }));

  return {
    ...base,
    maps,
    warps,
    triggers,
    objectEvents,
    dialogue,
    flags,
    variables,
    scriptSteps,
  };
}

const PLUGIN: PluginManifest = {
  id: 'perf-test',
  label: 'Perf Test',
  version: '0.1',
  description: '',
  validators: [
    {
      ruleId: 'rule_a',
      severity: 'warn',
      message: 'flag has no description',
      predicate: { kind: 'field_pattern', entityKind: 'flag', fieldPath: 'description', pattern: '.+', mustMatch: true },
    },
    {
      ruleId: 'rule_b',
      severity: 'info',
      message: 'flag matches FLAG_1xx pattern',
      predicate: { kind: 'entity_pattern', entityKind: 'flag', idPattern: '^FLAG_1\\d{2}$' },
    },
    {
      ruleId: 'rule_c',
      severity: 'warn',
      message: 'too few maps',
      predicate: { kind: 'entity_count', entityKind: 'map', min: 5000 },
    },
  ],
};

describe('large-manifest frontend perf', () => {
  it('runDesignLint completes under 500ms on a ~5000-entity manifest', () => {
    const manifest = buildLargeManifest();
    const t0 = performance.now();
    const report = runDesignLint(manifest);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(500);
    // Sanity: the lint engine produced findings (most flags are unreferenced,
    // most assets are absent so no orphan_asset, every dialogue is reached by
    // a script step, so the bulk of findings will be unused_flag).
    expect(report.findings.length).toBeGreaterThan(0);
  });

  it('findEntityReferences stays under 100ms per lookup across 8 entity-kind queries', () => {
    const manifest = buildLargeManifest();
    const queries: Array<{ kind: Parameters<typeof findEntityReferences>[1]; id: string }> = [
      { kind: 'map', id: 'MAP_100' },
      { kind: 'flag', id: 'FLAG_250' },
      { kind: 'object_event', id: 'MAP_50_obj_3' },
      { kind: 'trigger', id: 'MAP_30_trigger_0' },
      { kind: 'warp', id: 'MAP_20_warp_1' },
      { kind: 'variable', id: 'VAR_10' },
      { kind: 'dialogue', id: 'MAP_75_text_2' },
      { kind: 'script_step', id: 'MAP_60_script_4' },
    ];
    for (const q of queries) {
      const t0 = performance.now();
      const r = findEntityReferences(manifest, q.kind, q.id);
      const elapsed = performance.now() - t0;
      expect(elapsed).toBeLessThan(100);
      expect(r.found).toBe(true);
    }
  });

  it('runPluginValidators with 3 rules completes under 500ms on the same manifest', () => {
    const manifest = buildLargeManifest();
    const t0 = performance.now();
    const r = runPluginValidators(manifest, [PLUGIN]);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(500);
    // 500 flags all lack description -> all 500 trigger rule_a (mustMatch=true
    // fails on empty/null field).
    expect(r.findings.length).toBeGreaterThan(0);
  });
});
