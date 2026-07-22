import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  SceneBootError,
  createSceneBoot,
  deleteSceneBoot,
  getSceneBoot,
  listSceneBoots,
  updateSceneBoot,
  SCENE_BOOT_NAME_MAX_LENGTH,
  SCENE_BOOT_MAX_FLAGS,
} from './store.js';

describe('scene-boot store (Phase 4.1B)', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(path.join(tmpdir(), 'rom-editor-sceneboot-'));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('list is empty when no recipes exist', async () => {
    expect(await listSceneBoots(projectRoot)).toEqual([]);
  });

  it('create + list round-trips', async () => {
    const recipe = await createSceneBoot({
      projectRoot,
      name: 'cosmog-handoff',
      notes: 'after Oak gives you Cosmog',
      startingMapId: 'pallet_town',
      startingPosition: { x: 4, y: 5, facing: 'down' },
      initialFlags: [0x820, 0x821],
      initialVars: [{ varId: 0x40d0, value: 3 }],
      triggerScriptId: 'cosmog_handoff_script',
      skipIntro: true,
    });
    expect(recipe.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(recipe.name).toBe('cosmog-handoff');
    expect(recipe.startingPosition?.x).toBe(4);
    expect(recipe.initialFlags).toEqual([0x820, 0x821]);
    expect(recipe.initialVars).toEqual([{ varId: 0x40d0, value: 3 }]);

    const list = await listSceneBoots(projectRoot);
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe(recipe.id);
  });

  it('rejects an empty name', async () => {
    await expect(
      createSceneBoot({ projectRoot, name: '', startingMapId: 'x' }),
    ).rejects.toMatchObject({ code: 'invalid_name' });
  });

  it('rejects a name exceeding the cap', async () => {
    await expect(
      createSceneBoot({
        projectRoot,
        name: 'x'.repeat(SCENE_BOOT_NAME_MAX_LENGTH + 1),
        startingMapId: 'x',
      }),
    ).rejects.toMatchObject({ code: 'invalid_name' });
  });

  it('rejects a missing startingMapId', async () => {
    await expect(
      createSceneBoot({ projectRoot, name: 'x', startingMapId: '' }),
    ).rejects.toMatchObject({ code: 'invalid_starting_map' });
  });

  it('rejects an out-of-range position coordinate', async () => {
    await expect(
      createSceneBoot({
        projectRoot,
        name: 'x',
        startingMapId: 'x',
        startingPosition: { x: 1000, y: 0, facing: 'down' },
      }),
    ).rejects.toMatchObject({ code: 'invalid_position' });
  });

  it('rejects an invalid facing direction', async () => {
    await expect(
      createSceneBoot({
        projectRoot,
        name: 'x',
        startingMapId: 'x',
        startingPosition: { x: 0, y: 0, facing: 'sideways' as never },
      }),
    ).rejects.toMatchObject({ code: 'invalid_position' });
  });

  it('rejects a flag id out of u16 range', async () => {
    await expect(
      createSceneBoot({
        projectRoot,
        name: 'x',
        startingMapId: 'x',
        initialFlags: [0x10000],
      }),
    ).rejects.toMatchObject({ code: 'invalid_flag' });
  });

  it('rejects more flags than the cap', async () => {
    await expect(
      createSceneBoot({
        projectRoot,
        name: 'x',
        startingMapId: 'x',
        initialFlags: Array.from({ length: SCENE_BOOT_MAX_FLAGS + 1 }, (_, i) => i),
      }),
    ).rejects.toMatchObject({ code: 'invalid_flag' });
  });

  it('rejects a var id out of u16 range', async () => {
    await expect(
      createSceneBoot({
        projectRoot,
        name: 'x',
        startingMapId: 'x',
        initialVars: [{ varId: 0x10000, value: 0 }],
      }),
    ).rejects.toMatchObject({ code: 'invalid_var' });
  });

  it('update partially modifies a recipe', async () => {
    const recipe = await createSceneBoot({
      projectRoot,
      name: 'before',
      startingMapId: 'pallet_town',
    });
    const updated = await updateSceneBoot({
      projectRoot,
      recipeId: recipe.id,
      name: 'after',
      initialFlags: [0x100, 0x200],
    });
    expect(updated.name).toBe('after');
    expect(updated.initialFlags).toEqual([0x100, 0x200]);
    expect(updated.startingMapId).toBe('pallet_town');
  });

  it('update throws recipe_not_found for unknown id', async () => {
    await expect(
      updateSceneBoot({ projectRoot, recipeId: 'no-such-id', name: 'x' }),
    ).rejects.toMatchObject({ code: 'recipe_not_found' });
  });

  it('delete removes a recipe', async () => {
    const recipe = await createSceneBoot({
      projectRoot,
      name: 'temp',
      startingMapId: 'x',
    });
    await deleteSceneBoot(projectRoot, recipe.id);
    const list = await listSceneBoots(projectRoot);
    expect(list).toHaveLength(0);
  });

  it('delete is a no-op for unknown id', async () => {
    await expect(deleteSceneBoot(projectRoot, 'no-such-id')).resolves.toBeUndefined();
  });

  it('list returns newest-first ordering', async () => {
    const a = await createSceneBoot({ projectRoot, name: 'A', startingMapId: 'x' });
    await new Promise((r) => setTimeout(r, 5));
    const b = await createSceneBoot({ projectRoot, name: 'B', startingMapId: 'x' });
    await new Promise((r) => setTimeout(r, 5));
    const c = await createSceneBoot({ projectRoot, name: 'C', startingMapId: 'x' });
    const list = await listSceneBoots(projectRoot);
    expect(list.map((r) => r.id)).toEqual([c.id, b.id, a.id]);
  });

  it('getSceneBoot returns null for unknown id', async () => {
    expect(await getSceneBoot(projectRoot, 'no-such-id')).toBeNull();
  });

  it('throws SceneBootError for corrupt index.json', async () => {
    const dir = path.join(projectRoot, '.editor', 'scene-boots');
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'index.json'), '{not valid');
    await expect(listSceneBoots(projectRoot)).rejects.toBeInstanceOf(SceneBootError);
  });
});
