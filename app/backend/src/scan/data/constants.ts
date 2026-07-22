/**
 * Read symbolic constant lists from the decomp (enums / data tables) to drive
 * dropdowns in the data editors. Generic + reusable across the Game Data engine.
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';

async function read(projectRoot: string, rel: string): Promise<string> {
  try {
    return await fsp.readFile(path.join(projectRoot, rel), 'utf8');
  } catch {
    return '';
  }
}

/** Distinct `PREFIX_*` identifiers in first-seen order, minus count/sentinel junk. */
export function collectConstants(text: string, prefix: string): string[] {
  const re = new RegExp(`\\b${prefix}[A-Z0-9_]+\\b`, 'g');
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of text.matchAll(re)) {
    const id = m[0];
    if (seen.has(id)) continue;
    if (/(?:_COUNT|_MAX|NUMBER_OF|_GEN\d+$|_COUNT_)/.test(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export interface SpeciesEnums {
  readonly types: string[];
  readonly abilities: string[];
  readonly growthRates: string[];
  readonly bodyColors: string[];
  readonly eggGroups: string[];
}

/** Enum option lists the species editor needs. */
export async function readSpeciesEnums(projectRoot: string): Promise<SpeciesEnums> {
  const pkmn = await read(projectRoot, 'include/constants/pokemon.h');
  const abilHeader = await read(projectRoot, 'include/constants/abilities.h');
  const abilData = await read(projectRoot, 'src/data/abilities.h');
  // Abilities: prefer the data table (exact + ordered), fall back to the header.
  const abilFromData = [...abilData.matchAll(/\[(ABILITY_\w+)\]/g)].map((m) => m[1]!);
  const abilities = abilFromData.length > 0 ? dedupe(abilFromData) : collectConstants(abilHeader, 'ABILITY_');
  return {
    types: collectConstants(pkmn, 'TYPE_'),
    abilities,
    growthRates: collectConstants(pkmn, 'GROWTH_'),
    bodyColors: collectConstants(pkmn, 'BODY_COLOR_'),
    eggGroups: collectConstants(pkmn, 'EGG_GROUP_'),
  };
}

function dedupe(xs: string[]): string[] {
  return Array.from(new Set(xs));
}
