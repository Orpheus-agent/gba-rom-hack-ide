import type { ViewKey } from '../state';
import { useProjectStore } from '../state';
import { assessAllMechanics } from '../lib/mechanicDetectors';
import { runDesignLint } from '../lib/designLint';
import { listTemplates } from '../lib/templates';
import './Sidebar.css';

// Phase P.5 + The Real Game Editor Push - Sidebar lives inside the
// Ctrl+\ Advanced drawer (no longer the default left rail; the
// Navigator tree replaces it). Primary section is the bare minimum
// navigation: Project (ROM-loader form), World (maps atlas), Preview.
// Advanced section accumulates the demolished standalone-page views
// (Events / Dialogue / Flags / Species / etc.) PLUS the operator
// utilities (Build / Lint / Plugins / Mechanics / Timeline / Dependencies
// / Templates). All views remain reachable for power-user browsing - 
// they just no longer compete for visual weight in the default UI.

const PRIMARY_VIEW_KEYS: ReadonlyArray<ViewKey> = [
  'project',
  'maps',
  // Phase 4.2B - cross-map wild encounter overview, top-billing
  // because spawn-table balancing is a frequent design task.
  'spawns',
  'livePreview',
  'preview',
];

const ADVANCED_VIEW_KEYS: ReadonlyArray<ViewKey> = [
  // Demolished standalone-page views - reached normally via Navigator
  // tree + click-on-reference; surfaced here for bulk-browse access.
  'events',
  'dialogue',
  'dialogueReview',
  'flags',
  'choices',
  'healLocations',
  'species',
  'moves',
  'items',
  'abilities',
  'trainerClasses',
  'types',
  'pokedex',
  'tilesets',
  'assets',
  // Operator utilities - engineer-facing surfaces that never wanted to
  // be in the default UX.
  'mechanics',
  'lint',
  'dependencies',
  'templates',
  'plugins',
  'timeline',
  'build',
  // Phase 8I-1 - Tile intelligence browser (library + templates +
  // biome coverage). Lives in the Advanced drawer because it's a
  // power-user / engineer-facing surface, not a default-UX one.
  'tileIntel',
  // Phase 8I-3 - Map skeleton authoring + resolve view.
  'skeletons',
];

interface SidebarProps {
  readonly active: ViewKey;
  readonly onSelect: (view: ViewKey) => void;
}

interface NavItem {
  readonly key: ViewKey;
  readonly label: string;
}

const NAV_LABEL: Record<ViewKey, string> = {
  project: 'Project',
  maps: 'World',
  spawns: 'Wild encounters',
  learnsets: 'Learnsets',
  trainers: 'Trainers',
  events: 'Events',
  dialogue: 'Dialogue',
  dialogueReview: 'All dialogue',
  flags: 'Flags',
  assets: 'Assets',
  preview: 'Preview',
  livePreview: '▶ Play game',
  mechanics: 'Mechanics',
  lint: 'Lint',
  dependencies: 'Dependencies',
  templates: 'Templates',
  plugins: 'Plugins',
  timeline: 'Timeline',
  tilesets: 'Tilesets',
  species: 'Pokémon',
  moves: 'Moves',
  items: 'Items',
  abilities: 'Abilities',
  trainerClasses: 'Trainer classes',
  types: 'Type chart',
  pokedex: 'Pokédex',
  choices: 'Choices',
  healLocations: 'Heal locations',
  build: 'Build',
  // Phase 8I-1 - Tile-intel library / templates / coverage browser.
  tileIntel: 'Tile intelligence',
  // Phase 8I-3 - Map skeleton authoring + resolve view.
  skeletons: 'Map skeletons',
};

function useCountFor(key: ViewKey): string {
  return useProjectStore((s) => {
    if (s.load.kind !== 'loaded') return ' - ';
    if (key === 'project') return String(s.load.data.rootListing.entries.length);
    if (s.scan.kind !== 'loaded') return ' - ';
    const m = s.scan.data.manifest;
    switch (key) {
      case 'maps':
        return String(m.maps.length);
      case 'spawns':
        return String(m.encounterTables.length);
      case 'events':
        return String(m.triggers.length + m.objectEvents.length);
      case 'dialogue':
        return String(m.dialogue.length);
      case 'dialogueReview':
        return String(m.dialogue.length);
      case 'flags':
        return String(m.flags.length + m.variables.length);
      case 'assets':
        return String(m.assets.length);
      case 'preview':
        return String(m.maps.length);
      case 'livePreview':
        // No meaningful count - the route just hosts the embedded
        // emulator. Use an "on" indicator (em-dash) so the sidebar
        // count column stays aligned.
        return ' - ';
      case 'mechanics':
        return String(assessAllMechanics(m).filter((d) => d.present).length);
      case 'lint':
        return String(runDesignLint(m).findings.length);
      case 'templates':
        return String(listTemplates().length);
      case 'plugins':
        // Plugin count is fetched lazily by the PluginsView itself; we show
        // a neutral placeholder in the sidebar to avoid an extra fetch on
        // every render.
        return '…';
      case 'timeline':
        // Same lazy-fetch pattern as plugins - the TimelineView fetches its
        // own data; sidebar shows a neutral placeholder.
        return '…';
      case 'dependencies': {
        const total =
          m.maps.length +
          m.warps.length +
          m.triggers.length +
          m.objectEvents.length +
          m.flags.length +
          m.variables.length +
          m.encounterTables.length +
          m.trainers.length +
          m.dialogue.length +
          m.assets.length +
          m.scriptSteps.length;
        return String(total);
      }
      case 'build':
        return m.buildProfile ? '✓' : ' - ';
      case 'tilesets':
        return String((m.tilesets ?? []).length);
      case 'species':
        return String((m.species ?? []).length);
      case 'moves':
        return String((m.battleMoves ?? []).length);
      case 'items':
        return String((m.items ?? []).length);
      case 'abilities':
        return String((m.abilities ?? []).length);
      case 'trainerClasses':
        return String((m.trainerClassNames ?? []).length);
      case 'types':
        return String((m.typeMatchups ?? []).length);
      case 'pokedex':
        return String((m.pokedexEntries ?? []).length);
      case 'choices':
        return String((m.multichoiceLists ?? []).length);
      case 'healLocations':
        return String((m.healLocations ?? []).length);
    }
    return ' - ';
  });
}

function NavRow({ item, active, onSelect }: { item: NavItem; active: boolean; onSelect: () => void }) {
  const count = useCountFor(item.key);
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      data-testid={`sidebar-nav-${item.key}`}
      className={`sidebar__item${active ? ' sidebar__item--active' : ''}`}
      onClick={onSelect}
    >
      <span className="sidebar__label">{item.label}</span>
      <span className="sidebar__count">{count}</span>
    </button>
  );
}

export function Sidebar({ active, onSelect }: SidebarProps) {
  const renderRow = (key: ViewKey) => (
    <NavRow
      key={key}
      item={{ key, label: NAV_LABEL[key] }}
      active={active === key}
      onSelect={() => onSelect(key)}
    />
  );

  return (
    <aside className="sidebar" role="tablist" aria-label="Editor sections">
      <div className="sidebar__section" data-testid="sidebar-section-primary">
        {PRIMARY_VIEW_KEYS.map(renderRow)}
      </div>
      <div
        className="sidebar__section sidebar__section--advanced"
        data-testid="sidebar-section-advanced"
      >
        <div
          className="sidebar__section-heading"
          data-testid="sidebar-advanced-heading"
        >
          Advanced
        </div>
        {ADVANCED_VIEW_KEYS.map(renderRow)}
      </div>
    </aside>
  );
}
