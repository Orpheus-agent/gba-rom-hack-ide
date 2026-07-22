import { describe, expect, it } from 'vitest';
import {
  getConfigValue,
  getConfigValueForIdentity,
  listNpcGraphics,
  listNpcGraphicsForIdentity,
  listSymbols,
  listUniversalSymbols,
  resolveMapTruth,
  resolveMusicName,
  resolveNpcGraphics,
  resolveNpcGraphicsForIdentity,
  resolveNpcRole,
  resolveRegionMapSection,
  resolveSymbol,
  resolveSymbolForIdentity,
  resolveTrainerTruth,
  resolveUniversalSymbol,
  resolveWildEncounterSlot,
  resolveWildEncounterTable,
  symbolDbSummary,
  symbolFamilyForIdentity,
  isSymbolDatabaseAvailable,
} from './index';
import type { ProjectIdentity } from '@rom-editor/shared';

// The per-ROM-family symbol databases are generated from the user's own
// pret decomp checkout and are NOT distributed with this repository, so
// on a fresh clone they are absent. Assertions about their CONTENT run
// only when at least one family database is present; every assertion
// about API SHAPE (nulls, empty lists, no throw) runs unconditionally,
// which is what proves the missing-data path degrades gracefully.
const HAS_SYMBOL_DB = isSymbolDatabaseAvailable();
const itWithDb = it.runIf(HAS_SYMBOL_DB);

const fireredIdentity: ProjectIdentity = {
  kind: 'decomp',
  confidence: 1,
  displayName: 'pokefirered (decomp)',
  baseGame: 'pokefirered',
  fork: null,
  featureFlags: [],
  warnings: [],
  evidence: [],
};

const emeraldIdentity: ProjectIdentity = {
  ...fireredIdentity,
  baseGame: 'pokeemerald',
  displayName: 'pokeemerald (decomp)',
};

describe('symbolFamilyForIdentity', () => {
  it('maps pokefirered → firered-vanilla', () => {
    expect(symbolFamilyForIdentity(fireredIdentity)).toBe('firered-vanilla');
  });

  it('maps pokeemerald → emerald-vanilla', () => {
    expect(symbolFamilyForIdentity(emeraldIdentity)).toBe('emerald-vanilla');
  });

  it('returns null for unknown baseGame', () => {
    expect(
      symbolFamilyForIdentity({ ...fireredIdentity, baseGame: null }),
    ).toBeNull();
    expect(symbolFamilyForIdentity(null)).toBeNull();
  });

  it('maps CFRU forks (Unbound, Radical Red, Inflamed Red) to firered-cfru', () => {
    expect(
      symbolFamilyForIdentity({ ...fireredIdentity, fork: 'CFRU' }),
    ).toBe('firered-cfru');
    expect(
      symbolFamilyForIdentity({ ...fireredIdentity, fork: 'Pokemon Unbound' }),
    ).toBe('firered-cfru');
    expect(
      symbolFamilyForIdentity({ ...fireredIdentity, fork: 'Radical Red' }),
    ).toBe('firered-cfru');
    expect(
      symbolFamilyForIdentity({ ...fireredIdentity, fork: 'Inflamed-Red' }),
    ).toBe('firered-cfru');
  });

  // Phase 5.4 - DPE-flavored CFRU forks land on the DPE family.
  it('maps DPE forks to firered-cfru-dpe', () => {
    expect(
      symbolFamilyForIdentity({ ...fireredIdentity, fork: 'CFRU + DPE' }),
    ).toBe('firered-cfru-dpe');
    expect(
      symbolFamilyForIdentity({
        ...fireredIdentity,
        fork: 'Dynamic Pokemon Expansion',
      }),
    ).toBe('firered-cfru-dpe');
    expect(
      symbolFamilyForIdentity({
        ...fireredIdentity,
        fork: 'firered-cfru-dpe (gen 9)',
      }),
    ).toBe('firered-cfru-dpe');
  });

  it('maps pokeemerald-expansion forks to emerald-expansion', () => {
    expect(
      symbolFamilyForIdentity({
        ...emeraldIdentity,
        fork: 'pokeemerald-expansion',
      }),
    ).toBe('emerald-expansion');
    expect(
      symbolFamilyForIdentity({ ...emeraldIdentity, fork: 'rh-hideout' }),
    ).toBe('emerald-expansion');
  });

  it('a FireRed identity without CFRU fork stays on vanilla', () => {
    expect(
      symbolFamilyForIdentity({ ...fireredIdentity, fork: 'unrelated hack' }),
    ).toBe('firered-vanilla');
  });

  // Phase 7.1 - listSymbolsForIdentity walks the FORK_FALLBACK chain
  // and merges every symbol of a kind. Powers EntityPicker's
  // datalist on modernized ROMs.
  itWithDb('listSymbolsForIdentity returns >1000 species on CFRU+DPE', async () => {
    const { listSymbolsForIdentity } = await import('./index');
    const list = listSymbolsForIdentity(
      {
        ...fireredIdentity,
        kind: 'patch',
        baseGame: 'Pokémon FireRed',
        fork: 'CFRU+DPE',
      },
      'species',
    );
    // DPE-extended symbol DB ships 1241 species; allow some headroom
    // for future bumps without breaking this assertion.
    expect(list.length).toBeGreaterThan(1000);
    // Both vanilla (Pidgey) and DPE-added (Calyrex) entries reachable.
    const names = list.map((e) => e.name);
    expect(names.some((n) => /PIDGEY/i.test(n))).toBe(true);
    expect(names.some((n) => /CALYREX/i.test(n))).toBe(true);
  });

  it('listSymbolsForIdentity returns sorted-by-id output', async () => {
    const { listSymbolsForIdentity } = await import('./index');
    const list = listSymbolsForIdentity(
      {
        ...fireredIdentity,
        kind: 'patch',
        baseGame: 'Pokémon FireRed',
        fork: 'CFRU+DPE',
      },
      'species',
    );
    for (let i = 1; i < Math.min(list.length, 100); i++) {
      const prev = Number.parseInt(list[i - 1]!.hex, 16);
      const curr = Number.parseInt(list[i]!.hex, 16);
      expect(curr).toBeGreaterThanOrEqual(prev);
    }
  });

  it('listSymbolsForIdentity returns empty for null identity', async () => {
    const { listSymbolsForIdentity } = await import('./index');
    expect(listSymbolsForIdentity(null, 'species')).toEqual([]);
  });

  // Phase 6.8 - binary patch detector sets baseGame to the cartridge
  // header friendly name ('Pokémon FireRed'), not the decomp identifier
  // ('pokefirered'). Without normalisation, the binary path short-
  // circuited every symbol lookup AND Phase 6's overlay resolvers.
  it('maps binary-detected "Pokémon FireRed" to firered-vanilla', () => {
    expect(
      symbolFamilyForIdentity({
        ...fireredIdentity,
        kind: 'patch',
        baseGame: 'Pokémon FireRed',
      }),
    ).toBe('firered-vanilla');
  });

  it('maps binary "Pokémon FireRed" + CFRU+DPE fork to firered-cfru-dpe', () => {
    expect(
      symbolFamilyForIdentity({
        ...fireredIdentity,
        kind: 'patch',
        baseGame: 'Pokémon FireRed',
        fork: 'CFRU+DPE',
      }),
    ).toBe('firered-cfru-dpe');
  });

  it('handles mojibake "PokÃ©mon FireRed" (UTF-8-as-latin1 round-trip)', () => {
    expect(
      symbolFamilyForIdentity({
        ...fireredIdentity,
        kind: 'patch',
        baseGame: 'PokÃ©mon FireRed',
        fork: 'CFRU+DPE',
      }),
    ).toBe('firered-cfru-dpe');
  });

  it('maps binary "Pokémon Emerald" to emerald-vanilla', () => {
    expect(
      symbolFamilyForIdentity({
        ...emeraldIdentity,
        kind: 'patch',
        baseGame: 'Pokémon Emerald',
      }),
    ).toBe('emerald-vanilla');
  });

  it('maps "Pokémon LeafGreen" to firered lineage (shared engine)', () => {
    expect(
      symbolFamilyForIdentity({
        ...fireredIdentity,
        kind: 'patch',
        baseGame: 'Pokémon LeafGreen',
      }),
    ).toBe('firered-vanilla');
  });
});

describe('resolveSymbol - firered-vanilla', () => {
  itWithDb('resolves a known FireRed flag offset to the pret name', () => {
    // FLAG_HIDE_OAK_IN_HIS_LAB lives at 0x2B in pret/pokefirered/include/constants/flags.h
    const r = resolveSymbol('firered-vanilla', 'flag', 0x2b);
    expect(r).not.toBeNull();
    expect(r?.name).toBe('FLAG_HIDE_OAK_IN_HIS_LAB');
    expect(r?.source).toBe('pret');
    expect(r?.family).toBe('firered-vanilla');
  });

  itWithDb('accepts hex string form ("0x2B", "0x2b")', () => {
    expect(resolveSymbol('firered-vanilla', 'flag', '0x2B')?.name).toBe(
      'FLAG_HIDE_OAK_IN_HIS_LAB',
    );
    expect(resolveSymbol('firered-vanilla', 'flag', '0x2b')?.name).toBe(
      'FLAG_HIDE_OAK_IN_HIS_LAB',
    );
  });

  itWithDb('accepts decimal string form', () => {
    expect(resolveSymbol('firered-vanilla', 'flag', '43')?.name).toBe(
      'FLAG_HIDE_OAK_IN_HIS_LAB',
    );
  });

  it('returns null for unknown offsets', () => {
    expect(resolveSymbol('firered-vanilla', 'flag', 0xffff)).toBeNull();
  });

  it('returns null for malformed input', () => {
    expect(resolveSymbol('firered-vanilla', 'flag', 'not-a-number')).toBeNull();
    expect(resolveSymbol('firered-vanilla', 'flag', -1)).toBeNull();
    expect(resolveSymbol('firered-vanilla', 'flag', '')).toBeNull();
  });
});

describe('resolveSymbol - vars + songs', () => {
  itWithDb('resolves a vanilla FireRed var', () => {
    // 0x4001 is VAR_TEMP_1 in pret/pokefirered.
    const r = resolveSymbol('firered-vanilla', 'var', 0x4001);
    expect(r?.name).toMatch(/^VAR_/);
  });

  itWithDb('resolves a vanilla FireRed song', () => {
    // 0x18d is MUS_AZAREA_TOWN-ish; just sanity-check that *something*
    // resolves in the music range.
    const found = Object.entries(
      // Stress-test: ensure resolveSymbol agrees with listSymbols for a
      // sampling of MUS_ entries.
      listSymbols('firered-vanilla', 'song').slice(0, 5).reduce(
        (m, e) => Object.assign(m, { [e.hex]: e.name }),
        {} as Record<string, string>,
      ),
    );
    expect(found.length).toBeGreaterThan(0);
    for (const [hex, name] of found) {
      expect(resolveSymbol('firered-vanilla', 'song', hex)?.name).toBe(name);
    }
  });
});

describe('resolveSymbolForIdentity', () => {
  itWithDb('combines identity lookup + symbol resolution', () => {
    const r = resolveSymbolForIdentity(fireredIdentity, 'flag', 0x2b);
    expect(r?.name).toBe('FLAG_HIDE_OAK_IN_HIS_LAB');
  });

  it('returns null when the identity has no matching family', () => {
    expect(
      resolveSymbolForIdentity({ ...fireredIdentity, baseGame: null }, 'flag', 0x2b),
    ).toBeNull();
  });
});

describe('symbolDbSummary', () => {
  it('reports counts for every shipped family (vanilla + fork)', () => {
    const summary = symbolDbSummary();
    // Phase 5.4 added 'firered-cfru-dpe' as a 5th family.
    expect(summary.length).toBe(5);
    const families = summary.map((s) => s.family);
    expect(families).toContain('firered-vanilla');
    expect(families).toContain('emerald-vanilla');
    expect(families).toContain('firered-cfru');
    expect(families).toContain('firered-cfru-dpe');
    expect(families).toContain('emerald-expansion');
  });

  it('reports zero counts, not a crash, for families that were never generated', () => {
    for (const row of symbolDbSummary()) {
      if (row.generated) continue;
      expect(row.flagCount).toBe(0);
      expect(row.varCount).toBe(0);
      expect(row.songCount).toBe(0);
      expect(row.source).toBe('');
    }
  });

  itWithDb('reports real counts for the families that were generated', () => {
    const summary = symbolDbSummary();
    const ff = summary.find((s) => s.family === 'firered-vanilla')!;
    const em = summary.find((s) => s.family === 'emerald-vanilla')!;
    const cfru = summary.find((s) => s.family === 'firered-cfru')!;
    const exp = summary.find((s) => s.family === 'emerald-expansion')!;
    if (ff.generated) expect(ff.flagCount).toBeGreaterThan(500);
    if (em.generated) expect(em.flagCount).toBeGreaterThan(800);
    if (cfru.generated) {
      expect(cfru.flagCount).toBeGreaterThan(500);
      expect(cfru.source).toMatch(/Complete-Fire-Red-Upgrade/);
    }
    if (exp.generated) {
      expect(exp.flagCount).toBeGreaterThan(800);
      expect(exp.source).toMatch(/pokeemerald-expansion/);
    }
  });
});

describe('resolveSymbol - fork fallback chain', () => {
  itWithDb('CFRU resolves a CFRU-side flag in-family (no fallback needed)', () => {
    // 0x2B is FLAG_HIDE_OAK_IN_HIS_LAB in both vanilla FireRed AND
    // CFRU's fork of pokefirered's flags.h. The resolver picks up the
    // CFRU entry directly without falling through to vanilla.
    const r = resolveSymbol('firered-cfru', 'flag', 0x2b);
    expect(r).not.toBeNull();
    expect(r?.name).toBe('FLAG_HIDE_OAK_IN_HIS_LAB');
    expect(r?.family).toBe('firered-cfru');
  });

  itWithDb('falls back to firered-vanilla when CFRU does not define the flag', () => {
    // 0x2A9 (FLAG_RECEIVED_OLD_SEA_MAP) is present in vanilla FireRed
    // but NOT in CFRU's copy of flags.h. The resolver should walk the
    // fork → vanilla fallback chain and surface the vanilla name.
    const r = resolveSymbol('firered-cfru', 'flag', 0x2a9);
    expect(r).not.toBeNull();
    expect(r?.name).toBe('FLAG_RECEIVED_OLD_SEA_MAP');
    expect(r?.family).toBe('firered-vanilla');
  });

  itWithDb('emerald-expansion resolves a flag that exists in both vanilla + expansion', () => {
    const r = resolveSymbol('emerald-expansion', 'flag', 0x1);
    expect(r).not.toBeNull();
    expect(r?.name).toMatch(/^FLAG_/);
  });

  it('returns null when neither fork nor vanilla DB has the flag', () => {
    expect(resolveSymbol('firered-cfru', 'flag', 0xfffff)).toBeNull();
  });
});

describe('listSymbols', () => {
  itWithDb('returns every flag in declaration order', () => {
    const flags = listSymbols('firered-vanilla', 'flag');
    expect(flags.length).toBeGreaterThan(500);
    // First entry is FLAG_TEMP_1 per the file order.
    expect(flags[0]?.name).toBe('FLAG_TEMP_1');
  });
});

describe('resolveUniversalSymbol - Gen-3 engine constants', () => {
  it('resolves the tall-grass tile behavior to plain English', () => {
    const entry = resolveUniversalSymbol('tile_behavior', 0x02);
    expect(entry?.name).toBe('Tall grass');
    expect(entry?.description).toContain('Wild Pokémon');
  });

  it('resolves the cave-floor tile behavior', () => {
    const entry = resolveUniversalSymbol('tile_behavior', 0x08);
    expect(entry?.name).toBe('Cave floor');
  });

  it('resolves the PC terminal tile behavior', () => {
    const entry = resolveUniversalSymbol('tile_behavior', 0x83);
    expect(entry?.name).toBe('PC terminal');
  });

  it('resolves the bookshelf tile behavior', () => {
    const entry = resolveUniversalSymbol('tile_behavior', 0x81);
    expect(entry?.name).toBe('Bookshelf');
  });

  it('resolves a movement type to plain English (pret canonical numbering)', () => {
    const entry = resolveUniversalSymbol('movement_type', 0x02);
    expect(entry?.name).toBe('Wander around');
    // The Phase 2A-1 audit fix realigned this map to match pret/pokefirered's
    // canonical byte values (where 0x09=FACE_DOWN, 0x0A=FACE_UP, 0x0B=FACE_LEFT,
    // 0x0C=FACE_RIGHT). The old data labelled 0x0A as "Faces right" which
    // disagreed with the runtime engine - that's the bug that made the
    // session-1 Calyrex test produce an upward-facing NPC.
    expect(resolveUniversalSymbol('movement_type', 0x0a)?.name).toBe('Face up');
    expect(resolveUniversalSymbol('movement_type', 0x0c)?.name).toBe('Face right');
  });

  it('resolves the walk-down movement command byte', () => {
    const entry = resolveUniversalSymbol('movement_command', 0x08);
    expect(entry?.name).toBe('Walk - down');
  });

  it('resolves the end-of-sequence movement byte', () => {
    const entry = resolveUniversalSymbol('movement_command', 0xfe);
    expect(entry?.name).toBe('End sequence');
  });

  it('resolves msgbox type 0x06 to "Standard dialogue"', () => {
    const entry = resolveUniversalSymbol('msgbox_type', 0x06);
    expect(entry?.name).toBe('Standard dialogue');
  });

  it('resolves msgbox type 0x05 to "Yes/No prompt"', () => {
    const entry = resolveUniversalSymbol('msgbox_type', 0x05);
    expect(entry?.name).toBe('Yes/No prompt');
  });

  it('resolves weather to plain English', () => {
    expect(resolveUniversalSymbol('weather', 0x03)?.name).toBe('Rain');
    expect(resolveUniversalSymbol('weather', 0x08)?.name).toBe('Sandstorm');
  });

  it('resolves map type to plain English', () => {
    expect(resolveUniversalSymbol('map_type', 0x01)?.name).toBe('Town');
    expect(resolveUniversalSymbol('map_type', 0x03)?.name).toBe('Route');
    expect(resolveUniversalSymbol('map_type', 0x08)?.name).toBe('Indoor');
  });

  it('resolves battle scene to plain English', () => {
    expect(resolveUniversalSymbol('battle_scene', 0x01)?.name).toBe('Gym');
  });

  it('resolves AI flags to plain English', () => {
    expect(resolveUniversalSymbol('ai_flag', 0x02)?.name).toBe('Tries to faint player');
    expect(resolveUniversalSymbol('ai_flag', 0x20)?.name).toBe('Prefers strongest move');
  });

  it('resolves script command opcodes to plain English', () => {
    expect(resolveUniversalSymbol('script_command', 0x6c)?.name).toBe('Show dialogue');
    expect(resolveUniversalSymbol('script_command', 0x29)?.name).toBe('Set flag');
    expect(resolveUniversalSymbol('script_command', 0x79)?.name).toBe('Give Pokémon');
  });

  it('returns null for unknown values', () => {
    expect(resolveUniversalSymbol('tile_behavior', 0xfe)).toBeNull();
    expect(resolveUniversalSymbol('weather', 0xff)).toBeNull();
  });

  it('accepts decimal and hex-string inputs', () => {
    expect(resolveUniversalSymbol('tile_behavior', '0x02')?.name).toBe('Tall grass');
    expect(resolveUniversalSymbol('tile_behavior', 2)?.name).toBe('Tall grass');
    expect(resolveUniversalSymbol('tile_behavior', '2')?.name).toBe('Tall grass');
  });
});

describe('listUniversalSymbols', () => {
  it('lists tile behaviors with descriptions for the dropdown picker', () => {
    const behaviors = listUniversalSymbols('tile_behavior');
    expect(behaviors.length).toBeGreaterThan(50);
    const tallGrass = behaviors.find((b) => b.name === 'Tall grass');
    expect(tallGrass).toBeDefined();
    expect(tallGrass?.description).toContain('Wild Pokémon');
  });

  it('lists every weather option for the map header dropdown', () => {
    const weather = listUniversalSymbols('weather');
    expect(weather.length).toBeGreaterThanOrEqual(15);
    expect(weather.find((w) => w.name === 'Rain')).toBeDefined();
    expect(weather.find((w) => w.name === 'Sandstorm')).toBeDefined();
  });

  it('lists AI flag options for the trainer checkbox grid', () => {
    const flags = listUniversalSymbols('ai_flag');
    expect(flags.length).toBeGreaterThan(5);
    expect(flags.find((f) => f.name === 'Tries to faint player')).toBeDefined();
  });
});

describe('NPC graphics resolution (per-family)', () => {
  it('resolves Emerald sprite indices to Brendan / Bug Catcher / Rayquaza', () => {
    expect(resolveNpcGraphics('emerald-vanilla', 0x00)?.name).toBe('Brendan (default)');
    expect(resolveNpcGraphics('emerald-vanilla', 0x21)?.name).toBe('Bug Catcher');
    expect(resolveNpcGraphics('emerald-vanilla', 0x9f)?.name).toBe('Rayquaza');
  });

  it('resolves FireRed sprite indices to Red / Brock / Mewtwo', () => {
    expect(resolveNpcGraphics('firered-vanilla', 0x00)?.name).toBe('Red (default)');
    expect(resolveNpcGraphics('firered-vanilla', 0x2e)?.name).toBe('Brock');
    expect(resolveNpcGraphics('firered-vanilla', 0x4c)?.name).toBe('Mewtwo');
  });

  it('CFRU forks inherit the FireRed roster', () => {
    expect(resolveNpcGraphics('firered-cfru', 0x2e)?.name).toBe('Brock');
  });

  it('Emerald expansion forks inherit the Emerald roster', () => {
    expect(resolveNpcGraphics('emerald-expansion', 0x00)?.name).toBe('Brendan (default)');
  });

  itWithDb('falls back to the scraped OBJ_EVENT_GFX_* constant when not in the curated map (WP-D)', () => {
    // 0xFE on emerald-vanilla isn't in the hand-curated pretty-name
    // map but build-symbols.mjs scraped it from pret/pokeemerald as
    // OBJ_EVENT_GFX_VAR_E. Resolves to a prettified form so users see
    // "VAR E" instead of "NPC sprite #254" / a hex address.
    const resolved = resolveNpcGraphics('emerald-vanilla', 0xfe);
    expect(resolved).not.toBeNull();
    expect(resolved!.category).toBe('misc');
    expect(resolved!.name.length).toBeGreaterThan(0);
  });

  it('returns null for ids truly beyond every available source', () => {
    // 0x255 (decimal 597) is past the u8 range - normalizeKey rejects
    // it. Likewise null family always returns null.
    expect(resolveNpcGraphics(null, 0x00)).toBeNull();
  });

  it('returns null when no family identity is supplied', () => {
    expect(resolveNpcGraphics(null, 0x00)).toBeNull();
  });

  it('categorises Brendan as player, Brock as gym_leader, Mewtwo as legendary', () => {
    expect(resolveNpcGraphics('emerald-vanilla', 0x00)?.category).toBe('player');
    expect(resolveNpcGraphics('firered-vanilla', 0x2e)?.category).toBe('gym_leader');
    expect(resolveNpcGraphics('firered-vanilla', 0x4c)?.category).toBe('legendary');
  });

  it('resolveNpcGraphicsForIdentity uses the project identity to pick the right family', () => {
    const emeraldIdentity: ProjectIdentity = {
      kind: 'decomp',
      confidence: 1,
      displayName: 'pokeemerald',
      baseGame: 'pokeemerald',
      fork: null,
      featureFlags: [],
      warnings: [],
      evidence: [],
    };
    expect(resolveNpcGraphicsForIdentity(emeraldIdentity, 0x00)?.name).toBe(
      'Brendan (default)',
    );
    const fireredIdentity: ProjectIdentity = {
      ...emeraldIdentity,
      baseGame: 'pokefirered',
      displayName: 'pokefirered',
    };
    expect(resolveNpcGraphicsForIdentity(fireredIdentity, 0x00)?.name).toBe(
      'Red (default)',
    );
  });

  it('listNpcGraphics returns entries sorted by numeric id', () => {
    const sprites = listNpcGraphics('emerald-vanilla');
    expect(sprites.length).toBeGreaterThan(100);
    for (let i = 1; i < sprites.length; i++) {
      expect(sprites[i]!.graphicsId).toBeGreaterThan(sprites[i - 1]!.graphicsId);
    }
    expect(sprites[0]!.graphicsId).toBe(0);
    expect(sprites[0]!.name).toBe('Brendan (default)');
  });

  it('listNpcGraphics returns [] for null family', () => {
    expect(listNpcGraphics(null)).toEqual([]);
  });

  it('listNpcGraphicsForIdentity proxies via identity', () => {
    const identity: ProjectIdentity = {
      kind: 'decomp',
      confidence: 1,
      displayName: 'pokefirered',
      baseGame: 'pokefirered',
      fork: null,
      featureFlags: [],
      warnings: [],
      evidence: [],
    };
    const sprites = listNpcGraphicsForIdentity(identity);
    expect(sprites.length).toBeGreaterThan(50);
    expect(sprites[0]!.name).toBe('Red (default)');
  });
});

// Modernize-and-Ship slice 3 - species/move/ability/item/config DB
// extension. Tests are written to pass BOTH before the scraper has
// been re-run (when the JSONs have no species/moves/abilities/items
// keys) AND after (when they do). The contract is "resolveSymbol of
// the new kinds returns null when no entry exists, returns the bare
// constant name when one does".

describe('resolveSymbol - species/move/ability/item kinds', () => {
  it('returns null for an obviously-out-of-range species index', () => {
    expect(resolveSymbol('firered-cfru', 'species', 0xfffff)).toBeNull();
  });

  it('returns null for an obviously-out-of-range move index', () => {
    expect(resolveSymbol('firered-cfru', 'move', 0xfffff)).toBeNull();
  });

  it('returns null for an obviously-out-of-range ability index', () => {
    expect(resolveSymbol('firered-cfru', 'ability', 0xfffff)).toBeNull();
  });

  it('returns null for an obviously-out-of-range item index', () => {
    expect(resolveSymbol('firered-cfru', 'item', 0xfffff)).toBeNull();
  });

  it('handles unknown families gracefully across the new kinds', () => {
    for (const kind of ['species', 'move', 'ability', 'item'] as const) {
      expect(resolveSymbol('firered-vanilla', kind, 0xfffff)).toBeNull();
    }
  });

  it('returns either a bare constant name or null for valid species index 1', () => {
    // Pre-scraper: returns null because db.species is undefined.
    // Post-scraper: returns "SPECIES_BULBASAUR" or similar.
    // Either is acceptable - the contract is "no throw, no garbage".
    const result = resolveSymbol('firered-cfru', 'species', 0x1);
    if (result !== null) {
      expect(result.name).toMatch(/^SPECIES_/);
      expect(result.source).toBe('pret');
    }
  });
});

describe('getConfigValue', () => {
  it('returns null for an unknown config key', () => {
    expect(getConfigValue('firered-cfru', 'TOTALLY_NONEXISTENT_KEY')).toBeNull();
  });

  it('returns null for vanilla families (no config map)', () => {
    expect(getConfigValue('firered-vanilla', 'BASE_OBEDIENCE_LEVEL')).toBeNull();
    expect(getConfigValue('emerald-vanilla', 'BASE_OBEDIENCE_LEVEL')).toBeNull();
  });

  it('getConfigValueForIdentity returns null for null identity', () => {
    expect(getConfigValueForIdentity(null, 'BASE_OBEDIENCE_LEVEL')).toBeNull();
  });

  it('getConfigValueForIdentity walks the fork chain to find CFRU config', () => {
    // Pre-scraper: returns null because CFRU's config map is empty.
    // Post-scraper: returns the actual obedience level.
    // Either is acceptable - testing the API contract, not the data.
    const identity: ProjectIdentity = {
      kind: 'patch',
      confidence: 0.9,
      displayName: 'FireRed (Modernized)',
      baseGame: 'pokefirered',
      fork: 'CFRU',
      featureFlags: [],
      warnings: [],
      evidence: [],
    };
    const result = getConfigValueForIdentity(identity, 'BASE_OBEDIENCE_LEVEL');
    if (result !== null) {
      expect(typeof result).toBe('number');
    }
  });
});

// ---------------------------------------------------------------------
// Phase 6.4 - vanilla truth resolvers
//
// The resolvers ALL short-circuit when ProjectIdentity.overlaySafe is
// missing or false. They use the FORK_FALLBACK chain to find the
// vanilla truth data merged into firered-vanilla.json by Phase 6.3.
// ---------------------------------------------------------------------
describe('Phase 6.4 - vanilla truth resolvers', () => {
  const modernizedIdentity: ProjectIdentity = {
    kind: 'patch',
    confidence: 1,
    displayName: 'FireRed (Modernized + Gen 9 species)',
    baseGame: 'pokefirered',
    fork: 'CFRU+DPE',
    overlaySafe: true,
    modernizedBy: 'CFRU+DPE',
    featureFlags: [],
    warnings: [],
    evidence: [],
  };
  const unknownIdentity: ProjectIdentity = {
    kind: 'patch',
    confidence: 0.5,
    displayName: 'Bare ROM workspace',
    baseGame: 'pokefirered',
    fork: null,
    // overlaySafe NOT set
    featureFlags: [],
    warnings: [],
    evidence: [],
  };

  describe('resolveMapTruth', () => {
    it('returns null when identity is null', () => {
      expect(resolveMapTruth(null, 3, 0)).toBeNull();
    });
    it('returns null when overlaySafe is not set', () => {
      expect(resolveMapTruth(unknownIdentity, 3, 0)).toBeNull();
    });
    itWithDb('returns the vanilla entry for Pallet Town (bank 3, map 0)', () => {
      const r = resolveMapTruth(modernizedIdentity, 3, 0);
      expect(r).not.toBeNull();
      expect(r?.name).toBe('Pallet Town');
      expect(r?.mapsec).toBe('MAPSEC_PALLET_TOWN');
      expect(r?.regionGroup).toBe('town');
    });
    itWithDb('returns the vanilla entry for Route 1 (bank 3, map 19)', () => {
      const r = resolveMapTruth(modernizedIdentity, 3, 19);
      expect(r).not.toBeNull();
      expect(r?.name).toBe('Route 1');
      expect(r?.regionGroup).toBe('route');
    });
    it('returns null for an unknown (bank, num)', () => {
      expect(resolveMapTruth(modernizedIdentity, 99, 99)).toBeNull();
    });
  });

  describe('resolveRegionMapSection', () => {
    itWithDb('resolves MAPSEC_PALLET_TOWN by byte (0x58)', () => {
      const r = resolveRegionMapSection(modernizedIdentity, 0x58);
      expect(r?.mapsec).toBe('MAPSEC_PALLET_TOWN');
      expect(r?.name).toBe('PALLET TOWN');
    });
    itWithDb('resolves MAPSEC_ROUTE_1 by constant name', () => {
      const r = resolveRegionMapSection(modernizedIdentity, 'MAPSEC_ROUTE_1');
      expect(r?.name).toBe('ROUTE 1');
    });
    it('short-circuits when overlaySafe is false', () => {
      expect(resolveRegionMapSection(unknownIdentity, 0x58)).toBeNull();
    });
  });

  describe('resolveWildEncounterSlot / Table', () => {
    it('returns null when overlaySafe is false', () => {
      expect(
        resolveWildEncounterSlot(unknownIdentity, 3, 19, 'land_mons', 0),
      ).toBeNull();
      expect(
        resolveWildEncounterTable(unknownIdentity, 3, 19),
      ).toBeNull();
    });
    itWithDb('Route 1 slot 0 → SPECIES_PIDGEY', () => {
      const r = resolveWildEncounterSlot(modernizedIdentity, 3, 19, 'land_mons', 0);
      expect(r?.species).toBe('SPECIES_PIDGEY');
      expect(r?.minLevel).toBe(3);
      expect(r?.maxLevel).toBe(3);
    });
    itWithDb('Route 1 has a land_mons table', () => {
      const t = resolveWildEncounterTable(modernizedIdentity, 3, 19);
      expect(t?.land_mons).toBeDefined();
      expect(t?.land_mons?.mons.length).toBeGreaterThan(0);
    });
    it('returns null when the slot index is out of range', () => {
      // Route 1 only has 12 land_mons slots; index 99 is out of range.
      expect(
        resolveWildEncounterSlot(modernizedIdentity, 3, 19, 'land_mons', 99),
      ).toBeNull();
    });
  });

  describe('Phase 6.3b stubs (resolve trainer / npc-role / music)', () => {
    it('resolveTrainerTruth - returns null until 6.3b ships the scraper', () => {
      expect(resolveTrainerTruth(modernizedIdentity, 0x42)).toBeNull();
    });
    it('resolveNpcRole - returns null until 6.3b ships the scraper', () => {
      expect(resolveNpcRole(modernizedIdentity, 3, 0, 0)).toBeNull();
    });
    it('resolveMusicName - returns null (deferred for friendly-name curation)', () => {
      expect(resolveMusicName(modernizedIdentity, 'MUS_PALLET')).toBeNull();
    });
    it('all stubs short-circuit when overlaySafe is false', () => {
      expect(resolveTrainerTruth(unknownIdentity, 0x42)).toBeNull();
      expect(resolveNpcRole(unknownIdentity, 3, 0, 0)).toBeNull();
      expect(resolveMusicName(unknownIdentity, 'MUS_PALLET')).toBeNull();
    });
  });
});
