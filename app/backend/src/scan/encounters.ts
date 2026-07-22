import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type {
  EncounterSlot,
  EncounterTable,
  EncounterTableType,
  EntityId,
} from '@rom-editor/shared';

interface RawSlot {
  readonly min_level?: unknown;
  readonly max_level?: unknown;
  readonly species?: unknown;
}

interface RawTable {
  readonly encounter_rate?: unknown;
  readonly mons?: unknown;
}

interface RawEncounter {
  readonly map?: unknown;
  readonly base_label?: unknown;
  readonly land_mons?: unknown;
  readonly water_mons?: unknown;
  readonly fishing_mons?: unknown;
  readonly rock_smash_mons?: unknown;
}

interface RawField {
  readonly type?: unknown;
  readonly encounter_rates?: unknown;
}

interface RawGroup {
  readonly fields?: unknown;
  readonly encounters?: unknown;
}

interface RawRoot {
  readonly wild_encounter_groups?: unknown;
}

const KEY_TO_TYPE: Record<string, EncounterTableType> = {
  land_mons: 'grass',
  water_mons: 'water',
  fishing_mons: 'fishing',
  rock_smash_mons: 'rock_smash',
};

function asInt(v: unknown, fallback = 0): number {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string') {
    const n = Number.parseInt(v, 10);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function asArray(v: unknown): ReadonlyArray<unknown> {
  return Array.isArray(v) ? v : [];
}

function buildSlots(rawSlots: ReadonlyArray<unknown>, slotWeights: number[]): EncounterSlot[] {
  return rawSlots.flatMap((raw, i) => {
    if (typeof raw !== 'object' || raw === null) return [];
    const o = raw as RawSlot;
    const species = asString(o.species);
    if (!species) return [];
    const weight = slotWeights[i] ?? 1;
    return [
      {
        speciesId: species,
        minLevel: asInt(o.min_level),
        maxLevel: asInt(o.max_level),
        weight,
      },
    ];
  });
}

function buildTable(
  baseLabel: string,
  mapId: EntityId | null,
  type: EncounterTableType,
  rawTable: unknown,
  slotWeights: number[],
): EncounterTable | null {
  if (typeof rawTable !== 'object' || rawTable === null) return null;
  const o = rawTable as RawTable;
  const monsRaw = asArray(o.mons);
  if (monsRaw.length === 0) return null;
  const slots = buildSlots(monsRaw, slotWeights);
  return {
    id: `${baseLabel}_${type}`,
    name: `${baseLabel} (${type})`,
    mapId,
    type,
    encounterRate: asInt(o.encounter_rate),
    slots,
  };
}

function parseFieldsToWeights(rawFields: unknown): Record<EncounterTableType, number[]> {
  const out: Record<EncounterTableType, number[]> = {
    grass: [],
    water: [],
    fishing: [],
    cave: [],
    rock_smash: [],
    custom: [],
  };
  for (const field of asArray(rawFields)) {
    if (typeof field !== 'object' || field === null) continue;
    const f = field as RawField;
    const key = asString(f.type);
    if (!key) continue;
    const t = KEY_TO_TYPE[key];
    if (!t) continue;
    const rates = asArray(f.encounter_rates).map((r) => asInt(r, 1));
    out[t] = rates;
  }
  return out;
}

export interface EncountersResult {
  readonly tables: ReadonlyArray<EncounterTable>;
  readonly tablesByMap: ReadonlyMap<EntityId, ReadonlyArray<EntityId>>;
  readonly warnings: ReadonlyArray<string>;
}

export function extractEncounters(root: unknown): EncountersResult {
  const tables: EncounterTable[] = [];
  const tablesByMap = new Map<EntityId, EntityId[]>();
  const warnings: string[] = [];

  if (typeof root !== 'object' || root === null) {
    warnings.push('wild_encounters.json root is not an object');
    return { tables, tablesByMap, warnings };
  }
  const groups = asArray((root as RawRoot).wild_encounter_groups);
  if (groups.length === 0) {
    warnings.push('wild_encounters.json has no wild_encounter_groups');
    return { tables, tablesByMap, warnings };
  }

  for (const groupRaw of groups) {
    if (typeof groupRaw !== 'object' || groupRaw === null) continue;
    const group = groupRaw as RawGroup;
    const weights = parseFieldsToWeights(group.fields);
    for (const encRaw of asArray(group.encounters)) {
      if (typeof encRaw !== 'object' || encRaw === null) continue;
      const enc = encRaw as RawEncounter;
      const mapId = asString(enc.map);
      const baseLabel = asString(enc.base_label) ?? mapId ?? 'unknown';
      const idsForMap: EntityId[] = [];

      for (const [key, type] of Object.entries(KEY_TO_TYPE) as Array<[
        keyof typeof KEY_TO_TYPE,
        EncounterTableType,
      ]>) {
        const rawTable = (enc as Record<string, unknown>)[key];
        if (rawTable === null || rawTable === undefined) continue;
        const slotWeights = weights[type] ?? [];
        const table = buildTable(baseLabel, mapId, type, rawTable, slotWeights);
        if (!table) continue;
        tables.push(table);
        idsForMap.push(table.id);
      }

      if (mapId && idsForMap.length > 0) {
        tablesByMap.set(mapId, [...(tablesByMap.get(mapId) ?? []), ...idsForMap]);
      }
    }
  }

  tables.sort((a, b) => a.id.localeCompare(b.id));
  return { tables, tablesByMap, warnings };
}

async function tryReadFile(p: string): Promise<string | null> {
  try {
    return await fsp.readFile(p, 'utf8');
  } catch {
    return null;
  }
}

export async function parseEncounters(projectRoot: string): Promise<EncountersResult> {
  const candidates = [
    path.join(projectRoot, 'src', 'data', 'wild_encounters.json'),
    path.join(projectRoot, 'data', 'wild_encounters.json'),
  ];
  let raw: string | null = null;
  let usedPath: string | null = null;
  for (const c of candidates) {
    raw = await tryReadFile(c);
    if (raw) {
      usedPath = c;
      break;
    }
  }
  if (!raw || !usedPath) {
    return {
      tables: [],
      tablesByMap: new Map(),
      warnings: [
        `No wild_encounters.json found at any of: ${candidates.join(', ')} - wild encounter tables will not be indexed for this project.`,
      ],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return {
      tables: [],
      tablesByMap: new Map(),
      warnings: [
        `Could not parse ${usedPath}: ${e instanceof Error ? e.message : String(e)}`,
      ],
    };
  }
  return extractEncounters(parsed);
}
