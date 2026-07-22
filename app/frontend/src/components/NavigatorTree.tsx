// The Real Game Editor Push - Navigator tree replaces the 21-tab
// disconnected-page sidebar. Tree shape:
//
//   Region: <detected>
//     ├─ Towns
//     ├─ Routes
//     ├─ Buildings  (uses inferStructures)
//     ├─ Caves
//     └─ Other
//   Game Data
//     ├─ Species
//     ├─ Moves
//     ├─ Items
//     ├─ Abilities
//     ├─ Types
//     ├─ Trainer Classes
//     ├─ Pokédex
//     ├─ Flags
//     ├─ Variables
//     ├─ Heal Locations
//     ├─ Choices
//     ├─ Dialogue
//     ├─ Triggers
//     ├─ Tilesets
//     └─ Assets
//
// Clicking a map node → openMapInEditor (mounts MapEditor in MainPanel).
// Clicking a Game Data leaf → useSelection.select({kind, id}) → the
// existing inspectorRegistry dispatches the right inspector into the
// dock. No new inspector code needed - the dock already handles all
// these kinds.
//
// Large lists (species, moves, items at 1000+ entries on Unbound) get
// viewport-slice virtualization handrolled here - no new dependency.
// Only the visible ~60 rows render; scrolling reveals the rest.

import { useMemo, useRef, useState, useEffect } from 'react';
import type { ProjectManifest, MapNode } from '@rom-editor/shared';
import {
  useSelection,
  useViewStore,
  type EntityKind,
} from '../state';
import { inferStructures } from '../lib/structures';
import {
  displayName,
  lookupMapGroup,
  prettifyMapGroup,
  prettifyMapName,
} from '../lib/displayName';
import './NavigatorTree.css';

interface NavigatorTreeProps {
  readonly manifest: ProjectManifest | null;
}


const GAME_DATA_KINDS: ReadonlyArray<{
  readonly key: keyof ProjectManifest;
  readonly label: string;
  readonly entityKind: EntityKind;
  /** Whether to render a name + id ("Bulbasaur (SPECIES_BULBASAUR)") or
   *  just the name. */
  readonly showId?: boolean;
}> = [
  { key: 'species', label: 'Species', entityKind: 'species' },
  { key: 'battleMoves', label: 'Moves', entityKind: 'move' },
  { key: 'items', label: 'Items', entityKind: 'item' },
  { key: 'abilities', label: 'Abilities', entityKind: 'ability' },
  { key: 'typeMatchups', label: 'Type Matchups', entityKind: 'type' },
  { key: 'trainerClassNames', label: 'Trainer Classes', entityKind: 'trainerClass' },
  { key: 'pokedexEntries', label: 'Pokédex', entityKind: 'pokedexEntry' },
  { key: 'flags', label: 'Flags', entityKind: 'flag' },
  { key: 'variables', label: 'Variables', entityKind: 'variable' },
  { key: 'healLocations', label: 'Heal Locations', entityKind: 'healLocation' },
  { key: 'multichoiceLists', label: 'Multichoice Menus', entityKind: 'multichoice' },
  { key: 'dialogue', label: 'Dialogue', entityKind: 'dialogue' },
  { key: 'triggers', label: 'Triggers', entityKind: 'trigger' },
  { key: 'tilesets', label: 'Tilesets', entityKind: 'tileset' },
  { key: 'assets', label: 'Assets', entityKind: 'asset' },
  { key: 'trainers', label: 'Trainers', entityKind: 'trainer' },
  { key: 'encounterTables', label: 'Encounter Tables', entityKind: 'encounterTable' },
  { key: 'scriptSteps', label: 'Script Steps', entityKind: 'scriptStep' },
];

export function NavigatorTree({ manifest }: NavigatorTreeProps): JSX.Element {
  if (!manifest) {
    return (
      <aside className="navigator-tree" data-testid="navigator-tree">
        <div className="navigator-tree__empty">
          Open a ROM to populate the workspace navigator.
        </div>
      </aside>
    );
  }
  return (
    <aside className="navigator-tree" data-testid="navigator-tree">
      <NavigatorTopTabs />
      <RegionSection manifest={manifest} />
      <GameDataSection manifest={manifest} />
    </aside>
  );
}

/** Two always-visible top-level tabs: World (atlas) and Preview.
 *  Replaces the old PRIMARY_VIEW_KEYS rail. */
function NavigatorTopTabs(): JSX.Element {
  const activeView = useViewStore((s) => s.activeView);
  const setView = useViewStore((s) => s.setView);
  return (
    <div className="navigator-tree__tabs" data-testid="navigator-top-tabs">
      <button
        type="button"
        className={`navigator-tree__tab${activeView === 'maps' ? ' navigator-tree__tab--active' : ''}`}
        onClick={() => setView('maps')}
        data-testid="navigator-tab-world"
      >
        World
      </button>
      <button
        type="button"
        className={`navigator-tree__tab${activeView === 'preview' ? ' navigator-tree__tab--active' : ''}`}
        onClick={() => setView('preview')}
        data-testid="navigator-tab-preview"
      >
        Preview
      </button>
    </div>
  );
}

/** Numeric-aware string compare so "Route 2" < "Route 10" instead of the
 *  lexicographic "Route 10" < "Route 2". Used everywhere maps/areas list. */
export function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

/** `MAPSEC_PALLET_TOWN` → "Pallet Town", `MAPSEC_ROUTE_1` → "Route 1".
 *  Strips the constant prefix + a region-disambiguation suffix, then
 *  reuses the shared Gen-3 title-caser. Empty / NONE / DYNAMIC sections
 *  collapse to friendly buckets. */
export function prettifyMapSection(mapsec: string): string {
  if (!mapsec || mapsec === 'MAPSEC_NONE') return 'Unsorted';
  const body = mapsec
    .replace(/^MAPSEC_/, '')
    .replace(/_(FRLG|RS|R|G|S|E)$/, '')
    .replace(/_/g, ' ')
    .trim();
  if (!body) return 'Unsorted';
  // Title-case each word (so "PALLET TOWN" → "Pallet Town", "DYNAMIC" →
  // "Dynamic"); keep Gen-3 floor markers (1F / B2F) upper-cased.
  return body
    .toLowerCase()
    .replace(/\b([a-z])/g, (ch) => ch.toUpperCase())
    .replace(/\b(b?\d+f)\b/gi, (m) => m.toUpperCase());
}

interface StorySection {
  readonly key: string;
  readonly label: string;
  readonly maps: ReadonlyArray<MapNode>;
}

/** #2 Story-order navigation - group decomp maps by their
 *  `metadata.region_map_section` (so a town clusters with its interiors,
 *  a big dungeon gets its own node) and order those groups by the game's
 *  canonical `MAPSEC_*` enum order (manifest.mapSectionOrder). Within a
 *  section the overworld map sorts before its interiors, then numerically
 *  by name. Returns [] when the manifest carries no section order (binary
 *  ROMs / older scans) so the caller falls back to category grouping. */
export function buildStoryOrderSections(manifest: ProjectManifest): ReadonlyArray<StorySection> {
  const order = manifest.mapSectionOrder;
  if (!order || order.length === 0) return [];
  const orderIndex = new Map<string, number>();
  order.forEach((name, i) => orderIndex.set(name, i));

  const bySection = new Map<string, MapNode[]>();
  let anyTagged = false;
  for (const m of manifest.maps) {
    const raw = m.metadata?.['region_map_section'];
    const sec = typeof raw === 'string' ? raw : '';
    if (sec) anyTagged = true;
    const arr = bySection.get(sec) ?? [];
    arr.push(m);
    bySection.set(sec, arr);
  }
  // No map carried a region_map_section → this signal is unavailable; let
  // the caller use its category grouping instead of one giant "Unsorted".
  if (!anyTagged) return [];

  const sections: StorySection[] = [];
  for (const [key, maps] of bySection) {
    const sorted = [...maps].sort((a, b) => {
      // Outdoor overworld map (town/route/cave/…) before its interiors.
      const ra = a.group === 'interior' ? 1 : 0;
      const rb = b.group === 'interior' ? 1 : 0;
      if (ra !== rb) return ra - rb;
      return naturalCompare(
        displayName(manifest, a.id, false),
        displayName(manifest, b.id, false),
      );
    });
    sections.push({ key, label: prettifyMapSection(key), maps: sorted });
  }
  // Non-geographic buckets ("" / NONE / DYNAMIC = runtime-resolved or
  // placeless maps) sink below the real areas regardless of enum index.
  const isPlaceless = (key: string): boolean =>
    key === '' || key === 'MAPSEC_NONE' || key === 'MAPSEC_DYNAMIC';
  sections.sort((a, b) => {
    const pa = isPlaceless(a.key) ? 1 : 0;
    const pb = isPlaceless(b.key) ? 1 : 0;
    if (pa !== pb) return pa - pb;
    // Known sections in enum order (the canonical in-game progression);
    // unknown sink just above the placeless ones, tie-broken by label.
    const ia = orderIndex.has(a.key) ? orderIndex.get(a.key)! : Number.POSITIVE_INFINITY;
    const ib = orderIndex.has(b.key) ? orderIndex.get(b.key)! : Number.POSITIVE_INFINITY;
    if (ia !== ib) return ia - ib;
    return naturalCompare(a.label, b.label);
  });
  return sections;
}

/** Region/maps section. Maps grouped by MapNode.group (town/route/cave/etc.)
 *  with structures (Silph Co = one expandable node) factored out. */
function RegionSection({ manifest }: { manifest: ProjectManifest }): JSX.Element {
  const openMapInEditor = useViewStore((s) => s.openMapInEditor);
  const regionName = useMemo(() => {
    const first = manifest.regionMapSections?.[0]?.name;
    if (first) return first;
    // Fall back to identity baseGame.
    const base = manifest.identity?.baseGame;
    if (base) return base;
    return 'Region';
  }, [manifest]);

  const structures = useMemo(() => inferStructures(manifest), [manifest]);
  // Resolve each structure's memberIds to actual MapNode entries (kept
  // in scope here so the render loop has full map metadata without
  // re-resolving on every row).
  const structureMaps = useMemo(() => {
    const mapsById = new Map(manifest.maps.map((m) => [m.id, m]));
    return structures.map((st) => ({
      structure: st,
      members: st.memberIds
        .map((id) => mapsById.get(id))
        .filter((m): m is MapNode => Boolean(m)),
    }));
  }, [structures, manifest.maps]);
  // Build a set of mapIds that belong to ANY structure so the per-group
  // lists can skip them (they're surfaced under the Structures bucket).
  const mapIdsInStructure = useMemo(() => {
    const s = new Set<string>();
    for (const st of structures) for (const id of st.memberIds) s.add(id);
    return s;
  }, [structures]);

  const standaloneMapsByGroup = useMemo(() => {
    const byGroup = new Map<string, MapNode[]>();
    for (const m of manifest.maps) {
      if (mapIdsInStructure.has(m.id)) continue;
      // Phase 6.9 - bucket by lookupMapGroup so the vanilla-truth
      // overlay overrides the scanner's byte-derived group when the
      // ROM is overlaySafe. Falls through to m.group otherwise.
      const group = lookupMapGroup(manifest, m.id);
      const arr = byGroup.get(group) ?? [];
      arr.push(m);
      byGroup.set(group, arr);
    }
    // Sort each group by displayName, numeric-aware so "Route 2" precedes
    // "Route 10" (consults the overlay via lookupMap inside displayName).
    for (const [, arr] of byGroup) {
      arr.sort((a, b) =>
        naturalCompare(
          displayName(manifest, a.id, false),
          displayName(manifest, b.id, false),
        ),
      );
    }
    return byGroup;
  }, [manifest, manifest.maps, mapIdsInStructure]);

  // #2 Story-order navigation - when the manifest carries a MAPSEC enum
  // order (decomp), group maps into the game's areas in play order. Empty
  // for binary ROMs / older scans → the category grouping below renders.
  const storySections = useMemo(() => buildStoryOrderSections(manifest), [manifest]);

  if (storySections.length > 0) {
    return (
      <details
        className="navigator-tree__section"
        data-testid="navigator-region-section"
        open
      >
        <summary className="navigator-tree__section-header">
          <span className="navigator-tree__section-label">
            Region: {regionName} · {storySections.length} areas
          </span>
        </summary>
        <div className="navigator-tree__section-body">
          {storySections.map((sec) => (
            <NavigatorTreeBranch
              key={sec.key || '__unsorted'}
              label={`${sec.label} (${sec.maps.length})`}
              testId={`navigator-area-${sec.key || 'unsorted'}`}
            >
              {sec.maps.map((m) => (
                <NavigatorMapLeaf
                  key={m.id}
                  manifest={manifest}
                  map={m}
                  onOpen={() => openMapInEditor(m.id)}
                />
              ))}
            </NavigatorTreeBranch>
          ))}
        </div>
      </details>
    );
  }

  return (
    <details
      className="navigator-tree__section"
      data-testid="navigator-region-section"
      open
    >
      <summary className="navigator-tree__section-header">
        <span className="navigator-tree__section-label">Region: {regionName}</span>
      </summary>
      <div className="navigator-tree__section-body">
        {structureMaps.length > 0 && (
          <NavigatorTreeBranch
            label={`Structures (${structureMaps.length})`}
            testId="navigator-branch-structures"
          >
            {structureMaps.map(({ structure: st, members }) => (
              <NavigatorTreeBranch
                key={st.id}
                label={`${st.name} (${members.length})`}
                testId={`navigator-structure-${st.id}`}
              >
                {members.map((m) => (
                  <NavigatorMapLeaf
                    key={m.id}
                    manifest={manifest}
                    map={m}
                    onOpen={() => openMapInEditor(m.id)}
                  />
                ))}
              </NavigatorTreeBranch>
            ))}
          </NavigatorTreeBranch>
        )}
        {Array.from(standaloneMapsByGroup.entries())
          .sort(([a], [b]) => prettifyMapGroup(a, 'plural').localeCompare(prettifyMapGroup(b, 'plural')))
          .map(([group, maps]) => (
            <NavigatorTreeBranch
              key={group}
              label={`${prettifyMapGroup(group, 'plural')} (${maps.length})`}
              testId={`navigator-branch-${group}`}
            >
              {maps.map((m) => (
                <NavigatorMapLeaf
                  key={m.id}
                  manifest={manifest}
                  map={m}
                  onOpen={() => openMapInEditor(m.id)}
                />
              ))}
            </NavigatorTreeBranch>
          ))}
      </div>
    </details>
  );
}

/** Game data section. Each leaf list is virtualized (handrolled viewport
 *  slice) so 1000-entry species lists don't blow up the DOM on Unbound. */
function GameDataSection({ manifest }: { manifest: ProjectManifest }): JSX.Element {
  const setView = useViewStore((s) => s.setView);
  // Decomp projects edit game data from source, so manifest.* lists are empty
  // and the binary-lifted branches below render nothing. Surface the decomp
  // data editors as direct leaves instead.
  const isDecomp = !manifest.binaryRom;
  return (
    <details
      className="navigator-tree__section"
      data-testid="navigator-game-data-section"
    >
      <summary className="navigator-tree__section-header">
        <span className="navigator-tree__section-label">Game Data</span>
      </summary>
      <div className="navigator-tree__section-body">
        {isDecomp &&
          ([
            ['species', 'Pokémon (Species)'],
            ['moves', 'Moves'],
            ['abilities', 'Abilities'],
            ['items', 'Items'],
            ['learnsets', 'Learnsets'],
            ['types', 'Type Chart'],
            ['spawns', 'Wild Encounters'],
            ['trainers', 'Trainers'],
          ] as const).map(([viewKey, label]) => (
            <button
              key={viewKey}
              type="button"
              className="navigator-tree__branch-header"
              onClick={() => setView(viewKey)}
              data-testid={`navigator-decomp-${viewKey}`}
              style={{
                display: 'block',
                width: '100%',
                textAlign: 'left',
                background: 'none',
                border: 'none',
                color: 'inherit',
                cursor: 'pointer',
                padding: '4px 8px',
              }}
            >
              {label}
            </button>
          ))}
        {GAME_DATA_KINDS.map((meta) => {
          // Decomp surfaces trainers via its own editor leaf above (the binary
          // TrainerInspector can't read decomp parties), so skip the duplicate.
          if (isDecomp && meta.key === 'trainers') return null;
          const list = (manifest[meta.key] as unknown as ReadonlyArray<{ id: string; name?: string }> | undefined)
            ?? [];
          if (list.length === 0) return null;
          return (
            <GameDataBranch
              key={meta.key as string}
              label={meta.label}
              count={list.length}
              entityKind={meta.entityKind}
              entries={list}
              testId={`navigator-game-data-${meta.key as string}`}
            />
          );
        })}
      </div>
    </details>
  );
}

function GameDataBranch({
  label,
  count,
  entityKind,
  entries,
  testId,
}: {
  label: string;
  count: number;
  entityKind: EntityKind;
  entries: ReadonlyArray<{ readonly id: string; readonly name?: string }>;
  testId: string;
}): JSX.Element {
  return (
    <details
      className="navigator-tree__branch"
      data-testid={testId}
    >
      <summary className="navigator-tree__branch-header">
        {label} ({count})
      </summary>
      <VirtualizedEntryList entityKind={entityKind} entries={entries} />
    </details>
  );
}

const ROW_HEIGHT = 22;
const VIEWPORT_HEIGHT = 320;
const OVERSCAN = 6;

/** Handrolled viewport-slice virtualization - only renders the rows
 *  intersecting the viewport plus a small overscan. No new dependency. */
function VirtualizedEntryList({
  entityKind,
  entries,
}: {
  entityKind: EntityKind;
  entries: ReadonlyArray<{ readonly id: string; readonly name?: string }>;
}): JSX.Element {
  const select = useSelection((s) => s.select);
  const current = useSelection((s) => s.current);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);

  // Note: with details/summary we don't actually paint until expanded.
  // The scroll handler updates scrollTop on user scroll within the
  // ROW_HEIGHT * entries.length tall scroller.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const onScroll = () => setScrollTop(el.scrollTop);
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  const totalHeight = entries.length * ROW_HEIGHT;
  const startIdx = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const visibleCount = Math.ceil(VIEWPORT_HEIGHT / ROW_HEIGHT) + OVERSCAN * 2;
  const endIdx = Math.min(entries.length, startIdx + visibleCount);

  const visibleRows: JSX.Element[] = [];
  for (let i = startIdx; i < endIdx; i++) {
    const e = entries[i]!;
    const isSelected =
      current && current.kind === entityKind && current.id === e.id;
    const label = e.name && e.name.trim().length > 0 ? e.name : e.id;
    visibleRows.push(
      <button
        key={e.id}
        type="button"
        className={`navigator-tree__entry${isSelected ? ' navigator-tree__entry--selected' : ''}`}
        style={{
          position: 'absolute',
          top: i * ROW_HEIGHT,
          height: ROW_HEIGHT,
          left: 0,
          right: 0,
        }}
        onClick={() => select({ kind: entityKind, id: e.id })}
        data-testid={`navigator-entry-${entityKind}-${e.id}`}
        title={label}
      >
        {label}
      </button>,
    );
  }

  return (
    <div
      ref={scrollerRef}
      className="navigator-tree__list"
      style={{
        position: 'relative',
        maxHeight: VIEWPORT_HEIGHT,
        overflowY: 'auto',
      }}
      data-testid={`navigator-list-${entityKind}`}
    >
      <div style={{ position: 'relative', height: totalHeight }}>
        {visibleRows}
      </div>
    </div>
  );
}

/** Map leaf - clicking opens MapEditor in the main panel. */
function NavigatorMapLeaf({
  manifest,
  map,
  onOpen,
}: {
  manifest: ProjectManifest;
  map: MapNode;
  onOpen: () => void;
}): JSX.Element {
  const current = useSelection((s) => s.current);
  const isSelected = current && current.kind === 'map' && current.id === map.id;
  // Phase 6.9 - route through displayName so the vanilla-truth overlay
  // activates ("Unnamed area #109" → "Three Island Berry Forest" on
  // overlaySafe ROMs). prettifyMapName retained as the fallback path
  // inside displayName.ts::lookupMap.
  const label = displayName(manifest, map.id, false);
  return (
    <button
      type="button"
      className={`navigator-tree__entry${isSelected ? ' navigator-tree__entry--selected' : ''}`}
      onClick={onOpen}
      data-testid={`navigator-map-${map.id}`}
      title={label}
    >
      {label}
    </button>
  );
}

/** Generic collapsible tree branch with a count badge. */
function NavigatorTreeBranch({
  label,
  testId,
  children,
}: {
  label: string;
  testId: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <details
      className="navigator-tree__branch"
      data-testid={testId}
    >
      <summary className="navigator-tree__branch-header">{label}</summary>
      <div className="navigator-tree__branch-body">{children}</div>
    </details>
  );
}
