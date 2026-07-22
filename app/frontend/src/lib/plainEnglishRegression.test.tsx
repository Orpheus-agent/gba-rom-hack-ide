import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { ProjectManifest } from '@rom-editor/shared';
import { emptyManifest } from '@rom-editor/shared';
import { AbilitiesView } from '../components/AbilitiesView';
import { ChoicesView } from '../components/ChoicesView';
import { DialogueView } from '../components/DialogueView';
import { FlagsView } from '../components/FlagsView';
import { HealLocationsView } from '../components/HealLocationsView';
import { ItemsView } from '../components/ItemsView';
import { MapsBrowser } from '../components/MapsBrowser';
import { MovesView } from '../components/MovesView';
import { PokedexView } from '../components/PokedexView';
import { SpeciesView } from '../components/SpeciesView';
import { TypesView } from '../components/TypesView';
import { useUiPreferencesStore } from '../state';

/**
 * Phase I.1.6 - regression test against the 5th-time request to scrub
 * raw synthetic ids and JSON-shaped dumps from the rendered UI.
 *
 * Builds a synthetic manifest containing one entity per synthetic-id
 * kind, renders the major top-level views, and asserts that the DOM
 * never exposes those raw ids while the "show internal ids" toggle is
 * off. If any view starts leaking again, this fails the build.
 */
function makeLeakyManifest(): ProjectManifest {
  const base = emptyManifest('/tmp/leak-test', '2026-05-16T00:00:00Z');
  return {
    ...base,
    maps: [
      {
        id: 'binary_map_4_5',
        name: 'Map ?.5',
        group: 'town',
        musicId: 'song_42',
        tilesetIds: ['tileset_0x1a2b3c'],
        warpIds: [],
        scriptIds: [],
        objectEventIds: [],
        encounterTableIds: [],
        dimensions: { width: 20, height: 15 },
        metadata: {},
      },
    ],
    dialogue: [
      {
        id: 'binary_text_dialogue_0x1a8d0_0',
        name: 'binary_text_dialogue_0x1a8d0_0',
        speakerName: 'Anonymous',
        portraitAssetId: null,
        text: 'A line with a \\p paragraph break and a {CC} code.',
        choices: [],
      },
    ],
    flags: [
      {
        id: 'flag_0x800',
        name: 'flag_0x800',
        description: null,
        scope: 'global',
        engineValue: '0x800',
        defaultValue: false,
      },
    ],
    variables: [
      {
        id: 'var_0x5005',
        name: 'var_0x5005',
        description: null,
        scope: 'global',
        engineValue: '0x5005',
        defaultValue: 0,
      },
    ],
    healLocations: [
      {
        id: 'binary_heal_location_0',
        slotIndex: 0,
        group: 4,
        mapNum: 5,
        x: 6,
        y: 9,
        destMapId: 'binary_map_4_5',
        sourceFileOffset: 0x1000,
      },
    ],
    multichoiceLists: [
      {
        id: 'binary_multichoice_0',
        listIndex: 0,
        entryFileOffset: 0x2000,
        count: 2,
        choices: [
          { choiceIndex: 0, text: 'YES', textFileOffset: 0x2100 },
          { choiceIndex: 1, text: 'NO', textFileOffset: 0x2110 },
        ],
      },
    ],
    pokedexEntries: [
      {
        id: 'binary_pokedex_1',
        speciesIndex: 1,
        category: 'Seed',
        flavorText: 'A strange seed was planted on its back at birth.',
        sourceTableOffset: 0x3000,
        speciesName: 'BULBASAUR',
      },
    ],
    species: [
      {
        id: 'species_1',
        speciesIndex: 1,
        baseHP: 45,
        baseAttack: 49,
        baseDefense: 49,
        baseSpeed: 45,
        baseSpAttack: 65,
        baseSpDefense: 65,
        type1: 12,
        type2: 3,
        catchRate: 45,
        expYield: 64,
        item1: 0,
        item2: 0,
        genderRatio: 31,
        eggCycles: 20,
        friendship: 70,
        growthRate: 3,
        eggGroup1: 1,
        eggGroup2: 7,
        ability1: 65,
        ability2: 0,
        safariZoneFleeRate: 0,
        sourceFileOffset: 0x4000,
        name: 'BULBASAUR',
        type1Name: 'GRASS',
        type2Name: 'POISON',
      },
    ],
    battleMoves: [
      {
        id: 'move_1',
        moveIndex: 1,
        effect: 0,
        power: 40,
        type: 0,
        accuracy: 100,
        pp: 35,
        secondaryEffectChance: 0,
        target: 0,
        priority: 0,
        flags: 0x33,
        split: 1,
        sourceTableOffset: 0x5000,
        name: 'POUND',
        typeName: 'NORMAL',
      },
    ],
    items: [
      {
        id: 'item_4',
        itemIndex: 4,
        name: 'POTION',
        sourceTableOffset: 0x6000,
        price: 300,
        pocket: 1,
      },
    ],
    abilities: [
      {
        id: 'ability_65',
        abilityIndex: 65,
        name: 'OVERGROW',
        sourceTableOffset: 0x7000,
      },
    ],
    typeMatchups: [
      {
        id: 'type_matchup_0',
        attackerType: 12,
        defenderType: 11,
        effectiveness: 20,
        sourceTableOffset: 0x8000,
        attackerTypeName: 'GRASS',
        defenderTypeName: 'WATER',
      },
    ],
  };
}

const FORBIDDEN_LEAK_PATTERNS: ReadonlyArray<RegExp> = [
  /\bbinary_(map|text|obj|warp|coord|bg|trainer|cry|palette|lz77)_/,
  /\bspecies_\d+\b/,
  /\bmove_\d+\b/,
  /\bmovement_\d+\b/,
  /\bability_\d+\b/,
  /\bclass_\d+\b/,
  /\btype_\d+\b/,
  /\bitem_\d+\b/,
  /\bgfx_\d+\b/,
  /\bscript_0x[0-9a-f]+/i,
  /\bflag_0x[0-9a-f]+/i,
  /\bvar_0x[0-9a-f]+/i,
  /\btileset_0x[0-9a-f]+/i,
];

function assertNoLeaks(testId: string): void {
  // Collect all text nodes in the document for forbidden patterns.
  const body = document.body.textContent ?? '';
  for (const pat of FORBIDDEN_LEAK_PATTERNS) {
    if (pat.test(body)) {
      const m = pat.exec(body);
      throw new Error(
        `Plain-English leak in <${testId}>: matched "${m?.[0]}" against ${pat}`,
      );
    }
  }
}

describe('Phase I.1 - plain-English regression', () => {
  afterEach(() => {
    cleanup();
    // Ensure the toggle is OFF for all tests (default state).
    useUiPreferencesStore.setState({ showInternalIds: false });
  });

  it('DialogueView never leaks raw dialogue ids when internal-ids toggle is off', () => {
    const manifest = makeLeakyManifest();
    render(<DialogueView manifest={manifest} />);
    assertNoLeaks('DialogueView');
  });

  it('FlagsView never leaks raw flag / var ids when internal-ids toggle is off', () => {
    const manifest = makeLeakyManifest();
    render(<FlagsView manifest={manifest} />);
    assertNoLeaks('FlagsView');
  });

  it('MapsBrowser never leaks raw map ids when internal-ids toggle is off', () => {
    const manifest = makeLeakyManifest();
    render(
      <MapsBrowser
        manifest={manifest}
        selectedId={null}
        onSelect={() => {}}
        highlightedIds={new Set()}
      />,
    );
    assertNoLeaks('MapsBrowser');
  });

  // Phase O.82 - extend coverage to HealLocationsView (added in
  // O.42). The list-row resolver pipes destMapId through
  // displayName, and the detail editor shows the resolved name
  // again. Both surfaces are linted here.
  it('HealLocationsView never leaks raw map ids when internal-ids toggle is off', () => {
    const manifest = makeLeakyManifest();
    render(<HealLocationsView manifest={manifest} />);
    assertNoLeaks('HealLocationsView');
  });

  // Phase O.83 - ChoicesView + PokedexView coverage. The
  // multichoice list rows preview choice text and the pokedex
  // entries show category in muted text after the species name - 
  // both rendering paths must scrub synthetic ids.
  it('ChoicesView never leaks raw multichoice / dialogue ids', () => {
    const manifest = makeLeakyManifest();
    render(<ChoicesView manifest={manifest} />);
    assertNoLeaks('ChoicesView');
  });

  it('PokedexView never leaks raw pokedex / species ids', () => {
    const manifest = makeLeakyManifest();
    render(<PokedexView manifest={manifest} />);
    assertNoLeaks('PokedexView');
  });

  // Phase O.84 - extend coverage to the remaining RPG-data views.
  // Each fixture seeds one entry per view; the components must
  // render names + meta info (typing / power / pocket / etc.)
  // without exposing raw `species_<N>` / `move_<N>` / etc. ids.
  it('SpeciesView never leaks raw species / type / ability ids', () => {
    const manifest = makeLeakyManifest();
    render(<SpeciesView manifest={manifest} />);
    assertNoLeaks('SpeciesView');
  });

  it('MovesView never leaks raw move / type ids', () => {
    const manifest = makeLeakyManifest();
    render(<MovesView manifest={manifest} />);
    assertNoLeaks('MovesView');
  });

  it('ItemsView never leaks raw item ids', () => {
    const manifest = makeLeakyManifest();
    render(<ItemsView manifest={manifest} />);
    assertNoLeaks('ItemsView');
  });

  it('AbilitiesView never leaks raw ability ids', () => {
    const manifest = makeLeakyManifest();
    render(<AbilitiesView manifest={manifest} />);
    assertNoLeaks('AbilitiesView');
  });

  it('TypesView never leaks raw type-matchup ids', () => {
    const manifest = makeLeakyManifest();
    render(<TypesView manifest={manifest} />);
    assertNoLeaks('TypesView');
  });
});
