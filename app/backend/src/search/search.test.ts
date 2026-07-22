import { describe, expect, it } from 'vitest';
import type { ProjectManifest } from '@rom-editor/shared';
import { emptyManifest } from '@rom-editor/shared';
import { searchManifest, tokenize } from './search.js';

function makeManifestFixture(): ProjectManifest {
  const base = emptyManifest('/tmp/example', '2026-05-16T00:00:00Z');
  return {
    ...base,
    maps: [
      {
        id: 'MAP_LITTLEROOT_TOWN',
        name: 'LITTLEROOT_TOWN',
        group: 'town',
        dimensions: { width: 0, height: 0 },
        tilesetIds: [],
        warpIds: [],
        scriptIds: [],
        objectEventIds: [],
        encounterTableIds: [],
        musicId: 'MUS_LITTLEROOT_TOWN',
        metadata: { sourceDir: 'data/maps/LittlerootTown' },
      },
      {
        id: 'MAP_ROUTE101',
        name: 'ROUTE101',
        group: 'route',
        dimensions: { width: 0, height: 0 },
        tilesetIds: [],
        warpIds: [],
        scriptIds: [],
        objectEventIds: [],
        encounterTableIds: [],
        musicId: null,
        metadata: {},
      },
    ],
    flags: [
      {
        id: 'FLAG_RECEIVED_STARTER',
        name: 'FLAG_RECEIVED_STARTER',
        scope: 'global',
        defaultValue: false,
        description: 'Set once the player has chosen their starter Pokémon',
        engineValue: '0x807',
      },
      {
        id: 'FLAG_DIFFICULTY_CHOSEN',
        name: 'FLAG_DIFFICULTY_CHOSEN',
        scope: 'global',
        defaultValue: false,
        description: null,
        engineValue: '0x808',
      },
      {
        id: 'FLAG_VISITED_LITTLEROOT',
        name: 'FLAG_VISITED_LITTLEROOT',
        scope: 'global',
        defaultValue: false,
        description: null,
        engineValue: '0x809',
      },
    ],
    dialogue: [
      {
        id: 'LittlerootTown_Mom_Text_WelcomeHome',
        name: 'LittlerootTown_Mom_Text_WelcomeHome',
        speakerName: 'Mom',
        portraitAssetId: null,
        text: 'Hi, honey! Welcome back!',
        choices: [],
      },
      {
        id: 'BirchLab_Text_StarterIntro',
        name: 'BirchLab_Text_StarterIntro',
        speakerName: 'Birch',
        portraitAssetId: null,
        text: 'Pick a starter Pokémon. Which one will it be?',
        choices: [],
      },
    ],
    scriptSteps: [
      {
        id: 'BirchLab_Intro#0',
        kind: 'set_flag',
        params: { macro: 'setflag', args: ['FLAG_RECEIVED_STARTER'], flag: 'FLAG_RECEIVED_STARTER' },
      },
    ],
    trainers: [
      {
        id: 'TRAINER_RIVAL_1',
        name: 'BRENDAN',
        className: 'TRAINER_CLASS_RIVAL',
        party: [
          { speciesId: 'SPECIES_TREECKO', level: 5, moveIds: [], heldItemId: null },
        ],
        aiFlags: [],
        mapId: null,
      },
    ],
  };
}

describe('tokenize', () => {
  it('lowercases and splits on non-alphanumeric', () => {
    expect(tokenize('Starter Selection')).toEqual(['starter', 'selection']);
    expect(tokenize('starter-selection_FOO')).toEqual(['starter', 'selection', 'foo']);
    expect(tokenize('  Whitespace and   gaps  ')).toEqual(['whitespace', 'and', 'gaps']);
  });

  it('drops single-character tokens', () => {
    expect(tokenize('a b cd e fg')).toEqual(['cd', 'fg']);
  });

  it('returns [] for empty / whitespace-only input', () => {
    expect(tokenize('')).toEqual([]);
    expect(tokenize('   ')).toEqual([]);
    expect(tokenize('!!!')).toEqual([]);
  });
});

describe('searchManifest', () => {
  const manifest = makeManifestFixture();

  it('returns hits ranked by score across multiple entity kinds for "starter"', () => {
    const result = searchManifest(manifest, 'starter');
    // "starter" triggers the starter_choice intent which adds extra tokens.
    // The original 'starter' must remain in terms; intent expansion is additive.
    expect(result.terms).toContain('starter');
    expect(result.matchedIntents).toContain('starter_choice');
    expect(result.hits.length).toBeGreaterThanOrEqual(3);
    const kinds = new Set(result.hits.map((h) => h.entityKind));
    expect(kinds.has('flag')).toBe(true);
    expect(kinds.has('dialogue')).toBe(true);
    expect(kinds.has('scriptStep')).toBe(true);
  });

  it('returns the flag with highest score when the query exactly matches the id', () => {
    const result = searchManifest(manifest, 'FLAG_DIFFICULTY_CHOSEN');
    expect(result.hits[0]?.entityId).toBe('FLAG_DIFFICULTY_CHOSEN');
    expect(result.hits[0]?.entityKind).toBe('flag');
    expect(result.hits[0]?.score).toBeGreaterThan(0.5);
  });

  it('matches across entity kinds for the "first-time house event" canonical example', () => {
    // The test fixture has "Welcome back" + "LittlerootTown" maps; a search for
    // "littleroot" should hit the map AND the visited flag AND the dialogue.
    const result = searchManifest(manifest, 'littleroot');
    const ids = result.hits.map((h) => h.entityId);
    expect(ids).toContain('MAP_LITTLEROOT_TOWN');
    expect(ids).toContain('FLAG_VISITED_LITTLEROOT');
    expect(ids).toContain('LittlerootTown_Mom_Text_WelcomeHome');
  });

  it('handles multi-term queries by requiring at least one term to match', () => {
    const result = searchManifest(manifest, 'difficulty choice');
    const ids = result.hits.map((h) => h.entityId);
    // "difficulty" matches FLAG_DIFFICULTY_CHOSEN; "choice" doesn't match anything.
    expect(ids).toContain('FLAG_DIFFICULTY_CHOSEN');
    // The top hit should be FLAG_DIFFICULTY_CHOSEN (matches one term in id).
    expect(result.hits[0]?.entityId).toBe('FLAG_DIFFICULTY_CHOSEN');
  });

  it('boosts map kind so map hits rank above lower-kind hits at equal coverage', () => {
    const result = searchManifest(manifest, 'route');
    expect(result.hits[0]?.entityKind).toBe('map');
    expect(result.hits[0]?.entityId).toBe('MAP_ROUTE101');
  });

  it('returns no hits for a query that matches nothing', () => {
    const result = searchManifest(manifest, 'xyzzy_nonexistent_token');
    expect(result.hits).toHaveLength(0);
  });

  it('returns no hits for an empty/whitespace query', () => {
    expect(searchManifest(manifest, '').hits).toHaveLength(0);
    expect(searchManifest(manifest, '   ').hits).toHaveLength(0);
    expect(searchManifest(manifest, '!!!').hits).toHaveLength(0);
  });

  it('honors limit option and reports truncated when more hits exist', () => {
    const result = searchManifest(manifest, 'flag', { limit: 1 });
    expect(result.hits).toHaveLength(1);
    expect(result.truncated).toBe(true);
  });

  it('attaches a snippet for the first matched term', () => {
    const result = searchManifest(manifest, 'starter');
    const dialogueHit = result.hits.find((h) => h.entityKind === 'dialogue');
    expect(dialogueHit?.snippet).toBeDefined();
    expect(dialogueHit?.snippet?.toLowerCase()).toContain('starter');
  });

  it('reports matchedTerms accurately for each hit', () => {
    const result = searchManifest(manifest, 'starter pokemon');
    const dialogueHit = result.hits.find((h) => h.entityKind === 'dialogue' && h.entityId === 'BirchLab_Text_StarterIntro');
    expect([...(dialogueHit?.matchedTerms ?? [])].sort()).toEqual(['pokemon', 'starter']);
  });

  it('finds trainers by class name or party species', () => {
    const result = searchManifest(manifest, 'treecko');
    expect(result.hits.some((h) => h.entityKind === 'trainer' && h.entityId === 'TRAINER_RIVAL_1')).toBe(true);
  });
});
