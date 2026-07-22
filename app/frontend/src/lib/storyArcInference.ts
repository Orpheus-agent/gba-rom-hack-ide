import type { ProjectManifest } from '@rom-editor/shared';
import { lookupAnnotation } from './annotations';

/** Story-arc markers overlaid on the RegionAtlas. Each marker says
 *  "something narratively important happens at this map." */
export type StoryArcMarker =
  | { readonly kind: 'gym'; readonly order: number; readonly leaderName: string | null }
  | { readonly kind: 'rival' }
  | { readonly kind: 'champion' }
  | { readonly kind: 'keyItem'; readonly itemName: string };

/** Vanilla FRLG flag offsets → marker shape. Mirrors VANILLA_FRLG_FLAG_NAMES
 *  in displayName.ts but exposes the structured marker rather than the
 *  English label. Kept locally to avoid coupling displayName.ts to atlas
 *  rendering. */
const VANILLA_FRLG_FLAG_MARKERS: ReadonlyMap<number, StoryArcMarker> = new Map([
  // Gym defeats - order matches FRLG canonical badge sequence.
  [0x82f, { kind: 'gym', order: 1, leaderName: 'Brock' }],
  [0x830, { kind: 'gym', order: 2, leaderName: 'Misty' }],
  [0x831, { kind: 'gym', order: 3, leaderName: 'Lt. Surge' }],
  [0x832, { kind: 'gym', order: 4, leaderName: 'Erika' }],
  [0x833, { kind: 'gym', order: 5, leaderName: 'Koga' }],
  [0x834, { kind: 'gym', order: 6, leaderName: 'Sabrina' }],
  [0x835, { kind: 'gym', order: 7, leaderName: 'Blaine' }],
  [0x836, { kind: 'gym', order: 8, leaderName: 'Giovanni' }],
  // Rival fights - there's no canonical "rival flag" in vanilla FRLG;
  // the rival lab fight at Oak's lab is 0x82e.
  [0x82e, { kind: 'rival' }],
  // Elite Four + champion - surface only the champion (the four Elite
  // members all live on the same Indigo Plateau map, badges enough).
  [0x843, { kind: 'champion' }],
  // Key items.
  [0x828, { kind: 'keyItem', itemName: 'Pokédex' }],
  [0x82a, { kind: 'keyItem', itemName: 'Running Shoes' }],
]);

/** Annotation pattern recognisers for fork ROMs (Unbound etc.) where
 *  the canonical FRLG flag offsets don't apply but the user has
 *  annotated their flags with descriptive names. */
const ANNOTATION_PATTERNS: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly toMarker: (m: RegExpExecArray) => StoryArcMarker;
}> = [
  {
    pattern: /^Defeated\s+Gym\s+(\d+)(?:\s*[ - \-:]\s*(.+))?$/i,
    toMarker: (m) => ({
      kind: 'gym',
      order: Number.parseInt(m[1]!, 10),
      leaderName: m[2]?.trim() ?? null,
    }),
  },
  {
    pattern: /^Defeated\s+Rival/i,
    toMarker: () => ({ kind: 'rival' }),
  },
  {
    pattern: /^Defeated\s+Champion/i,
    toMarker: () => ({ kind: 'champion' }),
  },
  {
    pattern: /^(?:Received|Got|Obtained)\s+(Pokédex|Pokedex|HM\d+|Old Rod|Bicycle|Bike)/i,
    toMarker: (m) => ({ kind: 'keyItem', itemName: m[1]! }),
  },
];

/** Returns true if the manifest's identity is a vanilla FRLG-family ROM
 *  whose flag offsets match the curated table. The atlas overlay defaults
 *  to enabled for these and disabled for fork ROMs (which must surface
 *  story arcs via annotations). */
export function isVanillaFrlgIdentity(manifest: ProjectManifest): boolean {
  const id = manifest.identity;
  if (!id) return false;
  // "Vanilla" in our schema = no fork detected (e.g. CFRU, expansion).
  if (id.fork !== null) return false;
  const code = id.romHeader?.gameCode;
  return code === 'BPRE' || code === 'BPRG';
}

interface FlagMatch {
  readonly flagId: string;
  readonly marker: StoryArcMarker;
}

function matchFlag(
  flagId: string,
  manifest: ProjectManifest,
): StoryArcMarker | null {
  // Path 1: vanilla offset → curated marker.
  if (isVanillaFrlgIdentity(manifest)) {
    const hexMatch = /^(?:binary_)?flag_(?:0x)?([0-9a-fA-F]+)$/.exec(flagId);
    if (hexMatch) {
      const value = hexMatch[0].startsWith('binary_flag_')
        ? Number.parseInt(hexMatch[1]!, 10)
        : Number.parseInt(hexMatch[1]!, 16);
      const curated = VANILLA_FRLG_FLAG_MARKERS.get(value);
      if (curated) return curated;
    }
  }
  // Path 2: user annotation → pattern match (works on any ROM).
  const annotation = lookupAnnotation('flag', flagId);
  if (annotation) {
    for (const { pattern, toMarker } of ANNOTATION_PATTERNS) {
      const m = pattern.exec(annotation);
      if (m) return toMarker(m);
    }
  }
  return null;
}

/** Locate the map where the given flag gets SET by walking script steps.
 *  Returns the first map id whose scripts contain a setflag opcode for
 *  this flag. Returns null when the set-site can't be inferred.
 *
 *  Reuses the same heuristic as flagReferences.ts but locally scoped to
 *  avoid the heavyweight cross-ref index when only set-sites matter. */
function findFlagSetSiteMap(
  manifest: ProjectManifest,
  flagId: string,
): string | null {
  const steps = manifest.scriptSteps ?? [];
  const setterStepIds = new Set<string>();
  for (const s of steps) {
    if (s.kind !== 'set_flag') continue;
    const fid = (s.params as Record<string, unknown>)['flagId'];
    if (typeof fid === 'string' && fid === flagId) {
      setterStepIds.add(s.id);
    }
  }
  if (setterStepIds.size === 0) return null;
  // Triggers carry the map context.
  for (const t of manifest.triggers ?? []) {
    if (t.scriptStepIds.some((s) => setterStepIds.has(s as string))) {
      if (t.mapId) return t.mapId;
    }
  }
  // Fallback: maps that list any of these step ids in their scriptIds.
  for (const map of manifest.maps) {
    if (map.scriptIds.some((s) => setterStepIds.has(s as string))) {
      return map.id;
    }
  }
  return null;
}

/** Walk every flag in the manifest, find ones that map to story-arc
 *  markers, and locate the map each is "set on." Returns one entry
 *  per (mapId, marker) tuple. The atlas renders these as PixiJS pins.
 *
 *  Note: a single map can carry multiple markers (e.g. Pewter has both
 *  the Boulder Badge marker AND the Brock-defeated marker if both flags
 *  resolve there; the renderer can de-dupe by `kind+order`). */
export function inferStoryArcMarkers(
  manifest: ProjectManifest,
): ReadonlyArray<{ readonly mapId: string; readonly marker: StoryArcMarker }> {
  const out: Array<{ mapId: string; marker: StoryArcMarker }> = [];
  const allFlags: ReadonlyArray<{ id: string }> = manifest.flags ?? [];
  // Index flags by id so matchFlag doesn't need full manifest scan.
  for (const f of allFlags) {
    const marker = matchFlag(f.id, manifest);
    if (!marker) continue;
    const mapId = findFlagSetSiteMap(manifest, f.id);
    if (!mapId) continue;
    out.push({ mapId, marker });
  }
  return out;
}

/** True when the manifest contains enough vanilla-pattern flags OR
 *  user annotations to produce at least one story marker. Drives whether
 *  the atlas toggle is enabled. */
export function canShowStoryArc(manifest: ProjectManifest): boolean {
  if (isVanillaFrlgIdentity(manifest)) return true;
  // Fork: only enabled if at least one annotation matches a pattern.
  for (const f of manifest.flags ?? []) {
    const ann = lookupAnnotation('flag', f.id);
    if (!ann) continue;
    for (const { pattern } of ANNOTATION_PATTERNS) {
      if (pattern.test(ann)) return true;
    }
  }
  return false;
}

/** Human label for a marker, used by the atlas tooltip. */
export function describeMarker(marker: StoryArcMarker): string {
  if (marker.kind === 'gym') {
    return marker.leaderName
      ? `Gym ${marker.order} · ${marker.leaderName}`
      : `Gym ${marker.order}`;
  }
  if (marker.kind === 'rival') return 'Rival fight';
  if (marker.kind === 'champion') return 'Champion fight';
  return `Key item: ${marker.itemName}`;
}

/** Single-glyph badge used in PixiJS / DOM tooltip overlays. */
export function markerGlyph(marker: StoryArcMarker): string {
  if (marker.kind === 'gym') return String(marker.order);
  if (marker.kind === 'rival') return '★';
  if (marker.kind === 'champion') return '👑';
  return '🎒';
}
