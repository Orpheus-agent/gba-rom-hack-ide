import type { MapNode, ProjectManifest, Warp } from '@rom-editor/shared';

// Phase R.2 - Structure inference. Many Pokémon-game locations span
// multiple maps that the player perceives as one place: Silph Co. is
// "Silph Co. 1F" through "Silph Co. 11F"; Rock Tunnel is two floors;
// Pokémon Mansion is four floors plus a basement. This module clusters
// such maps into a single Structure so the WorldAtlas can render them
// as one node (expandable into floors), instead of N disconnected
// nodes in the warp graph.
//
// Clustering rule:
//   1. Maps must share a common name prefix when split on " " or "_".
//      A prefix of >= 2 tokens counts ("Silph Co. 1F" → prefix
//      ["Silph", "Co."]); single-token prefixes ("Route") do NOT
//      cluster ("Route 1" + "Route 2" are different places).
//   2. Maps must be mutually warp-connected (transitively) - at least
//      one warp connects two maps in the cluster.
//   3. Maps must be in compatible groups: interior + interior, cave +
//      cave, dungeon + dungeon. Town/route maps don't cluster.
//
// Edge cases:
//   - Two-map structures (a building's exterior + interior) DO
//     cluster if both meet the rules.
//   - Maps without warps stand alone.
//   - The function is deterministic + pure - safe to memoize on
//     (manifest.maps, manifest.warps) reference.

export interface Structure {
  /** Stable id derived from the shared name prefix + first member id
   *  (e.g. "struct:Silph_Co:MAP_SILPH_CO_1F"). */
  readonly id: string;
  /** Display label - the common name prefix joined with spaces. */
  readonly name: string;
  /** Sorted member map ids. The "primary" entry is members[0] (used
   *  when the atlas wants to collapse the structure to one click
   *  target). */
  readonly memberIds: ReadonlyArray<string>;
  /** Shared MapGroup. Determines colored treatment in atlas overlays. */
  readonly group: MapNode['group'];
  /** Number of internal warps (warps between members). Useful for
   *  rendering "Silph Co. (11 floors · 32 internal warps)" hints. */
  readonly internalWarpCount: number;
}

const CLUSTERABLE_GROUPS: ReadonlySet<MapNode['group']> = new Set([
  'interior',
  'cave',
  'dungeon',
]);

function splitNameTokens(name: string): string[] {
  return name
    .replace(/[._]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

function commonPrefix(a: ReadonlyArray<string>, b: ReadonlyArray<string>): string[] {
  const out: string[] = [];
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i]!.toLowerCase() === b[i]!.toLowerCase()) {
      out.push(a[i]!);
    } else {
      break;
    }
  }
  return out;
}

interface MapMeta {
  readonly map: MapNode;
  readonly tokens: ReadonlyArray<string>;
}

export function inferStructures(manifest: ProjectManifest): ReadonlyArray<Structure> {
  const maps = manifest.maps.filter((m) => CLUSTERABLE_GROUPS.has(m.group));
  if (maps.length < 2) return [];

  const metas: MapMeta[] = maps.map((m) => ({
    map: m,
    tokens: splitNameTokens(m.name || m.id),
  }));

  // Group by group (interior with interior, cave with cave, etc.) so
  // a route + an interior with the same name don't accidentally pair.
  const byGroup = new Map<MapNode['group'], MapMeta[]>();
  for (const meta of metas) {
    const arr = byGroup.get(meta.map.group) ?? [];
    arr.push(meta);
    byGroup.set(meta.map.group, arr);
  }

  // Build a warp index: from-map → set of connected map ids.
  const warpsBetween = new Map<string, Set<string>>();
  for (const w of manifest.warps) {
    addWarp(warpsBetween, w.fromMapId, w.toMapId);
    addWarp(warpsBetween, w.toMapId, w.fromMapId);
  }

  const visited = new Set<string>();
  const structures: Structure[] = [];

  for (const [, candidates] of byGroup) {
    for (let i = 0; i < candidates.length; i++) {
      const seed = candidates[i]!;
      if (visited.has(seed.map.id)) continue;

      // Grow the cluster by finding every other map (in the same
      // group) that shares a >=2-token prefix with the seed AND is
      // transitively warp-connected within the candidates set.
      const cluster: MapMeta[] = [seed];
      visited.add(seed.map.id);
      let added = true;
      while (added) {
        added = false;
        for (let j = i + 1; j < candidates.length; j++) {
          const other = candidates[j]!;
          if (visited.has(other.map.id)) continue;
          // Prefix check: must share >=2 tokens with at least one
          // current cluster member.
          const sharesPrefix = cluster.some((m) =>
            commonPrefix(m.tokens, other.tokens).length >= 2,
          );
          if (!sharesPrefix) continue;
          // Warp check: must be warp-connected to at least one
          // current cluster member.
          const connected = cluster.some((m) =>
            warpsBetween.get(m.map.id)?.has(other.map.id) ?? false,
          );
          if (!connected) continue;
          cluster.push(other);
          visited.add(other.map.id);
          added = true;
        }
      }

      if (cluster.length < 2) continue;

      // Compute the shared prefix across all cluster members.
      let prefix = cluster[0]!.tokens;
      for (let k = 1; k < cluster.length; k++) {
        prefix = commonPrefix(prefix, cluster[k]!.tokens);
      }
      if (prefix.length < 2) continue;

      const name = prefix.join(' ');
      const memberIds = cluster.map((m) => m.map.id).sort();
      const id = `struct:${name.replace(/\s+/g, '_')}:${memberIds[0]}`;
      const internalIds = new Set(memberIds);
      let internalWarpCount = 0;
      for (const w of manifest.warps) {
        if (internalIds.has(w.fromMapId) && internalIds.has(w.toMapId)) {
          internalWarpCount++;
        }
      }
      structures.push({
        id,
        name,
        memberIds,
        group: cluster[0]!.map.group,
        internalWarpCount,
      });
    }
  }

  return structures.sort((a, b) => b.memberIds.length - a.memberIds.length);
}

function addWarp(idx: Map<string, Set<string>>, from: string, to: string): void {
  const set = idx.get(from) ?? new Set<string>();
  set.add(to);
  idx.set(from, set);
}

/** Convenience: return the structure containing a given map id, or null. */
export function structureContaining(
  structures: ReadonlyArray<Structure>,
  mapId: string,
): Structure | null {
  for (const s of structures) {
    if (s.memberIds.includes(mapId)) return s;
  }
  return null;
}

/** Helper kept exported for the WorldAtlas + tests - surfaces every
 *  warp that crosses INTO or OUT OF the structure (so the atlas can
 *  draw external warp arrows distinct from internal floor transitions). */
export function externalWarps(
  warps: ReadonlyArray<Warp>,
  structure: Structure,
): ReadonlyArray<Warp> {
  const members = new Set(structure.memberIds);
  return warps.filter(
    (w) =>
      (members.has(w.fromMapId) && !members.has(w.toMapId)) ||
      (!members.has(w.fromMapId) && members.has(w.toMapId)),
  );
}
