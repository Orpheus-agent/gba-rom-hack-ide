// One-off debug - verify that the Navigator's name resolution chain
// returns "Pallet Town Professor Oaks Lab" for binary_map_4_3. If it
// does, the bug is UX-only (buried in 288-entry Interiors list). If
// it doesn't, the overlay isn't firing and that's the real bug.
import { readFileSync } from 'node:fs';
import { displayName } from '../src/lib/displayName';
import { lookupMapGroup } from '../src/lib/displayName';
import { inferStructures } from '../src/lib/structures';

const MANIFEST = 'C:/path/to/AppData/Roaming/rom-editor/projects/<project-id>/.editor/manifest.json';

const m = JSON.parse(readFileSync(MANIFEST, 'utf8'));

console.log('binary_map_4_3 displayName:', displayName(m, 'binary_map_4_3', false));
console.log('binary_map_4_3 lookupMapGroup:', lookupMapGroup(m, 'binary_map_4_3'));

// Confirm a couple of others for sanity.
console.log('binary_map_1_0 displayName:', displayName(m, 'binary_map_1_0', false));
console.log('binary_map_0_0 displayName:', displayName(m, 'binary_map_0_0', false));

// How many maps actually resolve to non-fallback names via the overlay?
let realCount = 0;
let fallbackCount = 0;
for (const mm of m.maps) {
  const name = displayName(m, mm.id, false);
  if (/^Unnamed area #|^Map /.test(name)) fallbackCount++;
  else realCount++;
}
console.log(`name resolution: ${realCount} real / ${fallbackCount} fallback`);

// Check inferred structures.
const structs = inferStructures(m);
console.log('structures count:', structs.length);
for (const s of structs.slice(0, 5)) {
  console.log(' -', s.name, `(${s.memberIds.length} members, group=${s.group})`);
}

// Find structures containing Pallet Town Player's House (binary_map_4_0, 4_1).
for (const id of ['binary_map_4_0', 'binary_map_4_1', 'binary_map_4_3', 'binary_map_4_2']) {
  const st = structs.find((s) => s.memberIds.includes(id));
  console.log(`${id} (${displayName(m, id, false)}) → structure: ${st ? `${st.name} [${st.memberIds.length}]` : 'STANDALONE'}`);
}

// Find structure containing Oak's Lab.
const oakStruct = structs.find((s) => s.memberIds.includes('binary_map_4_3'));
console.log("structure containing Oak's Lab:", oakStruct ? `${oakStruct.name} (${oakStruct.memberIds.length} members)` : 'NONE - standalone');
if (oakStruct) {
  console.log('  members (first 8):');
  for (const id of oakStruct.memberIds.slice(0, 8)) {
    console.log(`    ${id} → ${displayName(m, id, false)}`);
  }
}

// What does Oak's Lab look like in the Navigator? Show its peers
// in the Interiors bucket, ordered the way the sidebar would order
// them - mirroring the standaloneMapsByGroup logic (structure
// members filtered out).
const inStruct = new Set<string>(structs.flatMap((s) => s.memberIds as string[]));
const interiorMaps = m.maps.filter(
  (mm: { id: string }) => !inStruct.has(mm.id) && lookupMapGroup(m, mm.id) === 'interior',
);
interiorMaps.sort((a: { id: string }, b: { id: string }) =>
  displayName(m, a.id, false).localeCompare(displayName(m, b.id, false)),
);
const idx = interiorMaps.findIndex((mm: { id: string }) => mm.id === 'binary_map_4_3');
console.log(`Interiors bucket has ${interiorMaps.length} maps; binary_map_4_3 sits at index ${idx}`);
console.log('5 maps around Oak\'s Lab in sidebar order:');
for (let i = Math.max(0, idx - 2); i < Math.min(interiorMaps.length, idx + 3); i++) {
  console.log(`  [${i}] ${interiorMaps[i].id} → ${displayName(m, interiorMaps[i].id, false)}`);
}
