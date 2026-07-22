import type {
  Asset,
  DialogueNode,
  EncounterTable,
  Flag,
  MapNode,
  ObjectEvent,
  ProjectManifest,
  ScriptStep,
  SearchHit,
  SearchableEntityKind,
  Trainer,
  Trigger,
  Variable,
  Warp,
} from '@rom-editor/shared';
import { expandQueryIntent, type IntentId } from './intent.js';

const TOKEN_RE = /[a-z0-9]+/g;
const MIN_TERM_LEN = 2;

// Strip diacritics so e.g. "Pokémon" → "pokemon" - real Pokemon project text
// uses the accented form but operators search with plain ASCII.
function fold(text: string): string {
  return text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

export function tokenize(text: string): string[] {
  const folded = fold(text);
  const out: string[] = [];
  const matches = folded.match(TOKEN_RE);
  if (!matches) return out;
  for (const m of matches) {
    if (m.length >= MIN_TERM_LEN) out.push(m);
  }
  return out;
}

function joinSearchable(parts: ReadonlyArray<string | null | undefined>): string {
  const filtered: string[] = [];
  for (const p of parts) {
    if (typeof p === 'string' && p.length > 0) filtered.push(p);
  }
  return fold(filtered.join(' '));
}

function makeSnippet(text: string, term: string, maxLen = 120): string | null {
  if (!text) return null;
  const idx = text.indexOf(term);
  if (idx < 0) return null;
  const half = Math.floor(maxLen / 2);
  const start = Math.max(0, idx - half);
  const end = Math.min(text.length, start + maxLen);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  return prefix + text.slice(start, end) + suffix;
}

const KIND_WEIGHTS: Readonly<Record<SearchableEntityKind, number>> = {
  map: 1.5,
  dialogue: 1.3,
  trigger: 1.2,
  objectEvent: 1.2,
  trainer: 1.2,
  flag: 1.1,
  variable: 1.1,
  encounterTable: 1.0,
  warp: 1.0,
  asset: 1.0,
  scriptStep: 0.8,
};

interface EntityForScoring {
  readonly id: string;
  readonly name: string;
  readonly searchable: string;
}

function scoreEntity(
  entity: EntityForScoring,
  kind: SearchableEntityKind,
  terms: ReadonlyArray<string>,
): { score: number; matchedTerms: string[]; snippet: string | null } {
  const matched: string[] = [];
  let idHits = 0;
  let nameHits = 0;
  let textHits = 0;
  const idLower = fold(entity.id);
  const nameLower = fold(entity.name);
  for (const term of terms) {
    let hit = false;
    if (idLower.includes(term)) {
      idHits++;
      hit = true;
    }
    if (nameLower.includes(term)) {
      nameHits++;
      hit = true;
    }
    if (entity.searchable.includes(term)) {
      textHits++;
      hit = true;
    }
    if (hit) matched.push(term);
  }
  if (matched.length === 0) {
    return { score: 0, matchedTerms: [], snippet: null };
  }
  // Per-field weights: id-substring is the strongest signal, name next, body weakest.
  const fieldScore =
    (idHits / terms.length) * 0.5 +
    (nameHits / terms.length) * 0.35 +
    (textHits / terms.length) * 0.15;
  // Boost based on what fraction of terms matched at all.
  const coverage = matched.length / terms.length;
  const raw = fieldScore * 0.7 + coverage * 0.3;
  const score = Math.min(1, raw * KIND_WEIGHTS[kind]);
  const snippet =
    matched.length > 0 ? makeSnippet(entity.searchable, matched[0] ?? '') : null;
  return { score, matchedTerms: matched, snippet };
}

function mapToScoring(m: MapNode): EntityForScoring {
  return {
    id: m.id,
    name: m.name,
    searchable: joinSearchable([
      m.id,
      m.name,
      m.group,
      m.musicId,
      ...Object.entries(m.metadata).map(([k, v]) => `${k}:${String(v)}`),
    ]),
  };
}

function warpToScoring(w: Warp): EntityForScoring {
  return {
    id: w.id,
    name: w.name,
    searchable: joinSearchable([w.id, w.name, w.fromMapId, w.toMapId]),
  };
}

function triggerToScoring(t: Trigger): EntityForScoring {
  return {
    id: t.id,
    name: t.name,
    searchable: joinSearchable([t.id, t.name, t.kind, t.mapId, t.conditionExpression]),
  };
}

function objectEventToScoring(o: ObjectEvent): EntityForScoring {
  return {
    id: o.id,
    name: o.name,
    searchable: joinSearchable([
      o.id,
      o.name,
      o.kind,
      o.mapId,
      o.graphicsId,
      o.movementType,
      o.scriptId,
      o.flagId,
      o.trainerType,
    ]),
  };
}

function flagToScoring(f: Flag): EntityForScoring {
  return {
    id: f.id,
    name: f.name,
    searchable: joinSearchable([f.id, f.name, f.scope, f.description, f.engineValue]),
  };
}

function variableToScoring(v: Variable): EntityForScoring {
  return {
    id: v.id,
    name: v.name,
    searchable: joinSearchable([v.id, v.name, v.scope, v.description, v.engineValue]),
  };
}

function encounterTableToScoring(e: EncounterTable): EntityForScoring {
  return {
    id: e.id,
    name: e.name,
    searchable: joinSearchable([
      e.id,
      e.name,
      e.type,
      e.mapId,
      ...e.slots.map((s) => s.speciesId),
    ]),
  };
}

function trainerToScoring(t: Trainer): EntityForScoring {
  return {
    id: t.id,
    name: t.name,
    searchable: joinSearchable([
      t.id,
      t.name,
      t.className,
      ...t.aiFlags,
      ...t.party.map((p) => p.speciesId),
    ]),
  };
}

function dialogueToScoring(d: DialogueNode): EntityForScoring {
  return {
    id: d.id,
    name: d.name,
    searchable: joinSearchable([d.id, d.name, d.speakerName, d.text]),
  };
}

function assetToScoring(a: Asset): EntityForScoring {
  return {
    id: a.id,
    name: a.name,
    searchable: joinSearchable([a.id, a.name, a.kind, a.relativePath]),
  };
}

function scriptStepToScoring(s: ScriptStep): EntityForScoring {
  // Stringify params verbatim so macro names + args become searchable text.
  const paramText = Object.entries(s.params)
    .map(([k, v]) => `${k}:${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    .join(' ');
  return {
    id: s.id,
    name: s.id,
    searchable: joinSearchable([s.id, s.kind, paramText]),
  };
}

export interface SearchOptions {
  readonly limit?: number;
}

export function searchManifest(
  manifest: ProjectManifest,
  query: string,
  options: SearchOptions = {},
): {
  hits: SearchHit[];
  terms: string[];
  truncated: boolean;
  matchedIntents: ReadonlyArray<IntentId>;
  expandedTokens: ReadonlyArray<string>;
} {
  const limit = Math.max(1, Math.min(500, options.limit ?? 25));
  const expanded = expandQueryIntent(query);
  const originalTerms = expanded.originalTokens;
  if (originalTerms.length === 0 && expanded.addedTokens.length === 0) {
    return {
      hits: [],
      terms: [],
      truncated: false,
      matchedIntents: [],
      expandedTokens: [],
    };
  }
  const allTerms = [...originalTerms, ...expanded.addedTokens];

  // Per-entity score: max of (original-token score, expanded-token score × per-kind intent boost).
  // Original-token score preserves existing behavior unchanged when no intent fires.
  const aggregated = new Map<string, SearchHit>();
  const upsert = (kind: SearchableEntityKind, hit: SearchHit) => {
    const key = `${kind}:${hit.entityId}`;
    const existing = aggregated.get(key);
    if (!existing || hit.score > existing.score) aggregated.set(key, hit);
  };

  const scorePass = <T>(
    items: ReadonlyArray<T>,
    kind: SearchableEntityKind,
    toScoring: (t: T) => EntityForScoring,
    terms: ReadonlyArray<string>,
    boost: number,
  ) => {
    if (terms.length === 0) return;
    for (const item of items) {
      const e = toScoring(item);
      const r = scoreEntity(e, kind, terms);
      if (r.score > 0) {
        const boosted = Math.min(1, r.score * boost);
        upsert(kind, {
          entityKind: kind,
          entityId: e.id,
          entityName: e.name,
          score: boosted,
          snippet: r.snippet,
          matchedTerms: r.matchedTerms,
        });
      }
    }
  };

  const runPass = (terms: ReadonlyArray<string>, boostMap: Readonly<Partial<Record<SearchableEntityKind, number>>>) => {
    const b = (k: SearchableEntityKind) => boostMap[k] ?? 1.0;
    scorePass(manifest.maps, 'map', mapToScoring, terms, b('map'));
    scorePass(manifest.warps, 'warp', warpToScoring, terms, b('warp'));
    scorePass(manifest.triggers, 'trigger', triggerToScoring, terms, b('trigger'));
    scorePass(manifest.objectEvents, 'objectEvent', objectEventToScoring, terms, b('objectEvent'));
    scorePass(manifest.flags, 'flag', flagToScoring, terms, b('flag'));
    scorePass(manifest.variables, 'variable', variableToScoring, terms, b('variable'));
    scorePass(manifest.encounterTables, 'encounterTable', encounterTableToScoring, terms, b('encounterTable'));
    scorePass(manifest.trainers, 'trainer', trainerToScoring, terms, b('trainer'));
    scorePass(manifest.dialogue, 'dialogue', dialogueToScoring, terms, b('dialogue'));
    scorePass(manifest.assets, 'asset', assetToScoring, terms, b('asset'));
    scorePass(manifest.scriptSteps, 'scriptStep', scriptStepToScoring, terms, b('scriptStep'));
  };

  // Pass 1: original tokens, no intent boost - preserves baseline behavior.
  runPass(originalTerms, {});
  // Pass 2: full expanded token set with per-kind boosts ONLY when an intent fires.
  if (expanded.addedTokens.length > 0 || expanded.matchedIntents.length > 0) {
    runPass(allTerms, expanded.kindBoosts);
  }

  const allHits = Array.from(aggregated.values());
  allHits.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.entityKind !== b.entityKind) return a.entityKind.localeCompare(b.entityKind);
    return a.entityId.localeCompare(b.entityId);
  });

  const truncated = allHits.length > limit;
  return {
    hits: allHits.slice(0, limit),
    terms: allTerms,
    truncated,
    matchedIntents: expanded.matchedIntents,
    expandedTokens: [...expanded.addedTokens],
  };
}
