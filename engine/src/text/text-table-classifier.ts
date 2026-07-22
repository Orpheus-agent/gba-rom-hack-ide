/**
 * Content-based classifier for Gen-3 text-pointer tables (iter 90 /
 * UW-3-T9).
 *
 * Iter 88 (UW-3-T7) detects ALL text-pointer tables in the ROM as a
 * single structural pass without distinguishing them. This module
 * layers on a content-based classification step: given a table's
 * entry count + sample decoded strings, infer the *probable* kind:
 *
 *   - 'ability_descriptions'  (~76 entries vanilla, ~40 chars avg)
 *   - 'move_descriptions'     (~177 entries vanilla, ~70 chars avg)
 *   - 'item_descriptions'     (~376 entries vanilla, ~120 chars avg)
 *   - 'pokedex_flavor_text'   (~411 entries vanilla, ~180 chars avg)
 *   - 'dialogue'              (variable; long avg length + many entries)
 *   - 'unknown_text_table'    (didn't match any kind confidently)
 *
 * The classifier is a HYBRID of two signal families:
 *
 *  1. **Length-bucket score** - vanilla averages are well-known. Hacks
 *     may shift counts (Unbound has ~900 ability entries, e.g.) but
 *     the AVERAGE STRING LENGTH tends to remain stable per kind: an
 *     ability description is still short, a Pokédex entry is still
 *     long. Length is a more universal signal than count.
 *
 *  2. **Keyword-confirmation score** - certain phrases are strong
 *     indicators (e.g. "Powers up" → ability; "A move that" → move;
 *     "An item to be held" → item; "POKéMON" + species nouns →
 *     Pokédex). Hacks that translate or rewrite the strings will lose
 *     this signal, falling back to length-bucket alone.
 *
 * Per PD 5: heuristic-only - works on any Gen-3 cart's content,
 * regardless of baked offsets. Hacks with custom strings still get
 * a probable kind via length signal alone.
 *
 * Per PD 1 / PD 3: every classification carries a confidence in [0,1].
 *
 * Per PD 16: tables that don't confidently match any kind classify
 * as 'unknown_text_table' (inspectable, not silently dropped).
 */

/** The kinds the classifier can produce. */
export type TextTableKind =
  | 'ability_descriptions'
  | 'move_descriptions'
  | 'item_descriptions'
  | 'pokedex_flavor_text'
  | 'dialogue'
  | 'unknown_text_table';

/** Classifier output: kind + confidence + the signals that produced it. */
export interface TextTableClassification {
  readonly kind: TextTableKind;
  /** Confidence in [0, 1]. 0.0 = pure fallback, 1.0 = strong consensus. */
  readonly confidence: number;
  /** The signals that contributed - for evidence display + debugging. */
  readonly signals: {
    readonly avgStringLength: number;
    readonly lengthBucketKind: TextTableKind;
    readonly keywordKind: TextTableKind | null;
    readonly entryCount: number;
  };
}

interface KindProfile {
  readonly kind: TextTableKind;
  readonly minAvgLen: number;
  readonly maxAvgLen: number;
  readonly keywords: ReadonlyArray<string>;
}

/** Profiles tuned to vanilla Gen-3 averages with non-overlapping length
 *  buckets so the first-match-wins behavior in pickLengthBucket() is
 *  deterministic at boundary values. Tested values:
 *  ability ~25-50 chars / move ~60-80 / item ~100-140 / pokedex ~150-220. */
const KIND_PROFILES: ReadonlyArray<KindProfile> = Object.freeze([
  {
    kind: 'ability_descriptions',
    minAvgLen: 15,
    maxAvgLen: 55,
    keywords: [
      'powers up',
      'increases',
      'boosts',
      'prevents',
      'protects',
      'restores',
      'cures',
      'makes',
      "doesn't",
    ],
  },
  {
    kind: 'move_descriptions',
    minAvgLen: 56,
    maxAvgLen: 79,
    keywords: [
      'a move',
      'an attack',
      'hits ',
      'inflicts ',
      'has a ',
      'enables',
      'critical',
      'damage',
      'flinching',
    ],
  },
  {
    kind: 'item_descriptions',
    minAvgLen: 80,
    maxAvgLen: 139,
    keywords: [
      'a medicine',
      'an item',
      'a device',
      'a held',
      'a stone',
      'a poké ball',
      'machine',
    ],
  },
  {
    kind: 'pokedex_flavor_text',
    minAvgLen: 140,
    maxAvgLen: 320,
    keywords: [
      'pokémon',
      'pokemon',
      'this pokémon',
      'it has',
      'it is said',
      'its body',
      'lives in',
      'feeds on',
      'this species',
    ],
  },
  {
    kind: 'dialogue',
    minAvgLen: 321,
    maxAvgLen: 600,
    keywords: [
      ' said ',
      'you ',
      "i'm ",
      "don't ",
      'thank you',
      'hello',
      'welcome',
    ],
  },
]);

function computeAverageStringLength(sampleStrings: ReadonlyArray<string>): number {
  if (sampleStrings.length === 0) return 0;
  let total = 0;
  for (const s of sampleStrings) total += s.length;
  return total / sampleStrings.length;
}

function pickLengthBucket(avgLen: number): TextTableKind {
  // Pick the first profile whose [minAvgLen, maxAvgLen] contains avgLen.
  // Profiles ordered shortest-first so this gives the most specific match.
  for (const p of KIND_PROFILES) {
    if (avgLen >= p.minAvgLen && avgLen <= p.maxAvgLen) {
      return p.kind;
    }
  }
  return 'unknown_text_table';
}

/**
 * Phase H-RC5 (semantic-world plan §H.5) - gibberish detector.
 *
 * Without this filter, tables of structured binary data (movement
 * sequences, sprite pointers, palette tag tables, etc.) whose bytes
 * happen to land in the Gen-3 codec's printable range get classified
 * as "dialogue" purely on average-length. The user sees Dialogue
 * entries like ":ç Ë\pç ËÇè ËÓè Ëïè..." - structured data, not text.
 *
 * Real dialogue has:
 *   - Lots of spaces (word boundaries)
 *   - Mostly ASCII letters (with some accented Gen-3 chars)
 *   - Few control codes per character
 *
 * Bytecode/binary tables that decode to "printable" chars have:
 *   - Few spaces (no word boundaries)
 *   - High proportion of single accented chars (à á è ç ñ etc.)
 *     because those occupy the low bytes 0x01..0x2A
 *   - Heavy control codes (`\p`, `\l`, `{CC}`, `{VAR}`, `\n`)
 *
 * Returns true when the sample looks like real text. False when it
 * looks like structured binary that happened to decode.
 */
export function looksLikeRealText(sampleStrings: ReadonlyArray<string>): boolean {
  if (sampleStrings.length === 0) return false;
  const joined = sampleStrings.join('\n');
  if (joined.length === 0) return false;

  // Phase I.1.5 - thresholds tightened after H.5 still let 8 garbled
  // tables through on the user's heavy-hack ROM. Tweaks:
  //   - wordDensity floor 1/30 → 1/20 (real dialogue is wordier than this).
  //   - ctrlDensity ceiling 1/15 → 1/25 (binary tables that decode to text
  //     are usually dense with \p / \l between byte values).
  //   - asciiLetterFraction floor 0.4 → 0.55 (the original gibberish samples
  //     decoded to ~30% ASCII; real lines stay well above 0.55).
  //   - new nonAsciiCharFraction ceiling 0.3 - structured byte tables
  //     that decode to accented vowels (0x01-0x2A range) flag here even
  //     when other ratios are borderline.

  // 1. Word-boundary density: real dialogue has ≥1 space per ~20 chars.
  const spaces = (joined.match(/ /g) ?? []).length;
  const wordDensity = spaces / joined.length;
  if (wordDensity < 1 / 20) return false;

  // 2. Control-code density: real dialogue uses \p / \l / {CC} / {VAR}
  //    sparingly. Multi-char placeholders so count occurrences. We
  //    deliberately exclude `\n` from this count - natural newlines
  //    appear inside dialogue lines frequently and would skew the
  //    density when we test on joined samples.
  const controlOccurrences =
    (joined.match(/\\p/g)?.length ?? 0) +
    (joined.match(/\\l/g)?.length ?? 0) +
    (joined.match(/\{CC\}/g)?.length ?? 0) +
    (joined.match(/\{VAR\}/g)?.length ?? 0);
  // Roughly: one control code per ~15 chars is fine for dialogue;
  // beyond that the text is structured-data-printed-as-text.
  const ctrlDensity = controlOccurrences / Math.max(1, joined.length);
  if (ctrlDensity > 1 / 15) return false;

  // 3. ASCII letter dominance: real text is overwhelmingly A-Za-z +
  //    space + common punctuation. Accented Gen-3 chars (ç, è, é, etc.)
  //    are LEGAL in real Pokémon text but rare - typically < 5% of
  //    chars in a dialogue line. We require ≥ 40% PURE ASCII A-Za-z
  //    on top of the general printability check so strings that decode
  //    to mostly-accented chars (a strong signal of structured binary
  //    data hitting the low Gen-3 codec range 0x01..0x2A) get rejected.
  let asciiLetters = 0;
  let printable = 0;
  for (const ch of joined) {
    const c = ch.charCodeAt(0);
    const isAsciiLetter =
      (c >= 0x41 && c <= 0x5a) || // A-Z
      (c >= 0x61 && c <= 0x7a); // a-z
    if (isAsciiLetter) {
      asciiLetters++;
      printable++;
      continue;
    }
    if (
      (c >= 0x30 && c <= 0x39) || // 0-9
      c === 0x20 || // space
      c === 0x2e || c === 0x2c || c === 0x27 || c === 0x21 || c === 0x3f ||
      c === 0x2d || c === 0x3a // common punctuation: . , ' ! ? - :
    ) {
      printable++;
      continue;
    }
    if (
      // Gen-3 accented letters - count as printable but NOT as ASCII letter.
      c === 0xe9 || c === 0xe8 || c === 0xea || c === 0xeb ||
      c === 0xe1 || c === 0xe0 || c === 0xe2 || c === 0xe3 || c === 0xe4 ||
      c === 0xed || c === 0xec || c === 0xee || c === 0xef ||
      c === 0xf3 || c === 0xf2 || c === 0xf4 || c === 0xf6 ||
      c === 0xfa || c === 0xf9 || c === 0xfb || c === 0xfc ||
      c === 0xe7 || c === 0xf1 ||
      c === 0xc9 || c === 0xc8 || c === 0xca || c === 0xcb ||
      c === 0xc1 || c === 0xc0 || c === 0xc2 || c === 0xc4 ||
      c === 0xcd || c === 0xcc || c === 0xce || c === 0xcf ||
      c === 0xd3 || c === 0xd2 || c === 0xd4 || c === 0xd6 ||
      c === 0xda || c === 0xd9 || c === 0xdb || c === 0xdc ||
      c === 0xc7 || c === 0xd1 || c === 0xdf
    ) {
      printable++;
    }
  }
  const printableFraction = printable / joined.length;
  if (printableFraction < 0.5) return false;
  const asciiLetterFraction = asciiLetters / joined.length;
  if (asciiLetterFraction < 0.55) return false;
  // 4. New (Phase I.1.5): reject when accented-letter share is too high.
  //    Structured binary data that lands in the Gen-3 codec's low-byte
  //    accented-vowel range (0x01-0x2A) skews this fraction past 0.3.
  //    Real dialogue rarely has more than 5% accented characters even
  //    in EU FRLG; 30% is a clean separator.
  const accentedCount = printable - asciiLetters;
  const accentedFraction = accentedCount / Math.max(1, joined.length);
  if (accentedFraction > 0.3) return false;

  return true;
}

function pickKeywordKind(sampleStrings: ReadonlyArray<string>): TextTableKind | null {
  const lower = sampleStrings.join(' ').toLowerCase();
  // For each profile, count keyword hits; pick the profile with most hits
  // (and ≥1 hit).
  let bestKind: TextTableKind | null = null;
  let bestHits = 0;
  for (const p of KIND_PROFILES) {
    let hits = 0;
    for (const kw of p.keywords) {
      if (lower.includes(kw)) hits++;
    }
    if (hits > bestHits) {
      bestHits = hits;
      bestKind = p.kind;
    }
  }
  return bestHits >= 1 ? bestKind : null;
}

/**
 * Classify a text-pointer table by content signals.
 *
 *  - If length-bucket AND keyword-confirmation agree → confidence 0.85.
 *  - If only length-bucket matches → confidence 0.6.
 *  - If only keyword-confirmation matches → confidence 0.65 (using
 *    keyword kind since keywords are typically stronger than length).
 *  - If neither matches → 'unknown_text_table' at confidence 0.3.
 */
export function classifyTextTable(args: {
  readonly entryCount: number;
  readonly sampleStrings: ReadonlyArray<string>;
}): TextTableClassification {
  const avgStringLength = computeAverageStringLength(args.sampleStrings);
  const lengthBucketKind = pickLengthBucket(avgStringLength);
  const keywordKind = pickKeywordKind(args.sampleStrings);

  // Phase H-RC5: gate everything that needs the text to be human-
  // readable. If the gibberish detector rejects, force-classify as
  // 'unknown_text_table' so the dialogue lifter (which only ingests
  // 'dialogue' / 'unknown_text_table' per G.7) sees this in the
  // catch-all bucket - and the planned future "Text references" view
  // can decide what to do with it. Confidence stays low so downstream
  // consumers know we couldn't make sense of it.
  const isRealText = looksLikeRealText(args.sampleStrings);
  if (!isRealText) {
    return Object.freeze({
      kind: 'unknown_text_table',
      confidence: 0.25,
      signals: Object.freeze({
        avgStringLength,
        lengthBucketKind,
        keywordKind,
        entryCount: args.entryCount,
      }),
    });
  }

  let kind: TextTableKind;
  let confidence: number;
  if (
    lengthBucketKind !== 'unknown_text_table' &&
    keywordKind !== null &&
    lengthBucketKind === keywordKind
  ) {
    kind = lengthBucketKind;
    confidence = 0.85;
  } else if (keywordKind !== null) {
    kind = keywordKind;
    confidence = 0.65;
  } else if (lengthBucketKind !== 'unknown_text_table') {
    kind = lengthBucketKind;
    confidence = 0.6;
  } else {
    kind = 'unknown_text_table';
    confidence = 0.3;
  }

  return Object.freeze({
    kind,
    confidence,
    signals: Object.freeze({
      avgStringLength,
      lengthBucketKind,
      keywordKind,
      entryCount: args.entryCount,
    }),
  });
}
