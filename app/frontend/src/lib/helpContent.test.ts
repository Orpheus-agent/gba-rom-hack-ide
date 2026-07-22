import { describe, expect, it } from 'vitest';
import {
  HelpError,
  getHelpEntry,
  listHelpEntries,
  validateHelpCoverage,
} from './helpContent';
import type { ViewKey } from '../state';

const ALL_VIEW_KEYS: ReadonlyArray<ViewKey> = [
  'project',
  'maps',
  'events',
  'dialogue',
  'flags',
  'assets',
  'preview',
  'mechanics',
  'lint',
  'dependencies',
  'templates',
  'plugins',
  'timeline',
  'build',
  'tilesets',
  'species',
  'moves',
  'items',
  'abilities',
  'trainerClasses',
  'types',
  'pokedex',
  'choices',
  'healLocations',
];

describe('helpContent registry', () => {
  it('listHelpEntries returns exactly one entry per ViewKey, in registration order', () => {
    const entries = listHelpEntries();
    expect(entries.length).toBe(ALL_VIEW_KEYS.length);
    const seen = new Set<ViewKey>();
    for (const e of entries) {
      expect(seen.has(e.view)).toBe(false);
      seen.add(e.view);
    }
    expect(seen.size).toBe(ALL_VIEW_KEYS.length);
  });

  it('every entry has a non-empty title + summary + at least one tip', () => {
    for (const e of listHelpEntries()) {
      expect(e.title.length).toBeGreaterThan(0);
      expect(e.summary.length).toBeGreaterThan(0);
      expect(e.tips.length).toBeGreaterThan(0);
      for (const tip of e.tips) {
        expect(tip.length).toBeGreaterThan(0);
      }
    }
  });

  it('getHelpEntry returns the right entry for a known view', () => {
    expect(getHelpEntry('templates').title).toBe('Templates');
    expect(getHelpEntry('build').title).toBe('Build');
  });

  it('getHelpEntry throws HelpError with unknown_view for an invalid id', () => {
    try {
      getHelpEntry('garbage' as ViewKey);
      expect.fail('expected HelpError');
    } catch (e) {
      expect(e).toBeInstanceOf(HelpError);
      expect((e as HelpError).code).toBe('unknown_view');
    }
  });

  it('relatedViews (when present) only references known ViewKeys', () => {
    const known = new Set<ViewKey>(ALL_VIEW_KEYS);
    for (const e of listHelpEntries()) {
      if (!e.relatedViews) continue;
      for (const r of e.relatedViews) {
        expect(known.has(r)).toBe(true);
      }
    }
  });

  it('validateHelpCoverage passes for the shipping ViewKey set', () => {
    expect(() => validateHelpCoverage(ALL_VIEW_KEYS)).not.toThrow();
  });

  it('validateHelpCoverage throws invalid_coverage if a ViewKey is added without an entry', () => {
    try {
      validateHelpCoverage([...ALL_VIEW_KEYS, 'phantom_view' as ViewKey]);
      expect.fail('expected HelpError');
    } catch (e) {
      expect(e).toBeInstanceOf(HelpError);
      expect((e as HelpError).code).toBe('invalid_coverage');
    }
  });
});
