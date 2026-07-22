// Pure intent-expansion layer for the global search engine. Recognizes
// natural-language phrases the writer commonly types ("starter choice",
// "difficulty setting", "hard mode") and folds in additional search tokens
// drawn from the canonical Pokemerald-class vocabulary so the search lands
// at the right entities even when the writer doesn't know the exact engine
// identifiers.
//
// The expander is ADDITIVE - it never drops the user's literal tokens; it
// only adds vocabulary the writer likely meant. Per-intent kind boosts give
// matching entity kinds a score multiplier ≥1 so the relevant rows surface
// at the top of the ranked list.

import type { SearchableEntityKind } from '@rom-editor/shared';
import { tokenize } from './search.js';

export type IntentId =
  | 'starter_choice'
  | 'difficulty_mode'
  | 'intro_cutscene'
  | 'evolution_event'
  | 'warp_destination';

export interface IntentDefinition {
  readonly id: IntentId;
  /** Pattern matched against the original query string (case-insensitive). */
  readonly pattern: RegExp;
  /** Tokens added to the search term set when the pattern matches.
   *  These are folded through `tokenize` so casing / punctuation is normalized. */
  readonly addedTokens: ReadonlyArray<string>;
  /** Per-kind score multipliers applied to entity scores when the intent fires.
   *  Missing kinds default to 1.0 (no boost). */
  readonly kindBoosts: Readonly<Partial<Record<SearchableEntityKind, number>>>;
}

export const INTENT_REGISTRY: ReadonlyArray<IntentDefinition> = [
  {
    id: 'starter_choice',
    pattern: /\b(starter|birch|first\s+pokemon|choose\s+starter|starters)\b/i,
    addedTokens: [
      'birch',
      'starter',
      'starters',
      'treecko',
      'torchic',
      'mudkip',
      'givemon',
      'choose',
      'starterchoice',
    ],
    kindBoosts: { scriptStep: 1.5, dialogue: 1.2 },
  },
  {
    id: 'difficulty_mode',
    pattern: /\b(difficulty|hard\s*mode|nuzlocke|easy\s*mode|randomizer|hardcore)\b/i,
    addedTokens: [
      'difficulty',
      'hard_mode',
      'hard',
      'easy_mode',
      'easy',
      'nuzlocke',
      'randomizer',
      'mode',
    ],
    kindBoosts: { flag: 1.5, variable: 1.4 },
  },
  {
    id: 'intro_cutscene',
    pattern: /\b(intro|opening|cutscene|new\s+game|main\s+story|prologue|first\s+scene)\b/i,
    addedTokens: ['birch', 'intro', 'oak', 'professor', 'prologue', 'cutscene', 'newgame'],
    kindBoosts: { dialogue: 1.4, scriptStep: 1.2, trigger: 1.2 },
  },
  {
    id: 'evolution_event',
    pattern: /\b(evolution|evolve|gift\s+pokemon|received|received_mon|in[-\s]?game\s+trade)\b/i,
    addedTokens: ['received', 'evolution', 'evolve', 'gift', 'trade', 'gives'],
    kindBoosts: { flag: 1.3, scriptStep: 1.2 },
  },
  {
    id: 'warp_destination',
    pattern: /\b(warp|leads?\s+to|scenes?\s+that\s+lead|all\s+ways?\s+to)\b/i,
    addedTokens: ['warp', 'door', 'entrance'],
    kindBoosts: { warp: 1.6, map: 1.2 },
  },
];

export interface ExpandedQuery {
  /** Original tokens from the user's raw query (post-fold). */
  readonly originalTokens: ReadonlyArray<string>;
  /** Extra tokens added by every intent that matched, deduplicated against
   *  originals. */
  readonly addedTokens: ReadonlyArray<string>;
  /** Aggregated per-kind boost - max across firing intents (if two intents
   *  both boost scriptStep, the larger one wins; we don't multiply them). */
  readonly kindBoosts: Readonly<Partial<Record<SearchableEntityKind, number>>>;
  /** Intents that matched the query - surfaced so the UI can show "expanded:
   *  starter_choice" hints to the writer. */
  readonly matchedIntents: ReadonlyArray<IntentId>;
}

export function expandQueryIntent(query: string): ExpandedQuery {
  const originalTokens = tokenize(query);
  const originalSet = new Set(originalTokens);
  const added: string[] = [];
  const addedSet = new Set<string>();
  const matchedIntents: IntentId[] = [];
  const kindBoosts: Partial<Record<SearchableEntityKind, number>> = {};

  if (!query || query.trim().length === 0) {
    return {
      originalTokens,
      addedTokens: [],
      kindBoosts: {},
      matchedIntents: [],
    };
  }

  for (const intent of INTENT_REGISTRY) {
    if (!intent.pattern.test(query)) continue;
    matchedIntents.push(intent.id);
    for (const t of intent.addedTokens) {
      const folded = tokenize(t);
      for (const f of folded) {
        if (!originalSet.has(f) && !addedSet.has(f)) {
          added.push(f);
          addedSet.add(f);
        }
      }
    }
    for (const [kind, boost] of Object.entries(intent.kindBoosts) as Array<[
      SearchableEntityKind,
      number,
    ]>) {
      const existing = kindBoosts[kind] ?? 1.0;
      kindBoosts[kind] = Math.max(existing, boost);
    }
  }

  return {
    originalTokens,
    addedTokens: added,
    kindBoosts,
    matchedIntents,
  };
}
