import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { decodeCell, decodeMapBin, findLayoutDirById, parseLayoutDir } from './layouts.js';

describe('decodeCell', () => {
  it('decodes metatile id from low 10 bits', () => {
    expect(decodeCell(0x0001).metatileId).toBe(1);
    expect(decodeCell(0x03ff).metatileId).toBe(1023);
    expect(decodeCell(0xffff).metatileId).toBe(1023);
  });

  it('decodes collision from bits 10..11', () => {
    expect(decodeCell(0x0000).collision).toBe(0);
    expect(decodeCell(0x0400).collision).toBe(1);
    expect(decodeCell(0x0c00).collision).toBe(3);
  });

  it('decodes elevation from bits 12..15', () => {
    expect(decodeCell(0x1000).elevation).toBe(1);
    expect(decodeCell(0xf000).elevation).toBe(15);
  });
});

describe('decodeMapBin', () => {
  it('decodes a small grid in row-major order', () => {
    // 2x2 grid: cells {1,2,3,4}
    const buf = Buffer.from([
      0x01, 0x00, // 1
      0x02, 0x00, // 2
      0x03, 0x00, // 3
      0x04, 0x00, // 4
    ]);
    const cells = decodeMapBin(buf, 2, 2);
    expect(cells.map((c) => c.metatileId)).toEqual([1, 2, 3, 4]);
  });

  it('pads with zero cells when the file is shorter than width*height', () => {
    const buf = Buffer.from([0x05, 0x00]); // one cell present
    const cells = decodeMapBin(buf, 2, 2);
    expect(cells).toHaveLength(4);
    expect(cells[0]?.metatileId).toBe(5);
    expect(cells[1]?.metatileId).toBe(0);
  });

  it('truncates when the file is longer than width*height', () => {
    const buf = Buffer.from([
      0x01, 0x00, 0x02, 0x00, 0x03, 0x00, 0x04, 0x00, 0xff, 0x00, // 5 cells in buffer
    ]);
    const cells = decodeMapBin(buf, 2, 2);
    expect(cells).toHaveLength(4);
  });
});

describe('parseLayoutDir', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'rom-editor-layout-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('parses a complete layout.json + map.bin and decodes cells', async () => {
    const layoutDirName = 'LittlerootTown';
    mkdirSync(path.join(dir, 'data', 'layouts', layoutDirName), { recursive: true });
    writeFileSync(
      path.join(dir, 'data', 'layouts', layoutDirName, 'layout.json'),
      JSON.stringify({
        id: 'LAYOUT_LITTLEROOT_TOWN',
        name: 'LittlerootTown_Layout',
        width: 2,
        height: 2,
        border_width: 2,
        border_height: 2,
        primary_tileset: 'gTileset_General',
        secondary_tileset: 'gTileset_LittlerootTown',
        blockdata_filepath: `data/layouts/${layoutDirName}/map.bin`,
      }),
    );
    writeFileSync(
      path.join(dir, 'data', 'layouts', layoutDirName, 'map.bin'),
      Buffer.from([0x01, 0x04, 0x02, 0x00, 0x0a, 0x10, 0xff, 0xf0]),
    );

    const layout = await parseLayoutDir(dir, layoutDirName);
    expect(layout.id).toBe('LAYOUT_LITTLEROOT_TOWN');
    expect(layout.width).toBe(2);
    expect(layout.height).toBe(2);
    expect(layout.primaryTileset).toBe('gTileset_General');
    expect(layout.secondaryTileset).toBe('gTileset_LittlerootTown');
    expect(layout.cells).toHaveLength(4);
    // cell 0 = 0x0401: metatileId=1, collision=1, elevation=0
    expect(layout.cells[0]?.metatileId).toBe(1);
    expect(layout.cells[0]?.collision).toBe(1);
    // cell 1 = 0x0002: metatileId=2
    expect(layout.cells[1]?.metatileId).toBe(2);
    // cell 2 = 0x100a: metatileId=10, elevation=1
    expect(layout.cells[2]?.metatileId).toBe(10);
    expect(layout.cells[2]?.elevation).toBe(1);
    // cell 3 = 0xf0ff: metatileId=255, elevation=15
    expect(layout.cells[3]?.metatileId).toBe(255);
    expect(layout.cells[3]?.elevation).toBe(15);
  });

  it('emits zero cells when blockdata_filepath is missing', async () => {
    mkdirSync(path.join(dir, 'data', 'layouts', 'Empty'), { recursive: true });
    writeFileSync(
      path.join(dir, 'data', 'layouts', 'Empty', 'layout.json'),
      JSON.stringify({ id: 'LAYOUT_EMPTY', width: 3, height: 3 }),
    );
    const layout = await parseLayoutDir(dir, 'Empty');
    expect(layout.cells).toHaveLength(9);
    expect(layout.cells.every((c) => c.metatileId === 0)).toBe(true);
  });

  it('throws LayoutParseError for invalid width/height', async () => {
    mkdirSync(path.join(dir, 'data', 'layouts', 'Bad'), { recursive: true });
    writeFileSync(
      path.join(dir, 'data', 'layouts', 'Bad', 'layout.json'),
      JSON.stringify({ id: 'LAYOUT_BAD' }), // missing width/height
    );
    await expect(parseLayoutDir(dir, 'Bad')).rejects.toThrow(/width\/height missing/);
  });

  it('throws LayoutParseError when layout.json is missing', async () => {
    await expect(parseLayoutDir(dir, 'DoesNotExist')).rejects.toThrow(
      /No layout\.json|Could not read or parse/,
    );
  });
});

describe('findLayoutDirById', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'rom-editor-find-layout-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns the directory whose layout.json declares the requested id', async () => {
    mkdirSync(path.join(dir, 'data', 'layouts', 'LittlerootTown'), { recursive: true });
    writeFileSync(
      path.join(dir, 'data', 'layouts', 'LittlerootTown', 'layout.json'),
      JSON.stringify({ id: 'LAYOUT_LITTLEROOT_TOWN', width: 1, height: 1 }),
    );
    mkdirSync(path.join(dir, 'data', 'layouts', 'Route101'), { recursive: true });
    writeFileSync(
      path.join(dir, 'data', 'layouts', 'Route101', 'layout.json'),
      JSON.stringify({ id: 'LAYOUT_ROUTE101', width: 1, height: 1 }),
    );
    expect(await findLayoutDirById(dir, 'LAYOUT_LITTLEROOT_TOWN')).toBe('LittlerootTown');
    expect(await findLayoutDirById(dir, 'LAYOUT_ROUTE101')).toBe('Route101');
    expect(await findLayoutDirById(dir, 'LAYOUT_DOES_NOT_EXIST')).toBeNull();
  });

  it('returns null when data/layouts/ does not exist', async () => {
    expect(await findLayoutDirById(dir, 'LAYOUT_X')).toBeNull();
  });
});
