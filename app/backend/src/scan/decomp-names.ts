/**
 * Extract the canonical, human-readable name lists a user may type into a
 * `trainers.party` file - species, moves, held items, abilities - directly
 * from the decomp source. These drive the in-app autocomplete so a user can
 * see (and pick) only names the build will actually accept; a typo like
 * "Scizor" for "Scyther" would otherwise fail the `trainerproc` compile.
 *
 * `trainerproc` normalizes names (uppercases, spaces/punct → '_', strips
 * quotes) before matching the `MOVE_`/`ITEM_`/`ABILITY_`/`SPECIES_` constant,
 * so the display strings harvested here are exactly the valid input forms.
 *
 * Sources (verified against pokefirered-expansion):
 *   - Species   src/data/pokemon/species_info/*.h   .speciesName = _("X")
 *   - Moves     src/data/moves_info.h                .name = COMPOUND_STRING("X")
 *   - Items     src/data/items.h                     .name = ITEM_NAME("X")
 *   - Abilities src/data/abilities.h                 .name = _("X")
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';

export interface DecompNames {
  readonly species: string[];
  readonly moves: string[];
  readonly items: string[];
  readonly abilities: string[];
}

async function tryRead(p: string): Promise<string | null> {
  try {
    return await fsp.readFile(p, 'utf8');
  } catch {
    return null;
  }
}

/** Pull every capture-group-1 match of `re` from `source`. */
function extractAll(source: string, re: RegExp): string[] {
  const g = new RegExp(re.source, 'g');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = g.exec(source)) !== null) {
    if (m[1]) out.push(m[1]);
  }
  return out;
}

/** Drop placeholder/unused entries ("??????????", "-------", "") and dedupe+sort. */
function clean(names: string[]): string[] {
  const real = names.filter((n) => /[A-Za-z0-9]/.test(n));
  return Array.from(new Set(real)).sort((a, b) => a.localeCompare(b));
}

const SPECIES_RE = /\.speciesName = _\("([^"]+)"\)/;
const MOVE_RE = /\.name = COMPOUND_STRING\("([^"]+)"\)/;
const ITEM_RE = /\.name = ITEM_NAME\("([^"]+)"\)/;
const ABILITY_RE = /\.name = _\("([^"]+)"\)/;

/**
 * Read the four canonical name lists from a decomp project. Every source is
 * optional - a missing file yields an empty list for that category (so a
 * non-expansion project degrades to plain text inputs, never an error).
 */
export async function readDecompNames(projectRoot: string): Promise<DecompNames> {
  // Species names are split across gen_1_families.h … gen_9_families.h.
  const speciesDir = path.join(projectRoot, 'src', 'data', 'pokemon', 'species_info');
  const species: string[] = [];
  try {
    for (const f of await fsp.readdir(speciesDir)) {
      if (!f.endsWith('.h')) continue;
      const src = await tryRead(path.join(speciesDir, f));
      if (src) species.push(...extractAll(src, SPECIES_RE));
    }
  } catch {
    /* no species_info dir - leave empty */
  }

  const movesSrc = await tryRead(path.join(projectRoot, 'src', 'data', 'moves_info.h'));
  const itemsSrc = await tryRead(path.join(projectRoot, 'src', 'data', 'items.h'));
  const abilitiesSrc = await tryRead(path.join(projectRoot, 'src', 'data', 'abilities.h'));

  return {
    species: clean(species),
    moves: clean(movesSrc ? extractAll(movesSrc, MOVE_RE) : []),
    items: clean(itemsSrc ? extractAll(itemsSrc, ITEM_RE) : []),
    abilities: clean(abilitiesSrc ? extractAll(abilitiesSrc, ABILITY_RE) : []),
  };
}
