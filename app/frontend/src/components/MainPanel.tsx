import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import type { ProjectIdentity, ProjectKind, ProjectManifest } from '@rom-editor/shared';
import { pushToast, useProjectStore, useViewStore, type ViewKey } from '../state';
import { pickFile } from '../api';
import { inferStructures, type Structure } from '../lib/structures';
import { useSelection } from '../state';
import { MapsGraph } from './MapsGraph';
// ModernizeCard moved out of the IdentityCard subtree - it now lives
// in the titlebar via ModernizeButton (wired in EditorShell.tsx).
// The AttributionPanel and ExportPatchCard remain in IdentityCard for
// the post-modernize surface.
import { AttributionPanel } from './AttributionPanel';
import { SymbolDbNotice } from './SymbolDbNotice';
import { ExportPatchCard } from './ExportPatchCard';
import { MapsBrowser } from './MapsBrowser';
import { MapsSearch } from './MapsSearch';
import { MapEditor } from './MapEditor';
import { RegionAtlas } from './RegionAtlas';
import { EventsView } from './EventsView';
import { DialogueView } from './DialogueView';
import { FlagsView } from './FlagsView';
import { AssetsView } from './AssetsView';
import { PreviewView } from './PreviewView';
import { MechanicsView } from './MechanicsView';
import { LintView } from './LintView';
import { DependenciesView } from './DependenciesView';
import { TemplatesView } from './TemplatesView';
import { PluginsView } from './PluginsView';
import { TimelineView } from './TimelineView';
import { BuildView } from './BuildView';
import { TilesetBrowser } from './TilesetBrowser';
import { SpeciesView } from './SpeciesView';
import { DecompSpeciesView } from './DecompSpeciesView';
import { DecompMovesView } from './DecompMovesView';
import { DecompAbilitiesView } from './DecompAbilitiesView';
import { DecompItemsView } from './DecompItemsView';
import { DecompEncountersView } from './DecompEncountersView';
import { DecompLearnsetsView } from './DecompLearnsetsView';
import { DecompTypeChartView } from './DecompTypeChartView';
import { DecompTrainersView } from './DecompTrainersView';
import { MovesView } from './MovesView';
import { ItemsView } from './ItemsView';
import { AbilitiesView } from './AbilitiesView';
import { TrainerClassesView } from './TrainerClassesView';
import { TypesView } from './TypesView';
import { PokedexView } from './PokedexView';
import { ChoicesView } from './ChoicesView';
import { HealLocationsView } from './HealLocationsView';
import { DialogueReviewPanel } from './dialogue/DialogueReviewPanel';
import { EmulatorHost } from './preview/EmulatorHost';
// Phase 4.2B - cross-map wild encounter overview.
import { SpawnGridView } from './SpawnGrid';
// Phase 8I-1 - TileIntelligencePanel.
import { TileIntelligencePanel } from './TileIntelligencePanel';
// Phase 8I-3 - SkeletonEditor.
import { SkeletonEditor } from './SkeletonEditor';
import './MainPanel.css';

interface MainPanelProps {
  readonly view: ViewKey;
}

export function MainPanel({ view }: MainPanelProps) {
  return (
    <main className="main-panel" data-testid={`main-panel-${view}`}>
      {view === 'project' && <ProjectView />}
      {view === 'maps' && <MapsViewWired />}
      {view === 'spawns' && <SpawnsPanel />}
      {view === 'events' && <EventsViewWired />}
      {view === 'dialogue' && <DialogueViewWired />}
      {view === 'flags' && <FlagsViewWired />}
      {view === 'assets' && <AssetsViewWired />}
      {view === 'preview' && <PreviewViewWired />}
      {view === 'mechanics' && <MechanicsViewWired />}
      {view === 'lint' && <LintViewWired />}
      {view === 'dependencies' && <DependenciesViewWired />}
      {view === 'templates' && <TemplatesView />}
      {view === 'plugins' && <PluginsViewWired />}
      {view === 'timeline' && <TimelineViewWired />}
      {view === 'tilesets' && <TilesetBrowserWired />}
      {view === 'species' && <SpeciesPanel />}
      {view === 'moves' && <MovesPanel />}
      {view === 'items' && <ItemsPanel />}
      {view === 'learnsets' && <LearnsetsPanel />}
      {view === 'trainers' && <TrainersListPanel />}
      {view === 'abilities' && <AbilitiesPanel />}
      {view === 'trainerClasses' && <TrainerClassesViewWired />}
      {view === 'types' && <TypesPanel />}
      {view === 'pokedex' && <PokedexViewWired />}
      {view === 'choices' && <ChoicesViewWired />}
      {view === 'healLocations' && <HealLocationsViewWired />}
      {view === 'dialogueReview' && <DialogueReviewPanelWired />}
      {view === 'livePreview' && <EmulatorHost />}
      {view === 'build' && <BuildViewWired />}
      {view === 'tileIntel' && <TileIntelligencePanel />}
      {view === 'skeletons' && <SkeletonEditor />}
    </main>
  );
}

// Decomp projects (no binaryRom subsystems) get the source-editing species
// editor; binary-ROM projects keep the struct-lifting SpeciesView.
function SpeciesPanel() {
  const scan = useProjectStore((s) => s.scan);
  const isDecomp = scan.kind === 'loaded' && !scan.data.manifest.binaryRom;
  return isDecomp ? <DecompSpeciesView /> : <SpeciesViewWired />;
}

function MovesPanel() {
  const scan = useProjectStore((s) => s.scan);
  const isDecomp = scan.kind === 'loaded' && !scan.data.manifest.binaryRom;
  return isDecomp ? <DecompMovesView /> : <MovesViewWired />;
}

function AbilitiesPanel() {
  const scan = useProjectStore((s) => s.scan);
  const isDecomp = scan.kind === 'loaded' && !scan.data.manifest.binaryRom;
  return isDecomp ? <DecompAbilitiesView /> : <AbilitiesViewWired />;
}

function ItemsPanel() {
  const scan = useProjectStore((s) => s.scan);
  const isDecomp = scan.kind === 'loaded' && !scan.data.manifest.binaryRom;
  return isDecomp ? <DecompItemsView /> : <ItemsViewWired />;
}

function SpawnsPanel() {
  const scan = useProjectStore((s) => s.scan);
  const isDecomp = scan.kind === 'loaded' && !scan.data.manifest.binaryRom;
  // Decomp gets the editor (edits wild_encounters.json in place); binary keeps
  // the read-only cross-map SpawnGrid overview.
  return isDecomp ? <DecompEncountersView /> : <SpawnGridView />;
}

function TypesPanel() {
  const scan = useProjectStore((s) => s.scan);
  const isDecomp = scan.kind === 'loaded' && !scan.data.manifest.binaryRom;
  return isDecomp ? <DecompTypeChartView /> : <TypesViewWired />;
}

function TrainersListPanel() {
  const scan = useProjectStore((s) => s.scan);
  const isDecomp = scan.kind === 'loaded' && !scan.data.manifest.binaryRom;
  return isDecomp ? (
    <DecompTrainersView />
  ) : (
    <PlaceholderView
      title="Trainers"
      description="Full trainer list + party editor. Available on decomp projects (edits src/data/trainers.party)."
      emptyHint="Open a decomp project, or click a trainer NPC on a binary ROM map."
    />
  );
}

function LearnsetsPanel() {
  const scan = useProjectStore((s) => s.scan);
  const isDecomp = scan.kind === 'loaded' && !scan.data.manifest.binaryRom;
  return isDecomp ? (
    <DecompLearnsetsView />
  ) : (
    <PlaceholderView
      title="Learnsets"
      description="Level-up movesets. Editing is available on decomp projects (edits the active gen's level_up_learnsets file)."
      emptyHint="Open a decomp project to edit learnsets."
    />
  );
}

function SpeciesViewWired() {
  const scan = useProjectStore((s) => s.scan);
  const projectLoaded = useProjectStore((s) => s.load.kind === 'loaded');
  if (scan.kind !== 'loaded') {
    return (
      <PlaceholderView
        title="Pokémon"
        description="Every detected Pokémon species - base stats, types, abilities, held items, egg groups, growth rate. Edit any field; writes the 28-byte BaseStats struct in place."
        emptyHint={
          projectLoaded
            ? 'Project open but not yet scanned - click "Scan project" in the Project view.'
            : 'No project open - open one in the Project view to see species data.'
        }
      />
    );
  }
  return <SpeciesView manifest={scan.data.manifest} />;
}

function MovesViewWired() {
  const scan = useProjectStore((s) => s.scan);
  const projectLoaded = useProjectStore((s) => s.load.kind === 'loaded');
  if (scan.kind !== 'loaded') {
    return (
      <PlaceholderView
        title="Moves"
        description="Battle moves with type, power, accuracy, PP, priority, and effect. Click any move to edit its struct fields in place."
        emptyHint={
          projectLoaded
            ? 'Project open but not yet scanned.'
            : 'No project open.'
        }
      />
    );
  }
  return <MovesView manifest={scan.data.manifest} />;
}

function ItemsViewWired() {
  const scan = useProjectStore((s) => s.scan);
  const projectLoaded = useProjectStore((s) => s.load.kind === 'loaded');
  if (scan.kind !== 'loaded') {
    return (
      <PlaceholderView
        title="Items"
        description="Every item - price, pocket, hold effect, importance. Click any item to edit."
        emptyHint={
          projectLoaded
            ? 'Project open but not yet scanned.'
            : 'No project open.'
        }
      />
    );
  }
  return <ItemsView manifest={scan.data.manifest} />;
}

function AbilitiesViewWired() {
  const scan = useProjectStore((s) => s.scan);
  const projectLoaded = useProjectStore((s) => s.load.kind === 'loaded');
  if (scan.kind !== 'loaded') {
    return (
      <PlaceholderView
        title="Abilities"
        description="Every Pokémon ability. Edit name in place via the Gen-3 codec; descriptions are queued (parallel pointer table)."
        emptyHint={
          projectLoaded
            ? 'Project open but not yet scanned.'
            : 'No project open.'
        }
      />
    );
  }
  return <AbilitiesView manifest={scan.data.manifest} />;
}

function TrainerClassesViewWired() {
  const scan = useProjectStore((s) => s.scan);
  const projectLoaded = useProjectStore((s) => s.load.kind === 'loaded');
  if (scan.kind !== 'loaded') {
    return (
      <PlaceholderView
        title="Trainer classes"
        description="Every detected trainer class (Pokémon Trainer, Bug Catcher, Lass, etc.). Rename a class in place via the Gen-3 codec."
        emptyHint={
          projectLoaded
            ? 'Project open but not yet scanned.'
            : 'No project open.'
        }
      />
    );
  }
  return <TrainerClassesView manifest={scan.data.manifest} />;
}

function TypesViewWired() {
  const scan = useProjectStore((s) => s.scan);
  const projectLoaded = useProjectStore((s) => s.load.kind === 'loaded');
  if (scan.kind !== 'loaded') {
    return (
      <PlaceholderView
        title="Type chart"
        description="Every type matchup (attacker → defender → effectiveness). Edit any row's effectiveness in place."
        emptyHint={
          projectLoaded
            ? 'Project open but not yet scanned.'
            : 'No project open.'
        }
      />
    );
  }
  return <TypesView manifest={scan.data.manifest} />;
}

function PokedexViewWired() {
  const scan = useProjectStore((s) => s.scan);
  const projectLoaded = useProjectStore((s) => s.load.kind === 'loaded');
  if (scan.kind !== 'loaded') {
    return (
      <PlaceholderView
        title="Pokédex"
        description="Every detected Pokédex entry - category + flavor text. Read-only this pass."
        emptyHint={
          projectLoaded
            ? 'Project open but not yet scanned.'
            : 'No project open.'
        }
      />
    );
  }
  return <PokedexView manifest={scan.data.manifest} />;
}

function ChoicesViewWired() {
  const scan = useProjectStore((s) => s.scan);
  const projectLoaded = useProjectStore((s) => s.load.kind === 'loaded');
  if (scan.kind !== 'loaded') {
    return (
      <PlaceholderView
        title="Multichoice menus"
        description="Every gMultichoiceLists entry - visible choice strings (YES/NO, starter picker, store menu, etc.) are editable in place."
        emptyHint={
          projectLoaded ? 'Project open but not yet scanned.' : 'No project open.'
        }
      />
    );
  }
  return <ChoicesView manifest={scan.data.manifest} />;
}

function HealLocationsViewWired() {
  const scan = useProjectStore((s) => s.scan);
  const projectLoaded = useProjectStore((s) => s.load.kind === 'loaded');
  if (scan.kind !== 'loaded') {
    return (
      <PlaceholderView
        title="Heal locations"
        description="Every sHealLocations entry - the destinations the game warps the player to on white-out, after Fly / Teleport, and for mom's house initial spawn. Pick a different map or shift the (x, y) coords for each SPAWN_* slot."
        emptyHint={
          projectLoaded ? 'Project open but not yet scanned.' : 'No project open.'
        }
      />
    );
  }
  return <HealLocationsView manifest={scan.data.manifest} />;
}

function TilesetBrowserWired() {
  const scan = useProjectStore((s) => s.scan);
  const sessionId = useProjectStore((s) =>
    s.load.kind === 'loaded' ? s.load.data.session.id : null,
  );
  const projectLoaded = useProjectStore((s) => s.load.kind === 'loaded');
  if (scan.kind !== 'loaded' || !sessionId) {
    return (
      <PlaceholderView
        title="Tilesets"
        description="Browse every tileset detected in the ROM. Select a tileset to preview its metatiles in a grid; click any metatile to load it as the paint brush. Powers cross-tileset map building."
        emptyHint={
          projectLoaded
            ? 'Project open but not yet scanned - click "Scan project" in the Project view.'
            : 'No project open - open one in the Project view to see its tilesets.'
        }
      />
    );
  }
  return <TilesetBrowser manifest={scan.data.manifest} sessionId={sessionId} />;
}

function ProjectView() {
  const load = useProjectStore((s) => s.load);
  const scan = useProjectStore((s) => s.scan);
  const openProject = useProjectStore((s) => s.openProject);
  const openProjectFromFile = useProjectStore((s) => s.openProjectFromFile);
  const closeProject = useProjectStore((s) => s.closeProject);
  const scanCurrent = useProjectStore((s) => s.scanCurrentProject);

  if (load.kind === 'loaded') {
    return (
      <div className="view view--project">
        <IdentityCard
          identity={load.data.identity}
          projectRoot={load.data.session.projectRoot}
          sessionId={load.data.session.id}
        />
        <div className="view__panel">
          <h3 className="view__panel-heading">Project content</h3>
          {scan.kind === 'loaded' ? (
            <ScanSummary manifest={scan.data.manifest} />
          ) : (
            <div className="view__panel-meta">
              {scan.kind === 'scanning' && 'Scanning project…'}
              {scan.kind === 'idle' &&
                `${load.data.rootListing.entries.length} root entries. Scan the project to index maps, events, flags, dialogue, and assets.`}
              {scan.kind === 'error' && (
                <span className="alert alert--error">
                  Scan failed: {scan.message} <code>({scan.code})</code>
                </span>
              )}
            </div>
          )}
          <div className="view__actions" style={{ marginTop: 12 }}>
            <button
              type="button"
              data-testid="scan-project-button"
              className="btn btn--primary"
              disabled={
                scan.kind === 'scanning' ||
                (scan.kind === 'loaded' && scan.revalidating === true)
              }
              onClick={() => void scanCurrent()}
            >
              {scan.kind === 'scanning' ||
              (scan.kind === 'loaded' && scan.revalidating === true)
                ? 'Scanning…'
                : scan.kind === 'loaded'
                  ? 'Re-scan project'
                  : 'Scan project'}
            </button>
          </div>
        </div>
        <div className="view__actions">
          <button type="button" className="btn btn--secondary" onClick={closeProject}>
            Close project
          </button>
        </div>
      </div>
    );
  }

  return (
    <ProjectOpenForm
      load={load}
      onOpen={openProject}
      onOpenFromFile={openProjectFromFile}
    />
  );
}

function ScanSummary({ manifest }: { manifest: ProjectManifest }) {
  const rows: ReadonlyArray<[label: string, count: number]> = [
    ['Maps', manifest.maps.length],
    ['Warps', manifest.warps.length],
    ['Triggers', manifest.triggers.length],
    ['Object events', manifest.objectEvents.length],
    ['Flags', manifest.flags.length],
    ['Variables', manifest.variables.length],
    ['Encounter tables', manifest.encounterTables.length],
    ['Trainers', manifest.trainers.length],
    ['Dialogue', manifest.dialogue.length],
    ['Assets', manifest.assets.length],
    ['Script steps', manifest.scriptSteps.length],
    // Iter 94 (UW-3-T13) - new manifest collections from
    // species/move/item/ability/pokedex lifters. Surfaced even when
    // empty so users see the surface exists; sparse for decomp
    // projects (only the BinaryRomScanner populates these).
    ['Species names', manifest.speciesNames?.length ?? 0],
    ['Move names', manifest.moveNames?.length ?? 0],
    ['Items', manifest.items?.length ?? 0],
    ['Abilities', manifest.abilities?.length ?? 0],
    ['Pokédex entries', manifest.pokedexEntries?.length ?? 0],
    ['Trainer classes', manifest.trainerClassNames?.length ?? 0],
    ['Type names', manifest.typeNames?.length ?? 0],
    ['Type matchups', manifest.typeMatchups?.length ?? 0],
    ['Save blocks', manifest.saveBlocks?.length ?? 0],
    ['Menus', manifest.menus?.length ?? 0],
    ['Battle moves', manifest.battleMoves?.length ?? 0],
    ['Experience curves', manifest.experienceCurves?.length ?? 0],
    ['Overworld sprites', manifest.overworldSprites?.length ?? 0],
    ['Species (full stats)', manifest.species?.length ?? 0],
    ['Species evolutions', manifest.speciesEvolutions?.length ?? 0],
    ['Species learnsets', manifest.speciesLearnsets?.length ?? 0],
    ['Species TM/HM compat', manifest.speciesTMHM?.length ?? 0],
    ['Region map areas', manifest.regionMapSections?.length ?? 0],
  ];
  const totalEntities = rows.reduce((a, [, n]) => a + n, 0);
  return (
    <div data-testid="scan-summary">
      <div className="view__panel-meta">
        Indexed {totalEntities} entities across {rows.length} collections
      </div>
      <dl className="map-inspector__fields" style={{ marginTop: 8 }}>
        {rows.map(([label, count]) => (
          <span key={label} style={{ display: 'contents' }}>
            <dt>{label}</dt>
            <dd>{count}</dd>
          </span>
        ))}
      </dl>
      {manifest.binaryRom && <BinaryRomScanReportSection report={manifest.binaryRom} />}
    </div>
  );
}

/** Iter 92 (UW-3-T11) - surfaces the BinaryRomScanner's per-subsystem
 *  results so operators see what the FULL engine pipeline found, not
 *  just the manifest collections that have lifters registered. PD 12
 *  + PD 16: every detector's status is visible; "unrecognized" doesn't
 *  hide here. */
function BinaryRomScanReportSection({
  report,
}: {
  report: NonNullable<ProjectManifest['binaryRom']>;
}) {
  const lifted = report.subsystems.filter((s) => s.liftedToManifest);
  const surfacedOnly = report.subsystems.filter(
    (s) => !s.liftedToManifest && s.status === 'detected',
  );
  const notDetected = report.subsystems.filter((s) => s.status === 'not_detected');
  return (
    <details
      className="identity-card__details"
      data-testid="binary-rom-scan-report"
      open
      style={{ marginTop: 12 }}
    >
      <summary>
        Binary ROM ingest{' '}
        <span className="identity-card__meta-value">
          ({report.detectedCount}/{report.detectorCount} detectors hit; {report.liftedCount}{' '}
          lifted into manifest; {report.ingestDurationMs} ms)
        </span>
      </summary>
      <div style={{ marginTop: 8 }}>
        <p className="identity-card__rom-binary-hint">
          The binary scanner ran the engine's full {report.detectorCount}-detector pipeline on{' '}
          <code>{report.sourcePath}</code> (sha1 <code>{report.romSha1.slice(0, 12)}…</code>,{' '}
          {(report.romByteLength / (1024 * 1024)).toFixed(2)} MiB). Each detector below was
          surfaced; those marked <em>lifted</em> contributed entries to the standard manifest
          collections above. Unlifted-but-detected subsystems are still inspectable here
          (PD 16) - register a lifter in <code>binary-rom-registry.ts</code> to lift their
          structured output into a standard collection.
        </p>
        {lifted.length > 0 && (
          <>
            <div className="identity-card__meta-label" style={{ marginTop: 8 }}>
              Lifted to manifest ({lifted.length})
            </div>
            <ul data-testid="binary-rom-lifted-list">
              {lifted.map((s) => (
                <li key={s.id} data-testid={`binary-rom-subsystem-${s.id}`}>
                  <strong>{s.name}</strong> → <code>{s.liftedCollection}</code>{' '}
                  (conf {(s.confidence * 100).toFixed(0)}%
                  {s.summary ? `; ${s.summary}` : ''})
                </li>
              ))}
            </ul>
          </>
        )}
        {surfacedOnly.length > 0 && (
          <>
            <div className="identity-card__meta-label" style={{ marginTop: 8 }}>
              Detected but not yet lifted ({surfacedOnly.length})
            </div>
            <ul data-testid="binary-rom-surfaced-list">
              {surfacedOnly.map((s) => (
                <li key={s.id} data-testid={`binary-rom-subsystem-${s.id}`}>
                  <strong>{s.name}</strong> (conf {(s.confidence * 100).toFixed(0)}%
                  {s.summary ? `; ${s.summary}` : ''})
                </li>
              ))}
            </ul>
          </>
        )}
        {notDetected.length > 0 && (
          <details style={{ marginTop: 8 }}>
            <summary>
              Not detected ({notDetected.length}) - graceful per PD 1, not errors
            </summary>
            <ul data-testid="binary-rom-not-detected-list">
              {notDetected.map((s) => (
                <li key={s.id} data-testid={`binary-rom-subsystem-${s.id}`}>
                  {s.name}
                  {s.summary ? ` - ${s.summary}` : ''}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </details>
  );
}

function DialogueViewWired() {
  const scan = useProjectStore((s) => s.scan);
  const projectLoaded = useProjectStore((s) => s.load.kind === 'loaded');
  if (scan.kind !== 'loaded') {
    return (
      <PlaceholderView
        title="Dialogue"
        description="Dialogue text indexed from the project's `data/maps/*/text.inc` files. Edits write back to the source atomically."
        emptyHint={
          projectLoaded
            ? 'Project open but not yet scanned - click "Scan project" in the Project view.'
            : 'No project open - open one in the Project view to see its dialogue.'
        }
      />
    );
  }
  return <DialogueView manifest={scan.data.manifest} />;
}

function DialogueReviewPanelWired() {
  const scan = useProjectStore((s) => s.scan);
  const projectLoaded = useProjectStore((s) => s.load.kind === 'loaded');
  if (scan.kind !== 'loaded') {
    return (
      <PlaceholderView
        title="All dialogue"
        description="A single searchable list of every dialogue line in the project - filter by speaker, sort by length, click a row to edit it in the inspector. Solves the 'where is this string?' pointer-chase that ROM hackers have lived with for 20 years."
        emptyHint={
          projectLoaded
            ? 'Project open but not yet scanned - click "Scan project" in the Project view.'
            : 'No project open - open one in the Project view to see its dialogue.'
        }
      />
    );
  }
  return <DialogueReviewPanel manifest={scan.data.manifest} />;
}

function FlagsViewWired() {
  const scan = useProjectStore((s) => s.scan);
  const projectLoaded = useProjectStore((s) => s.load.kind === 'loaded');
  if (scan.kind !== 'loaded') {
    return (
      <PlaceholderView
        title="Flags"
        description="Flags and variables indexed from the project, with every cross-reference (which scripts set them, which object events gate on them, which dialogue choices toggle them) traced from the canonical manifest."
        emptyHint={
          projectLoaded
            ? 'Project open but not yet scanned - click "Scan project" in the Project view.'
            : 'No project open - open one in the Project view to see its flags and variables.'
        }
      />
    );
  }
  return <FlagsView manifest={scan.data.manifest} />;
}

function AssetsViewWired() {
  const scan = useProjectStore((s) => s.scan);
  const projectLoaded = useProjectStore((s) => s.load.kind === 'loaded');
  if (scan.kind !== 'loaded') {
    return (
      <PlaceholderView
        title="Assets"
        description="Sprites, tilesets, palettes, music, and UI graphics in the project. Selecting an asset surfaces every map, object event, dialogue line, and script step that references it."
        emptyHint={
          projectLoaded
            ? 'Project open but not yet scanned - click "Scan project" in the Project view.'
            : 'No project open - open one in the Project view to browse its assets.'
        }
      />
    );
  }
  return <AssetsView manifest={scan.data.manifest} />;
}

function PreviewViewWired() {
  const scan = useProjectStore((s) => s.scan);
  const projectLoaded = useProjectStore((s) => s.load.kind === 'loaded');
  if (scan.kind !== 'loaded') {
    return (
      <PlaceholderView
        title="Preview"
        description="Walk any map interactively. Drop a player marker, toggle collision / warps / triggers / flag-gate overlays, and the inspector reports what's under the player - so you can verify a warp goes where you fixed it without launching a build."
        emptyHint={
          projectLoaded
            ? 'Project open but not yet scanned - click "Scan project" in the Project view.'
            : 'No project open - open one in the Project view to preview its maps.'
        }
      />
    );
  }
  return <PreviewView manifest={scan.data.manifest} />;
}

function EventsViewWired() {
  const scan = useProjectStore((s) => s.scan);
  const projectLoaded = useProjectStore((s) => s.load.kind === 'loaded');
  if (scan.kind !== 'loaded') {
    return (
      <PlaceholderView
        title="Events"
        description="Events (triggers, dialogue, scripts) in the project will appear here as a readable node graph."
        emptyHint={
          projectLoaded
            ? 'Project open but not yet scanned - click "Scan project" in the Project view.'
            : 'No project open - open one in the Project view to see its events.'
        }
      />
    );
  }
  return <EventsView manifest={scan.data.manifest} />;
}

function MapsViewWired() {
  const scan = useProjectStore((s) => s.scan);
  const sessionId = useProjectStore((s) =>
    s.load.kind === 'loaded' ? s.load.data.session.id : null,
  );
  const projectLoaded = useProjectStore((s) => s.load.kind === 'loaded');
  const scanCurrent = useProjectStore((s) => s.scanCurrentProject);
  const editingMapId = useViewStore((s) => s.editingMapId);
  const openMapInEditor = useViewStore((s) => s.openMapInEditor);
  const closeMapEditor = useViewStore((s) => s.closeMapEditor);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [highlightedIds, setHighlightedIds] = useState<ReadonlySet<string>>(new Set());

  const handleMatchedChange = useCallback((ids: ReadonlySet<string>) => {
    setHighlightedIds(ids);
  }, []);

  // The Real Game Editor Push - when the default view became 'maps', the
  // empty state needs to expose the "Scan project" affordance inline.
  // Previously the user had to navigate to the Project view to scan; now
  // they can scan from the world view itself, which is where they land
  // after opening a ROM. Mirrors the scan-button pattern from ProjectView.
  if (scan.kind !== 'loaded' || !sessionId) {
    const scanning = scan.kind === 'scanning';
    const scanFailed = scan.kind === 'error';
    return (
      <div className="view">
        <h1 className="view__title">World</h1>
        <p className="view__subtitle">
          Maps detected in the project will appear here as a navigable world
          atlas - click any region, town, or route to drill in.
        </p>
        <div className="view__empty" data-testid="view-empty">
          {!projectLoaded ? (
            <span>
              No project open - click <strong>Open ROM</strong> in the titlebar
              to load a ROM or project.
            </span>
          ) : scanFailed ? (
            <>
              <span className="alert alert--error">
                Scan failed: {(scan as { message: string }).message}
              </span>
              <div style={{ marginTop: 8 }}>
                <button
                  type="button"
                  data-testid="maps-empty-scan-button"
                  className="btn btn--primary"
                  onClick={() => void scanCurrent()}
                >
                  Retry scan
                </button>
              </div>
            </>
          ) : (
            <>
              <span>
                Project is open but not yet scanned. Indexing maps, events,
                flags, dialogue, and assets…
              </span>
              <div style={{ marginTop: 12 }}>
                <button
                  type="button"
                  data-testid="maps-empty-scan-button"
                  className="btn btn--primary"
                  disabled={scanning}
                  onClick={() => void scanCurrent()}
                >
                  {scanning ? 'Scanning…' : 'Scan project'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  if (editingMapId) {
    const editingMap = scan.data.manifest.maps.find((m) => m.id === editingMapId);
    if (editingMap) {
      return (
        <MapEditor
          manifest={scan.data.manifest}
          map={editingMap}
          onClose={closeMapEditor}
        />
      );
    }
  }
  // Phase O.81 - final-line-of-defense for the O.78-O.80 silent
  // routing bug. Caller-side fixes prevent openMapInEditor from being
  // called with an unresolvable id, but any future code path that
  // bypasses those guards would hit this fallthrough. Detect the
  // mismatch + clear editingMapId + toast so the operator gets honest
  // feedback instead of a confusing silent route to the maps list.
  return (
    <MapsViewBody
      sessionId={sessionId}
      manifest={scan.data.manifest}
      unresolvedMapId={editingMapId}
      closeMapEditor={closeMapEditor}
      selectedId={selectedId}
      setSelectedId={setSelectedId}
      highlightedIds={highlightedIds}
      handleMatchedChange={handleMatchedChange}
      openMapInEditor={openMapInEditor}
    />
  );
}

function MapsViewBody({
  sessionId,
  manifest,
  unresolvedMapId,
  closeMapEditor,
  selectedId,
  setSelectedId,
  highlightedIds,
  handleMatchedChange,
}: {
  sessionId: string;
  manifest: ProjectManifest;
  unresolvedMapId: string | null;
  closeMapEditor: () => void;
  selectedId: string | null;
  setSelectedId: (id: string | null) => void;
  highlightedIds: ReadonlySet<string>;
  handleMatchedChange: (ids: ReadonlySet<string>) => void;
  openMapInEditor: (id: string) => void;
}) {
  useEffect(() => {
    if (
      unresolvedMapId &&
      !manifest.maps.some((m) => m.id === unresolvedMapId)
    ) {
      pushToast(
        'error',
        `Couldn't open map "${unresolvedMapId}" - it isn't in the lifted manifest. Falling back to the maps list.`,
      );
      closeMapEditor();
    }
  }, [unresolvedMapId, manifest.maps, closeMapEditor]);

  // The Real Game Editor Push - RegionAtlas (PixiJS-rendered region
  // map) replaces MapsGraph (ReactFlow node graph) as the primary
  // world view. MapsBrowser (categorical list) stays alongside for
  // operators who want a flat searchable list; MapsSearch keeps the
  // semantic search bar. The unused `selectedId` / `highlightedIds`
  // / `handleMatchedChange` state still drives MapsBrowser highlights
  // and the search-result chip - no functionality lost.
  return (
    <div className="maps-view" data-testid="maps-view">
      <WorldAtlasBanner manifest={manifest} />
      <MapsSearch
        sessionId={sessionId}
        onMatchedMapsChange={handleMatchedChange}
        onPickMap={(id) => setSelectedId(id)}
      />
      <div className="maps-view__body">
        <MapsBrowser
          manifest={manifest}
          selectedId={selectedId}
          onSelect={(id) => setSelectedId(id)}
          highlightedIds={highlightedIds}
        />
        <RegionAtlas manifest={manifest} />
      </div>
    </div>
  );
}

// MapsGraph is retained as an import so legacy references / tests
// that mount it directly still resolve. The default maps view uses
// RegionAtlas; MapsGraph can be re-mounted from the Advanced drawer
// or via direct routing if a power-user prefers it.
void MapsGraph;

// StructureChip - click-through to StructureInspector via useSelection.
function StructureChip({ structure }: { structure: Structure }) {
  const select = useSelection((s) => s.select);
  return (
    <button
      type="button"
      className="world-atlas-banner__structure-chip"
      title={`${structure.memberIds.length} floors · ${structure.internalWarpCount} internal warps`}
      onClick={() => select({ kind: 'structure', id: structure.id })}
      style={{
        cursor: 'pointer',
        font: 'inherit',
        color: 'inherit',
      }}
    >
      {structure.name} ({structure.memberIds.length})
    </button>
  );
}

// Phase P.4 - World Atlas banner. Mounts above the MapsBrowser + MapsGraph
// to anchor the loaded MapsView as the "world atlas" home surface (per the
// roadmap's "region atlas as the home screen, not a file browser" goal).
// Surfaces aggregate context - region count, map count, warp count, badge
// progression markers - so the user immediately sees the shape of the
// project before drilling into a map.
//
// Falls back gracefully for manifests without region_map_sections: shows
// the map/warp totals with a "(regions not yet detected)" hint. Phase R.1
// will replace this with a real region-tile renderer.
function WorldAtlasBanner({ manifest }: { manifest: ProjectManifest }) {
  const regions = manifest.regionMapSections ?? [];
  const regionLabel =
    regions.length > 0
      ? `${regions.length} region${regions.length === 1 ? '' : 's'} detected`
      : 'Regions not yet detected (Phase R.1 will surface them)';

  const groups = manifest.maps.reduce<Record<string, number>>((acc, m) => {
    acc[m.group] = (acc[m.group] ?? 0) + 1;
    return acc;
  }, {});

  const groupOrder = ['town', 'route', 'cave', 'interior', 'dungeon', 'special'];
  const groupChips = groupOrder
    .filter((g) => (groups[g] ?? 0) > 0)
    .map((g) => ({
      kind: g,
      count: groups[g] ?? 0,
    }));

  // Phase R.2 - surface inferred structures (Silph Co. = one node etc.).
  const structures = useMemo(() => inferStructures(manifest), [manifest]);

  return (
    <header className="world-atlas-banner" data-testid="world-atlas-banner">
      <div className="world-atlas-banner__title-row">
        <h1 className="world-atlas-banner__title">
          {regions.length > 0 ? regions[0]?.name ?? 'World' : 'World'}
        </h1>
        <span className="world-atlas-banner__sub">
          {manifest.maps.length} maps · {manifest.warps.length} warps · {regionLabel}
          {structures.length > 0 && (
            <>
              {' · '}
              <span data-testid="world-atlas-banner-structures">
                {structures.length} structure
                {structures.length === 1 ? '' : 's'}
              </span>
            </>
          )}
        </span>
      </div>
      {groupChips.length > 0 && (
        <div
          className="world-atlas-banner__groups"
          data-testid="world-atlas-banner-groups"
        >
          {groupChips.map((g) => (
            <span
              key={g.kind}
              className={`world-atlas-banner__chip world-atlas-banner__chip--${g.kind}`}
              data-testid={`world-atlas-banner-chip-${g.kind}`}
            >
              <span className="world-atlas-banner__chip-count">{g.count}</span>
              <span className="world-atlas-banner__chip-label">{g.kind}</span>
            </span>
          ))}
        </div>
      )}
      {structures.length > 0 && (
        <div
          className="world-atlas-banner__structures"
          data-testid="world-atlas-banner-structures-list"
        >
          {structures.slice(0, 8).map((s) => (
            <StructureChip key={s.id} structure={s} />
          ))}
          {structures.length > 8 && (
            <span className="world-atlas-banner__structure-chip world-atlas-banner__structure-chip--more">
              + {structures.length - 8} more
            </span>
          )}
        </div>
      )}
    </header>
  );
}

function ProjectOpenForm({
  load,
  onOpen,
  onOpenFromFile,
}: {
  load: Exclude<ReturnType<typeof useProjectStore.getState>['load'], { kind: 'loaded' }>;
  onOpen: (root: string) => Promise<void>;
  onOpenFromFile: (filePath: string) => Promise<void>;
}) {
  const [path, setPath] = useState(load.kind === 'error' ? load.projectRoot : '');
  const [pickerError, setPickerError] = useState<string | null>(null);
  const [pickerBusy, setPickerBusy] = useState(false);

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!path.trim()) return;
    void onOpen(path.trim());
  }

  const isLoading = load.kind === 'loading';
  const disabled = isLoading || pickerBusy;

  async function browseAndOpen(kind: 'folder' | 'rom-or-archive'): Promise<void> {
    setPickerError(null);
    setPickerBusy(true);
    try {
      const result = await pickFile(kind);
      if (result.error === 'platform_not_supported') {
        setPickerError(
          'Native file picker is only available on Windows. Paste the path into the field instead.',
        );
        return;
      }
      if (result.error) {
        setPickerError(result.message ?? 'File picker failed');
        return;
      }
      if (!result.path) {
        // User cancelled - not an error, just no-op.
        return;
      }
      if (kind === 'folder') {
        setPath(result.path);
        await onOpen(result.path);
      } else {
        setPath(result.path);
        await onOpenFromFile(result.path);
      }
    } catch (e) {
      setPickerError(e instanceof Error ? e.message : String(e));
    } finally {
      setPickerBusy(false);
    }
  }

  return (
    <div className="view view--project">
      <div className="view__hero">
        <h1 className="view__title">Open a project</h1>
        <p className="view__subtitle">
          Point the editor at a local directory (decomp source tree or patch workspace),
          or start from a <code>.gba</code> ROM or <code>.zip</code> archive - the editor will
          classify it and show what it found.
        </p>
        <div className="open-form__pickers">
          <button
            type="button"
            className="btn btn--primary"
            data-testid="browse-folder-button"
            onClick={() => void browseAndOpen('folder')}
            disabled={disabled}
          >
            {pickerBusy ? 'Picking…' : 'Browse folder…'}
          </button>
          <button
            type="button"
            className="btn btn--primary"
            data-testid="browse-rom-button"
            onClick={() => void browseAndOpen('rom-or-archive')}
            disabled={disabled}
          >
            {pickerBusy ? 'Picking…' : 'Browse ROM / ZIP…'}
          </button>
        </div>
        <form className="open-form" onSubmit={submit} aria-label="Open project">
          <label className="open-form__label" htmlFor="project-root-input">
            …or paste an absolute path
          </label>
          <div className="open-form__row">
            <input
              id="project-root-input"
              data-testid="project-root-input"
              type="text"
              className="open-form__input"
              placeholder="e.g. C:\Users\you\projects\pokeemerald  or  /home/you/pokeemerald"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              disabled={disabled}
              spellCheck={false}
              autoComplete="off"
            />
            <button
              type="submit"
              data-testid="open-project-button"
              className="btn btn--primary"
              disabled={disabled || !path.trim()}
            >
              {isLoading ? 'Opening…' : 'Open'}
            </button>
          </div>
        </form>
        {pickerError && (
          <div className="alert alert--error" role="alert" data-testid="picker-error">
            <strong>Picker error:</strong> {pickerError}
          </div>
        )}
        {load.kind === 'error' && (
          <div className="alert alert--error" role="alert" data-testid="open-error">
            <strong>Could not open:</strong> {load.message}
            <div className="alert__code">code: {load.code}</div>
          </div>
        )}
      </div>
    </div>
  );
}

function IdentityCard({
  identity,
  projectRoot,
  sessionId,
}: {
  identity: ProjectIdentity;
  projectRoot: string;
  sessionId: string;
}) {
  const confidencePct = Math.round(identity.confidence * 100);
  return (
    <div
      className={`identity-card identity-card--${identity.kind}`}
      data-testid="identity-card"
    >
      <div className="identity-card__header">
        <span className="identity-card__kind">{kindLabel(identity.kind)}</span>
        <span className="identity-card__confidence">
          confidence {confidencePct}%
        </span>
      </div>
      <h1 className="identity-card__name" data-testid="identity-display-name">
        {identity.displayName}
      </h1>
      {/* Phase 6.6 - overlay status pill. Tells the user at a glance
          whether the editor is asserting vanilla labels (overlaySafe)
          or falling back to best-effort scanner data. The negative
          case lights up for any ROM whose op-log doesn't carry our
          modernize_rom entry AND whose SHA-1 isn't in the fingerprint
          table - typically custom CFRU builds or unrelated hacks. */}
      {identity.overlaySafe ? (
        <div
          className="identity-card__overlay-pill identity-card__overlay-pill--safe"
          data-testid="identity-overlay-pill-safe"
          title="The editor is asserting vanilla FRLG names for maps, encounter slots, and regions on this ROM. Source: pret/pokefirered ground truth."
        >
          ✓ Vanilla labels active
          {identity.modernizedBy && ` · ${identity.modernizedBy}`}
        </div>
      ) : (
        identity.kind === 'patch' &&
        identity.romHeader && (
          <div
            className="identity-card__overlay-pill identity-card__overlay-pill--unknown"
            data-testid="identity-overlay-pill-unknown"
            title="The editor doesn't have ground truth for this ROM, so labels (map names, encounter species, etc.) are best-effort from the scanner. Click Modernize on a vanilla FireRed to enable the vanilla overlay."
          >
            ⓘ Unknown ROM - labels are best-effort
          </div>
        )
      )}
      <div className="identity-card__path" title={projectRoot}>
        {projectRoot}
      </div>
      <div className="identity-card__bar" aria-hidden="true">
        <div
          className="identity-card__bar-fill"
          style={{ width: `${Math.max(2, confidencePct)}%` }}
        />
      </div>
      {identity.baseGame && (
        <div className="identity-card__meta">
          <span className="identity-card__meta-label">Base game</span>
          <span className="identity-card__meta-value">{identity.baseGame}</span>
        </div>
      )}
      {identity.evidence.length > 0 && (
        <details className="identity-card__details">
          <summary>Evidence ({identity.evidence.length})</summary>
          <ul className="identity-card__evidence-list" data-testid="identity-evidence">
            {identity.evidence.map((ev) => (
              <li key={ev}>{ev}</li>
            ))}
          </ul>
        </details>
      )}
      {identity.romHeader && (
        <RomHeaderSection header={identity.romHeader} />
      )}
      {identity.romStructure && (
        <RomStructureSection structure={identity.romStructure} />
      )}
      {identity.detectedSubsystems && identity.detectedSubsystems.length > 0 && (
        <DetectedSubsystemsSection subsystems={identity.detectedSubsystems} />
      )}
      {identity.coverageSummary && (
        <UnknownsPolicySection coverage={identity.coverageSummary} />
      )}
      {identity.romBinary && (
        <RomBinarySection rom={identity.romBinary} />
      )}
      <SymbolDbNotice />
      {identity.fork === 'CFRU' && (
        <AttributionPanel sessionId={sessionId} variant="inline" />
      )}
      {identity.fork === 'CFRU' && (
        <ExportPatchCard
          sessionId={sessionId}
          isCfru={true}
          defaultHackName={
            projectRoot.split(/[\\/]/).filter(Boolean).pop() ?? 'my-hack'
          }
        />
      )}
      {identity.warnings.length > 0 && (
        <ul className="identity-card__warnings" data-testid="identity-warnings">
          {identity.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function RomHeaderSection({
  header,
}: {
  header: NonNullable<ProjectIdentity['romHeader']>;
}) {
  return (
    <details
      className="identity-card__details identity-card__rom-header"
      data-testid="identity-rom-header"
      open
    >
      <summary>
        ROM cartridge header{' '}
        <span className="identity-card__meta-value">
          ({header.gameCode}
          {header.knownGame ? ` - ${header.knownGame}` : ''})
        </span>
      </summary>
      <div className="identity-card__rom-header-body">
        <div className="identity-card__meta">
          <span className="identity-card__meta-label">Game code</span>
          <span className="identity-card__meta-value" data-testid="rom-header-game-code">
            {header.gameCode}
          </span>
        </div>
        <div className="identity-card__meta">
          <span className="identity-card__meta-label">Internal title</span>
          <span className="identity-card__meta-value" data-testid="rom-header-title">
            {header.internalTitle.length > 0 ? header.internalTitle : '(empty)'}
          </span>
        </div>
        <div className="identity-card__meta">
          <span className="identity-card__meta-label">Maker code</span>
          <span className="identity-card__meta-value" data-testid="rom-header-maker">
            {header.makerCode.length > 0 ? header.makerCode : '(empty)'}
          </span>
        </div>
        <div className="identity-card__meta">
          <span className="identity-card__meta-label">Software version</span>
          <span
            className="identity-card__meta-value"
            data-testid="rom-header-version"
          >
            v{header.softwareVersion}
          </span>
        </div>
        {header.knownGame && (
          <div className="identity-card__meta">
            <span className="identity-card__meta-label">Recognized as</span>
            <span
              className="identity-card__meta-value"
              data-testid="rom-header-known-game"
            >
              {header.knownGame}
            </span>
          </div>
        )}
        <p className="identity-card__rom-binary-hint">
          Parsed by the engine's GBA cartridge header detector. Game code is
          stable across regional releases; hacks typically keep the parent's
          code (e.g. Unbound → BPRE) but rewrite the internal title.
        </p>
      </div>
    </details>
  );
}

function RomMemoryMap({
  structure,
}: {
  structure: NonNullable<ProjectIdentity['romStructure']>;
}) {
  const { memoryLayout, pointerTables, compressionRegions } = structure;
  const [selectedBandKey, setSelectedBandKey] = useState<string | null>(null);
  const MAP_WIDTH = 800;
  const MAP_HEIGHT = 32;
  const MIN_BAND_PX = 2;
  const HEADER_COLOR = '#a78bfa'; // purple
  const POINTER_TABLE_COLOR = '#60a5fa'; // blue
  const LZ77_COLOR = '#fb923c'; // orange
  const BG_COLOR = '#1f2937'; // dark gray (unclassified body)

  const toX = (offset: number): number =>
    Math.min(MAP_WIDTH, (offset / memoryLayout.romSize) * MAP_WIDTH);
  const toWidth = (bytes: number): number =>
    Math.max(MIN_BAND_PX, (bytes / memoryLayout.romSize) * MAP_WIDTH);

  interface MapBand {
    readonly key: string;
    readonly x: number;
    readonly width: number;
    readonly color: string;
    readonly title: string;
    readonly kind: 'header' | 'pointer_table' | 'lz77_block';
    readonly offset: number;
    readonly bytes: number;
    readonly extra?: string;
  }
  const bands: MapBand[] = [];
  // Header band - always 0..headerLength.
  bands.push({
    key: 'header',
    x: toX(memoryLayout.headerOffset),
    width: toWidth(memoryLayout.headerLength),
    color: HEADER_COLOR,
    title: `Header - 0x${memoryLayout.headerOffset.toString(16).toUpperCase().padStart(6, '0')} (${memoryLayout.headerLength} bytes)`,
    kind: 'header',
    offset: memoryLayout.headerOffset,
    bytes: memoryLayout.headerLength,
  });
  // Top-N pointer tables.
  if (pointerTables) {
    pointerTables.largestTables.forEach((t, i) => {
      const bytes = t.length * t.stride;
      bands.push({
        key: `pt-${i}`,
        x: toX(t.offset),
        width: toWidth(bytes),
        color: POINTER_TABLE_COLOR,
        title: `Pointer table - 0x${t.offset.toString(16).toUpperCase().padStart(6, '0')} (${t.length} entries × ${t.stride} = ${bytes} bytes)`,
        kind: 'pointer_table',
        offset: t.offset,
        bytes,
        extra: `${t.length} pointer entries × ${t.stride}-byte stride`,
      });
    });
  }
  // Top-N LZ77 blocks.
  if (compressionRegions) {
    compressionRegions.largestLz77Blocks.forEach((b, i) => {
      bands.push({
        key: `lz-${i}`,
        x: toX(b.offset),
        width: toWidth(b.compressedSize),
        color: LZ77_COLOR,
        title: `LZ77 block - 0x${b.offset.toString(16).toUpperCase().padStart(6, '0')} (${b.compressedSize} → ${b.uncompressedSize} bytes)`,
        kind: 'lz77_block',
        offset: b.offset,
        bytes: b.compressedSize,
        extra: `Decompresses to ${b.uncompressedSize.toLocaleString()} bytes (ratio ${(b.uncompressedSize / b.compressedSize).toFixed(2)}×)`,
      });
    });
  }
  const selectedBand = bands.find((b) => b.key === selectedBandKey) ?? null;
  const fmtHex = (n: number): string =>
    `0x${n.toString(16).toUpperCase().padStart(6, '0')}`;
  const kindLabel = (k: MapBand['kind']): string => {
    if (k === 'header') return 'Cartridge header';
    if (k === 'pointer_table') return 'Pointer table';
    return 'LZ77 compression block';
  };

  return (
    <div
      className="identity-card__rom-memory-map"
      data-testid="identity-rom-memory-map"
    >
      <div className="identity-card__meta-label" style={{ marginBottom: 4 }}>
        Memory map heatmap (top regions per kind)
      </div>
      <svg
        viewBox={`0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`}
        preserveAspectRatio="none"
        role="img"
        aria-label="ROM memory map visualization"
        style={{ width: '100%', height: 32, display: 'block' }}
      >
        <rect x={0} y={0} width={MAP_WIDTH} height={MAP_HEIGHT} fill={BG_COLOR} />
        {bands.map((b) => {
          const isSelected = b.key === selectedBandKey;
          return (
            <rect
              key={b.key}
              x={b.x}
              y={0}
              width={b.width}
              height={MAP_HEIGHT}
              fill={b.color}
              stroke={isSelected ? '#ffffff' : 'transparent'}
              strokeWidth={isSelected ? 2 : 0}
              style={{ cursor: 'pointer' }}
              data-testid={`rom-map-band-${b.key}`}
              onClick={() => setSelectedBandKey(isSelected ? null : b.key)}
            >
              <title>{b.title}</title>
            </rect>
          );
        })}
      </svg>
      <div
        className="identity-card__rom-memory-map-legend"
        style={{ display: 'flex', gap: 12, fontSize: 11, marginTop: 4 }}
      >
        <span>
          <span
            style={{
              display: 'inline-block',
              width: 10,
              height: 10,
              background: HEADER_COLOR,
              marginRight: 4,
              verticalAlign: 'middle',
            }}
          />
          Cartridge header
        </span>
        <span>
          <span
            style={{
              display: 'inline-block',
              width: 10,
              height: 10,
              background: POINTER_TABLE_COLOR,
              marginRight: 4,
              verticalAlign: 'middle',
            }}
          />
          Pointer tables
        </span>
        <span>
          <span
            style={{
              display: 'inline-block',
              width: 10,
              height: 10,
              background: LZ77_COLOR,
              marginRight: 4,
              verticalAlign: 'middle',
            }}
          />
          LZ77 blocks
        </span>
        <span style={{ marginLeft: 'auto', opacity: 0.7 }}>
          Hover or click bands for details · {(memoryLayout.romSize / (1024 * 1024)).toFixed(2)} MiB total
        </span>
      </div>
      {selectedBand && (
        <div
          className="identity-card__rom-memory-map-detail"
          data-testid="rom-map-selected-detail"
          style={{
            marginTop: 8,
            padding: 8,
            border: `1px solid ${selectedBand.color}`,
            borderRadius: 4,
            fontSize: 12,
          }}
        >
          <div style={{ fontWeight: 'bold', marginBottom: 4 }}>
            <span
              style={{
                display: 'inline-block',
                width: 10,
                height: 10,
                background: selectedBand.color,
                marginRight: 6,
                verticalAlign: 'middle',
              }}
            />
            {kindLabel(selectedBand.kind)} @ {fmtHex(selectedBand.offset)}
          </div>
          <div>
            <strong>Range:</strong> {fmtHex(selectedBand.offset)}..
            {fmtHex(selectedBand.offset + selectedBand.bytes)} (
            {selectedBand.bytes.toLocaleString()} bytes)
          </div>
          {selectedBand.extra && <div>{selectedBand.extra}</div>}
          <button
            type="button"
            onClick={() => setSelectedBandKey(null)}
            style={{
              marginTop: 6,
              fontSize: 11,
              padding: '2px 8px',
              cursor: 'pointer',
            }}
            data-testid="rom-map-selected-clear"
          >
            Clear selection
          </button>
        </div>
      )}
    </div>
  );
}

function RomStructureSection({
  structure,
}: {
  structure: NonNullable<ProjectIdentity['romStructure']>;
}) {
  const { memoryLayout, pointerTables, compressionRegions } = structure;
  const hex = (n: number): string => `0x${n.toString(16).toUpperCase().padStart(6, '0')}`;
  const mib = (n: number): string => `${(n / (1024 * 1024)).toFixed(2)} MiB`;
  return (
    <details
      className="identity-card__details identity-card__rom-structure"
      data-testid="identity-rom-structure"
    >
      <summary>
        ROM structure{' '}
        <span className="identity-card__meta-value">
          ({mib(memoryLayout.romSize)}
          {pointerTables ? ` · ${pointerTables.tableCount} pointer tables` : ''}
          {compressionRegions
            ? ` · ${compressionRegions.confirmedLz77BlockCount} LZ77 blocks`
            : ''})
        </span>
      </summary>
      <div className="identity-card__rom-structure-body">
        {/* UW-1-T5: SVG memory-map heatmap at the top of the body */}
        <RomMemoryMap structure={structure} />
        {/* Memory layout: ROM size + header + body offsets/lengths */}
        <div className="identity-card__meta-label" style={{ marginTop: 12 }}>
          Memory layout
        </div>
        <ul
          className="identity-card__rom-structure-list"
          data-testid="rom-structure-memory-layout"
        >
          <li>
            <strong>ROM size:</strong> {memoryLayout.romSize.toLocaleString()} bytes (
            {mib(memoryLayout.romSize)})
          </li>
          <li>
            <strong>Header:</strong> {hex(memoryLayout.headerOffset)}..
            {hex(memoryLayout.headerOffset + memoryLayout.headerLength)} (
            {memoryLayout.headerLength} bytes)
          </li>
          <li>
            <strong>Body:</strong> {hex(memoryLayout.bodyOffset)}..
            {hex(memoryLayout.bodyOffset + memoryLayout.bodyLength)} (
            {memoryLayout.bodyLength.toLocaleString()} bytes)
          </li>
        </ul>
        {/* Pointer-table inventory */}
        {pointerTables ? (
          <>
            <div
              className="identity-card__meta-label"
              style={{ marginTop: 12 }}
              data-testid="rom-structure-pointer-tables-label"
            >
              Pointer tables ({pointerTables.tableCount})
            </div>
            <ul className="identity-card__rom-structure-list">
              <li>
                <strong>Total pointers:</strong>{' '}
                {pointerTables.totalPointerCount.toLocaleString()}
              </li>
              <li>
                <strong>Tables:</strong> {pointerTables.tableCount} ({' '}
                {pointerTables.tableBytesCovered.toLocaleString()} bytes covered)
              </li>
              <li>
                <strong>Cross-ref targets:</strong>{' '}
                {pointerTables.clusterTargetCount.toLocaleString()}
              </li>
            </ul>
            {pointerTables.largestTables.length > 0 && (
              <>
                <div className="identity-card__meta-label" style={{ marginTop: 8 }}>
                  Largest tables ({pointerTables.largestTables.length})
                </div>
                <ul className="identity-card__rom-structure-table-list">
                  {pointerTables.largestTables.map((t, i) => (
                    <li key={i}>
                      {hex(t.offset)} - {t.length} entries × {t.stride} bytes
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        ) : (
          <p className="identity-card__rom-binary-hint">
            No pointer-table network detected (engine returned
            <em> not_detected</em> - ROM may be too small to scan, or pointers
            don't run at the canonical 4-byte stride).
          </p>
        )}
        {/* Compression-region inventory */}
        {compressionRegions ? (
          <>
            <div
              className="identity-card__meta-label"
              style={{ marginTop: 12 }}
              data-testid="rom-structure-compression-label"
            >
              Compression regions ({compressionRegions.confirmedLz77BlockCount} LZ77)
            </div>
            <ul className="identity-card__rom-structure-list">
              <li>
                <strong>Confirmed LZ77 blocks:</strong>{' '}
                {compressionRegions.confirmedLz77BlockCount} ({' '}
                {compressionRegions.confirmedLz77BytesCovered.toLocaleString()} bytes)
              </li>
              <li>
                <strong>Probable compressed regions:</strong>{' '}
                {compressionRegions.probableCompressionRegionCount} ({' '}
                {compressionRegions.probableCompressionBytesScored.toLocaleString()} bytes)
              </li>
            </ul>
            {compressionRegions.largestLz77Blocks.length > 0 && (
              <>
                <div className="identity-card__meta-label" style={{ marginTop: 8 }}>
                  Largest LZ77 blocks ({compressionRegions.largestLz77Blocks.length})
                </div>
                <ul className="identity-card__rom-structure-table-list">
                  {compressionRegions.largestLz77Blocks.map((b, i) => (
                    <li key={i}>
                      {hex(b.offset)} - {b.compressedSize.toLocaleString()} →{' '}
                      {b.uncompressedSize.toLocaleString()} bytes
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        ) : (
          <p className="identity-card__rom-binary-hint">
            No compression regions detected (engine returned <em>not_detected</em>
 - ROM contains no recognizable LZ77 streams or high-entropy blocks).
          </p>
        )}
        <p className="identity-card__rom-binary-hint">
          All structural data comes from the engine's universal heuristic
          detectors (no baked offsets) - works on any GBA ROM including
          heavily-relocated hacks.
        </p>
      </div>
    </details>
  );
}

function DetectedSubsystemsSection({
  subsystems,
}: {
  subsystems: NonNullable<ProjectIdentity['detectedSubsystems']>;
}) {
  // Friendly display name for known detector IDs. Fallback to the
  // engine's `name` field if we haven't seen this id before - hack
  // plugins may surface new subsystems via the same channel.
  const idLabel = (id: string): string => {
    switch (id) {
      case 'save_system':
        return 'Save backend';
      case 'moves_system':
        return 'Moves table';
      case 'type_chart_system':
        return 'Type effectiveness chart';
      case 'items_system':
        return 'Items table';
      case 'abilities_system':
        return 'Abilities table';
      case 'move_names':
        return 'Move names';
      case 'species_names':
        return 'Species names';
      case 'save_data_system':
        return 'Save data layout';
      case 'menu_system':
        return 'Menu system';
      case 'palette_system':
        return 'Palette regions';
      case 'audio_system':
        return 'Audio engine';
      case 'pokedex_system':
        return 'Pokédex entries';
      case 'type_names':
        return 'Type names';
      case 'trainer_class_names':
        return 'Trainer class names';
      case 'cry_table_system':
        return 'Cry table';
      case 'text_pointer_tables':
        return 'Text pointer tables';
      case 'lz77_pointer_tables':
        return 'LZ77 graphics pointer tables';
      default:
        return id;
    }
  };
  const detectedCount = subsystems.filter((s) => s.status === 'detected').length;
  const totalCount = subsystems.length;
  return (
    <details
      className="identity-card__details identity-card__detected-subsystems"
      data-testid="identity-detected-subsystems"
      open
    >
      <summary>
        Detected combat subsystems{' '}
        <span className="identity-card__meta-value">
          ({detectedCount} of {totalCount} detected)
        </span>
      </summary>
      <div className="identity-card__detected-subsystems-body">
        <ul
          className="identity-card__detected-subsystems-list"
          data-testid="detected-subsystems-list"
        >
          {subsystems.map((sub) => {
            const confidencePct = Math.round(sub.confidence * 100);
            return (
              <li
                key={sub.id}
                className={`identity-card__detected-subsystem identity-card__detected-subsystem--${sub.status}`}
                data-testid={`detected-subsystem-${sub.id}`}
              >
                <div className="identity-card__detected-subsystem-row">
                  <span
                    className={`identity-card__detected-subsystem-badge identity-card__detected-subsystem-badge--${sub.status}`}
                    aria-label={`Status: ${sub.status}`}
                    title={`Status: ${sub.status}`}
                  >
                    {sub.status === 'detected' ? '✓' : sub.status === 'partial' ? '~' : '×'}
                  </span>
                  <span className="identity-card__detected-subsystem-name">
                    {idLabel(sub.id)}
                  </span>
                  <span className="identity-card__detected-subsystem-confidence">
                    {confidencePct}%
                  </span>
                </div>
                {sub.summary && (
                  <div
                    className="identity-card__detected-subsystem-summary"
                    data-testid={`detected-subsystem-${sub.id}-summary`}
                  >
                    {sub.summary}
                  </div>
                )}
                {!sub.summary && sub.status !== 'detected' && (
                  <div className="identity-card__detected-subsystem-summary identity-card__detected-subsystem-summary--missing">
                    Engine returned {sub.status}; ROM does not contain a
                    recognizable {idLabel(sub.id).toLowerCase()}.
                  </div>
                )}
                {sub.sampleNames && sub.sampleNames.length > 0 && (
                  <DetectedSubsystemSampleNames
                    id={sub.id}
                    sampleNames={sub.sampleNames}
                  />
                )}
              </li>
            );
          })}
        </ul>
        <p className="identity-card__rom-binary-hint">
          These subsystems are detected directly from the ROM binary via the
          engine's universal heuristic detectors (no baked offsets) - they
          work on vanilla AND any hack that retains the canonical Gen-3
          structural layouts.
        </p>
      </div>
    </details>
  );
}

/**
 * Per-tile sample-names chip list rendered below the summary for
 * subsystems that expose decoded names (species/abilities/moves/items
 * detectors). Shows the first 6 non-empty names by default; click
 * "View all" to expand to all sampleNames (up to ~24 per detector);
 * click "Show less" to collapse. Empty placeholder names (e.g. item 0
 * "?????") are skipped so the preview shows meaningful data only.
 *
 * UW-3-T4 iter 85: added expand-toggle so users can see the full
 * decoded table inline without running a separate Scan Project pass.
 * First step toward future per-subsystem inspector modals (PD 14
 * deeper).
 *
 * PD 14 visual surface: chip list + toggle button - not raw JSON dump.
 * PD 13: data comes from engine's sampleNames; no editor-side
 * decoding.
 */
function DetectedSubsystemSampleNames({
  id,
  sampleNames,
}: {
  id: string;
  sampleNames: ReadonlyArray<string>;
}) {
  const [expanded, setExpanded] = useState(false);
  const previewCount = 6;
  const meaningful = sampleNames.filter((n) => n.length > 0);
  if (meaningful.length === 0) return null;
  const preview = meaningful.slice(0, previewCount);
  const hasMore = meaningful.length > preview.length;
  const visible = expanded ? meaningful : preview;
  return (
    <div
      className="identity-card__detected-subsystem-sample-names"
      data-testid={`detected-subsystem-${id}-sample-names`}
    >
      <span className="identity-card__detected-subsystem-sample-names-label">
        Sample:
      </span>{' '}
      <span className="identity-card__detected-subsystem-sample-names-list">
        {visible.join(', ')}
        {!expanded && hasMore ? ` +${meaningful.length - preview.length} more` : ''}
      </span>
      {hasMore && (
        <button
          type="button"
          className="identity-card__detected-subsystem-sample-names-toggle"
          data-testid={`detected-subsystem-${id}-sample-names-toggle`}
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
        >
          {expanded ? 'Show less' : `View all (${meaningful.length})`}
        </button>
      )}
    </div>
  );
}

/**
 * Cat 15 unknowns-policy surface (UW-2-T14 iter 80). Renders coverage
 * totals + top-N scored-unknown regions in the IdentityCard. Honors
 * PD 12 ("no dead zones - every byte either classified or surfaced as
 * a scored-unknown object with confidence + provenance + context") +
 * PD 14 (visual surface - formatted totals row + region table, not raw
 * JSON).
 *
 * The lightweight scanRomStructure path only runs ~14 detectors so
 * the unaccounted percentage will typically be high; we present the
 * data honestly and prompt the user to run "Scan Project" for full
 * coverage closure.
 */
function UnknownsPolicySection({
  coverage,
}: {
  coverage: NonNullable<ProjectIdentity['coverageSummary']>;
}) {
  const hex = (n: number): string => `0x${n.toString(16).toUpperCase().padStart(6, '0')}`;
  const formatBytes = (n: number): string => {
    if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MiB`;
    if (n >= 1024) return `${(n / 1024).toFixed(1)} KiB`;
    return `${n} B`;
  };
  // UW-3-T5 iter 86: surface the full-project scan affordance INSIDE the
  // coverage card so the user can close the lightweight-scan gap without
  // scrolling away from the unaccounted-bytes data that prompted them to
  // scan in the first place. Shares the project-store scan action with the
  // top-level Scan Project button - no duplicate state machine.
  const scan = useProjectStore((s) => s.scan);
  const scanCurrent = useProjectStore((s) => s.scanCurrentProject);
  // Treat both bare 'scanning' AND mid-revalidation as in-progress for
  // button disabled-state purposes (so the user can't double-trigger).
  const scanInProgress =
    scan.kind === 'scanning' ||
    (scan.kind === 'loaded' && scan.revalidating === true);
  const scanLoaded = scan.kind === 'loaded';
  return (
    <details
      className="identity-card__details identity-card__unknowns-policy"
      data-testid="identity-unknowns-policy"
      open
    >
      <summary>
        Coverage &amp; unknowns policy{' '}
        <span className="identity-card__meta-value">
          (classified {coverage.classifiedPct.toFixed(2)}% · unknown{' '}
          {coverage.unknownScoredPct.toFixed(2)}% · unaccounted{' '}
          {coverage.unaccountedPct.toFixed(2)}%)
        </span>
      </summary>
      <div className="identity-card__unknowns-policy-body">
        <ul
          className="identity-card__unknowns-policy-totals"
          data-testid="unknowns-policy-totals"
        >
          <li>
            <strong>ROM size:</strong> {formatBytes(coverage.romSize)} (
            {coverage.romSize.toLocaleString()} bytes)
          </li>
          <li>
            <strong>Classified:</strong> {formatBytes(coverage.classifiedBytes)} (
            {coverage.classifiedPct.toFixed(2)}%) across {coverage.regionCount} regions
          </li>
          <li>
            <strong>Scored-unknown:</strong> {formatBytes(coverage.unknownScoredBytes)} (
            {coverage.unknownScoredPct.toFixed(2)}%) - engine flagged but couldn't classify
          </li>
          <li>
            <strong>Unaccounted:</strong> {formatBytes(coverage.unaccountedBytes)} (
            {coverage.unaccountedPct.toFixed(2)}%) - not yet covered by lightweight scan
          </li>
        </ul>
        {coverage.topScoredUnknownRegions.length > 0 && (
          <>
            <div className="identity-card__meta-label" style={{ marginTop: 8 }}>
              Top {coverage.topScoredUnknownRegions.length} scored-unknown regions
            </div>
            <ul
              className="identity-card__unknowns-policy-regions"
              data-testid="unknowns-policy-regions"
            >
              {coverage.topScoredUnknownRegions.map((rgn) => (
                <li key={`${rgn.start}-${rgn.end}`} data-testid={`unknown-region-${rgn.start}`}>
                  <code>
                    {hex(rgn.start)}..{hex(rgn.end)}
                  </code>{' '}
                  ({formatBytes(rgn.sizeBytes)}, score {(rgn.score * 100).toFixed(0)}%, from{' '}
                  <em>{rgn.provenance}</em>)
                  {rgn.note ? ` - ${rgn.note}` : ''}
                </li>
              ))}
            </ul>
          </>
        )}
        {coverage.topScoredUnknownRegions.length === 0 && coverage.unknownScoredBytes === 0 && (
          <p className="identity-card__rom-binary-hint">
            No scored-unknown regions detected at project-open.
          </p>
        )}
        <div
          className="identity-card__unknowns-policy-action"
          data-testid="unknowns-policy-action"
          style={{ marginTop: 12 }}
        >
          <button
            type="button"
            className="btn btn--primary"
            data-testid="unknowns-policy-scan-button"
            disabled={scanInProgress}
            onClick={() => void scanCurrent()}
          >
            {scanInProgress
              ? 'Scanning…'
              : scanLoaded
                ? 'Re-run full project scan'
                : 'Run full project scan'}
          </button>
        </div>
        <p
          className="identity-card__rom-binary-hint"
          data-testid="unknowns-policy-disclaimer"
        >
          {scanLoaded ? (
            <>
              Full project scan complete via{' '}
              <code data-testid="unknowns-policy-scanner-name">{scan.data.scannerName}</code>{' '}
              in {scan.data.scanDurationMs} ms - manifest indexed at{' '}
              <code data-testid="unknowns-policy-manifest-path">{scan.data.manifestPath}</code>.
              The coverage totals above remain the engine's universal coverage map (PD 8);
              the full scan layered editable manifest content (maps, events, dialogue,
              flags, assets) on top.
            </>
          ) : scan.kind === 'error' ? (
            <span className="alert alert--error">
              Scan failed: {scan.message} <code>({scan.code})</code>
            </span>
          ) : (
            <>
              Coverage totals come from the engine's universal coverage map (PD 8 + PD 12).
              The lightweight project-open scan only runs the 14 fast detectors; running
              the full scan above surfaces additional classified regions and closes the
              unaccounted gap.
            </>
          )}
        </p>
      </div>
    </details>
  );
}

function RomBinarySection({ rom }: { rom: NonNullable<ProjectIdentity['romBinary']> }) {
  const sourceLabel =
    rom.speciesSource === 'documented'
      ? 'documented offsets'
      : rom.speciesSource === 'signature_scan'
        ? 'signature scan (data was relocated)'
        : 'not readable';
  return (
    <details
      className="identity-card__details identity-card__rom-binary"
      data-testid="identity-rom-binary"
    >
      <summary>
        ROM contents{' '}
        <span className="identity-card__meta-value">
          ({rom.speciesCount} species)
        </span>
      </summary>
      <div className="identity-card__rom-binary-body">
        <div className="identity-card__meta">
          <span className="identity-card__meta-label">Variant</span>
          <span className="identity-card__meta-value">
            {rom.variantDisplayName ?? 'Unknown / unseeded'}
          </span>
        </div>
        <div className="identity-card__meta">
          <span className="identity-card__meta-label">Read via</span>
          <span className="identity-card__meta-value">{sourceLabel}</span>
        </div>
        {rom.speciesCount > 0 && (
          <>
            <div className="identity-card__meta-label" style={{ marginTop: 8 }}>
              First {Math.min(rom.speciesPreview.length, 24)} species
            </div>
            <ul
              className="identity-card__rom-species"
              data-testid="identity-rom-species-preview"
            >
              {rom.speciesPreview.map((name, i) => (
                <li key={i}>{name}</li>
              ))}
            </ul>
            <p className="identity-card__rom-binary-hint">
              These names were decoded directly from the ROM binary using
              the Gen-3 Pokémon character set. Reading map / event / dialogue
              content from a binary ROM is a larger feature - for now bare
              ROMs surface what we can read without a decomp source tree.
            </p>
          </>
        )}
        {rom.speciesCount === 0 && (
          <p className="identity-card__rom-binary-hint">
            The editor could not decode a species table from this ROM. This
            usually means it's a heavy hack with relocated or customized data
            (Unbound, Radical Red, etc.). Header info is still trustworthy;
            content-level reads need hack-specific offsets we don't have yet.
          </p>
        )}
      </div>
    </details>
  );
}

function kindLabel(kind: ProjectKind): string {
  switch (kind) {
    case 'decomp':
      return 'Decomp project';
    case 'patch':
      return 'Patch project';
    case 'hybrid':
      return 'Hybrid project';
    case 'unknown':
      return 'Unclassified';
  }
}

function PlaceholderView({
  title,
  description,
  emptyHint,
}: {
  title: string;
  description: string;
  emptyHint: string;
}) {
  const projectLoaded = useProjectStore((s) => s.load.kind === 'loaded');
  return (
    <div className="view">
      <h1 className="view__title">{title}</h1>
      <p className="view__subtitle">{description}</p>
      <div className="view__empty" data-testid="view-empty">
        {projectLoaded
          ? `No ${title.toLowerCase()} indexed yet.`
          : emptyHint}
      </div>
    </div>
  );
}

function MechanicsViewWired() {
  const scan = useProjectStore((s) => s.scan);
  const projectLoaded = useProjectStore((s) => s.load.kind === 'loaded');
  if (scan.kind !== 'loaded') {
    return (
      <PlaceholderView
        title="Mechanics"
        description="Detects common modern-hack mechanics (starter selection, difficulty systems, evolution flag groups, encounter-table variants) from the canonical manifest. Each detection shows the entity ids that imply it."
        emptyHint={
          projectLoaded
            ? 'Project open but not yet scanned - click "Scan project" in the Project view.'
            : 'No project open - open one in the Project view to inspect its mechanics.'
        }
      />
    );
  }
  return <MechanicsView manifest={scan.data.manifest} />;
}

function LintViewWired() {
  const scan = useProjectStore((s) => s.scan);
  const projectLoaded = useProjectStore((s) => s.load.kind === 'loaded');
  if (scan.kind !== 'loaded') {
    return (
      <PlaceholderView
        title="Lint"
        description="Design-quality checks over the canonical manifest: orphan dialogue, unused flags, orphan assets, empty triggers, decorative-or-broken object events. Catches mistakes before the build does."
        emptyHint={
          projectLoaded
            ? 'Project open but not yet scanned - click "Scan project" in the Project view.'
            : 'No project open - open one in the Project view to lint it.'
        }
      />
    );
  }
  return <LintView manifest={scan.data.manifest} />;
}

function DependenciesViewWired() {
  const scan = useProjectStore((s) => s.scan);
  const projectLoaded = useProjectStore((s) => s.load.kind === 'loaded');
  if (scan.kind !== 'loaded') {
    return (
      <PlaceholderView
        title="Dependencies"
        description="Pick any entity from any kind - map, flag, asset, dialogue, object event, trigger, warp, variable, encounter table, trainer, script step - and the editor reports every entity that depends on it (inbound) plus every entity it depends on (outbound)."
        emptyHint={
          projectLoaded
            ? 'Project open but not yet scanned - click "Scan project" in the Project view.'
            : 'No project open - open one in the Project view to trace its dependencies.'
        }
      />
    );
  }
  return <DependenciesView manifest={scan.data.manifest} />;
}

function PluginsViewWired() {
  const scan = useProjectStore((s) => s.scan);
  const projectLoaded = useProjectStore((s) => s.load.kind === 'loaded');
  if (scan.kind !== 'loaded') {
    return (
      <PlaceholderView
        title="Plugins"
        description="Declarative JSON plugins in `<projectRoot>/.editor/plugins/` extend the editor with project-specific validators, event-type aliases, map layer hints, and adapter metadata - no code runs in the editor process."
        emptyHint={
          projectLoaded
            ? 'Project open but not yet scanned - click "Scan project" in the Project view.'
            : 'No project open - open one in the Project view to load its plugins.'
        }
      />
    );
  }
  return <PluginsView manifest={scan.data.manifest} />;
}

function TimelineViewWired() {
  // Phase I.1 - pass the loaded manifest into TimelineView so payload
  // renderers can resolve entity ids to plain-English names instead of
  // showing raw JSON. Falls back to no-manifest mode when no scan has
  // been loaded yet (TimelineView still works - payloads render as
  // structured key/value blocks without name resolution).
  const scan = useProjectStore((s) => s.scan);
  const manifest = scan.kind === 'loaded' ? scan.data.manifest : null;
  return <TimelineView manifest={manifest} />;
}

function BuildViewWired() {
  const scan = useProjectStore((s) => s.scan);
  const projectLoaded = useProjectStore((s) => s.load.kind === 'loaded');
  if (scan.kind !== 'loaded') {
    return (
      <PlaceholderView
        title="Build"
        description="Detected toolchain, build command, and on-disk artifacts the last build produced. Source → toolchain → compiled output, made visible."
        emptyHint={
          projectLoaded
            ? 'Project open but not yet scanned - click "Scan project" in the Project view.'
            : 'No project open - open one in the Project view to see its build status.'
        }
      />
    );
  }
  return <BuildView manifest={scan.data.manifest} />;
}

