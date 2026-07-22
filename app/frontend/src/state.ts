import { create } from 'zustand';
import type { ProjectOpenResponse, ScanResponse } from '@rom-editor/shared';
import {
  ProjectApiError,
  openProject as apiOpenProject,
  openProjectFromFile as apiOpenProjectFromFile,
  scanProject as apiScanProject,
} from './api';

export type ViewKey =
  | 'project'
  | 'maps'
  | 'events'
  | 'dialogue'
  | 'flags'
  | 'assets'
  | 'preview'
  // Phase 4.2B - cross-map wild-encounter overview.
  | 'spawns'
  | 'mechanics'
  | 'lint'
  | 'dependencies'
  | 'templates'
  | 'plugins'
  | 'timeline'
  | 'tilesets'
  | 'species'
  | 'moves'
  | 'items'
  | 'abilities'
  // A3 - level-up learnsets (decomp).
  | 'learnsets'
  // A7 - full trainers list + party editor (decomp).
  | 'trainers'
  | 'trainerClasses'
  | 'types'
  | 'pokedex'
  | 'choices'
  | 'healLocations'
  | 'dialogueReview'
  | 'livePreview'
  | 'build'
  // Phase 8I-1 - TileIntelligencePanel (library / templates / coverage).
  | 'tileIntel'
  // Phase 8I-3 - SkeletonEditor (map-skeleton authoring + resolve).
  | 'skeletons';

export type ProjectLoadState =
  | { readonly kind: 'empty' }
  | { readonly kind: 'loading'; readonly projectRoot: string }
  | { readonly kind: 'loaded'; readonly data: ProjectOpenResponse }
  | {
      readonly kind: 'error';
      readonly projectRoot: string;
      readonly code: string;
      readonly message: string;
    };

export type ScanState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'scanning' }
  | {
      readonly kind: 'loaded';
      readonly data: ScanResponse;
      /** Stale-while-revalidate flag. True when a rescan is in flight
       *  but the prior `data` is still visible to consumers (so they
       *  don't unmount their editing UI mid-rescan). False / undefined
       *  when the data is fresh from a completed scan. Set by
       *  scanCurrentProject() during the in-flight window. */
      readonly revalidating?: boolean;
    }
  | { readonly kind: 'error'; readonly code: string; readonly message: string };

interface ProjectStoreState {
  readonly load: ProjectLoadState;
  readonly scan: ScanState;
  openProject: (projectRoot: string) => Promise<void>;
  /** Intake a .gba or .zip file: backend wraps/extracts into a managed
   *  project dir under %APPDATA% and opens it via the regular open flow. */
  openProjectFromFile: (filePath: string) => Promise<void>;
  scanCurrentProject: () => Promise<void>;
  closeProject: () => void;
}

export const useProjectStore = create<ProjectStoreState>((set, get) => ({
  load: { kind: 'empty' },
  scan: { kind: 'idle' },
  async openProject(projectRoot) {
    set({ load: { kind: 'loading', projectRoot }, scan: { kind: 'idle' } });
    try {
      const data = await apiOpenProject(projectRoot);
      set({ load: { kind: 'loaded', data } });
    } catch (e) {
      if (e instanceof ProjectApiError) {
        set({
          load: { kind: 'error', projectRoot, code: e.code, message: e.message },
        });
      } else {
        set({
          load: {
            kind: 'error',
            projectRoot,
            code: 'unknown',
            message: e instanceof Error ? e.message : String(e),
          },
        });
      }
    }
  },
  async openProjectFromFile(filePath) {
    // Mirror openProject's loading-then-loaded-or-error pattern. The
    // "projectRoot" we surface in loading/error states is the source file
    // the user picked - that's the most meaningful identifier from their
    // perspective; the managed project root only matters internally.
    set({ load: { kind: 'loading', projectRoot: filePath }, scan: { kind: 'idle' } });
    try {
      const data = await apiOpenProjectFromFile(filePath);
      set({ load: { kind: 'loaded', data } });
    } catch (e) {
      if (e instanceof ProjectApiError) {
        set({
          load: { kind: 'error', projectRoot: filePath, code: e.code, message: e.message },
        });
      } else {
        set({
          load: {
            kind: 'error',
            projectRoot: filePath,
            code: 'unknown',
            message: e instanceof Error ? e.message : String(e),
          },
        });
      }
    }
  },
  async scanCurrentProject() {
    const state = get();
    if (state.load.kind !== 'loaded') return;
    // Stale-while-revalidate. If we already have scan data, keep it
    // visible during the rescan + set revalidating:true. This prevents
    // consumers gated on `scan.kind === 'loaded'` (MapEditor,
    // inspectors, the visual scripter) from unmounting during edit-
    // triggered rescans - losing the user's editing context. Only flip
    // to bare 'scanning' when this is the initial scan (no prior data
    // to keep visible).
    const prior = state.scan;
    if (prior.kind === 'loaded') {
      set({ scan: { kind: 'loaded', data: prior.data, revalidating: true } });
    } else {
      set({ scan: { kind: 'scanning' } });
    }
    try {
      const data = await apiScanProject(state.load.data.session.id);
      set({ scan: { kind: 'loaded', data } });
    } catch (e) {
      if (e instanceof ProjectApiError) {
        set({ scan: { kind: 'error', code: e.code, message: e.message } });
      } else {
        set({
          scan: {
            kind: 'error',
            code: 'unknown',
            message: e instanceof Error ? e.message : String(e),
          },
        });
      }
    }
  },
  closeProject() {
    set({ load: { kind: 'empty' }, scan: { kind: 'idle' } });
  },
}));

/** Phase 4.1C - Scene-boot prefill carried across the view switch.
 *
 *  When the user right-clicks a map tile (or a script step) and picks
 *  "Boot from here", we:
 *    1. Stash this prefill in the view store.
 *    2. Switch to the livePreview view.
 *    3. SceneBootPicker consumes the prefill on mount, clears it.
 *
 *  Optional `startingPosition` lets the map-tile context menu prefill
 *  coordinates as well. */
export interface SceneBootPrefill {
  readonly startingMapId: string;
  readonly startingPosition: {
    readonly x: number;
    readonly y: number;
    readonly facing: 'down' | 'up' | 'left' | 'right';
  } | null;
  // Phase 9G - optional fields populated by the script + scene
  // right-click affordances. The picker uses them to pre-fill the
  // composer's name + notes so the user doesn't have to re-type
  // context when they recall the recipe later.
  readonly suggestedName?: string;
  readonly suggestedNotes?: string;
  // Phase 9G - flags/vars to seed (matches SceneBootPicker's
  // composer fields). Empty when the source didn't specify any.
  readonly initialFlags?: ReadonlyArray<number>;
  readonly initialVars?: ReadonlyArray<{ readonly id: number; readonly value: number }>;
}

interface ViewStoreState {
  readonly activeView: ViewKey;
  readonly editingMapId: string | null;
  readonly sceneBootPrefill: SceneBootPrefill | null;
  setView: (view: ViewKey) => void;
  openMapInEditor: (mapId: string) => void;
  closeMapEditor: () => void;
  /** Phase 4.1C - Prefill the SceneBootPicker + jump to livePreview. */
  bootFromHere: (prefill: SceneBootPrefill) => void;
  /** Phase 4.1C - Consume + clear the prefill (called by SceneBootPicker
   *  after applying it to its composer state). */
  consumeSceneBootPrefill: () => void;
}

export const useViewStore = create<ViewStoreState>((set) => ({
  // The Real Game Editor Push - default landing is the World atlas, not
  // the ROM-loader form. When no project is open the World view shows a
  // friendly empty state ("Open a ROM to begin"). The titlebar "Open ROM"
  // button routes to 'project' on demand for the ROM-loader flow.
  activeView: 'maps',
  editingMapId: null,
  sceneBootPrefill: null,
  setView(view) {
    set({ activeView: view });
  },
  openMapInEditor(mapId) {
    set({ activeView: 'maps', editingMapId: mapId });
  },
  closeMapEditor() {
    set({ editingMapId: null });
  },
  bootFromHere(prefill) {
    set({ activeView: 'livePreview', sceneBootPrefill: prefill });
  },
  consumeSceneBootPrefill() {
    set({ sceneBootPrefill: null });
  },
}));

// UI preferences store - orthogonal display toggles that survive a page
// reload. Currently houses the "Show internal ids" debug toggle: when
// ON, every resolved entity name (`PIKACHU`, `BUG CATCHER`, `Pallet
// Town`) renders with its synthetic id appended in parens for power-
// user diagnosis (`PIKACHU (species_25)`). Default OFF - operators
// shouldn't see JSON-shaped strings unless they ask for them.
const SHOW_INTERNAL_IDS_KEY = 'rom-editor.showInternalIds';

function loadShowInternalIds(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(SHOW_INTERNAL_IDS_KEY) === '1';
  } catch {
    return false;
  }
}

function persistShowInternalIds(value: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(SHOW_INTERNAL_IDS_KEY, value ? '1' : '0');
  } catch {
    // Best-effort persistence.
  }
}

interface UiPreferencesStoreState {
  readonly showInternalIds: boolean;
  setShowInternalIds: (value: boolean) => void;
  toggleShowInternalIds: () => void;
}

export const useUiPreferencesStore = create<UiPreferencesStoreState>((set, get) => ({
  showInternalIds: loadShowInternalIds(),
  setShowInternalIds(value) {
    persistShowInternalIds(value);
    set({ showInternalIds: value });
  },
  toggleShowInternalIds() {
    const next = !get().showInternalIds;
    persistShowInternalIds(next);
    set({ showInternalIds: next });
  },
}));

// Phase UX-D - Map paint mode store.
//
// Drives the MapEditor's paint toolbar + tile palette + per-cell click
// behavior. The undo stack records each committed cell edit so the
// operator can Ctrl+Z back through their session's changes; redo stack
// fills on undo. Cleared when a different map is opened.

export type PaintTool = 'pointer' | 'pencil' | 'fill' | 'eyedropper' | 'collision';

export interface PaintEdit {
  /** Map id this edit belongs to. Required so undo/redo only fires on
   *  the active map (switching maps clears the stacks via openMapInEditor). */
  readonly mapId: string;
  readonly x: number;
  readonly y: number;
  /** Metatile id before the edit (for undo). */
  readonly prevMetatileId: number;
  /** Metatile id after the edit (for redo). */
  readonly nextMetatileId: number;
}

interface PaintStoreState {
  readonly tool: PaintTool;
  /** Currently-selected metatile id painted by Pencil + Fill. Defaults
   *  to 0 (typically the grass / floor base tile). */
  readonly selectedMetatileId: number;
  /** Undo stack - most recent edit at the END. Bounded to 256 entries
   *  per map to keep memory predictable. */
  readonly undoStack: ReadonlyArray<PaintEdit>;
  /** Redo stack - populated by undo, cleared when a new edit lands. */
  readonly redoStack: ReadonlyArray<PaintEdit>;
  /** Phase H-RC6 - pinned favorite tiles, persisted to localStorage.
   *  Format: `${tilesetStructFileOffset}:${metatileId}` so favorites
   *  carry their tileset context across reloads. */
  readonly favoriteTiles: ReadonlyArray<string>;
  setTool: (tool: PaintTool) => void;
  setSelectedMetatileId: (id: number) => void;
  pushEdit: (edit: PaintEdit) => void;
  undo: () => PaintEdit | null;
  redo: () => PaintEdit | null;
  clearForMap: (mapId: string | null) => void;
  toggleFavoriteTile: (tilesetOffset: number, metatileId: number) => void;
}

const UNDO_STACK_LIMIT = 256;

const FAVORITE_TILES_KEY = 'rom-editor.favoriteTiles';

function loadFavoriteTiles(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(FAVORITE_TILES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.every((s): s is string => typeof s === 'string')
      ? parsed
      : [];
  } catch {
    return [];
  }
}

function persistFavoriteTiles(tiles: ReadonlyArray<string>): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(FAVORITE_TILES_KEY, JSON.stringify(tiles));
  } catch {
    // localStorage full / disabled - silent fallback (in-memory only).
  }
}

export const usePaintStore = create<PaintStoreState>((set, get) => ({
  tool: 'pointer',
  selectedMetatileId: 0,
  undoStack: [],
  redoStack: [],
  favoriteTiles: loadFavoriteTiles(),
  setTool(tool) {
    set({ tool });
  },
  setSelectedMetatileId(id) {
    set({ selectedMetatileId: id });
  },
  toggleFavoriteTile(tilesetOffset, metatileId) {
    const key = `${tilesetOffset}:${metatileId}`;
    const s = get();
    const next = s.favoriteTiles.includes(key)
      ? s.favoriteTiles.filter((k) => k !== key)
      : [...s.favoriteTiles, key];
    persistFavoriteTiles(next);
    set({ favoriteTiles: next });
  },
  pushEdit(edit) {
    set((s) => ({
      undoStack: [...s.undoStack.slice(-(UNDO_STACK_LIMIT - 1)), edit],
      redoStack: [], // new edit invalidates redo history
    }));
  },
  undo() {
    const s = get();
    const last = s.undoStack[s.undoStack.length - 1];
    if (!last) return null;
    set({
      undoStack: s.undoStack.slice(0, -1),
      redoStack: [...s.redoStack, last],
    });
    return last;
  },
  redo() {
    const s = get();
    const last = s.redoStack[s.redoStack.length - 1];
    if (!last) return null;
    set({
      undoStack: [...s.undoStack, last],
      redoStack: s.redoStack.slice(0, -1),
    });
    return last;
  },
  clearForMap(mapId) {
    set({
      undoStack: [],
      redoStack: [],
      selectedMetatileId: 0,
      tool: mapId === null ? 'pointer' : get().tool,
    });
  },
}));

// Phase O.1 - Global toast notifications. Editors call pushToast()
// after writes land (or fail) so the operator always sees a small
// "Saved" / "Failed: <reason>" card in the corner. Auto-dismisses
// after 4s; the ToastContainer renders the active list.
export type ToastKind = 'success' | 'error' | 'info';

export interface Toast {
  readonly id: number;
  readonly kind: ToastKind;
  readonly message: string;
}

interface ToastStoreState {
  readonly toasts: ReadonlyArray<Toast>;
  push: (kind: ToastKind, message: string) => void;
  dismiss: (id: number) => void;
}

let toastIdCounter = 1;

export const useToastStore = create<ToastStoreState>((set) => ({
  toasts: [],
  push(kind, message) {
    const id = toastIdCounter++;
    set((s) => ({ toasts: [...s.toasts, { id, kind, message }] }));
    if (typeof window !== 'undefined') {
      window.setTimeout(() => {
        set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
      }, 4000);
    }
  },
  dismiss(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },
}));

// Convenience helper - editors call pushToast('success', 'Saved') after writes.
export function pushToast(kind: ToastKind, message: string): void {
  useToastStore.getState().push(kind, message);
}

// Phase P.2 - Workspace selection store. The whole roadmap pivots on the
// idea that clicking ANY in-game entity should open its inspector in the
// right dock without navigating to a separate page. `useSelection` is the
// single source of truth for "what is currently selected in the workspace".
// Inspector panels subscribe by kind and render kind-aware editors (the
// per-entity inspectors land in Phase S; P.2 just ships the primitive).
//
// EntityKind enumerates every selectable thing the roadmap commits to
// supporting. The set is open by design: new ROM-hack-specific kinds
// surface here as they are discovered (Phase Y.3 unknown-subsystem
// annotation, for instance, would extend this with a generic 'subsystem'
// kind tagged by an annotation id).
export type EntityKind =
  | 'map'
  | 'warp'
  | 'trigger'
  | 'objectEvent'
  | 'sign'
  | 'door'
  | 'healLocation'
  | 'tile'
  | 'connection'
  | 'species'
  | 'move'
  | 'ability'
  | 'type'
  | 'item'
  | 'trainer'
  | 'trainerClass'
  | 'flag'
  | 'variable'
  | 'script'
  | 'scriptStep'
  | 'dialogue'
  | 'multichoice'
  | 'choice'
  | 'tileset'
  | 'palette'
  | 'asset'
  | 'sprite'
  | 'song'
  | 'encounterTable'
  | 'encounterSlot'
  | 'pokedexEntry'
  | 'region'
  | 'structure'
  | 'cutscene';

export interface EntityRef {
  readonly kind: EntityKind;
  readonly id: string;
  /** Optional map context so map-scoped entities (warps, triggers,
   *  objectEvents, tiles) know which map they belong to without
   *  the inspector having to re-derive it from the manifest. */
  readonly mapContext?: string;
  /** Optional descriptor capturing any extra coordinates / slot indices
   *  the inspector might need (e.g. encounter slot index, tile x/y).
   *  Kept loose-typed because each entity kind has its own shape. */
  readonly details?: Readonly<Record<string, string | number | boolean | null>>;
  /** Section ID a host inspector should auto-expand on selection. Used
   *  by consolidated inspectors that absorbed sub-kinds (e.g. selecting
   *  a `pokedexEntry` opens SpeciesInspector with expandSection='pokedex').
   *  Each host panel exports its supported section IDs as a `SECTION_IDS`
   *  constant so typos surface in the call site. */
  readonly expandSection?: string;
}

interface SelectionStoreState {
  readonly current: EntityRef | null;
  /** History of recently-selected entities (most recent first) so the
   *  workspace can show a breadcrumb or "back" affordance later. Bounded
   *  to 32 entries to keep memory predictable. */
  readonly history: ReadonlyArray<EntityRef>;
  select: (ref: EntityRef) => void;
  clear: () => void;
}

const SELECTION_HISTORY_LIMIT = 32;

export const useSelection = create<SelectionStoreState>((set, get) => ({
  current: null,
  history: [],
  select(ref) {
    const prev = get().current;
    // Idempotent: re-selecting the same entity is a no-op so subscribers
    // don't re-render when the user click-cycles a marker. mapContext
    // updates DO replace the selection so an entity reached via a
    // different map context surfaces the new context.
    if (
      prev &&
      prev.kind === ref.kind &&
      prev.id === ref.id &&
      prev.mapContext === ref.mapContext
    ) {
      return;
    }
    set((s) => {
      const nextHistory = prev
        ? [prev, ...s.history.filter((h) => !(h.kind === prev.kind && h.id === prev.id))].slice(
            0,
            SELECTION_HISTORY_LIMIT,
          )
        : s.history;
      return { current: ref, history: nextHistory };
    });
  },
  clear() {
    set({ current: null });
  },
}));

// Phase P.2 - Advanced drawer store. The 24 tab Sidebar moves into a
// slide-in drawer toggled by Ctrl+\ / Cmd+\ so the default workspace
// stays visually quiet. Until P.4 (World Atlas) lands the drawer starts
// OPEN so the existing sidebar-driven navigation remains visible - the
// roadmap intends the drawer to default CLOSED once the World Atlas is
// the entry surface. The localStorage persistence lets power users keep
// the drawer pinned open.
const ADVANCED_DRAWER_KEY = 'rom-editor.advancedDrawerOpen';

function loadDrawerOpen(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const stored = window.localStorage.getItem(ADVANCED_DRAWER_KEY);
    if (stored === '0') return false;
    if (stored === '1') return true;
  } catch {
    // localStorage unavailable - fall through to default.
  }
  // The Real Game Editor Push - default CLOSED. The Navigator tree is
  // now the always-visible left rail; the Advanced drawer is an
  // overlay reached via Ctrl+\ for power users who want to browse
  // every detected entity as a flat tab list (Build, Lint, Plugins,
  // Mechanics, Timeline, Dependencies, Templates, the demolished
  // standalone views).
  return false;
}

function persistDrawerOpen(value: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(ADVANCED_DRAWER_KEY, value ? '1' : '0');
  } catch {
    // Best-effort persistence - in-memory state survives anyway.
  }
}

interface AdvancedDrawerStoreState {
  readonly open: boolean;
  toggle: () => void;
  setOpen: (value: boolean) => void;
}

export const useAdvancedDrawerStore = create<AdvancedDrawerStoreState>((set, get) => ({
  open: loadDrawerOpen(),
  toggle() {
    const next = !get().open;
    persistDrawerOpen(next);
    set({ open: next });
  },
  setOpen(value) {
    persistDrawerOpen(value);
    set({ open: value });
  },
}));
