import { describe, expect, it } from 'vitest';
import { expandQueryIntent } from './intent.js';

describe('expandQueryIntent', () => {
  it('returns empty expansion when the query is empty / whitespace', () => {
    expect(expandQueryIntent('').matchedIntents).toEqual([]);
    expect(expandQueryIntent('   ').matchedIntents).toEqual([]);
    expect(expandQueryIntent('').addedTokens).toEqual([]);
  });

  it('passes through queries that match no intent', () => {
    const r = expandQueryIntent('littleroot town fountain');
    expect(r.originalTokens.length).toBeGreaterThan(0);
    expect(r.matchedIntents).toEqual([]);
    expect(r.addedTokens).toEqual([]);
    expect(r.kindBoosts).toEqual({});
  });

  it('fires starter_choice for "starter" and adds canonical decomp tokens', () => {
    const r = expandQueryIntent('starter');
    expect(r.matchedIntents).toContain('starter_choice');
    expect(r.addedTokens).toEqual(expect.arrayContaining(['birch', 'treecko', 'torchic', 'mudkip', 'givemon']));
    expect(r.kindBoosts.scriptStep).toBeGreaterThan(1.0);
    // Original 'starter' must NOT appear in addedTokens (no duplicates with originals).
    expect(r.addedTokens).not.toContain('starter');
  });

  it('fires difficulty_mode for "hard mode" / "nuzlocke" with kind boost on flag', () => {
    const r = expandQueryIntent('nuzlocke run');
    expect(r.matchedIntents).toContain('difficulty_mode');
    // Tokenizer splits on non-alphanumerics, so "hard_mode" becomes "hard" + "mode".
    expect(r.addedTokens).toEqual(expect.arrayContaining(['hard', 'easy', 'difficulty', 'randomizer', 'mode']));
    expect(r.kindBoosts.flag).toBeGreaterThan(1.0);
    expect(r.kindBoosts.variable).toBeGreaterThan(1.0);
  });

  it('fires intro_cutscene for "intro" / "main story" and boosts dialogue', () => {
    const r = expandQueryIntent('intro cutscene');
    expect(r.matchedIntents).toContain('intro_cutscene');
    expect(r.addedTokens).toEqual(expect.arrayContaining(['birch', 'oak', 'professor']));
    expect(r.kindBoosts.dialogue).toBeGreaterThan(1.0);
  });

  it('fires warp_destination for "leads to" / "all ways to" and boosts warp', () => {
    const r = expandQueryIntent('all ways to Route101');
    expect(r.matchedIntents).toContain('warp_destination');
    expect(r.addedTokens).toEqual(expect.arrayContaining(['warp', 'door', 'entrance']));
    expect(r.kindBoosts.warp).toBeGreaterThan(1.0);
  });

  it('fires multiple intents for overlapping queries and merges kind boosts via max', () => {
    const r = expandQueryIntent('intro and starter choice');
    expect(r.matchedIntents).toEqual(expect.arrayContaining(['starter_choice', 'intro_cutscene']));
    // scriptStep gets boost from starter_choice (1.5) AND from intro_cutscene (1.2) - max wins.
    expect(r.kindBoosts.scriptStep).toBe(1.5);
    // dialogue gets boost from both intents - both contribute, max wins (intro_cutscene 1.4).
    expect(r.kindBoosts.dialogue).toBe(1.4);
  });

  it('deduplicates addedTokens across multiple firing intents', () => {
    const r = expandQueryIntent('intro starter');
    // Both intents add 'birch'; should appear only once.
    const birchCount = r.addedTokens.filter((t) => t === 'birch').length;
    expect(birchCount).toBe(1);
  });
});
