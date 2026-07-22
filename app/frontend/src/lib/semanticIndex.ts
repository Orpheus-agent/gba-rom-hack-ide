import type { ProjectManifest } from '@rom-editor/shared';
import { resolveSymbolForIdentity } from './symbols';
import type { EntityKind } from '../state';
import { lookupAnnotation } from './annotations';
import { inferStructures } from './structures';

// Phase X.1 - Semantic index. Builds a flat searchable list of every
// entity in the project across every EntityKind so the command palette
// can do "BULBASAUR" → species_1, "Pewter Gym" → MAP_PEWTER_GYM, etc.
// with a single lookup.
//
// The index is rebuilt lazily on manifest change. Each entry carries:
//   - kind:   EntityKind for useSelection.select dispatch
//   - id:     EntityRef.id for useSelection.select dispatch
//   - name:   primary searchable label (resolved through Q.6 →
//             manifest → Q.1 symbol DB → fallback)
//   - hint:   short metadata string for UI display ("Lv 14 trainer",
//             "0x2B flag", "Grass/Poison")
//   - tags:   additional search tokens (type names, group, kind label)

export interface SemanticIndexEntry {
  readonly kind: EntityKind;
  readonly id: string;
  readonly name: string;
  readonly hint: string;
  readonly tags: ReadonlyArray<string>;
  /** Optional map context for selection.mapContext. */
  readonly mapContext?: string;
}

export interface SemanticIndex {
  readonly entries: ReadonlyArray<SemanticIndexEntry>;
  readonly entryCount: number;
}

const EMPTY_INDEX: SemanticIndex = { entries: [], entryCount: 0 };

export function buildSemanticIndex(manifest: ProjectManifest | null): SemanticIndex {
  if (!manifest) return EMPTY_INDEX;
  const entries: SemanticIndexEntry[] = [];

  const resolveAnnotation = (kind: EntityKind, id: string, fallback: string): string =>
    lookupAnnotation(kind, id) ?? fallback;

  // Species
  for (const s of manifest.species ?? []) {
    const baseName = s.name ?? `Species #${s.speciesIndex}`;
    const typeChip = [s.type1Name, s.type2Name && s.type2Name !== s.type1Name ? s.type2Name : null]
      .filter(Boolean)
      .join('/');
    entries.push({
      kind: 'species',
      id: s.id,
      name: resolveAnnotation('species', s.id, baseName),
      hint: `Dex #${s.speciesIndex}${typeChip ? ` · ${typeChip}` : ''}`,
      tags: ['species', 'pokemon', typeChip, baseName].filter((t): t is string => !!t),
    });
  }

  // Battle moves
  for (const m of manifest.battleMoves ?? []) {
    const baseName = m.name ?? `Move #${m.moveIndex}`;
    entries.push({
      kind: 'move',
      id: m.id,
      name: resolveAnnotation('move', m.id, baseName),
      hint: `Move${m.power > 0 ? ` · ${m.power} pwr` : ''}${m.typeName ? ` · ${m.typeName}` : ''}`,
      tags: ['move', 'attack', m.typeName ?? '', baseName].filter(Boolean) as string[],
    });
  }

  // Abilities
  for (const a of manifest.abilities ?? []) {
    const baseName = a.name && a.name.length > 0 ? a.name : `Ability #${a.abilityIndex}`;
    entries.push({
      kind: 'ability',
      id: a.id,
      name: resolveAnnotation('ability', a.id, baseName),
      hint: `Ability #${a.abilityIndex}`,
      tags: ['ability', baseName],
    });
  }

  // Types
  for (const t of manifest.typeNames ?? []) {
    entries.push({
      kind: 'type',
      id: t.id,
      name: resolveAnnotation('type', t.id, t.name),
      hint: `Type #${t.typeIndex}`,
      tags: ['type', t.name],
    });
  }

  // Items
  for (const it of manifest.items ?? []) {
    const baseName = it.name || `Item #${it.itemIndex}`;
    entries.push({
      kind: 'item',
      id: it.id,
      name: resolveAnnotation('item', it.id, baseName),
      hint: `Item #${it.itemIndex}${it.price != null ? ` · ${it.price}₽` : ''}`,
      tags: ['item', baseName],
    });
  }

  // Trainers
  for (const t of manifest.trainers) {
    const partyPreview = t.party
      .slice(0, 3)
      .map((p) => `${p.speciesId.replace(/^species_/, '#')}.${p.level}`)
      .join(', ');
    entries.push({
      kind: 'trainer',
      id: t.id,
      name: resolveAnnotation('trainer', t.id, t.id),
      hint: `${t.className || 'Trainer'} · ${t.party.length} ${t.party.length === 1 ? 'mon' : 'mons'}${partyPreview ? ` (${partyPreview})` : ''}`,
      tags: ['trainer', t.className, ...t.party.map((p) => p.speciesId)].filter(
        (x): x is string => !!x,
      ),
      mapContext: t.mapId ?? undefined,
    });
  }

  // Maps
  for (const m of manifest.maps) {
    const baseName = m.name || m.id;
    entries.push({
      kind: 'map',
      id: m.id,
      name: resolveAnnotation('map', m.id, baseName),
      hint: `${m.group} · ${m.warpIds.length} warp${m.warpIds.length === 1 ? '' : 's'}`,
      tags: ['map', m.group, baseName],
    });
  }

  // Flags
  for (const f of manifest.flags) {
    const baseName = f.name && f.name !== f.id ? f.name : f.id;
    entries.push({
      kind: 'flag',
      id: f.id,
      name: resolveAnnotation('flag', f.id, baseName),
      hint: `${f.engineValue} flag · ${f.scope}`,
      tags: ['flag', f.scope, baseName, f.engineValue],
    });
  }

  // Variables
  for (const v of manifest.variables) {
    const baseName = v.name && v.name !== v.id ? v.name : v.id;
    entries.push({
      kind: 'variable',
      id: v.id,
      name: resolveAnnotation('variable', v.id, baseName),
      hint: `${v.engineValue} variable · ${v.scope}`,
      tags: ['variable', 'var', v.scope, baseName, v.engineValue],
    });
  }

  // Regions
  for (const r of manifest.regionMapSections ?? []) {
    if (!r.name) continue;
    entries.push({
      kind: 'region',
      id: r.id,
      name: resolveAnnotation('region', r.id, r.name),
      hint: `Region section #${r.sectionIndex}`,
      tags: ['region', r.name],
    });
  }

  // Pokédex entries
  for (const dx of manifest.pokedexEntries ?? []) {
    if (!dx.flavorText) continue;
    const baseName = dx.speciesName ?? `Dex #${dx.speciesIndex}`;
    entries.push({
      kind: 'pokedexEntry',
      id: dx.id,
      name: resolveAnnotation('pokedexEntry', dx.id, `${baseName} (Dex)`),
      hint: dx.category ? `${dx.category} Pokémon entry` : 'Pokédex entry',
      tags: ['pokedex', 'dex', baseName, dx.category ?? ''],
    });
  }

  // Heal locations
  for (const h of manifest.healLocations ?? []) {
    entries.push({
      kind: 'healLocation',
      id: h.id,
      name: resolveAnnotation('healLocation', h.id, `SPAWN_${h.slotIndex}`),
      hint: `Heal slot #${h.slotIndex}${h.destMapId ? ` → ${h.destMapId}` : ''}`,
      tags: ['heal', 'spawn', h.destMapId ?? ''],
      mapContext: h.destMapId ?? undefined,
    });
  }

  // Encounter tables
  for (const et of manifest.encounterTables) {
    entries.push({
      kind: 'encounterTable',
      id: et.id,
      name: resolveAnnotation('encounterTable', et.id, et.id),
      hint: `${et.type} encounters${et.mapId ? ` · ${et.mapId}` : ''} · ${et.slots.length} slots`,
      tags: ['encounter', et.type, et.mapId ?? ''],
      mapContext: et.mapId ?? undefined,
    });
  }

  // Trainer classes
  for (const c of manifest.trainerClassNames ?? []) {
    entries.push({
      kind: 'trainerClass',
      id: c.id,
      name: resolveAnnotation('trainerClass', c.id, c.name),
      hint: `Trainer class #${c.classIndex}`,
      tags: ['class', 'trainer', c.name],
    });
  }

  // Phase S.20 - object-event palettes
  for (const pal of manifest.objectEventPalettes ?? []) {
    entries.push({
      kind: 'palette',
      id: pal.id,
      name: resolveAnnotation(
        'palette',
        pal.id,
        `Palette tag 0x${pal.tag.toString(16).toUpperCase()}`,
      ),
      hint: `OW sprite palette · entry #${pal.entryIndex}`,
      tags: ['palette', 'ow', `tag-${pal.tag.toString(16)}`],
    });
  }

  // Phase R.2 - structures (Silph Co. = one node)
  for (const struct of inferStructures(manifest)) {
    entries.push({
      kind: 'structure',
      id: struct.id,
      name: resolveAnnotation('structure', struct.id, struct.name),
      hint: `${struct.memberIds.length} floors · ${struct.group}`,
      tags: ['structure', struct.group, struct.name],
    });
  }

  // Tilesets
  for (const ts of manifest.tilesets ?? []) {
    entries.push({
      kind: 'tileset',
      id: ts.id,
      name: resolveAnnotation('tileset', ts.id, ts.id),
      hint: `${ts.isSecondary ? 'Secondary' : 'Primary'} tileset · ${ts.isCompressed ? 'LZ77' : 'Raw'}`,
      tags: ['tileset', ts.isSecondary ? 'secondary' : 'primary'],
    });
  }

  // Dialogue nodes - index by id with a snippet of body text for search.
  for (const dlg of manifest.dialogue) {
    const snippet = dlg.text ? dlg.text.slice(0, 60).replace(/\s+/g, ' ') : '';
    entries.push({
      kind: 'dialogue',
      id: dlg.id,
      name: resolveAnnotation('dialogue', dlg.id, dlg.id),
      hint: snippet ? `"${snippet}${dlg.text.length > 60 ? '…' : ''}"` : 'Dialogue',
      tags: ['dialogue', dlg.speakerName ?? '', snippet.toLowerCase()].filter(
        Boolean,
      ) as string[],
    });
  }

  // Songs reachable via map music (so the palette can find them as
  // entries even though they aren't a dedicated manifest table)
  const seenSongs = new Set<number>();
  for (const m of manifest.maps) {
    if (!m.musicId) continue;
    const idx = parseSongIndex(m.musicId);
    if (idx === null || seenSongs.has(idx)) continue;
    seenSongs.add(idx);
    const resolved = resolveSymbolForIdentity(manifest.identity, 'song', idx);
    if (!resolved) continue;
    entries.push({
      kind: 'song',
      id: `song_${idx}`,
      name: resolveAnnotation('song', `song_${idx}`, resolved.name),
      hint: `Music · 0x${idx.toString(16).toUpperCase()}`,
      tags: ['song', 'music', resolved.name],
    });
  }

  return { entries, entryCount: entries.length };
}

function parseSongIndex(id: string): number | null {
  const synthHex = /^song_0x([0-9A-Fa-f]+)$/.exec(id);
  if (synthHex) return parseInt(synthHex[1]!, 16);
  const synthDec = /^song_(\d+)$/.exec(id);
  if (synthDec) return parseInt(synthDec[1]!, 10);
  if (/^0x[0-9A-Fa-f]+$/.test(id)) return parseInt(id, 16);
  if (/^\d+$/.test(id)) return parseInt(id, 10);
  return null;
}

export interface SearchResult {
  readonly entry: SemanticIndexEntry;
  readonly score: number;
}

/** Phase X.2 - Query DSL on top of plain-text search. Supported
 *  prefixes (case-insensitive):
 *    kind:<kind> - restrict to that EntityKind (species, move,
 *                            trainer, flag, etc.). Multiple `kind:`
 *                            tokens are OR'd.
 *    type:<typename> - species/move type filter (matches typeName
 *                            via tags; e.g. type:fire surfaces Fire-type
 *                            Pokémon AND Fire-type moves).
 *
 *  Plain (non-prefixed) tokens still AND-match the entry name + tags.
 *
 *  Examples:
 *    "kind:trainer brock"           → trainers named Brock
 *    "kind:move type:electric"      → all Electric-type moves
 *    "type:fire"                    → any entity tagged Fire (species + moves)
 *    "brock"                        → free-text search across everything
 *
 *  Scoring of the plain part:
 *    100  exact match (case-insensitive)
 *     50  starts with query
 *     30  word boundary match
 *     20  contains anywhere
 *     12  exact tag match
 *      5  partial tag match
 *
 *  When ONLY DSL tokens are present (no plain tokens), every passing
 *  entry gets a constant score of 25 so they rank predictably. */
export function searchSemanticIndex(
  index: SemanticIndex,
  query: string,
  limit: number = 50,
): ReadonlyArray<SearchResult> {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const rawTokens = q.split(/\s+/).filter(Boolean);
  const kindFilters: string[] = [];
  const tagFilters: string[] = [];
  const plainTokens: string[] = [];
  for (const tok of rawTokens) {
    if (tok.startsWith('kind:') && tok.length > 5) {
      kindFilters.push(tok.slice(5));
    } else if (tok.startsWith('type:') && tok.length > 5) {
      tagFilters.push(tok.slice(5));
    } else {
      plainTokens.push(tok);
    }
  }

  const out: SearchResult[] = [];
  for (const entry of index.entries) {
    if (kindFilters.length > 0 && !kindFilters.includes(entry.kind)) continue;

    const tagsLc = entry.tags.map((t) => t.toLowerCase());

    // type:X filter - entry must have at least one tag containing X
    // (allows "type:fire" to match Fire-type species + moves).
    if (tagFilters.length > 0) {
      const allTagFiltersPass = tagFilters.every((tf) =>
        tagsLc.some((t) => t.includes(tf)),
      );
      if (!allTagFiltersPass) continue;
    }

    const nameLc = entry.name.toLowerCase();
    let total = 0;
    let allMatched = true;
    for (const tok of plainTokens) {
      const tokScore = scoreToken(nameLc, tagsLc, tok);
      if (tokScore === 0) {
        allMatched = false;
        break;
      }
      total += tokScore;
    }
    if (!allMatched) continue;

    // If only DSL filters were given (no plain tokens), give a flat
    // score so ordering is by index order. Otherwise use the
    // accumulated scoring.
    if (plainTokens.length === 0) total = 25;

    out.push({ entry, score: total });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
}

function scoreToken(
  nameLc: string,
  tagsLc: ReadonlyArray<string>,
  token: string,
): number {
  if (nameLc === token) return 100;
  if (nameLc.startsWith(token)) return 50;
  // Word boundary: separator or start
  const wordBoundaryRe = new RegExp(`(^|[\\s_\\-/])${escapeRegExp(token)}`);
  if (wordBoundaryRe.test(nameLc)) return 30;
  if (nameLc.includes(token)) return 20;
  for (const tag of tagsLc) {
    if (tag === token) return 12;
    if (tag.includes(token)) return 5;
  }
  return 0;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
