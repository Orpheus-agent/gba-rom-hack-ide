// One-off debug script - replicates the Navigator's name + bucket
// resolution for binary_map_4_3 (Oak's Lab) against the current
// manifest, to figure out why the user can't find Professor Oak's
// Lab in the sidebar. Throw-away - delete after debug.
import { readFileSync } from 'node:fs';

const MANIFEST = 'C:/path/to/AppData/Roaming/rom-editor/projects/<project-id>/.editor/manifest.json';

const m = JSON.parse(readFileSync(MANIFEST, 'utf8'));
console.log('identity:', JSON.stringify(m.identity, null, 2).slice(0, 400));
console.log('overlaySafe:', m.identity?.overlaySafe);
console.log('fork:', m.identity?.fork);
console.log('baseGame:', m.identity?.baseGame);

const target = m.maps.find((mm) => mm.id === 'binary_map_4_3');
console.log('binary_map_4_3 name:', target?.name, 'group:', target?.group);

// Bucket all maps by group (mirrors Navigator's lookupMapGroup
// fallback path - without an overlay lookup, every map gets put
// in its raw group bucket).
const byGroup = new Map();
for (const mm of m.maps) {
  const k = mm.group;
  byGroup.set(k, (byGroup.get(k) ?? 0) + 1);
}
console.log('group histogram:', Object.fromEntries(byGroup));
console.log('total maps:', m.maps.length);
