import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { detectProject } from '../detect/index.js';
import { scanProject } from '../scan/index.js';
import { searchManifest } from '../search/search.js';

// Phase 12 criterion 2 - "stable under large hack projects" - requires we
// can actually scan + lint + search a project at realistic upper-bound size.
// These tests build a synthetic decomp on disk with parameters chosen to
// exceed any real-world Pokémon ROM hack I've measured (pokeemerald has
// ~250 maps; we test against 50 here - generously below to keep the test
// CI-friendly, but the *budget* assertions hold even if you bump scale).

interface LargeProjectShape {
  readonly mapCount: number;
  readonly objectEventsPerMap: number;
  readonly warpsPerMap: number;
  readonly flagsTotal: number;
  readonly varsTotal: number;
  readonly trainerCount: number;
  readonly dialogueLinesPerMap: number;
}

function buildLargeDecompFixture(root: string, shape: LargeProjectShape): void {
  writeFileSync(path.join(root, 'Makefile'), 'all:\n\techo build\n');
  writeFileSync(path.join(root, 'pokeemerald.ld'), '/* linker */\n');
  mkdirSync(path.join(root, 'include', 'constants'), { recursive: true });
  mkdirSync(path.join(root, 'src'));
  mkdirSync(path.join(root, 'data', 'maps'), { recursive: true });
  mkdirSync(path.join(root, 'data', 'scripts'), { recursive: true });
  mkdirSync(path.join(root, 'gflib'), { recursive: true });

  // Maps + per-map object events + warps + text.inc dialogue + scripts.inc
  for (let i = 0; i < shape.mapCount; i++) {
    const dirName = `Map_${String(i).padStart(3, '0')}`;
    const mapId = `MAP_${String(i).padStart(3, '0')}`;
    const mapDir = path.join(root, 'data', 'maps', dirName);
    mkdirSync(mapDir);

    const objectEvents = Array.from({ length: shape.objectEventsPerMap }, (_, k) => ({
      id: `o${k}`,
      x: k * 2,
      y: 5,
      elevation: 3,
      script: `Map${i}_Obj${k}_Script`,
      flag: k === 0 ? `FLAG_MAP_${i}_OBJ_${k}_DONE` : null,
      graphics_id: 'OBJ_EVENT_GFX_PLACEHOLDER',
      movement_type: 'NO_MOVEMENT',
      trainer_type: 'TRAINER_TYPE_NONE',
    }));

    const warps = Array.from({ length: shape.warpsPerMap }, (_, k) => ({
      id: `w${k}`,
      x: k * 4,
      y: 0,
      elevation: 3,
      dest_map: `MAP_${String((i + 1) % shape.mapCount).padStart(3, '0')}`,
      dest_warp_id: 0,
    }));

    writeFileSync(
      path.join(mapDir, 'map.json'),
      JSON.stringify({
        id: mapId,
        name: dirName.toUpperCase(),
        layout: `LAYOUT_${mapId}`,
        music: `MUS_${mapId}`,
        region_map_section: `MAPSEC_${mapId}`,
        requires_flash: false,
        weather: 'WEATHER_NONE',
        map_type: 'MAP_TYPE_TOWN',
        battle_scene: 'MAP_BATTLE_SCENE_NORMAL',
        connections: null,
        object_events: objectEvents,
        warp_events: warps,
        coord_events: [
          { x: 5, y: 5, elevation: 3, script: `Map${i}_Trigger0` },
        ],
        bg_events: [],
      }),
    );

    // Text.inc with N dialogue labels
    const textLines: string[] = [];
    for (let d = 0; d < shape.dialogueLinesPerMap; d++) {
      textLines.push(
        `Map${i}_Text${d}::`,
        `\t.string "Map ${i} text line ${d}."$`,
        '',
      );
    }
    writeFileSync(path.join(mapDir, 'text.inc'), textLines.join('\n'));

    // Scripts.inc with msgbox + setflag + branch macros (typed by parser)
    const scriptLines: string[] = [];
    for (let s = 0; s < shape.objectEventsPerMap; s++) {
      scriptLines.push(
        `Map${i}_Obj${s}_Script::`,
        `\tlock`,
        `\tmsgbox Map${i}_Text${s % shape.dialogueLinesPerMap}, MSGBOX_DEFAULT`,
        `\tsetflag FLAG_MAP_${i}_OBJ_${s}_DONE`,
        `\trelease`,
        `\treturn`,
        '',
      );
    }
    scriptLines.push(
      `Map${i}_Trigger0::`,
      `\tgoto_if_set FLAG_MAP_${i}_SEEN, Map${i}_Trigger0_End`,
      `\tsetflag FLAG_MAP_${i}_SEEN`,
      `Map${i}_Trigger0_End:`,
      `\treturn`,
      '',
    );
    writeFileSync(path.join(mapDir, 'scripts.inc'), scriptLines.join('\n'));
  }

  // Flags + Variables in include/constants/{flags,vars}.h
  const flagLines: string[] = ['#ifndef GUARD_FLAGS_H', '#define GUARD_FLAGS_H', ''];
  for (let i = 0; i < shape.flagsTotal; i++) {
    flagLines.push(`#define FLAG_GLOBAL_${i.toString(16).padStart(4, '0')} 0x${(0x900 + i).toString(16)}`);
  }
  // Plus the per-map flags referenced above
  for (let i = 0; i < shape.mapCount; i++) {
    for (let k = 0; k < shape.objectEventsPerMap; k++) {
      flagLines.push(`#define FLAG_MAP_${i}_OBJ_${k}_DONE 0x${(0x2000 + i * 100 + k).toString(16)}`);
    }
    flagLines.push(`#define FLAG_MAP_${i}_SEEN 0x${(0x3000 + i).toString(16)}`);
  }
  flagLines.push('', '#endif');
  writeFileSync(path.join(root, 'include', 'constants', 'flags.h'), flagLines.join('\n'));

  const varLines: string[] = ['#ifndef GUARD_VARS_H', '#define GUARD_VARS_H', ''];
  for (let i = 0; i < shape.varsTotal; i++) {
    varLines.push(`#define VAR_GLOBAL_${i.toString(16).padStart(4, '0')} 0x${(0x4000 + i).toString(16)}`);
  }
  varLines.push('', '#endif');
  writeFileSync(path.join(root, 'include', 'constants', 'vars.h'), varLines.join('\n'));

  // Trainers in src/data/trainers.h
  mkdirSync(path.join(root, 'src', 'data'), { recursive: true });
  const trainerLines: string[] = ['static const struct Trainer gTrainers[] = {'];
  for (let i = 0; i < shape.trainerCount; i++) {
    trainerLines.push(
      `\t[TRAINER_${i.toString().padStart(3, '0')}] = {`,
      `\t\t.partyFlags = 0,`,
      `\t\t.trainerClass = TRAINER_CLASS_YOUNGSTER,`,
      `\t\t.encounterMusic_gender = TRAINER_ENCOUNTER_MUSIC_MALE,`,
      `\t\t.trainerPic = TRAINER_PIC_YOUNGSTER,`,
      `\t\t.trainerName = _("Trainer ${i}"),`,
      `\t},`,
    );
  }
  trainerLines.push('};');
  writeFileSync(path.join(root, 'src', 'data', 'trainers.h'), trainerLines.join('\n'));
}

describe('large-project perf', () => {
  let projectRoot: string;
  const shape: LargeProjectShape = {
    mapCount: 50,
    objectEventsPerMap: 5,
    warpsPerMap: 2,
    flagsTotal: 200,
    varsTotal: 50,
    trainerCount: 30,
    dialogueLinesPerMap: 10,
  };

  beforeEach(() => {
    projectRoot = mkdtempSync(path.join(tmpdir(), 'rom-editor-perf-'));
    buildLargeDecompFixture(projectRoot, shape);
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('detects the synthetic decomp project as kind=decomp', async () => {
    const identity = await detectProject(projectRoot);
    expect(identity.kind).toBe('decomp');
  });

  it('scanProject completes within the 5000ms budget for a 50-map / 250-script project', async () => {
    const t0 = performance.now();
    const result = await scanProject(projectRoot);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(5000);
    // Indexed counts are concrete + non-trivial; if the scanner silently
    // dropped most of the content the perf number would be meaningless.
    // Lower bounds rather than exact equality because the parsers
    // legitimately dedupe / filter (e.g. a flag declared in multiple
    // headers, an object-event with an unrecognized script).
    expect(result.manifest.maps).toHaveLength(shape.mapCount);
    expect(result.manifest.objectEvents.length).toBeGreaterThanOrEqual(
      shape.mapCount * shape.objectEventsPerMap,
    );
    expect(result.manifest.warps.length).toBeGreaterThanOrEqual(
      shape.mapCount * shape.warpsPerMap,
    );
    // Global flags must all be picked up. Per-map flags may dedupe.
    expect(result.manifest.flags.length).toBeGreaterThanOrEqual(shape.flagsTotal);
    // Dialogue: at least one label per map should be parsed from text.inc.
    expect(result.manifest.dialogue.length).toBeGreaterThanOrEqual(shape.mapCount);
    // Scriptsteps from the per-map scripts.inc.
    expect(result.manifest.scriptSteps.length).toBeGreaterThan(0);
  });

  it('searchManifest stays under the 200ms per-query budget for 4 common queries', async () => {
    const result = await scanProject(projectRoot);
    const queries = ['MAP_001', 'FLAG_GLOBAL_0010', 'Trainer 5', 'Text0'];
    for (const q of queries) {
      const t0 = performance.now();
      const r = searchManifest(result.manifest, q, { limit: 50 });
      const elapsed = performance.now() - t0;
      expect(elapsed).toBeLessThan(200);
      expect(r.hits.length).toBeGreaterThan(0);
    }
  });
});
