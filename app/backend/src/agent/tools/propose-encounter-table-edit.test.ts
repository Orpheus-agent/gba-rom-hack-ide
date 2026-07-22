import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { EncounterTable, ProjectManifest } from '@rom-editor/shared';
import { writeManifest } from '../../scan/manifest-io.js';
import {
  computeEncounterTableEdit,
  proposeEncounterTableEdit,
} from './propose-encounter-table-edit.js';

/** Minimal manifest with one encounter table. */
function manifest(
  encounterTables: EncounterTable[],
  over: Partial<ProjectManifest> = {},
): ProjectManifest {
  return {
    schemaVersion: 1,
    generatedAtUtc: '2026-05-25T00:00:00.000Z',
    projectRoot: '/x',
    identity: {
      kind: 'patch',
      confidence: 1,
      displayName: 'fake binary rom',
      baseGame: 'firered',
      fork: null,
      featureFlags: [],
      warnings: [],
      evidence: [],
    },
    buildProfile: null,
    maps: [],
    warps: [],
    triggers: [],
    objectEvents: [],
    dialogue: [],
    flags: [],
    variables: [],
    encounterTables,
    trainers: [],
    scriptSteps: [],
    assets: [],
    ...over,
  };
}

function fakeProposalFetch(): {
  fetchFn: typeof fetch;
  captured: () => { description: string; edits: unknown[] } | null;
} {
  let body: { description: string; edits: unknown[] } | null = null;
  const fetchFn = vi.fn().mockImplementation(async (_url: unknown, init: { body: string }) => {
    body = JSON.parse(init.body) as { description: string; edits: unknown[] };
    return {
      ok: true,
      status: 200,
      json: async () => ({
        id: 'patch_fake',
        projectId: 'p',
        description: body!.description,
        edits: body!.edits,
        status: 'pending',
        createdAtUtc: '2026-05-25T00:00:00.000Z',
      }),
      text: async () => '',
    };
  }) as unknown as typeof fetch;
  return { fetchFn, captured: () => body };
}

/** Build a tiny ROM with:
 *    - a WildPokemonInfo at 0x200 (encounterRate=25, slotsPtr→0x300)
 *    - 3 slots at 0x300: { minL:5, maxL:7, species=16 }, { minL:6, maxL:8, species=19 },
 *      { minL:10, maxL:12, species=129 }
 */
function buildFakeRom(): Buffer {
  const buf = Buffer.alloc(0x1000, 0xff);
  buf[0x200] = 25; // encounterRate
  // 3 bytes of padding
  buf[0x204] = 0x00;
  buf[0x205] = 0x03;
  buf[0x206] = 0x00;
  buf[0x207] = 0x08; // 0x08000300 GBA pointer (we don't actually deref this in the test)
  // slot 0: Pidgey (16) at 0x300
  buf[0x300] = 5;
  buf[0x301] = 7;
  buf[0x302] = 0x10; // species 16 LE
  buf[0x303] = 0x00;
  // slot 1: Rattata (19)
  buf[0x304] = 6;
  buf[0x305] = 8;
  buf[0x306] = 0x13;
  buf[0x307] = 0x00;
  // slot 2: Magikarp (129)
  buf[0x308] = 10;
  buf[0x309] = 12;
  buf[0x30a] = 0x81;
  buf[0x30b] = 0x00;
  return buf;
}

function makeTable(over: Partial<EncounterTable> = {}): EncounterTable {
  return {
    id: 'binary_encounter_2_0_land',
    name: 'Route 1 grass',
    mapId: 'map_2_0',
    type: 'grass',
    encounterRate: 25,
    slots: [
      { speciesId: 'species_16', minLevel: 5, maxLevel: 7, weight: 1, fileOffset: 0x300 },
      { speciesId: 'species_19', minLevel: 6, maxLevel: 8, weight: 1, fileOffset: 0x304 },
      { speciesId: 'species_129', minLevel: 10, maxLevel: 12, weight: 1, fileOffset: 0x308 },
    ],
    infoFileOffset: 0x200,
    slotsFileOffset: 0x300,
    ...over,
  };
}

describe('computeEncounterTableEdit', () => {
  let root: string;
  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(tmpdir(), 'propose-enc-table-edit-'));
  });
  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  it('rejects when no manifest', async () => {
    const result = await computeEncounterTableEdit(root, {
      encounterTableId: 'binary_encounter_2_0_land',
      op: 'setRate',
      encounterRate: 50,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('missing_manifest');
    }
  });

  it('rejects unknown table id', async () => {
    await writeManifest(root, manifest([]));
    await fsp.writeFile(path.join(root, 'test.gba'), buildFakeRom());
    const result = await computeEncounterTableEdit(root, {
      encounterTableId: 'binary_encounter_99_99_water',
      op: 'setRate',
      encounterRate: 30,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('unknown_table');
  });

  it('rejects when no ROM file', async () => {
    await writeManifest(root, manifest([makeTable()]));
    const result = await computeEncounterTableEdit(root, {
      encounterTableId: 'binary_encounter_2_0_land',
      op: 'setRate',
      encounterRate: 30,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('no_rom_file');
  });

  // setRate
  it('setRate emits 1-byte binary_write_bytes at infoFileOffset+0', async () => {
    await writeManifest(root, manifest([makeTable()]));
    await fsp.writeFile(path.join(root, 'test.gba'), buildFakeRom());
    const result = await computeEncounterTableEdit(root, {
      encounterTableId: 'binary_encounter_2_0_land',
      op: 'setRate',
      encounterRate: 50,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.edits).toHaveLength(1);
    const edit = result.result.edits[0]! as { kind: string; offset: number; beforeBytes: string; afterBytes: string };
    expect(edit.kind).toBe('binary_write_bytes');
    expect(edit.offset).toBe(0x200);
    expect(edit.beforeBytes).toBe('19'); // 25 = 0x19
    expect(edit.afterBytes).toBe('32'); // 50 = 0x32
  });

  it('setRate rejects when infoFileOffset missing', async () => {
    const t = makeTable();
    const { infoFileOffset: _omit, ...stripped } = t;
    void _omit;
    await writeManifest(root, manifest([stripped as EncounterTable]));
    await fsp.writeFile(path.join(root, 'test.gba'), buildFakeRom());
    const result = await computeEncounterTableEdit(root, {
      encounterTableId: 'binary_encounter_2_0_land',
      op: 'setRate',
      encounterRate: 50,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('missing_offset');
  });

  it('setRate no-ops when rate already matches', async () => {
    await writeManifest(root, manifest([makeTable()]));
    await fsp.writeFile(path.join(root, 'test.gba'), buildFakeRom());
    const result = await computeEncounterTableEdit(root, {
      encounterTableId: 'binary_encounter_2_0_land',
      op: 'setRate',
      encounterRate: 25,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('no_op');
  });

  // reorder
  it('reorder emits a permuted slot-array write', async () => {
    await writeManifest(root, manifest([makeTable()]));
    await fsp.writeFile(path.join(root, 'test.gba'), buildFakeRom());
    // Swap slot 0 and slot 2 (Pidgey rare, Magikarp common).
    const result = await computeEncounterTableEdit(root, {
      encounterTableId: 'binary_encounter_2_0_land',
      op: 'reorder',
      slotOrder: [2, 1, 0],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.edits).toHaveLength(1);
    const edit = result.result.edits[0]! as { kind: string; offset: number; beforeBytes: string; afterBytes: string };
    expect(edit.offset).toBe(0x300);
    // Before bytes: slot0 (0507 1000) | slot1 (0608 1300) | slot2 (0a0c 8100)
    expect(edit.beforeBytes).toBe('05071000060813000a0c8100');
    // permuted [2,1,0]: slot2 | slot1 | slot0
    expect(edit.afterBytes).toBe('0a0c81000608130005071000');
  });

  it('reorder rejects non-permutation', async () => {
    await writeManifest(root, manifest([makeTable()]));
    await fsp.writeFile(path.join(root, 'test.gba'), buildFakeRom());
    const result = await computeEncounterTableEdit(root, {
      encounterTableId: 'binary_encounter_2_0_land',
      op: 'reorder',
      slotOrder: [0, 0, 2], // duplicate 0
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('invalid_reorder');
  });

  it('reorder rejects wrong length', async () => {
    await writeManifest(root, manifest([makeTable()]));
    await fsp.writeFile(path.join(root, 'test.gba'), buildFakeRom());
    const result = await computeEncounterTableEdit(root, {
      encounterTableId: 'binary_encounter_2_0_land',
      op: 'reorder',
      slotOrder: [0, 1], // table has 3 slots
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('invalid_reorder');
  });

  it('reorder no-ops when identity permutation', async () => {
    await writeManifest(root, manifest([makeTable()]));
    await fsp.writeFile(path.join(root, 'test.gba'), buildFakeRom());
    const result = await computeEncounterTableEdit(root, {
      encounterTableId: 'binary_encounter_2_0_land',
      op: 'reorder',
      slotOrder: [0, 1, 2],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('no_op');
  });

  // bulkReplaceSpecies
  it('bulkReplaceSpecies rewrites every slot species, preserves levels', async () => {
    await writeManifest(root, manifest([makeTable()]));
    await fsp.writeFile(path.join(root, 'test.gba'), buildFakeRom());
    const result = await computeEncounterTableEdit(root, {
      encounterTableId: 'binary_encounter_2_0_land',
      op: 'bulkReplaceSpecies',
      speciesId: 129, // Magikarp
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.edits).toHaveLength(1);
    const edit = result.result.edits[0]! as { offset: number; afterBytes: string };
    expect(edit.offset).toBe(0x300);
    // Every slot's species becomes 0x81 0x00 (129 LE). Levels preserved.
    // slot0: 05 07 81 00 | slot1: 06 08 81 00 | slot2: 0a 0c 81 00
    expect(edit.afterBytes).toBe('05078100060881000a0c8100');
  });

  it('bulkReplaceSpecies no-ops when every slot already matches', async () => {
    // Table where every slot is already species 129.
    const t = makeTable({
      slots: [
        { speciesId: 'species_129', minLevel: 5, maxLevel: 7, weight: 1, fileOffset: 0x300 },
        { speciesId: 'species_129', minLevel: 6, maxLevel: 8, weight: 1, fileOffset: 0x304 },
        { speciesId: 'species_129', minLevel: 10, maxLevel: 12, weight: 1, fileOffset: 0x308 },
      ],
    });
    await writeManifest(root, manifest([t]));
    await fsp.writeFile(path.join(root, 'test.gba'), buildFakeRom());
    const result = await computeEncounterTableEdit(root, {
      encounterTableId: 'binary_encounter_2_0_land',
      op: 'bulkReplaceSpecies',
      speciesId: 129,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('no_op');
  });

  // Phase 4.2A - manifest's speciesNames table should drive the
  // description text instead of leaking the raw numeric id.
  it('bulkReplaceSpecies uses species NAME in description when speciesNames is populated', async () => {
    await writeManifest(
      root,
      manifest([makeTable()], {
        speciesNames: [
          { id: 'species_129', speciesIndex: 129, name: 'Magikarp', sourceTableOffset: 0 },
        ],
      }),
    );
    await fsp.writeFile(path.join(root, 'test.gba'), buildFakeRom());
    const result = await computeEncounterTableEdit(root, {
      encounterTableId: 'binary_encounter_2_0_land',
      op: 'bulkReplaceSpecies',
      speciesId: 129,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.description).toContain('Magikarp');
    expect(result.result.description).not.toContain('species 129');
    const edit = result.result.edits[0]! as { note?: string };
    expect(edit.note).toContain('Magikarp');
  });

  it('bulkReplaceSpecies falls back to "species N" when speciesNames is missing the id', async () => {
    await writeManifest(root, manifest([makeTable()]));
    await fsp.writeFile(path.join(root, 'test.gba'), buildFakeRom());
    const result = await computeEncounterTableEdit(root, {
      encounterTableId: 'binary_encounter_2_0_land',
      op: 'bulkReplaceSpecies',
      speciesId: 129,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.description).toContain('species 129');
  });
});

describe('proposeEncounterTableEdit (agent flow)', () => {
  let root: string;
  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(tmpdir(), 'propose-enc-table-edit-'));
  });
  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  it('registers a proposal via proposePatch for setRate', async () => {
    await writeManifest(root, manifest([makeTable()]));
    await fsp.writeFile(path.join(root, 'test.gba'), buildFakeRom());
    const { fetchFn, captured } = fakeProposalFetch();
    const result = await proposeEncounterTableEdit(
      { projectRoot: root, baseUrl: 'http://127.0.0.1:8717' },
      {
        encounterTableId: 'binary_encounter_2_0_land',
        op: 'setRate',
        encounterRate: 75,
      },
      { fetchFn },
    );
    expect(result.proposal).not.toBeNull();
    expect(result.op).toBe('setRate');
    const body = captured();
    expect(body).not.toBeNull();
    expect(body!.edits).toHaveLength(1);
  });

  it('propagates compute failures as null-proposal results', async () => {
    await writeManifest(root, manifest([]));
    const result = await proposeEncounterTableEdit(
      { projectRoot: root, baseUrl: 'http://x' },
      {
        encounterTableId: 'nonexistent',
        op: 'setRate',
        encounterRate: 50,
      },
    );
    expect(result.proposal).toBeNull();
    expect(result.message).toMatch(/not in manifest/);
  });
});
