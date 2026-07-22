// Unified per-kind reference engine. One entry point for "show me every
// entity that depends on this one + every entity it depends on", across
// every entity kind in the canonical manifest. The DependenciesView UI is
// a thin shell over this engine.
//
// Each per-kind builder returns a typed `EntityReferenceReport` with two
// halves: inbound (entities that point AT this one) and outbound (entities
// this one points AT). Sections are kind-tagged so the UI can render with
// consistent badges + colors.

import type { ProjectManifest } from '@rom-editor/shared';
import { findAssetReferences } from './assetReferences';

export type ReferenceableEntityKind =
  | 'map'
  | 'flag'
  | 'asset'
  | 'dialogue'
  | 'object_event'
  | 'trigger'
  | 'warp'
  | 'variable'
  | 'encounter_table'
  | 'trainer'
  | 'script_step';

export interface ReferenceLink {
  /** Stable id of the entity this link points to. */
  readonly id: string;
  /** Entity kind for color coding + cross-navigation. */
  readonly kind: ReferenceableEntityKind;
  /** Human-readable relation describing how the link applies
   *  (e.g. "tileset", "gates", "called from"). */
  readonly relation: string;
  /** Optional secondary text for context (map id, coord, etc.). */
  readonly context?: string;
}

export interface EntityReferenceReport {
  readonly entityKind: ReferenceableEntityKind;
  readonly entityId: string;
  readonly found: boolean;
  readonly inbound: ReadonlyArray<ReferenceLink>;
  readonly outbound: ReadonlyArray<ReferenceLink>;
}

function emptyReport(
  kind: ReferenceableEntityKind,
  id: string,
  found: boolean,
): EntityReferenceReport {
  return { entityKind: kind, entityId: id, found, inbound: [], outbound: [] };
}

export function findEntityReferences(
  manifest: ProjectManifest,
  kind: ReferenceableEntityKind,
  id: string,
): EntityReferenceReport {
  switch (kind) {
    case 'map':
      return forMap(manifest, id);
    case 'flag':
      return forFlag(manifest, id);
    case 'asset':
      return forAsset(manifest, id);
    case 'dialogue':
      return forDialogue(manifest, id);
    case 'object_event':
      return forObjectEvent(manifest, id);
    case 'trigger':
      return forTrigger(manifest, id);
    case 'warp':
      return forWarp(manifest, id);
    case 'variable':
      return forVariable(manifest, id);
    case 'encounter_table':
      return forEncounterTable(manifest, id);
    case 'trainer':
      return forTrainer(manifest, id);
    case 'script_step':
      return forScriptStep(manifest, id);
  }
}

// -----------------------------------------------------------------------------
// Per-kind builders.

function forMap(manifest: ProjectManifest, id: string): EntityReferenceReport {
  const map = manifest.maps.find((m) => m.id === id);
  if (!map) return emptyReport('map', id, false);
  const inbound: ReferenceLink[] = [];
  const outbound: ReferenceLink[] = [];

  // Inbound - warps that lead to this map.
  for (const w of manifest.warps) {
    if (w.toMapId === id) {
      inbound.push({
        id: w.id,
        kind: 'warp',
        relation: 'leads to this map',
        context: `from ${w.fromMapId} @ (${w.fromCoord.x}, ${w.fromCoord.y})`,
      });
    }
  }

  // Outbound - warps from this map.
  for (const w of manifest.warps) {
    if (w.fromMapId === id) {
      outbound.push({
        id: w.id,
        kind: 'warp',
        relation: 'warp out',
        context: `→ ${w.toMapId} @ (${w.toCoord.x}, ${w.toCoord.y})`,
      });
    }
  }
  // Outbound - object events on this map.
  for (const o of manifest.objectEvents) {
    if (o.mapId === id) {
      outbound.push({
        id: o.id,
        kind: 'object_event',
        relation: 'object event',
        context: `${o.kind} @ (${o.coord.x}, ${o.coord.y})`,
      });
    }
  }
  // Outbound - triggers on this map.
  for (const t of manifest.triggers) {
    if (t.mapId === id) {
      outbound.push({
        id: t.id,
        kind: 'trigger',
        relation: 'trigger',
        context: t.kind,
      });
    }
  }
  // Outbound - encounter tables on this map.
  for (const e of manifest.encounterTables) {
    if (e.mapId === id) {
      outbound.push({
        id: e.id,
        kind: 'encounter_table',
        relation: 'encounter table',
        context: e.type,
      });
    }
  }
  // Outbound - tileset assets.
  for (const tileId of map.tilesetIds) {
    outbound.push({
      id: tileId,
      kind: 'asset',
      relation: 'tileset',
    });
  }
  // Outbound - music asset.
  if (map.musicId) {
    outbound.push({
      id: map.musicId,
      kind: 'asset',
      relation: 'music',
    });
  }
  return { entityKind: 'map', entityId: id, found: true, inbound, outbound };
}

function forFlag(manifest: ProjectManifest, id: string): EntityReferenceReport {
  const flag = manifest.flags.find((f) => f.id === id);
  if (!flag) return emptyReport('flag', id, false);
  const inbound: ReferenceLink[] = [];
  // Object events gated by this flag.
  for (const o of manifest.objectEvents) {
    if (o.flagId === id) {
      inbound.push({
        id: o.id,
        kind: 'object_event',
        relation: 'gates visibility',
        context: `${o.kind} on ${o.mapId}`,
      });
    }
  }
  // Script steps that set/clear/branch on it.
  for (const s of manifest.scriptSteps) {
    const f = s.params['flag'];
    const c = s.params['condition'];
    if (
      (typeof f === 'string' && f === id) ||
      (typeof c === 'string' && c === id)
    ) {
      inbound.push({
        id: s.id,
        kind: 'script_step',
        relation: s.kind,
      });
    }
  }
  // Dialogue choices that set it.
  for (const d of manifest.dialogue) {
    for (const ch of d.choices) {
      if (ch.setsFlagIds.includes(id)) {
        inbound.push({
          id: d.id,
          kind: 'dialogue',
          relation: 'choice sets flag',
          context: `choice: ${ch.label}`,
        });
      }
    }
  }
  return { entityKind: 'flag', entityId: id, found: true, inbound, outbound: [] };
}

function forAsset(manifest: ProjectManifest, id: string): EntityReferenceReport {
  const asset = manifest.assets.find((a) => a.id === id);
  if (!asset) return emptyReport('asset', id, false);
  const refs = findAssetReferences(manifest, id);
  const inbound: ReferenceLink[] = [];
  for (const m of refs.maps) {
    inbound.push({
      id: m.map.id,
      kind: 'map',
      relation: m.role,
    });
  }
  for (const o of refs.objectEvents) {
    inbound.push({
      id: o.id,
      kind: 'object_event',
      relation: 'graphics',
      context: `${o.kind} on ${o.mapId}`,
    });
  }
  for (const d of refs.dialogueNodes) {
    inbound.push({
      id: d.id,
      kind: 'dialogue',
      relation: 'portrait',
      context: d.speakerName ?? undefined,
    });
  }
  for (const s of refs.scriptSteps) {
    inbound.push({
      id: s.id,
      kind: 'script_step',
      relation: 'sound call',
    });
  }
  return { entityKind: 'asset', entityId: id, found: true, inbound, outbound: [] };
}

function forDialogue(manifest: ProjectManifest, id: string): EntityReferenceReport {
  const node = manifest.dialogue.find((d) => d.id === id);
  if (!node) return emptyReport('dialogue', id, false);
  const inbound: ReferenceLink[] = [];
  const outbound: ReferenceLink[] = [];
  // Inbound - script steps that call this dialogue via msgbox/message.
  for (const s of manifest.scriptSteps) {
    if (s.kind === 'dialogue' && typeof s.params['text'] === 'string' && s.params['text'] === id) {
      inbound.push({ id: s.id, kind: 'script_step', relation: 'msgbox call' });
    }
  }
  // Inbound - other dialogue choices linking to this.
  for (const d of manifest.dialogue) {
    for (const ch of d.choices) {
      if (ch.nextDialogueId === id) {
        inbound.push({
          id: d.id,
          kind: 'dialogue',
          relation: 'choice links',
          context: `choice: ${ch.label}`,
        });
      }
    }
  }
  // Outbound - this dialogue's choices link to other dialogue.
  for (const ch of node.choices) {
    if (ch.nextDialogueId) {
      outbound.push({
        id: ch.nextDialogueId,
        kind: 'dialogue',
        relation: 'choice target',
        context: `choice: ${ch.label}`,
      });
    }
    for (const fid of ch.setsFlagIds) {
      outbound.push({
        id: fid,
        kind: 'flag',
        relation: 'choice sets',
        context: `choice: ${ch.label}`,
      });
    }
  }
  // Outbound - portrait asset.
  if (node.portraitAssetId) {
    outbound.push({
      id: node.portraitAssetId,
      kind: 'asset',
      relation: 'portrait',
    });
  }
  return { entityKind: 'dialogue', entityId: id, found: true, inbound, outbound };
}

function forObjectEvent(manifest: ProjectManifest, id: string): EntityReferenceReport {
  const obj = manifest.objectEvents.find((o) => o.id === id);
  if (!obj) return emptyReport('object_event', id, false);
  const outbound: ReferenceLink[] = [];
  outbound.push({
    id: obj.mapId,
    kind: 'map',
    relation: 'lives on',
    context: `(${obj.coord.x}, ${obj.coord.y})`,
  });
  if (obj.flagId) outbound.push({ id: obj.flagId, kind: 'flag', relation: 'gated by' });
  if (obj.scriptId) {
    // ScriptId is the label; surface as a script_step pointer to the first step.
    outbound.push({ id: `${obj.scriptId}#0`, kind: 'script_step', relation: 'runs script' });
  }
  if (obj.graphicsId) {
    outbound.push({ id: obj.graphicsId, kind: 'asset', relation: 'graphics' });
  }
  return { entityKind: 'object_event', entityId: id, found: true, inbound: [], outbound };
}

function forTrigger(manifest: ProjectManifest, id: string): EntityReferenceReport {
  const t = manifest.triggers.find((x) => x.id === id);
  if (!t) return emptyReport('trigger', id, false);
  const outbound: ReferenceLink[] = [];
  if (t.mapId) {
    outbound.push({
      id: t.mapId,
      kind: 'map',
      relation: 'fires on',
      context: t.coord ? `(${t.coord.x}, ${t.coord.y})` : 'no coord',
    });
  }
  for (const sid of t.scriptStepIds) {
    outbound.push({
      id: sid,
      kind: 'script_step',
      relation: 'runs step',
    });
  }
  return { entityKind: 'trigger', entityId: id, found: true, inbound: [], outbound };
}

function forWarp(manifest: ProjectManifest, id: string): EntityReferenceReport {
  const w = manifest.warps.find((x) => x.id === id);
  if (!w) return emptyReport('warp', id, false);
  return {
    entityKind: 'warp',
    entityId: id,
    found: true,
    inbound: [],
    outbound: [
      { id: w.fromMapId, kind: 'map', relation: 'from map', context: `(${w.fromCoord.x}, ${w.fromCoord.y})` },
      { id: w.toMapId, kind: 'map', relation: 'to map', context: `(${w.toCoord.x}, ${w.toCoord.y})` },
    ],
  };
}

function forVariable(manifest: ProjectManifest, id: string): EntityReferenceReport {
  const v = manifest.variables.find((x) => x.id === id);
  if (!v) return emptyReport('variable', id, false);
  const inbound: ReferenceLink[] = [];
  for (const s of manifest.scriptSteps) {
    const vKey = s.params['variable'];
    const dKey = s.params['dest'];
    const sKey = s.params['source'];
    const lKey = s.params['left'];
    const rKey = s.params['right'];
    const hit =
      (typeof vKey === 'string' && vKey === id) ||
      (typeof dKey === 'string' && dKey === id) ||
      (typeof sKey === 'string' && sKey === id) ||
      (typeof lKey === 'string' && lKey === id) ||
      (typeof rKey === 'string' && rKey === id);
    if (hit) inbound.push({ id: s.id, kind: 'script_step', relation: s.kind });
  }
  return { entityKind: 'variable', entityId: id, found: true, inbound, outbound: [] };
}

function forEncounterTable(manifest: ProjectManifest, id: string): EntityReferenceReport {
  const e = manifest.encounterTables.find((x) => x.id === id);
  if (!e) return emptyReport('encounter_table', id, false);
  const outbound: ReferenceLink[] = [];
  if (e.mapId) outbound.push({ id: e.mapId, kind: 'map', relation: 'lives on' });
  // Slot species pointers - we don't have species as a manifest entity kind,
  // so we surface them as relation context only (no kind link target).
  return { entityKind: 'encounter_table', entityId: id, found: true, inbound: [], outbound };
}

function forTrainer(manifest: ProjectManifest, id: string): EntityReferenceReport {
  const t = manifest.trainers.find((x) => x.id === id);
  if (!t) return emptyReport('trainer', id, false);
  const outbound: ReferenceLink[] = [];
  if (t.mapId) outbound.push({ id: t.mapId, kind: 'map', relation: 'lives on' });
  return { entityKind: 'trainer', entityId: id, found: true, inbound: [], outbound };
}

function forScriptStep(manifest: ProjectManifest, id: string): EntityReferenceReport {
  const s = manifest.scriptSteps.find((x) => x.id === id);
  if (!s) return emptyReport('script_step', id, false);
  const inbound: ReferenceLink[] = [];
  const outbound: ReferenceLink[] = [];
  // Parent trigger - any trigger whose scriptStepIds contains this id.
  for (const t of manifest.triggers) {
    if (t.scriptStepIds.includes(id)) {
      inbound.push({ id: t.id, kind: 'trigger', relation: 'parent trigger' });
    }
  }
  // Object events whose scriptId matches the label part of this step.
  const hashIdx = id.lastIndexOf('#');
  if (hashIdx > 0) {
    const label = id.slice(0, hashIdx);
    for (const o of manifest.objectEvents) {
      if (o.scriptId === label) {
        inbound.push({ id: o.id, kind: 'object_event', relation: 'object event script' });
      }
    }
  }
  // Outbound - branch target / dialogue called.
  const targetLabel = s.params['label'];
  if (typeof targetLabel === 'string') {
    outbound.push({ id: `${targetLabel}#0`, kind: 'script_step', relation: 'branches to' });
  }
  const text = s.params['text'];
  if (typeof text === 'string') {
    outbound.push({ id: text, kind: 'dialogue', relation: 'shows dialogue' });
  }
  const flag = s.params['flag'];
  if (typeof flag === 'string') {
    outbound.push({ id: flag, kind: 'flag', relation: 'touches flag' });
  }
  const variable = s.params['variable'];
  if (typeof variable === 'string') {
    outbound.push({ id: variable, kind: 'variable', relation: 'touches variable' });
  }
  return { entityKind: 'script_step', entityId: id, found: true, inbound, outbound };
}
