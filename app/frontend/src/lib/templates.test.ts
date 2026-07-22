import { describe, expect, it } from 'vitest';
import { getTemplate, listTemplates, materializeTemplate, TemplateError } from './templates';

describe('templates registry', () => {
  it('lists all 5 shipped templates', () => {
    const ids = listTemplates().map((t) => t.id).sort();
    expect(ids).toEqual([
      'boss_battle_intro',
      'gift_pokemon_event',
      'npc_with_dialogue',
      'randomizer_toggle',
      'town_skeleton',
    ]);
  });

  it('getTemplate throws unknown_template for an unknown id', () => {
    // @ts-expect-error invalid id by type but runtime-testable
    expect(() => getTemplate('not_real')).toThrow(TemplateError);
  });

  it('town_skeleton produces 1 map + 3 object events + 1 outbound warp with names tied to mapName', () => {
    const r = materializeTemplate('town_skeleton', { mapName: 'NewTown' });
    expect(r.entities.maps).toHaveLength(1);
    expect(r.entities.maps?.[0]?.id).toBe('NewTown');
    expect(r.entities.objectEvents).toHaveLength(3);
    expect(r.entities.objectEvents?.[0]?.mapId).toBe('NewTown');
    expect(r.entities.warps).toHaveLength(1);
    expect(r.entities.warps?.[0]?.fromMapId).toBe('NewTown');
    expect(r.summary).toContain('NewTown');
  });

  it('boss_battle_intro produces 1 trigger + 4 script steps + 2 dialogue stubs', () => {
    const r = materializeTemplate('boss_battle_intro', {
      bossLabel: 'Boss_FirstGym',
      dialogueLabel: 'Text_FirstGym',
    });
    expect(r.entities.triggers).toHaveLength(1);
    expect(r.entities.scriptSteps).toHaveLength(4);
    expect(r.entities.dialogue).toHaveLength(2);
    expect(r.entities.triggers?.[0]?.scriptStepIds).toEqual([
      'Boss_FirstGym#0',
      'Boss_FirstGym#1',
      'Boss_FirstGym#2',
      'Boss_FirstGym#3',
    ]);
  });

  it('gift_pokemon_event produces NPC + 3 script steps + 1 flag tied to species/flag params', () => {
    const r = materializeTemplate('gift_pokemon_event', {
      speciesId: 'SPECIES_EEVEE',
      flagId: 'FLAG_RECEIVED_EEVEE',
    });
    expect(r.entities.objectEvents?.[0]?.flagId).toBe('FLAG_RECEIVED_EEVEE');
    expect(r.entities.scriptSteps).toHaveLength(3);
    expect(r.entities.flags?.[0]?.id).toBe('FLAG_RECEIVED_EEVEE');
  });

  it('randomizer_toggle takes no params and produces 2 flags + 1 variable', () => {
    const r = materializeTemplate('randomizer_toggle', {});
    expect(r.entities.flags).toHaveLength(2);
    expect(r.entities.variables).toHaveLength(1);
    expect(r.entities.flags?.map((f) => f.id).sort()).toEqual([
      'FLAG_RANDOMIZER_ENABLED',
      'FLAG_RANDOMIZER_SEEDED',
    ]);
  });

  it('rejects missing required params with TemplateError code=missing_required_param', () => {
    expect(() => materializeTemplate('town_skeleton', {})).toThrow(TemplateError);
    try {
      materializeTemplate('town_skeleton', {});
    } catch (e) {
      expect((e as TemplateError).code).toBe('missing_required_param');
    }
    expect(() => materializeTemplate('gift_pokemon_event', { speciesId: 'X' })).toThrow();
  });

  it('npc_with_dialogue uses default dialogue text when the optional param is empty', () => {
    const r = materializeTemplate('npc_with_dialogue', { npcName: 'TownGreeter' });
    expect(r.entities.dialogue?.[0]?.text).toBe('Hello, traveler!');
    expect(r.entities.objectEvents?.[0]?.id).toBe('obj_towngreeter');
  });
});
