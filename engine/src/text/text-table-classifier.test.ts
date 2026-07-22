import { describe, expect, it } from 'vitest';
import {
  classifyTextTable,
  type TextTableKind,
} from './text-table-classifier.js';

/** Helper: build N strings of approximately targetLen characters that
 *  look like real text (spaces every ~5 chars, ASCII printable). Phase
 *  H-RC5 gibberish detector rejects all-same-letter strings, so
 *  fixtures need realistic shape even when only length matters to
 *  the classifier. */
function makeSamples(targetLen: number, n: number = 8): string[] {
  // 5-char word + 1 space = 6 chars/word. Pad to exact targetLen.
  const word = 'lorem';
  const wordWithSpace = `${word} `;
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    let s = '';
    while (s.length < targetLen) s += wordWithSpace;
    out.push(s.slice(0, targetLen));
  }
  return out;
}

/** Helper: build N strings each containing `keyword` then padded to
 *  `targetLen` total chars. Padding uses spaced words for the Phase
 *  H-RC5 gibberish detector. */
function makeKeywordSamples(keyword: string, targetLen: number, n: number = 8): string[] {
  const wordWithSpace = 'word ';
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    let s = keyword;
    while (s.length < targetLen) s += wordWithSpace;
    out.push(s.slice(0, targetLen));
  }
  return out;
}

describe('classifyTextTable - length-bucket alone', () => {
  it('classifies a 76-entry table with ~40-char strings as ability_descriptions', () => {
    const r = classifyTextTable({
      entryCount: 76,
      sampleStrings: makeSamples(40),
    });
    expect(r.kind).toBe<TextTableKind>('ability_descriptions');
    expect(r.confidence).toBeGreaterThanOrEqual(0.6);
  });

  it('classifies a 177-entry table with ~70-char strings as move_descriptions', () => {
    const r = classifyTextTable({
      entryCount: 177,
      sampleStrings: makeSamples(70),
    });
    expect(r.kind).toBe<TextTableKind>('move_descriptions');
  });

  it('classifies a 376-entry table with ~120-char strings as item_descriptions', () => {
    const r = classifyTextTable({
      entryCount: 376,
      sampleStrings: makeSamples(120),
    });
    expect(r.kind).toBe<TextTableKind>('item_descriptions');
  });

  it('classifies a 411-entry table with ~180-char strings as pokedex_flavor_text', () => {
    const r = classifyTextTable({
      entryCount: 411,
      sampleStrings: makeSamples(180),
    });
    expect(r.kind).toBe<TextTableKind>('pokedex_flavor_text');
  });

  it('returns unknown_text_table when avg length is below the smallest bucket (no keywords)', () => {
    const r = classifyTextTable({
      entryCount: 50,
      sampleStrings: makeSamples(5), // below ability min 15
    });
    expect(r.kind).toBe<TextTableKind>('unknown_text_table');
    // Confidence is either 0.3 (length-bucket fallback) or 0.25
    // (Phase H-RC5 gibberish-rejection fallback for very short
    // strings that lack word boundaries). Both signal "we don't know
    // what this is".
    expect(r.confidence).toBeLessThanOrEqual(0.3);
  });
});

describe('classifyTextTable - keyword confirmation boosts confidence', () => {
  it('length+keyword agreement yields confidence 0.85 for ability descriptions', () => {
    const r = classifyTextTable({
      entryCount: 76,
      sampleStrings: [
        'Powers up Bug-type moves.',
        'Increases the holder\'s attack.',
        'Prevents sleep.',
        'Restores HP.',
        'Boosts Speed.',
        'Powers up moves.',
        'Increases evasion.',
        'Boosts critical hits.',
      ],
    });
    expect(r.kind).toBe<TextTableKind>('ability_descriptions');
    expect(r.confidence).toBe(0.85);
    expect(r.signals.lengthBucketKind).toBe<TextTableKind>('ability_descriptions');
    expect(r.signals.keywordKind).toBe<TextTableKind>('ability_descriptions');
  });

  it('length+keyword agreement yields 0.85 for item descriptions', () => {
    // Item bucket is [60, 180] chars avg. Each line ≥80 chars.
    const r = classifyTextTable({
      entryCount: 376,
      sampleStrings: [
        'A medicine that heals all status conditions and restores HP. Restores 60 HP per use.',
        "An item to be held by a Pokémon. The held Pokémon's Speed is increased substantially.",
        'A device that warms the body of an Ice-type Pokémon during long winter expeditions out.',
        'A held item used by Trainers. It quickly cures confusion when consumed once in battle.',
        'A stone used to evolve certain species of Pokémon when used while leveling up at night.',
        'A medicine that restores HP by 60 points when used in battle or on the overworld map.',
        'An item that turns weak Pokémon stronger by raising base attack stat permanently once.',
        'A device for warding off wild Pokémon while exploring tall grass and dangerous caves.',
      ],
    });
    expect(r.kind).toBe<TextTableKind>('item_descriptions');
    expect(r.confidence).toBe(0.85);
  });

  it('length+keyword agreement yields 0.85 for Pokédex flavor text', () => {
    // Pokédex bucket is [120, 320] chars avg. Each line ≥130 chars.
    const r = classifyTextTable({
      entryCount: 411,
      sampleStrings: [
        'This Pokémon lives in dense forests and feeds on nuts and seeds it gathers throughout the day, storing them carefully in hidden burrows underground.',
        'It is said that this Pokémon has the ability to change its body color to match its surroundings, making it nearly invisible to careless predators around.',
        'Its body radiates a soft glow when threatened, scaring away enemies in the dim caves and ancient forests where it has lived for generations untold.',
        'This species hibernates underground during the cold winter months in temperate climate regions, emerging in spring once the snow has finally fully melted.',
        'It has powerful wings that allow it to fly long distances across mountain ranges and oceans wide, often migrating thousands of kilometers each season.',
        'This Pokémon can sense the emotions of those around it through subtle changes in body temperature, reacting to fear and joy with equal gentle sensitivity.',
        'It feeds on the energy of the moon and is most active during clear nights with bright moonlight, basking under stars on hilltops and tall mountain peaks.',
        'Its body is covered in a thick, protective hide that shields it from harsh desert winds, always allowing it to traverse sand dunes for many days at a time.',
      ],
    });
    expect(r.kind).toBe<TextTableKind>('pokedex_flavor_text');
    expect(r.confidence).toBe(0.85);
  });

  it('keyword-only match (length out of bucket) yields confidence 0.65', () => {
    // Strings have "Powers up" keyword (ability) but length 200 chars
    // (lands in pokedex bucket [120-320], NOT in ability bucket [15-65]).
    const r = classifyTextTable({
      entryCount: 76,
      sampleStrings: makeKeywordSamples('Powers up Bug moves. ', 200),
    });
    // Length picks pokedex; keyword picks ability. Keyword wins per
    // classifier rule (keywords are stronger than length alone).
    expect(r.kind).toBe<TextTableKind>('ability_descriptions');
    expect(r.confidence).toBe(0.65);
  });
});

describe('classifyTextTable - signals exposed', () => {
  it('reports avgStringLength + lengthBucketKind + keywordKind + entryCount', () => {
    const samples = ['Powers up moves.', 'Increases attack.'];
    const r = classifyTextTable({ entryCount: 76, sampleStrings: samples });
    expect(r.signals.avgStringLength).toBeCloseTo(
      samples.reduce((a, b) => a + b.length, 0) / samples.length,
      1,
    );
    expect(r.signals.entryCount).toBe(76);
    expect(typeof r.signals.lengthBucketKind).toBe('string');
  });

  it('result + signals are frozen', () => {
    const r = classifyTextTable({
      entryCount: 76,
      sampleStrings: makeSamples(40),
    });
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r.signals)).toBe(true);
  });
});

describe('classifyTextTable - Phase H-RC5 gibberish rejection', () => {
  it('rejects structured binary data masquerading as text (no spaces)', () => {
    // Real failure mode from the user's heavy-hack verification:
    // strings like ":ç Ë\pç ËÇè ËÓè Ëïè Ëªè..." - alternating Gen-3
    // accented chars with control codes, no English word boundaries.
    const r = classifyTextTable({
      entryCount: 100,
      sampleStrings: [
        ':ç\\pç{CC}è\\pèèèè',
        '{VAR}è\\pèèèè{CC}',
        '\\pè\\pèèèè{CC}è',
        '\\p\\p\\p{CC}{VAR}èèè',
      ],
    });
    expect(r.kind).toBe<TextTableKind>('unknown_text_table');
    expect(r.confidence).toBe(0.25);
  });

  it('rejects strings dominated by non-ASCII chars (printable but not English)', () => {
    // Strings that are mostly accented vowels and decoded control codes
    // - what binary-data-as-text typically looks like after expanded codec.
    const r = classifyTextTable({
      entryCount: 50,
      sampleStrings: [
        'çççèèèîîîôôôûûûñññ ',
        'àààáááâââäääÇÇÇÉÉÉ ',
        'ÔÔÔÕÕÕÖÖÖßßß♂♀',
      ],
    });
    expect(r.kind).toBe<TextTableKind>('unknown_text_table');
  });

  it('accepts dialogue with occasional Gen-3 accented chars (Pokémon name etc.)', () => {
    const r = classifyTextTable({
      entryCount: 100,
      sampleStrings: [
        'Welcome to the world of Pokémon!',
        "I'm researcher Oak. Glad to meet you.",
        'My grandson rushed off without saying goodbye.',
      ],
    });
    expect(r.kind).not.toBe<TextTableKind>('unknown_text_table');
  });

  it('rejects the user-reported garbled binary-as-text pattern (Phase I.1.5)', () => {
    // The 8 entries the user saw in DialogueView after the H session
    // looked like ":ç Ë\pç ËÇè ËÓè..." - sparse spaces, dense accented
    // vowels from the 0x01-0x2A codec range, scattered \p sentinels.
    // Tightened thresholds in I.1.5 now reject these as unknown.
    const r = classifyTextTable({
      entryCount: 16,
      sampleStrings: [
        ':ç Ë\\pç ËÇè ËÓè Ëïè Ëæ',
        'Çä\\pôö Çä\\pôö Çä\\pôö',
        'ñÑ\\pâã\\pü Ñâã üÑâã',
      ],
    });
    expect(r.kind).toBe<TextTableKind>('unknown_text_table');
  });
});

describe('classifyTextTable - universal-hack tolerance', () => {
  it('classifies a 900-entry expanded ability table by length signal alone', () => {
    // Heavy hack (Unbound-class) has ~900 ability entries. Length still
    // ~40 chars per ability description. Should classify as ability
    // even though count is way over vanilla.
    const r = classifyTextTable({
      entryCount: 900,
      sampleStrings: makeSamples(40),
    });
    expect(r.kind).toBe<TextTableKind>('ability_descriptions');
  });

  it('classifies a 500-entry expanded move table by length signal alone', () => {
    const r = classifyTextTable({
      entryCount: 500,
      sampleStrings: makeSamples(70),
    });
    expect(r.kind).toBe<TextTableKind>('move_descriptions');
  });
});
