import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  buildCSnippet,
  buildRuleId,
  buildBannedBackupSnippet,
  isLikelyItemId,
  isLikelySpeciesId,
  proposeFormChangeRule,
} from './propose-form-change-rule.js';

describe('id shape validators', () => {
  it('isLikelySpeciesId accepts standard CFRU constants', () => {
    expect(isLikelySpeciesId('SPECIES_ZACIAN')).toBe(true);
    expect(isLikelySpeciesId('SPECIES_ZACIAN_CROWNED')).toBe(true);
    expect(isLikelySpeciesId('SPECIES_URSHIFU_RAPID_GIGA')).toBe(true);
  });
  it('isLikelySpeciesId rejects malformed inputs', () => {
    expect(isLikelySpeciesId('Zacian')).toBe(false);
    expect(isLikelySpeciesId('SPECIES_zacian')).toBe(false);
    expect(isLikelySpeciesId('')).toBe(false);
    expect(isLikelySpeciesId('species_zacian')).toBe(false);
  });
  it('isLikelyItemId accepts standard ITEM_ constants', () => {
    expect(isLikelyItemId('ITEM_RUSTED_SWORD')).toBe(true);
    expect(isLikelyItemId('ITEM_GRISEOUS_ORB')).toBe(true);
  });
  it('isLikelyItemId rejects malformed inputs', () => {
    expect(isLikelyItemId('Rusted Sword')).toBe(false);
    expect(isLikelyItemId('item_rusted_sword')).toBe(false);
    expect(isLikelyItemId('SPECIES_RUSTED_SWORD')).toBe(false);
  });
});

describe('buildRuleId', () => {
  it('produces a deterministic id from the species + item pair', () => {
    expect(buildRuleId('SPECIES_ZACIAN', 'ITEM_RUSTED_SWORD')).toBe(
      'form_change_SPECIES_ZACIAN_ITEM_RUSTED_SWORD',
    );
  });
});

describe('buildCSnippet', () => {
  it('emits forward + reverse case branches for a bidirectional rule', () => {
    const snippet = buildCSnippet(
      {
        id: 'r',
        speciesId: 'SPECIES_ZACIAN',
        heldItemId: 'ITEM_RUSTED_SWORD',
        targetSpeciesId: 'SPECIES_ZACIAN_CROWNED',
        oneWay: false,
        notes: null,
      },
      'ITEM_EFFECT_RUSTED_SWORD',
    );
    expect(snippet).toContain('case SPECIES_ZACIAN:');
    expect(snippet).toContain('targetSpecies = SPECIES_ZACIAN_CROWNED;');
    expect(snippet).toContain('case SPECIES_ZACIAN_CROWNED:');
    expect(snippet).toContain('targetSpecies = SPECIES_ZACIAN;');
    expect(snippet).toContain('itemEffect == ITEM_EFFECT_RUSTED_SWORD');
    expect(snippet).toContain('itemEffect != ITEM_EFFECT_RUSTED_SWORD');
  });

  it('omits the reverse branch for a one-way rule', () => {
    const snippet = buildCSnippet(
      {
        id: 'r',
        speciesId: 'SPECIES_ZACIAN',
        heldItemId: 'ITEM_RUSTED_SWORD',
        targetSpeciesId: 'SPECIES_ZACIAN_CROWNED',
        oneWay: true,
        notes: null,
      },
      'ITEM_EFFECT_RUSTED_SWORD',
    );
    expect(snippet).toContain('case SPECIES_ZACIAN:');
    expect(snippet).toContain('targetSpecies = SPECIES_ZACIAN_CROWNED;');
    expect(snippet).not.toContain('targetSpecies = SPECIES_ZACIAN;');
    expect(snippet).toContain('one-way rule');
  });
});

describe('buildBannedBackupSnippet', () => {
  it('produces a paste-ready sBannedBackupSpecies entry for the target', () => {
    const snippet = buildBannedBackupSnippet({
      id: 'r',
      speciesId: 'SPECIES_ZACIAN',
      heldItemId: 'ITEM_RUSTED_SWORD',
      targetSpeciesId: 'SPECIES_ZACIAN_CROWNED',
      oneWay: true,
      notes: null,
    });
    expect(snippet).toContain('SPECIES_ZACIAN_CROWNED,');
    expect(snippet).toContain('sBannedBackupSpecies');
  });
});

describe('proposeFormChangeRule', () => {
  let root: string;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(tmpdir(), 'form-change-rule-test-'));
  });
  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  it('persists a bidirectional rule, returns forward+reverse snippets, no banned-backup', async () => {
    const result = await proposeFormChangeRule(
      { projectRoot: root, baseUrl: 'http://x' },
      {
        speciesId: 'SPECIES_GIRATINA',
        heldItemId: 'ITEM_GRISEOUS_ORB',
        targetSpeciesId: 'SPECIES_GIRATINA_ORIGIN',
      },
    );
    expect(result.ok).toBe(true);
    expect(result.rule).toEqual({
      id: 'form_change_SPECIES_GIRATINA_ITEM_GRISEOUS_ORB',
      speciesId: 'SPECIES_GIRATINA',
      heldItemId: 'ITEM_GRISEOUS_ORB',
      targetSpeciesId: 'SPECIES_GIRATINA_ORIGIN',
      oneWay: false,
      notes: null,
    });
    expect(result.cSnippet).toContain('case SPECIES_GIRATINA:');
    expect(result.cSnippet).toContain('case SPECIES_GIRATINA_ORIGIN:');
    expect(result.bannedBackupSnippet).toBeNull();
    expect(result.persistedRulesPath).toBe(
      path.join(root, '.editor', 'form-change-rules.json'),
    );
    const raw = await fsp.readFile(result.persistedRulesPath!, 'utf8');
    const parsed = JSON.parse(raw) as { schemaVersion: number; rules: unknown[] };
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.rules).toHaveLength(1);
  });

  it('returns a banned-backup snippet for one-way rules', async () => {
    const result = await proposeFormChangeRule(
      { projectRoot: root, baseUrl: 'http://x' },
      {
        speciesId: 'SPECIES_AEGISLASH',
        heldItemId: 'ITEM_KINGS_SHIELD',
        targetSpeciesId: 'SPECIES_AEGISLASH_BLADE',
        oneWay: true,
      },
    );
    expect(result.ok).toBe(true);
    expect(result.bannedBackupSnippet).not.toBeNull();
    expect(result.bannedBackupSnippet).toContain('SPECIES_AEGISLASH_BLADE,');
  });

  it('rejects bad species ids', async () => {
    const result = await proposeFormChangeRule(
      { projectRoot: root, baseUrl: 'http://x' },
      {
        speciesId: 'zacian', // not SPECIES_*
        heldItemId: 'ITEM_RUSTED_SWORD',
        targetSpeciesId: 'SPECIES_ZACIAN_CROWNED',
      },
    );
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/doesn't match the SPECIES_/);
  });

  it('rejects bad item ids', async () => {
    const result = await proposeFormChangeRule(
      { projectRoot: root, baseUrl: 'http://x' },
      {
        speciesId: 'SPECIES_ZACIAN',
        heldItemId: 'Rusted Sword',
        targetSpeciesId: 'SPECIES_ZACIAN_CROWNED',
      },
    );
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/doesn't match the ITEM_/);
  });

  it('rejects species === target', async () => {
    const result = await proposeFormChangeRule(
      { projectRoot: root, baseUrl: 'http://x' },
      {
        speciesId: 'SPECIES_ZACIAN',
        heldItemId: 'ITEM_RUSTED_SWORD',
        targetSpeciesId: 'SPECIES_ZACIAN',
      },
    );
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/DIFFERENT base \+ target species/);
  });

  it('appends a new rule and replaces an existing one with the same id', async () => {
    // First insert.
    await proposeFormChangeRule(
      { projectRoot: root, baseUrl: 'http://x' },
      {
        speciesId: 'SPECIES_ZACIAN',
        heldItemId: 'ITEM_RUSTED_SWORD',
        targetSpeciesId: 'SPECIES_ZACIAN_CROWNED',
        notes: 'first',
      },
    );
    // Different rule - different species.
    await proposeFormChangeRule(
      { projectRoot: root, baseUrl: 'http://x' },
      {
        speciesId: 'SPECIES_ZAMAZENTA',
        heldItemId: 'ITEM_RUSTED_SHIELD',
        targetSpeciesId: 'SPECIES_ZAMAZENTA_CROWNED',
      },
    );
    // Replace the first rule (same species+item id).
    const replaced = await proposeFormChangeRule(
      { projectRoot: root, baseUrl: 'http://x' },
      {
        speciesId: 'SPECIES_ZACIAN',
        heldItemId: 'ITEM_RUSTED_SWORD',
        targetSpeciesId: 'SPECIES_ZACIAN_CROWNED',
        notes: 'updated',
        oneWay: true,
      },
    );
    expect(replaced.ok).toBe(true);
    expect(replaced.totalRulesAfterApply).toBe(2);
    const raw = await fsp.readFile(replaced.persistedRulesPath!, 'utf8');
    const parsed = JSON.parse(raw) as { rules: Array<{ id: string; notes: string | null; oneWay: boolean }> };
    expect(parsed.rules).toHaveLength(2);
    const zacian = parsed.rules.find((r) => r.id === 'form_change_SPECIES_ZACIAN_ITEM_RUSTED_SWORD');
    expect(zacian?.notes).toBe('updated');
    expect(zacian?.oneWay).toBe(true);
  });

  it('creates the .editor directory if it does not exist', async () => {
    await expect(fsp.stat(path.join(root, '.editor'))).rejects.toThrow();
    const result = await proposeFormChangeRule(
      { projectRoot: root, baseUrl: 'http://x' },
      {
        speciesId: 'SPECIES_GIRATINA',
        heldItemId: 'ITEM_GRISEOUS_ORB',
        targetSpeciesId: 'SPECIES_GIRATINA_ORIGIN',
      },
    );
    expect(result.ok).toBe(true);
    const stat = await fsp.stat(path.join(root, '.editor'));
    expect(stat.isDirectory()).toBe(true);
  });

  it('includes next-step prompt with both the banned-backup step and the rebuild step', async () => {
    const result = await proposeFormChangeRule(
      { projectRoot: root, baseUrl: 'http://x' },
      {
        speciesId: 'SPECIES_AEGISLASH',
        heldItemId: 'ITEM_KINGS_SHIELD',
        targetSpeciesId: 'SPECIES_AEGISLASH_BLADE',
        oneWay: true,
      },
    );
    expect(result.nextStep).toContain('sBannedBackupSpecies');
    expect(result.nextStep).toContain('build-cfru-bundle.mjs');
    expect(result.nextStep).toContain('Re-modernize');
  });
});
