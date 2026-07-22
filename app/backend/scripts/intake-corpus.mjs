// Intake + scan each of the three corpus ROMs the AI-pivot plan
// pins as verification targets. Writes a managed project dir
// under %APPDATA%\rom-editor\projects\<sha1>\ for each, then
// runs the binary-rom scanner so .editor/manifest.json is on disk.
//
// One-off helper - invoke once after a fresh clone:
//   node scripts/intake-corpus.mjs
//
// Outputs the managed project root for each ROM so the next
// session can locate them without re-intaking.
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { intakeFile } from '../dist/projects/intake.js';
import { scanProject, writeManifest } from '../dist/scan/index.js';

const ROMS = [
  'C:\\path\\to\\roms\\Pokemon - FireRed Version (USA).gba',
  'C:\\path\\to\\roms\\Pokémon Unbound (v2.1.1.1).gba',
  'C:\\path\\to\\roms\\Radical Red (4.10).gba',
];

async function summarize(manifestPath) {
  const m = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
  return {
    identity: m.identity?.displayName ?? m.identity?.kind,
    sha1: m.identity?.romBinary?.variant ?? '',
    counts: {
      maps: (m.maps ?? []).length,
      warps: (m.warps ?? []).length,
      triggers: (m.triggers ?? []).length,
      objectEvents: (m.objectEvents ?? []).length,
      dialogue: (m.dialogue ?? []).length,
      flags: (m.flags ?? []).length,
      variables: (m.variables ?? []).length,
      encounterTables: (m.encounterTables ?? []).length,
      trainers: (m.trainers ?? []).length,
      scriptSteps: (m.scriptSteps ?? []).length,
      assets: (m.assets ?? []).length,
      species: (m.species ?? []).length,
      moveNames: (m.moveNames ?? []).length,
      items: (m.items ?? []).length,
      abilities: (m.abilities ?? []).length,
      trainerClassNames: (m.trainerClassNames ?? []).length,
      typeNames: (m.typeNames ?? []).length,
    },
  };
}

for (const romPath of ROMS) {
  console.log(`\n=== ${path.basename(romPath)} ===`);
  let intake;
  try {
    intake = await intakeFile(romPath);
  } catch (err) {
    console.error('  intake failed:', err.message);
    continue;
  }
  console.log('  managed root:', intake.managedProjectRoot);
  console.log('  sha1:', intake.sha1);

  let scan;
  try {
    scan = await scanProject(intake.managedProjectRoot);
  } catch (err) {
    console.error('  scan failed:', err.message);
    continue;
  }
  const manifestPath = await writeManifest(intake.managedProjectRoot, scan.manifest);
  console.log('  manifest:', manifestPath);
  console.log('  scanner:', scan.scannerName);
  if (scan.warnings.length > 0) {
    console.log('  warnings:');
    for (const w of scan.warnings) console.log('    -', w);
  }

  const summary = await summarize(manifestPath);
  console.log('  identity:', summary.identity);
  console.log('  counts:', JSON.stringify(summary.counts));
}
