import { describe, expect, it } from 'vitest';
import type { ProjectManifest } from '@rom-editor/shared';
import {
  aiFlagNames,
  displayName,
  lookupEncounterSlotSpecies,
  lookupMapGroup,
  prettifyConstantName,
  prettifyMapName,
  resolveDisplayName,
  titleCaseGen3Name,
} from './displayName';

/** Minimum manifest scaffolding - only fields displayName touches. */
function makeManifest(over: Partial<ProjectManifest> = {}): ProjectManifest {
  const base: ProjectManifest = {
    schemaVersion: 1,
    generatedAtUtc: '2026-05-17T00:00:00.000Z',
    projectRoot: '/tmp/test',
    identity: {
      kind: 'patch',
      confidence: 0.5,
      displayName: 'Bare ROM',
      baseGame: null,
      fork: null,
      featureFlags: [],
      warnings: [],
      evidence: [],
    },
    buildProfile: null,
    maps: [],
    warps: [],
    triggers: [],
    objectEvents: [],
    dialogue: [],
    flags: [],
    variables: [],
    encounterTables: [],
    trainers: [],
    scriptSteps: [],
    assets: [],
  };
  return { ...base, ...over };
}

describe('resolveDisplayName - sample lookups', () => {
  it('resolves species_N from speciesNames when present', () => {
    const m = makeManifest({
      speciesNames: [
        { id: 'binary_species_0', speciesIndex: 0, name: '', sourceTableOffset: 0 },
        { id: 'binary_species_25', speciesIndex: 25, name: 'PIKACHU', sourceTableOffset: 0 },
      ],
    });
    const r = resolveDisplayName(m, 'species_25');
    expect(r.text).toBe('PIKACHU');
    expect(r.kind).toBe('real');
  });

  it('falls back to "Pokémon #N" when species sample missing the index', () => {
    const m = makeManifest({
      speciesNames: [{ id: 'b_0', speciesIndex: 0, name: '', sourceTableOffset: 0 }],
    });
    const r = resolveDisplayName(m, 'species_99');
    expect(r.text).toBe('Pokémon #99');
    expect(r.kind).toBe('fallback');
  });

  it('resolves move_M via moveNames', () => {
    const m = makeManifest({
      moveNames: [{ id: 'b_45', moveIndex: 45, name: 'VINE WHIP', sourceTableOffset: 0 }],
    });
    expect(resolveDisplayName(m, 'move_45').text).toBe('VINE WHIP');
  });

  it('resolves item_K via items', () => {
    const m = makeManifest({
      items: [{ id: 'b_4', itemIndex: 4, name: 'MASTER BALL', sourceTableOffset: 0 }],
    });
    expect(resolveDisplayName(m, 'item_4').text).toBe('MASTER BALL');
  });

  it('resolves class_N via trainerClassNames', () => {
    const m = makeManifest({
      trainerClassNames: [
        { id: 'b_3', classIndex: 3, name: 'BUG CATCHER', sourceTableOffset: 0 },
      ],
    });
    expect(resolveDisplayName(m, 'class_3').text).toBe('BUG CATCHER');
  });

  it('resolves type_N via typeNames', () => {
    const m = makeManifest({
      typeNames: [{ id: 'b_10', typeIndex: 10, name: 'FIRE', sourceTableOffset: 0 }],
    });
    expect(resolveDisplayName(m, 'type_10').text).toBe('FIRE');
  });
});

describe('resolveDisplayName - overworld sprite', () => {
  it('describes the sprite by dimensions when found', () => {
    const m = makeManifest({
      overworldSprites: [
        {
          id: 'b_5',
          spriteIndex: 5,
          structFileOffset: 0,
          tileTag: 0,
          paletteTag: 0,
          reflectionPaletteTag: 0,
          size: 0,
          width: 16,
          height: 32,
          paletteSlotBits: 0,
          tracks: 0,
          pointerTableEntryOffset: 0,
        },
      ],
    });
    expect(resolveDisplayName(m, 'gfx_5').text).toBe('16×32 sprite #5');
  });

  it('falls back to "NPC sprite #N" when sprite not in roster', () => {
    expect(resolveDisplayName(makeManifest(), 'gfx_99').text).toBe('NPC sprite #99');
  });
});

describe('resolveDisplayName - maps', () => {
  it('passes through real map names', () => {
    const m = makeManifest({
      maps: [
        {
          id: 'binary_map_0_1',
          name: 'Pallet Town',
          group: 'town',
          dimensions: { width: 10, height: 10 },
          tilesetIds: [],
          warpIds: [],
          scriptIds: [],
          objectEventIds: [],
          encounterTableIds: [],
          musicId: null,
          metadata: {},
        },
      ],
    });
    expect(resolveDisplayName(m, 'binary_map_0_1').text).toBe('Pallet Town');
  });

  it('replaces iter-95 synthetic "Map ?.202" with "Unnamed area #202"', () => {
    const m = makeManifest({
      maps: [
        {
          id: 'binary_map_?_202',
          name: 'Map ?.202',
          group: 'town',
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
    });
    expect(resolveDisplayName(m, 'binary_map_?_202').text).toBe('Unnamed area #202');
  });
});

// Phase 6.5 - vanilla-truth overlay tests. The overlay only activates
// when manifest.identity.overlaySafe is true (set by Phase 6.2 from
// the op-log → identity trust signal). On modernized CFRU+DPE ROMs,
// the overlay asserts vanilla names for `binary_map_${bank}_${num}`
// synthetic ids and overrides the byte-derived MapGroup categorisation.
describe('Phase 6.5 - vanilla-truth overlay', () => {
  const overlaySafeManifest = (): ProjectManifest => ({
    schemaVersion: 1,
    generatedAtUtc: '2026-05-27T00:00:00.000Z',
    projectRoot: '/tmp/test',
    identity: {
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
    },
    buildProfile: null,
    maps: [
      {
        id: 'binary_map_3_0',
        name: 'Map 3.0',
        group: 'unknown', // scanner couldn't categorise - overlay should override
        dimensions: { width: 20, height: 20 },
        tilesetIds: [],
        warpIds: [],
        scriptIds: [],
        objectEventIds: [],
        encounterTableIds: [],
        musicId: null,
        metadata: {},
      },
      {
        id: 'binary_map_3_19',
        name: 'Map 3.19',
        group: 'unknown',
        dimensions: { width: 20, height: 30 },
        tilesetIds: [],
        warpIds: [],
        scriptIds: [],
        objectEventIds: [],
        encounterTableIds: [],
        musicId: null,
        metadata: {},
      },
    ],
    warps: [],
    triggers: [],
    objectEvents: [],
    dialogue: [],
    flags: [],
    variables: [],
    encounterTables: [],
    trainers: [],
    scriptSteps: [],
    assets: [],
  });

  it('lookupMap returns "Pallet Town" for binary_map_3_0 on a modernized ROM', () => {
    expect(resolveDisplayName(overlaySafeManifest(), 'binary_map_3_0').text).toBe(
      'Pallet Town',
    );
  });

  it('lookupMap returns "Route 1" for binary_map_3_19 on a modernized ROM', () => {
    expect(resolveDisplayName(overlaySafeManifest(), 'binary_map_3_19').text).toBe(
      'Route 1',
    );
  });

  it('lookupMap falls through to "Unnamed area #N" when overlaySafe is missing', () => {
    const m = overlaySafeManifest();
    const identity = { ...m.identity! };
    delete (identity as { overlaySafe?: boolean }).overlaySafe;
    const m2 = { ...m, identity };
    // Without the overlay, prettifyMapName turns "Map 3.0" into the
    // synthetic "Unnamed area #0" - the screenshot bug pre-overlay.
    expect(resolveDisplayName(m2, 'binary_map_3_0').text).toBe('Unnamed area #0');
  });

  it('lookupMapGroup returns "town" for Pallet Town on a modernized ROM (overlay overrides "unknown")', () => {
    expect(lookupMapGroup(overlaySafeManifest(), 'binary_map_3_0')).toBe('town');
  });

  it('lookupMapGroup returns "route" for Route 1', () => {
    expect(lookupMapGroup(overlaySafeManifest(), 'binary_map_3_19')).toBe('route');
  });

  it('lookupMapGroup falls through to manifest.group when overlaySafe is false', () => {
    const m = overlaySafeManifest();
    const identity = { ...m.identity!, overlaySafe: false };
    const m2 = { ...m, identity };
    expect(lookupMapGroup(m2, 'binary_map_3_0')).toBe('unknown');
  });

  it('lookupEncounterSlotSpecies returns "Pidgey" for Route 1 land slot 0', () => {
    expect(
      lookupEncounterSlotSpecies(
        overlaySafeManifest(),
        'binary_map_3_19',
        'land_mons',
        0,
      ),
    ).toBe('Pidgey');
  });

  it('lookupEncounterSlotSpecies returns null when overlaySafe is false', () => {
    const m = overlaySafeManifest();
    const identity = { ...m.identity!, overlaySafe: false };
    const m2 = { ...m, identity };
    expect(
      lookupEncounterSlotSpecies(m2, 'binary_map_3_19', 'land_mons', 0),
    ).toBeNull();
  });

  it('lookupEncounterSlotSpecies returns null for an out-of-range slot', () => {
    expect(
      lookupEncounterSlotSpecies(
        overlaySafeManifest(),
        'binary_map_3_19',
        'land_mons',
        99,
      ),
    ).toBeNull();
  });
});

describe('prettifyMapName - direct helper', () => {
  it('handles "Map G.N" with numeric group', () => {
    expect(prettifyMapName('Map 3.5', 'binary_map_3_5')).toBe('Unnamed area #5');
  });
  it('handles "Map ?.N"', () => {
    expect(prettifyMapName('Map ?.202', 'binary_map_?_202')).toBe('Unnamed area #202');
  });
  it('preserves already-real names', () => {
    expect(prettifyMapName('Pallet Town', 'binary_map_0_1')).toBe('Pallet Town');
  });
  // Phase F (semantic-world plan §1.3): vanilla MAPSEC names are all-caps.
  it('title-cases all-caps MAPSEC names', () => {
    expect(prettifyMapName('PALLET TOWN', 'binary_map_0_1')).toBe('Pallet Town');
    expect(prettifyMapName('VIRIDIAN FOREST', 'binary_map_3_0')).toBe('Viridian Forest');
    expect(prettifyMapName('ROUTE 1', 'binary_map_3_1')).toBe('Route 1');
  });
  it('preserves floor markers in all-caps names', () => {
    expect(prettifyMapName('POKEMON CENTER 1F', 'x')).toBe('Pokemon Center 1F');
    expect(prettifyMapName('MT. MOON B2F', 'x')).toBe('Mt. Moon B2F');
  });
});

describe('titleCaseGen3Name', () => {
  it('returns mixed-case names unchanged', () => {
    expect(titleCaseGen3Name('Pallet Town')).toBe('Pallet Town');
    expect(titleCaseGen3Name("Player's House")).toBe("Player's House");
  });
  it('title-cases all-caps names', () => {
    expect(titleCaseGen3Name('PALLET TOWN')).toBe('Pallet Town');
    expect(titleCaseGen3Name('ROUTE 22')).toBe('Route 22');
    expect(titleCaseGen3Name('SILPH CO.')).toBe('Silph Co.');
  });
  it('preserves floor markers', () => {
    expect(titleCaseGen3Name('SILPH CO. 7F')).toBe('Silph Co. 7F');
    expect(titleCaseGen3Name('ROCKET HIDEOUT B1F')).toBe('Rocket Hideout B1F');
    expect(titleCaseGen3Name('CERULEAN CAVE B2F')).toBe('Cerulean Cave B2F');
  });
  it('preserves S.S. acronym in ship names', () => {
    expect(titleCaseGen3Name('S.S. ANNE')).toBe('S.S. Anne');
  });
  it('handles empty + single-char + non-letter strings', () => {
    expect(titleCaseGen3Name('')).toBe('');
    expect(titleCaseGen3Name('123')).toBe('123');
  });
});

describe('resolveDisplayName - synthetic-prefix prettifiers', () => {
  const m = makeManifest();
  it('script_0x... → Script @ 0x...', () => {
    expect(resolveDisplayName(m, 'script_0xABCD').text).toBe('Script @ 0xABCD');
  });
  it('flag_0x... → Flag @ 0x...', () => {
    expect(resolveDisplayName(m, 'flag_0x800').text).toBe('Flag @ 0x800');
  });
  it('flag_0x820 → "Boulder Badge obtained" (vanilla FRLG)', () => {
    // Phase O.43 - curated badge flag labeling.
    expect(resolveDisplayName(m, 'flag_0x820').text).toBe('Boulder Badge obtained');
    expect(resolveDisplayName(m, 'flag_0x827').text).toBe('Earth Badge obtained');
    expect(resolveDisplayName(m, 'flag_0x828').text).toBe('Pokédex received');
  });
  it('flag_0x82F-0x836 → gym leader defeat labels (Phase O.44)', () => {
    expect(resolveDisplayName(m, 'flag_0x82f').text).toBe('Defeated Brock (Pewter)');
    expect(resolveDisplayName(m, 'flag_0x830').text).toBe('Defeated Misty (Cerulean)');
    expect(resolveDisplayName(m, 'flag_0x833').text).toBe('Defeated Koga (Fuchsia)');
    expect(resolveDisplayName(m, 'flag_0x836').text).toBe('Defeated Giovanni (Viridian)');
  });
  it('flag_0x83F-0x843 → Elite Four + Champion labels (Phase O.44)', () => {
    expect(resolveDisplayName(m, 'flag_0x83f').text).toBe(
      'Defeated Lorelei (Elite Four)',
    );
    expect(resolveDisplayName(m, 'flag_0x842').text).toBe(
      'Defeated Lance (Elite Four)',
    );
    expect(resolveDisplayName(m, 'flag_0x843').text).toBe('Defeated Champion (rival)');
  });
  it('var_0x4000-0x400F → "Temp variable 0..F" labels (Phase O.45)', () => {
    expect(resolveDisplayName(m, 'var_0x4000').text).toBe('Temp variable 0');
    expect(resolveDisplayName(m, 'var_0x4001').text).toBe('Temp variable 1');
    expect(resolveDisplayName(m, 'var_0x400a').text).toBe('Temp variable A');
    expect(resolveDisplayName(m, 'var_0x400f').text).toBe('Temp variable F');
  });
  it('binary_var_<decimal> resolves to the same temp labels (Phase O.45)', () => {
    // 0x4000 == 16384 decimal.
    expect(resolveDisplayName(m, 'binary_var_16384').text).toBe('Temp variable 0');
    expect(resolveDisplayName(m, 'binary_var_16399').text).toBe('Temp variable F');
    // 0x4020 == 16416 decimal - outside the curated table, generic label.
    expect(resolveDisplayName(m, 'binary_var_16416').text).toBe('Var @ 0x4020');
  });
  it('binary_flag_<decimal> resolves the same way', () => {
    // 0x820 == 2080 decimal.
    expect(resolveDisplayName(m, 'binary_flag_2080').text).toBe(
      'Boulder Badge obtained',
    );
    // 0x99 == 153 decimal - outside the curated table, generic label.
    expect(resolveDisplayName(m, 'binary_flag_153').text).toBe('Flag @ 0x99');
  });
  it('full curated FRLG flag table round-trips via both id formats (Phase O.74)', () => {
    // Phase O.74 - sweep across the entire curated table verifying
    // every value resolves via both `flag_0xN` AND
    // `binary_flag_<decimal>` formats. Prevents a future refactor
    // from accidentally dropping an entry.
    const cases: ReadonlyArray<{ value: number; label: string }> = [
      // Badges (O.43)
      { value: 0x820, label: 'Boulder Badge obtained' },
      { value: 0x821, label: 'Cascade Badge obtained' },
      { value: 0x822, label: 'Thunder Badge obtained' },
      { value: 0x823, label: 'Rainbow Badge obtained' },
      { value: 0x824, label: 'Soul Badge obtained' },
      { value: 0x825, label: 'Marsh Badge obtained' },
      { value: 0x826, label: 'Volcano Badge obtained' },
      { value: 0x827, label: 'Earth Badge obtained' },
      // Early-story milestones (O.43)
      { value: 0x828, label: 'Pokédex received' },
      { value: 0x829, label: 'Pokéballs received from Oak' },
      { value: 0x82a, label: 'Running shoes received' },
      { value: 0x82b, label: "Oak's Parcel received" },
      { value: 0x82d, label: 'Got starter from Oak' },
      { value: 0x82e, label: "Defeated rival in Oak's lab" },
      // Gym leaders (O.44)
      { value: 0x82f, label: 'Defeated Brock (Pewter)' },
      { value: 0x830, label: 'Defeated Misty (Cerulean)' },
      { value: 0x831, label: 'Defeated Lt. Surge (Vermilion)' },
      { value: 0x832, label: 'Defeated Erika (Celadon)' },
      { value: 0x833, label: 'Defeated Koga (Fuchsia)' },
      { value: 0x834, label: 'Defeated Sabrina (Saffron)' },
      { value: 0x835, label: 'Defeated Blaine (Cinnabar)' },
      { value: 0x836, label: 'Defeated Giovanni (Viridian)' },
      // Elite Four + Champion (O.44)
      { value: 0x83f, label: 'Defeated Lorelei (Elite Four)' },
      { value: 0x840, label: 'Defeated Bruno (Elite Four)' },
      { value: 0x841, label: 'Defeated Agatha (Elite Four)' },
      { value: 0x842, label: 'Defeated Lance (Elite Four)' },
      { value: 0x843, label: 'Defeated Champion (rival)' },
    ];
    for (const { value, label } of cases) {
      const hexId = `flag_0x${value.toString(16)}`;
      const decId = `binary_flag_${value}`;
      expect(resolveDisplayName(m, hexId).text, `hex form for ${label}`).toBe(label);
      expect(resolveDisplayName(m, decId).text, `decimal form for ${label}`).toBe(label);
    }
  });
  it('song_N → Song #N', () => {
    expect(resolveDisplayName(m, 'song_42').text).toBe('Song #42');
  });
  it('song_0 → "Silence (MUS_DUMMY)" (Phase O.50)', () => {
    // Phase O.50 - universally-stable song 0 label.
    expect(resolveDisplayName(m, 'song_0').text).toBe('Silence (MUS_DUMMY)');
    expect(resolveDisplayName(m, 'binary_song_0').text).toBe('Silence (MUS_DUMMY)');
  });
  it('tileset_0x... → Tileset @ 0x...', () => {
    expect(resolveDisplayName(m, 'tileset_0x12345').text).toBe('Tileset @ 0x12345');
  });
  it('binary_warp_G_N_W → Warp #W', () => {
    expect(resolveDisplayName(m, 'binary_warp_0_1_2').text).toBe('Warp #2');
  });
  it('binary_obj_G_N_L → Object #L', () => {
    expect(resolveDisplayName(m, 'binary_obj_0_1_5').text).toBe('Object #5');
  });
  it('binary_coord_G_N_I → Step trigger #I', () => {
    expect(resolveDisplayName(m, 'binary_coord_0_1_3').text).toBe('Step trigger #3');
  });
  it('binary_trainer_N → Trainer #N', () => {
    expect(resolveDisplayName(m, 'binary_trainer_57').text).toBe('Trainer #57');
  });
});

describe('resolveDisplayName - edge cases', () => {
  it('null/undefined/empty returns em-dash passthrough', () => {
    expect(resolveDisplayName(makeManifest(), null).text).toBe(' - ');
    expect(resolveDisplayName(makeManifest(), undefined).text).toBe(' - ');
    expect(resolveDisplayName(makeManifest(), '').text).toBe(' - ');
  });

  it('unrecognized id passes through unchanged', () => {
    expect(resolveDisplayName(makeManifest(), 'something_random').text).toBe('something_random');
    expect(resolveDisplayName(makeManifest(), 'something_random').kind).toBe('passthrough');
  });
});

describe('resolveDisplayName - universal Gen-3 engine constants', () => {
  it('resolves tile_behavior_2 to "Tall grass"', () => {
    expect(resolveDisplayName(makeManifest(), 'tile_behavior_2').text).toBe('Tall grass');
  });

  it('resolves mb_8 to "Cave floor" (legacy decomp prefix)', () => {
    expect(resolveDisplayName(makeManifest(), 'mb_8').text).toBe('Cave floor');
  });

  it('resolves weather_3 to "Rain"', () => {
    expect(resolveDisplayName(makeManifest(), 'weather_3').text).toBe('Rain');
  });

  it('resolves map_type_1 to "Town"', () => {
    expect(resolveDisplayName(makeManifest(), 'map_type_1').text).toBe('Town');
  });

  it('resolves battle_scene_1 to "Gym"', () => {
    expect(resolveDisplayName(makeManifest(), 'battle_scene_1').text).toBe('Gym');
  });

  it('resolves msgbox_6 to "Standard dialogue" (replaces the bare hex XSE users memorise)', () => {
    expect(resolveDisplayName(makeManifest(), 'msgbox_6').text).toBe('Standard dialogue');
  });

  it('resolves opcode_108 (decimal for 0x6C) to "Show dialogue"', () => {
    expect(resolveDisplayName(makeManifest(), 'opcode_108').text).toBe('Show dialogue');
  });

  it('resolves move_step_8 (applymovement walk-down byte) to "Walk - down"', () => {
    expect(resolveDisplayName(makeManifest(), 'move_step_8').text).toBe('Walk - down');
  });

  it('resolves move_step_254 (end-sequence) to "End sequence"', () => {
    expect(resolveDisplayName(makeManifest(), 'move_step_254').text).toBe('End sequence');
  });

  it('falls back gracefully for unknown tile behavior IDs', () => {
    const r = resolveDisplayName(makeManifest(), 'tile_behavior_254');
    expect(r.text).toBe('Tile behavior #254');
    expect(r.kind).toBe('fallback');
  });
});

describe('aiFlagNames - bitmask to plain-English list', () => {
  it('returns names for each set bit, skipping unset bits', () => {
    // 0x21 = TRIES_TO_FAINT (0x2) + PREFERS_STRONGEST (0x20) is wrong;
    // 0x21 = 0x20 + 0x01 = PREFERS_STRONGEST + AVOIDS_INEFFECTIVE
    const names = aiFlagNames(0x21);
    expect(names).toHaveLength(2);
    expect(names.map((n) => n.name)).toEqual([
      'Avoids ineffective moves',
      'Prefers strongest move',
    ]);
  });

  it('returns empty array for no flags set', () => {
    expect(aiFlagNames(0)).toEqual([]);
  });

  it('returns a name even for bits not in the registry', () => {
    // 0x1000 is not in our curated registry yet.
    const names = aiFlagNames(0x1000);
    expect(names).toHaveLength(1);
    expect(names[0]!.name).toMatch(/Battle AI behavior/);
  });
});

describe('displayName - internal-id toggle', () => {
  it('default OFF: shows just the resolved name', () => {
    const m = makeManifest({
      speciesNames: [{ id: 'b', speciesIndex: 25, name: 'PIKACHU', sourceTableOffset: 0 }],
    });
    expect(displayName(m, 'species_25', false)).toBe('PIKACHU');
  });
  it('ON: appends the original id in parens', () => {
    const m = makeManifest({
      speciesNames: [{ id: 'b', speciesIndex: 25, name: 'PIKACHU', sourceTableOffset: 0 }],
    });
    expect(displayName(m, 'species_25', true)).toBe('PIKACHU (species_25)');
  });
  it('ON does not append when text equals id (passthrough)', () => {
    expect(displayName(makeManifest(), 'random_string', true)).toBe('random_string');
  });
});

// Modernize-and-Ship slice 3 - symbol-DB-derived constant names need
// prettifying ("SPECIES_PIKACHU" → "Pikachu") before they're surfaced.
describe('prettifyConstantName', () => {
  it('strips the prefix and title-cases each underscore-separated word', () => {
    expect(prettifyConstantName('SPECIES_PIKACHU', 'SPECIES_')).toBe('Pikachu');
    expect(prettifyConstantName('SPECIES_GREAT_TUSK', 'SPECIES_')).toBe('Great Tusk');
    expect(prettifyConstantName('MOVE_HYDRO_PUMP', 'MOVE_')).toBe('Hydro Pump');
    expect(prettifyConstantName('ABILITY_FLASH_FIRE', 'ABILITY_')).toBe('Flash Fire');
    expect(prettifyConstantName('ITEM_MASTER_BALL', 'ITEM_')).toBe('Master Ball');
  });

  it('preserves 2-3 letter all-caps abbreviations', () => {
    expect(prettifyConstantName('ITEM_TM', 'ITEM_')).toBe('TM');
    expect(prettifyConstantName('ITEM_HM01', 'ITEM_')).toBe('HM01');
    expect(prettifyConstantName('MOVE_AI_TEST', 'MOVE_')).toBe('AI Test');
  });

  it('preserves Roman numerals', () => {
    expect(prettifyConstantName('SPECIES_FORM_II', 'SPECIES_')).toBe('Form II');
    expect(prettifyConstantName('MOVE_VARIANT_III', 'MOVE_')).toBe('Variant III');
  });

  it('passes through gracefully when prefix is absent, preserving short tokens', () => {
    // "NOT" is a 3-letter all-caps abbreviation per our preservation rule;
    // "PREFIXED" is 8 chars so it title-cases. Result: "NOT Prefixed".
    expect(prettifyConstantName('NOT_PREFIXED', 'SPECIES_')).toBe('NOT Prefixed');
  });

  it('handles the edge case of only the prefix', () => {
    expect(prettifyConstantName('SPECIES_', 'SPECIES_')).toBe('SPECIES_');
  });

  it('handles single-word names', () => {
    expect(prettifyConstantName('SPECIES_KORAIDON', 'SPECIES_')).toBe('Koraidon');
    expect(prettifyConstantName('MOVE_TACKLE', 'MOVE_')).toBe('Tackle');
  });
});

// Modernize-and-Ship slice 3 - the species/move/ability/item lookups
// fall through to the symbol DB before the synthetic "Pokémon #N" /
// "Move #N" fallback. The fallback only fires when:
//   1. The manifest has no name for that index
//   2. The symbol DB has no entry for that index (or the project's
//      identity doesn't resolve to a known symbol family)
// These tests confirm the behavior when the symbol DB is empty for the
// new kinds (pre-scraper) - the synthetic fallback fires, exactly as
// before. After the scraper repopulates the DB, the symbol-DB hit wins.
describe('resolveDisplayName - symbol DB fallback for species/move/item/ability', () => {
  it('species fallback path returns synthetic name when no manifest entry AND no symbol DB hit', () => {
    const m = makeManifest({
      speciesNames: [],
      identity: {
        kind: 'patch',
        confidence: 0.9,
        // Use baseGame: null so the symbol family resolves to null,
        // ensuring the symbol-DB branch is skipped regardless of which
        // JSONs are loaded. The fallback "Pokémon #N" still fires.
        baseGame: null,
        fork: null,
        displayName: 'Bare ROM',
        featureFlags: [],
        warnings: [],
        evidence: [],
      },
    });
    expect(resolveDisplayName(m, 'species_999').text).toBe('Pokémon #999');
  });

  it('move/item/ability follow the same fallback chain', () => {
    const m = makeManifest({
      identity: {
        kind: 'patch',
        confidence: 0.9,
        baseGame: null,
        fork: null,
        displayName: 'Bare ROM',
        featureFlags: [],
        warnings: [],
        evidence: [],
      },
    });
    expect(resolveDisplayName(m, 'move_999').text).toBe('Move #999');
    expect(resolveDisplayName(m, 'item_999').text).toBe('Item #999');
    expect(resolveDisplayName(m, 'ability_999').text).toBe('Ability #999');
  });
});
