#!/usr/bin/env node
// Integration smoke test: boots the built backend, exercises:
//   - GET  /api/health - service status payload
//   - POST /api/projects/open - open a real temp directory, get session + listing
//   - GET  /api/projects/:id/listing - list a subdirectory
// then shuts down. Exits 0 on pass, 1 on fail.
//
// Run with: node tests/smoke.mjs   (from the repo root)

import { setTimeout as sleep } from 'node:timers/promises';
import { spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const backendDir = resolve(repoRoot, 'app', 'backend');

const PORT = 18717;
const HOST = '127.0.0.1';
const BASE = `http://${HOST}:${PORT}`;

const child = spawn(process.execPath, ['./dist/index.js'], {
  cwd: backendDir,
  env: { ...process.env, PORT: String(PORT), HOST },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let stdout = '';
let stderr = '';
child.stdout.on('data', (c) => {
  stdout += c.toString();
});
child.stderr.on('data', (c) => {
  stderr += c.toString();
});

let exited = false;
child.on('exit', (code) => {
  exited = true;
  if (code !== null && code !== 0) {
    console.error(`[smoke] backend exited early with code ${code}`);
  }
});

const cleanup = () => {
  if (!exited) {
    try {
      child.kill();
    } catch {
      /* ignore */
    }
  }
};
process.on('exit', cleanup);
process.on('SIGINT', () => {
  cleanup();
  process.exit(130);
});

const fail = (msg) => {
  console.error(`[smoke] FAIL: ${msg}`);
  console.error('[smoke] backend stdout:\n' + stdout);
  console.error('[smoke] backend stderr:\n' + stderr);
  cleanup();
  process.exit(1);
};

async function waitForReady() {
  let lastErr = null;
  for (let i = 0; i < 100; i++) {
    if (exited) fail('backend exited before responding');
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return await r.json();
      lastErr = new Error(`HTTP ${r.status}`);
    } catch (e) {
      lastErr = e;
    }
    await sleep(100);
  }
  fail(`backend did not respond in 10s. last error: ${lastErr?.message ?? 'unknown'}`);
}

async function runHealth() {
  const body = await waitForReady();
  if (body.status !== 'ok') fail(`unexpected health status: ${JSON.stringify(body)}`);
  if (body.service !== 'rom-editor-backend') fail(`unexpected service: ${JSON.stringify(body)}`);
  if (typeof body.version !== 'string') fail(`missing version: ${JSON.stringify(body)}`);
  if (typeof body.uptimeSeconds !== 'number') fail(`missing uptimeSeconds: ${JSON.stringify(body)}`);
  console.log('[smoke] PASS: /api/health =', body);
}

async function runProjectOpen() {
  const tmpDir = await fsp.mkdtemp(join(os.tmpdir(), 'rom-editor-smoke-'));
  try {
    await fsp.writeFile(join(tmpDir, 'README.md'), '# smoke test project\n');
    await fsp.mkdir(join(tmpDir, 'data', 'maps'), { recursive: true });
    await fsp.writeFile(join(tmpDir, 'data', 'maps', 'town.json'), '{}');

    const openRes = await fetch(`${BASE}/api/projects/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectRoot: tmpDir }),
    });
    if (!openRes.ok) fail(`/api/projects/open returned ${openRes.status}`);
    const open = await openRes.json();
    if (!open.session?.id) fail(`open response missing session.id: ${JSON.stringify(open)}`);
    if (!Array.isArray(open.rootListing?.entries)) {
      fail(`open response missing rootListing.entries: ${JSON.stringify(open)}`);
    }
    const readme = open.rootListing.entries.find((e) => e.name === 'README.md');
    if (!readme) fail(`README.md not in root listing: ${JSON.stringify(open.rootListing)}`);
    if (readme.kind !== 'file') fail(`README.md kind != 'file': ${JSON.stringify(readme)}`);
    if (typeof readme.sizeBytes !== 'number' || readme.sizeBytes <= 0) {
      fail(`README.md sizeBytes wrong: ${JSON.stringify(readme)}`);
    }
    if (!open.identity || typeof open.identity.kind !== 'string') {
      fail(`open response missing identity: ${JSON.stringify(open)}`);
    }
    if (!Array.isArray(open.identity.evidence)) {
      fail(`identity.evidence is not an array: ${JSON.stringify(open.identity)}`);
    }
    if (typeof open.identity.confidence !== 'number') {
      fail(`identity.confidence is not a number: ${JSON.stringify(open.identity)}`);
    }
    // A bare README+data fixture should NOT clear the decomp/patch thresholds.
    if (open.identity.kind !== 'unknown') {
      fail(`expected identity.kind='unknown' for bare fixture, got ${open.identity.kind}`);
    }
    console.log(
      '[smoke] PASS: /api/projects/open id=',
      open.session.id,
      'identity=',
      open.identity.kind,
      'confidence=',
      open.identity.confidence,
    );

    const listRes = await fetch(
      `${BASE}/api/projects/${open.session.id}/listing?path=${encodeURIComponent('data/maps')}`,
    );
    if (!listRes.ok) fail(`/api/projects/:id/listing returned ${listRes.status}`);
    const listing = await listRes.json();
    if (listing.path !== 'data/maps') fail(`listing.path wrong: ${JSON.stringify(listing)}`);
    if (!listing.entries.some((e) => e.name === 'town.json')) {
      fail(`town.json not in subdir listing: ${JSON.stringify(listing)}`);
    }
    console.log('[smoke] PASS: /api/projects/:id/listing path=data/maps entries=', listing.entries.length);

    const escRes = await fetch(
      `${BASE}/api/projects/${open.session.id}/listing?path=${encodeURIComponent('../..')}`,
    );
    if (escRes.status !== 400) fail(`expected 400 on traversal, got ${escRes.status}`);
    const escBody = await escRes.json();
    if (escBody.error?.code !== 'path_escapes_project_root') {
      fail(`expected path_escapes_project_root, got ${JSON.stringify(escBody)}`);
    }
    console.log('[smoke] PASS: traversal blocked with', escBody.error.code);
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
}

async function runDecompDetection() {
  const tmpDir = await fsp.mkdtemp(join(os.tmpdir(), 'rom-editor-smoke-decomp-'));
  try {
    await fsp.writeFile(join(tmpDir, 'Makefile'), 'all:\n\techo build\n');
    await fsp.writeFile(join(tmpDir, 'pokeemerald.ld'), '/* linker */\n');
    await fsp.mkdir(join(tmpDir, 'src'));
    await fsp.mkdir(join(tmpDir, 'include'));
    await fsp.mkdir(join(tmpDir, 'data'));
    await fsp.mkdir(join(tmpDir, 'tools', 'agbcc'), { recursive: true });

    // Add real headers so the scanner has flags/vars to index
    await fsp.mkdir(join(tmpDir, 'include', 'constants'), { recursive: true });
    await fsp.writeFile(
      join(tmpDir, 'include', 'constants', 'flags.h'),
      [
        '// Story flags',
        '#define FLAG_VISITED_LITTLEROOT 0x800  // First town visited',
        '#define FLAG_BADGE01_GET 0x807',
        '#define FLAG_TEMP_BOULDER 0x10',
        '',
      ].join('\n'),
    );
    await fsp.writeFile(
      join(tmpDir, 'include', 'constants', 'vars.h'),
      [
        '#define VAR_LITTLEROOT_INTRO_STATE 0x4080  // Intro cutscene step',
        '#define VAR_TEMP_0 0x0',
        '',
      ].join('\n'),
    );

    // Add trainers + parties so the scanner has trainers to index
    await fsp.mkdir(join(tmpDir, 'src', 'data'), { recursive: true });
    await fsp.writeFile(
      join(tmpDir, 'src', 'data', 'trainers.h'),
      [
        'const struct Trainer gTrainers[] = {',
        '  [TRAINER_NONE] = { .trainerClass = TRAINER_CLASS_PKMN_TRAINER_1, .trainerName = _(""), .aiFlags = 0, .party = { .NoItemDefaultMoves = NULL } },',
        '  [TRAINER_RIVAL_1] = { .trainerClass = TRAINER_CLASS_RIVAL, .trainerName = _("BRENDAN"), .aiFlags = AI_SCRIPT_CHECK_BAD_MOVE, .party = { .NoItemDefaultMoves = sParty_Rival1 } },',
        '};',
        '',
      ].join('\n'),
    );
    await fsp.writeFile(
      join(tmpDir, 'src', 'data', 'trainer_parties.h'),
      [
        'static const struct TrainerMon sParty_Rival1[] = {',
        '  { .lvl = 5, .species = SPECIES_TREECKO },',
        '  { .lvl = 5, .species = SPECIES_ZIGZAGOON },',
        '  { .lvl = 6, .species = SPECIES_POOCHYENA },',
        '};',
        '',
      ].join('\n'),
    );

    // Add wild_encounters.json so the scanner has tables to index
    await fsp.writeFile(
      join(tmpDir, 'src', 'data', 'wild_encounters.json'),
      JSON.stringify({
        wild_encounter_groups: [
          {
            fields: [{ type: 'land_mons', encounter_rates: [20, 20, 10] }],
            encounters: [
              {
                map: 'MAP_ROUTE101',
                base_label: 'gRoute101',
                land_mons: {
                  encounter_rate: 20,
                  mons: [
                    { min_level: 2, max_level: 2, species: 'SPECIES_POOCHYENA' },
                    { min_level: 2, max_level: 3, species: 'SPECIES_ZIGZAGOON' },
                    { min_level: 3, max_level: 3, species: 'SPECIES_WURMPLE' },
                  ],
                },
              },
            ],
          },
        ],
      }),
    );

    // Two maps that warp into each other + one NPC + one sign trigger
    await fsp.mkdir(join(tmpDir, 'data', 'maps', 'LittlerootTown'), { recursive: true });
    await fsp.writeFile(
      join(tmpDir, 'data', 'maps', 'LittlerootTown', 'map.json'),
      JSON.stringify({
        id: 'MAP_LITTLEROOT_TOWN',
        name: 'LITTLEROOT_TOWN',
        layout: 'LAYOUT_LITTLEROOT_TOWN',
        music: 'MUS_LITTLEROOT_TOWN',
        map_type: 'MAP_TYPE_TOWN',
        object_events: [
          {
            graphics_id: 'OBJ_EVENT_GFX_BOY',
            x: 10,
            y: 12,
            elevation: 3,
            trainer_type: 'TRAINER_TYPE_NONE',
            script: 'LittlerootTown_EventScript_Boy',
            flag: '0',
          },
        ],
        warp_events: [{ x: 4, y: 5, elevation: 0, dest_map: 'MAP_ROUTE101', dest_warp_id: '0' }],
        coord_events: [],
        bg_events: [
          {
            type: 'sign',
            x: 6,
            y: 8,
            elevation: 0,
            player_facing_dir: 'BG_EVENT_PLAYER_FACING_ANY',
            script: 'LittlerootTown_Sign',
          },
        ],
      }),
    );
    await fsp.mkdir(join(tmpDir, 'data', 'maps', 'Route101'), { recursive: true });
    await fsp.writeFile(
      join(tmpDir, 'data', 'maps', 'Route101', 'map.json'),
      JSON.stringify({
        id: 'MAP_ROUTE101',
        name: 'ROUTE101',
        map_type: 'MAP_TYPE_ROUTE',
        object_events: [],
        warp_events: [{ x: 20, y: 5, dest_map: 'MAP_LITTLEROOT_TOWN', dest_warp_id: '0' }],
        coord_events: [],
        bg_events: [],
      }),
    );

    // Add assets so the asset parser has content
    await fsp.mkdir(join(tmpDir, 'graphics', 'object_events', 'pics'), { recursive: true });
    await fsp.mkdir(join(tmpDir, 'graphics', 'tilesets'), { recursive: true });
    await fsp.mkdir(join(tmpDir, 'sound', 'songs'), { recursive: true });
    await fsp.writeFile(join(tmpDir, 'graphics', 'object_events', 'pics', 'boy.png'), 'png-bytes');
    await fsp.writeFile(join(tmpDir, 'graphics', 'tilesets', 'primary.png'), 'png-bytes');
    await fsp.writeFile(join(tmpDir, 'graphics', 'tilesets', 'primary.pal'), 'pal-bytes');
    await fsp.writeFile(join(tmpDir, 'sound', 'songs', 'littleroot.aif'), 'aif-bytes');

    // Add a scripts.inc so the script decoder has content
    await fsp.writeFile(
      join(tmpDir, 'data', 'maps', 'LittlerootTown', 'scripts.inc'),
      [
        'LittlerootTown_Sign::',
        '\tlock',
        '\tmsgbox LittlerootTown_Sign_Text_RouteSign, MSGBOX_SIGN',
        '\trelease',
        '\tend',
        '',
      ].join('\n'),
    );

    // Add per-map text.inc files so the dialogue parser has content
    await fsp.writeFile(
      join(tmpDir, 'data', 'maps', 'LittlerootTown', 'text.inc'),
      [
        'LittlerootTown_Mom_Text_WelcomeHome::',
        '\t.string "Hi, honey! Welcome back!$"',
        '',
        'LittlerootTown_Sign_Text_RouteSign::',
        '\t.string "ROUTE 101 ENTRANCE$"',
        '',
      ].join('\n'),
    );

    const res = await fetch(`${BASE}/api/projects/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectRoot: tmpDir }),
    });
    if (!res.ok) fail(`decomp open returned ${res.status}`);
    const open = await res.json();
    if (open.identity.kind !== 'decomp') {
      fail(`expected kind='decomp', got '${open.identity.kind}': ${JSON.stringify(open.identity)}`);
    }
    if (open.identity.baseGame !== 'pokeemerald') {
      fail(`expected baseGame='pokeemerald', got '${open.identity.baseGame}'`);
    }
    if (open.identity.confidence < 0.9) {
      fail(`expected confidence>=0.9, got ${open.identity.confidence}`);
    }
    console.log(
      '[smoke] PASS: decomp detection =',
      open.identity.kind,
      open.identity.displayName,
      'confidence=',
      open.identity.confidence,
    );

    // Now scan the project - verify the manifest is built and persisted.
    const scanRes = await fetch(`${BASE}/api/projects/${open.session.id}/scan`, { method: 'POST' });
    if (!scanRes.ok) fail(`scan returned ${scanRes.status}`);
    const scan = await scanRes.json();
    if (scan.scannerName !== 'DecompScanner') {
      fail(`expected scannerName=DecompScanner, got '${scan.scannerName}'`);
    }
    if (!Array.isArray(scan.manifest?.maps)) {
      fail(`scan response missing manifest.maps: ${JSON.stringify(scan)}`);
    }
    if (scan.manifest.maps.length !== 2) {
      fail(`expected 2 maps from scanner, got ${scan.manifest.maps.length}`);
    }
    const mapIds = scan.manifest.maps.map((m) => m.id).sort();
    if (mapIds[0] !== 'MAP_LITTLEROOT_TOWN' || mapIds[1] !== 'MAP_ROUTE101') {
      fail(`unexpected map ids: ${JSON.stringify(mapIds)}`);
    }
    // Warp bidirectionality: 2 warps total (LT→R101 and R101→LT)
    if (scan.manifest.warps.length !== 2) {
      fail(`expected 2 warps, got ${scan.manifest.warps.length}`);
    }
    const outbound = scan.manifest.warps.find((w) => w.fromMapId === 'MAP_LITTLEROOT_TOWN');
    if (outbound?.toMapId !== 'MAP_ROUTE101') {
      fail(`outbound warp destination wrong: ${JSON.stringify(outbound)}`);
    }
    if (outbound.toCoord.x !== 20 || outbound.toCoord.y !== 5) {
      fail(`outbound toCoord not resolved: ${JSON.stringify(outbound.toCoord)}`);
    }
    // Object events + bg-event trigger
    if (scan.manifest.objectEvents.length !== 1) {
      fail(`expected 1 object event, got ${scan.manifest.objectEvents.length}`);
    }
    if (scan.manifest.objectEvents[0].kind !== 'npc') {
      fail(`object event kind wrong: ${scan.manifest.objectEvents[0].kind}`);
    }
    if (scan.manifest.triggers.length !== 1) {
      fail(`expected 1 trigger (bg sign), got ${scan.manifest.triggers.length}`);
    }
    if (scan.manifest.triggers[0].kind !== 'on_interact') {
      fail(`trigger kind wrong: ${scan.manifest.triggers[0].kind}`);
    }
    // Flags + variables from headers
    if (scan.manifest.flags.length !== 3) {
      fail(`expected 3 flags, got ${scan.manifest.flags.length}`);
    }
    if (scan.manifest.variables.length !== 2) {
      fail(`expected 2 variables, got ${scan.manifest.variables.length}`);
    }
    const tempFlag = scan.manifest.flags.find((f) => f.id === 'FLAG_TEMP_BOULDER');
    if (tempFlag?.scope !== 'temporary') {
      fail(`FLAG_TEMP_BOULDER scope wrong: ${JSON.stringify(tempFlag)}`);
    }
    const visited = scan.manifest.flags.find((f) => f.id === 'FLAG_VISITED_LITTLEROOT');
    if (visited?.description !== 'First town visited') {
      fail(`FLAG_VISITED_LITTLEROOT description wrong: ${JSON.stringify(visited)}`);
    }
    // Persistence: read the on-disk manifest and verify it matches
    const onDisk = JSON.parse(await fsp.readFile(scan.manifestPath, 'utf8'));
    if (onDisk.schemaVersion !== 1) fail(`on-disk manifest.schemaVersion != 1`);
    if (onDisk.maps.length !== 2) fail(`on-disk manifest.maps.length != 2`);
    if (onDisk.warps.length !== 2) fail(`on-disk manifest.warps.length != 2`);
    if (onDisk.objectEvents.length !== 1) fail(`on-disk objectEvents.length != 1`);
    if (onDisk.flags.length !== 3) fail(`on-disk flags.length != 3`);
    if (onDisk.variables.length !== 2) fail(`on-disk variables.length != 2`);
    if (scan.manifest.encounterTables.length !== 1) {
      fail(`expected 1 encounter table, got ${scan.manifest.encounterTables.length}`);
    }
    if (scan.manifest.encounterTables[0].slots.length !== 3) {
      fail(`expected 3 slots, got ${scan.manifest.encounterTables[0].slots.length}`);
    }
    const route = scan.manifest.maps.find((m) => m.id === 'MAP_ROUTE101');
    if (!route || route.encounterTableIds.length !== 1) {
      fail(`Route101 encounter wiring wrong: ${JSON.stringify(route)}`);
    }
    if (onDisk.encounterTables.length !== 1) fail(`on-disk encounterTables.length != 1`);
    if (scan.manifest.trainers.length !== 2) {
      fail(`expected 2 trainers, got ${scan.manifest.trainers.length}`);
    }
    const rival = scan.manifest.trainers.find((t) => t.id === 'TRAINER_RIVAL_1');
    if (!rival || rival.party.length !== 3) {
      fail(`rival trainer wrong: ${JSON.stringify(rival)}`);
    }
    if (rival.name !== 'BRENDAN' || rival.className !== 'TRAINER_CLASS_RIVAL') {
      fail(`rival fields wrong: ${JSON.stringify(rival)}`);
    }
    if (onDisk.trainers.length !== 2) fail(`on-disk trainers.length != 2`);
    if (scan.manifest.dialogue.length !== 2) {
      fail(`expected 2 dialogue nodes, got ${scan.manifest.dialogue.length}`);
    }
    const mom = scan.manifest.dialogue.find((d) => d.id === 'LittlerootTown_Mom_Text_WelcomeHome');
    if (!mom || mom.speakerName !== 'Mom') {
      fail(`mom dialogue wrong: ${JSON.stringify(mom)}`);
    }
    if (!mom.text.startsWith('Hi, honey!')) {
      fail(`mom dialogue text wrong: ${JSON.stringify(mom.text)}`);
    }
    if (onDisk.dialogue.length !== 2) fail(`on-disk dialogue.length != 2`);
    if (scan.manifest.assets.length !== 4) {
      fail(`expected 4 assets, got ${scan.manifest.assets.length}`);
    }
    const npcAsset = scan.manifest.assets.find((a) => a.id === 'graphics/object_events/pics/boy.png');
    if (!npcAsset || npcAsset.kind !== 'overworld_sprite') {
      fail(`npc asset wrong: ${JSON.stringify(npcAsset)}`);
    }
    const bgmAsset = scan.manifest.assets.find((a) => a.id === 'sound/songs/littleroot.aif');
    if (!bgmAsset || bgmAsset.kind !== 'music') {
      fail(`bgm asset wrong: ${JSON.stringify(bgmAsset)}`);
    }
    if (onDisk.assets.length !== 4) fail(`on-disk assets.length != 4`);
    if (scan.manifest.scriptSteps.length < 4) {
      fail(`expected at least 4 script steps, got ${scan.manifest.scriptSteps.length}`);
    }
    const signTrigger = scan.manifest.triggers.find((t) => t.id === 'MAP_LITTLEROOT_TOWN_bg_0');
    if (!signTrigger || signTrigger.scriptStepIds.length === 0) {
      fail(`sign trigger script steps not resolved: ${JSON.stringify(signTrigger)}`);
    }
    if (signTrigger.scriptStepIds[0] !== 'LittlerootTown_Sign__0') {
      fail(`first script step id wrong: ${signTrigger.scriptStepIds[0]}`);
    }
    const signMsgbox = scan.manifest.scriptSteps.find((s) => s.id === 'LittlerootTown_Sign__1');
    if (signMsgbox?.kind !== 'dialogue' || signMsgbox?.params?.text !== 'LittlerootTown_Sign_Text_RouteSign') {
      fail(`msgbox step wrong: ${JSON.stringify(signMsgbox)}`);
    }
    if (onDisk.scriptSteps.length < 4) fail(`on-disk scriptSteps.length < 4`);

    // Search the manifest for "littleroot" - should hit map + dialogue at least.
    const searchRes = await fetch(`${BASE}/api/projects/${open.session.id}/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'littleroot', limit: 10 }),
    });
    if (!searchRes.ok) fail(`/api/projects/:id/search returned ${searchRes.status}`);
    const search = await searchRes.json();
    if (!Array.isArray(search.hits) || search.hits.length === 0) {
      fail(`search returned no hits: ${JSON.stringify(search)}`);
    }
    const searchKinds = new Set(search.hits.map((h) => h.entityKind));
    if (!searchKinds.has('map')) {
      fail(`search did not return a map hit: ${JSON.stringify(search.hits)}`);
    }
    console.log('[smoke] PASS: search "littleroot" =', search.hits.length, 'hits across kinds', Array.from(searchKinds).sort());

    // Build profile should be detected: Makefile + pokeemerald.ld in fixture
    if (!scan.manifest.buildProfile) {
      fail(`buildProfile is null but Makefile + pokeemerald.ld are present`);
    }
    if (scan.manifest.buildProfile.buildCommand !== 'make') {
      fail(`buildCommand wrong: ${JSON.stringify(scan.manifest.buildProfile)}`);
    }

    // Build endpoint: invoke a real cross-platform command (node -e) to verify
    // the pipeline works end-to-end. We don't try `make` because not every host
    // has it installed - but the runner itself MUST execute real processes.
    const buildRes = await fetch(`${BASE}/api/projects/${open.session.id}/build`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        argvOverride: [process.execPath, '-e', 'console.log("BUILD_OK_SMOKE")'],
      }),
    });
    if (!buildRes.ok) fail(`/api/projects/:id/build returned ${buildRes.status}`);
    const build = await buildRes.json();
    if (build.exitCode !== 0) fail(`build exit != 0: ${JSON.stringify(build)}`);
    if (!build.stdout.includes('BUILD_OK_SMOKE')) {
      fail(`build stdout did not contain expected marker: ${JSON.stringify(build.stdout)}`);
    }
    console.log('[smoke] PASS: build profile =', scan.manifest.buildProfile.toolchain,
      'invocation exit=', build.exitCode, 'durationMs=', build.durationMs);
    console.log(
      '[smoke] PASS: scan =',
      scan.scannerName,
      'maps=',
      scan.manifest.maps.length,
      'warps=',
      scan.manifest.warps.length,
      'triggers=',
      scan.manifest.triggers.length,
      'objectEvents=',
      scan.manifest.objectEvents.length,
      'flags=',
      scan.manifest.flags.length,
      'vars=',
      scan.manifest.variables.length,
      'encounterTables=',
      scan.manifest.encounterTables.length,
      'trainers=',
      scan.manifest.trainers.length,
      'dialogue=',
      scan.manifest.dialogue.length,
      'assets=',
      scan.manifest.assets.length,
      'scriptSteps=',
      scan.manifest.scriptSteps.length,
      `(${scan.scanDurationMs}ms)`,
    );
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
}

async function runPatchDetection() {
  const tmpDir = await fsp.mkdtemp(join(os.tmpdir(), 'rom-editor-smoke-patch-'));
  try {
    await fsp.writeFile(join(tmpDir, 'mod.ips'), 'patch bytes');
    await fsp.writeFile(join(tmpDir, 'base.gba'), 'rom bytes');

    const res = await fetch(`${BASE}/api/projects/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectRoot: tmpDir }),
    });
    if (!res.ok) fail(`patch open returned ${res.status}`);
    const open = await res.json();
    if (open.identity.kind !== 'patch') {
      fail(`expected kind='patch', got '${open.identity.kind}': ${JSON.stringify(open.identity)}`);
    }
    console.log(
      '[smoke] PASS: patch detection =',
      open.identity.kind,
      open.identity.displayName,
      'confidence=',
      open.identity.confidence,
    );
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
}

async function runHybridDetection() {
  const tmpDir = await fsp.mkdtemp(join(os.tmpdir(), 'rom-editor-smoke-hybrid-'));
  try {
    // decomp signals
    await fsp.writeFile(join(tmpDir, 'Makefile'), 'all:\n\techo build\n');
    await fsp.writeFile(join(tmpDir, 'pokefirered.ld'), '/* linker */\n');
    await fsp.mkdir(join(tmpDir, 'src'));
    await fsp.mkdir(join(tmpDir, 'include'));
    await fsp.mkdir(join(tmpDir, 'data'));
    // patch signals
    await fsp.writeFile(join(tmpDir, 'released.ips'), 'patch');
    await fsp.writeFile(join(tmpDir, 'base.gba'), 'rom');

    const res = await fetch(`${BASE}/api/projects/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectRoot: tmpDir }),
    });
    if (!res.ok) fail(`hybrid open returned ${res.status}`);
    const open = await res.json();
    if (open.identity.kind !== 'hybrid') {
      fail(`expected kind='hybrid', got '${open.identity.kind}': ${JSON.stringify(open.identity)}`);
    }
    if (open.identity.baseGame !== 'pokefirered') {
      fail(`expected baseGame='pokefirered', got '${open.identity.baseGame}'`);
    }
    console.log(
      '[smoke] PASS: hybrid detection =',
      open.identity.kind,
      open.identity.displayName,
    );
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
}

try {
  await runHealth();
  await runProjectOpen();
  await runDecompDetection();
  await runPatchDetection();
  await runHybridDetection();
  console.log('[smoke] ALL CHECKS PASSED');
  cleanup();
  process.exit(0);
} catch (e) {
  fail(`unexpected error: ${e instanceof Error ? e.stack : String(e)}`);
}
