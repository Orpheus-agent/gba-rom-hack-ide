import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { classifyAsset, parseAssets } from './assets.js';

describe('classifyAsset', () => {
  it('classifies palette extensions', () => {
    expect(classifyAsset('graphics/pokemon/bulbasaur/normal.pal')).toBe('palette');
    expect(classifyAsset('graphics/some.gbapal')).toBe('palette');
  });

  it('classifies music vs sound by sound/songs/ path', () => {
    expect(classifyAsset('sound/songs/littleroot.aif')).toBe('music');
    expect(classifyAsset('sound/songs/midi/intro.aif')).toBe('music');
    expect(classifyAsset('sound/cry/treecko.aif')).toBe('sound');
    expect(classifyAsset('sound/sound_effects/beep.wav')).toBe('sound');
  });

  it('classifies PNGs by path heuristic', () => {
    expect(classifyAsset('graphics/object_events/pics/may.png')).toBe('overworld_sprite');
    expect(classifyAsset('graphics/trainers/front_pics/may.png')).toBe('trainer_sprite');
    expect(classifyAsset('graphics/trainer/back/may.png')).toBe('trainer_sprite');
    expect(classifyAsset('graphics/pokemon/bulbasaur/front.png')).toBe('battle_sprite');
    expect(classifyAsset('graphics/battle_anims/intro.png')).toBe('battle_sprite');
    expect(classifyAsset('graphics/tilesets/secondary/route101/tiles.png')).toBe('tileset');
    expect(classifyAsset('graphics/portraits/oak.png')).toBe('portrait');
    expect(classifyAsset('graphics/animations/jump.png')).toBe('animation');
    expect(classifyAsset('graphics/icons/menu.png')).toBe('icon');
    expect(classifyAsset('graphics/title_screen/logo.png')).toBe('ui_graphic');
  });

  it('returns null for compiled outputs and unknown formats', () => {
    expect(classifyAsset('graphics/foo.4bpp')).toBeNull();
    expect(classifyAsset('graphics/foo.bin')).toBeNull();
    expect(classifyAsset('graphics/foo.lz')).toBeNull();
    expect(classifyAsset('docs/README.md')).toBeNull();
  });
});

describe('parseAssets (on-disk)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'rom-editor-assets-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('walks graphics/ and sound/ trees and emits typed Asset entries', async () => {
    mkdirSync(path.join(dir, 'graphics', 'object_events', 'pics', 'people'), { recursive: true });
    mkdirSync(path.join(dir, 'graphics', 'tilesets', 'primary'), { recursive: true });
    mkdirSync(path.join(dir, 'graphics', 'trainers', 'front_pics'), { recursive: true });
    mkdirSync(path.join(dir, 'sound', 'songs'), { recursive: true });
    mkdirSync(path.join(dir, 'sound', 'cry'), { recursive: true });
    writeFileSync(path.join(dir, 'graphics', 'object_events', 'pics', 'people', 'may.png'), 'png');
    writeFileSync(path.join(dir, 'graphics', 'tilesets', 'primary', 'tiles.png'), 'tile');
    writeFileSync(
      path.join(dir, 'graphics', 'trainers', 'front_pics', 'may.png'),
      'trainer-pic',
    );
    writeFileSync(path.join(dir, 'graphics', 'tilesets', 'primary', 'palette.pal'), 'pal');
    writeFileSync(path.join(dir, 'sound', 'songs', 'littleroot.aif'), 'mus');
    writeFileSync(path.join(dir, 'sound', 'cry', 'treecko.aif'), 'sfx');

    const result = await parseAssets(dir);
    const ids = result.assets.map((a) => a.id);
    expect(ids).toContain('graphics/object_events/pics/people/may.png');
    expect(ids).toContain('graphics/tilesets/primary/tiles.png');
    expect(ids).toContain('graphics/trainers/front_pics/may.png');
    expect(ids).toContain('graphics/tilesets/primary/palette.pal');
    expect(ids).toContain('sound/songs/littleroot.aif');
    expect(ids).toContain('sound/cry/treecko.aif');

    const may = result.assets.find((a) => a.id === 'graphics/object_events/pics/people/may.png');
    expect(may?.kind).toBe('overworld_sprite');
    expect(may?.relativePath).toBe('graphics/object_events/pics/people/may.png');
    expect(may?.metadata['extension']).toBe('.png');
    expect(may?.metadata['sizeBytes']).toBeGreaterThan(0);

    const song = result.assets.find((a) => a.id === 'sound/songs/littleroot.aif');
    expect(song?.kind).toBe('music');
    const sfx = result.assets.find((a) => a.id === 'sound/cry/treecko.aif');
    expect(sfx?.kind).toBe('sound');
  });

  it('skips derived binary outputs (.4bpp, .bin, .lz)', async () => {
    mkdirSync(path.join(dir, 'graphics'), { recursive: true });
    writeFileSync(path.join(dir, 'graphics', 'real.png'), 'png');
    writeFileSync(path.join(dir, 'graphics', 'compiled.4bpp'), '4bpp');
    writeFileSync(path.join(dir, 'graphics', 'tilemap.bin'), 'bin');
    writeFileSync(path.join(dir, 'graphics', 'compressed.lz'), 'lz');
    const result = await parseAssets(dir);
    const ids = result.assets.map((a) => a.id);
    expect(ids).toContain('graphics/real.png');
    expect(ids).not.toContain('graphics/compiled.4bpp');
    expect(ids).not.toContain('graphics/tilemap.bin');
    expect(ids).not.toContain('graphics/compressed.lz');
  });

  it('warns when graphics/ or sound/ is absent', async () => {
    const result = await parseAssets(dir);
    expect(result.assets).toHaveLength(0);
    expect(result.warnings.some((w) => /graphics\//.test(w))).toBe(true);
    expect(result.warnings.some((w) => /sound\//.test(w))).toBe(true);
  });

  it('sorts assets by id for stable serialization', async () => {
    mkdirSync(path.join(dir, 'graphics', 'a'), { recursive: true });
    mkdirSync(path.join(dir, 'graphics', 'b'), { recursive: true });
    writeFileSync(path.join(dir, 'graphics', 'b', 'zebra.png'), '');
    writeFileSync(path.join(dir, 'graphics', 'a', 'apple.png'), '');
    const result = await parseAssets(dir);
    const ids = result.assets.map((a) => a.id);
    expect(ids).toEqual([...ids].sort());
  });

  it('emits one entry per file and tracks size accurately', async () => {
    mkdirSync(path.join(dir, 'graphics'), { recursive: true });
    writeFileSync(path.join(dir, 'graphics', 'big.png'), 'X'.repeat(2048));
    const result = await parseAssets(dir);
    const big = result.assets.find((a) => a.id === 'graphics/big.png');
    expect(big?.metadata['sizeBytes']).toBe(2048);
  });
});
