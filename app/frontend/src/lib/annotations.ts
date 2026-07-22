import { create } from 'zustand';
import type { EntityKind } from '../state';

// Phase Q.6 - User annotations. Every entity in the workspace can be
// given a manual human-readable name that supersedes the auto-resolved
// label (manifest name → pret symbol DB → hand-curated → synthetic
// fallback). Annotations are project-namespaced via the project key
// so opening a different ROM doesn't bleed names across.
//
// Persistence - two tiers:
//   1. localStorage keyed by `rom-editor.annotations.<project>` - fast,
//      offline, the authoritative read source for the current session.
//   2. WP-C3 - <projectRoot>/.editor/annotations.json side-car via
//      GET/PUT /api/projects/<sessionId>/annotations. Survives a clean
//      checkout + lets teammates share names + lets a different machine
//      pick up where you left off. We push every mutation through here
//      (debounced 400ms) and pull on every project open (merge: disk
//      wins for keys the local store doesn't have; local wins for keys
//      it does - preserves in-flight edits that haven't synced yet).
//
// Phase Q.6.1 (overhaul pass, 2026-05-25) - annotations gained an
// optional description field so users can attach freeform context to
// any entity ("this flag fires when Brock is defeated", "this NPC is
// the rival on Route 1"). Backward-compat: legacy string-only values
// still load - they're treated as `{ name }`.

const STORAGE_PREFIX = 'rom-editor.annotations';
const DEFAULT_PROJECT_KEY = '_default';
const SIDECAR_PUT_DEBOUNCE_MS = 400;

/** Rich annotation value. The two fields are independently optional - 
 *  the user can name without describing, describe without renaming, or
 *  both. Trimmed of whitespace at the storage boundary; empty strings
 *  for either field are treated as "no value". */
export interface Annotation {
  readonly name?: string;
  readonly description?: string;
}

type StoredAnnotation = string | Annotation;

function storageKey(projectKey: string): string {
  return `${STORAGE_PREFIX}.${projectKey}`;
}

function makeKey(kind: EntityKind, id: string): string {
  return `${kind}:${id}`;
}

/** Normalize a stored annotation (which may be a legacy string or a
 *  rich object) to the rich form. Trims fields and drops empty values. */
function normalizeAnnotation(raw: StoredAnnotation): Annotation | null {
  if (typeof raw === 'string') {
    const name = raw.trim();
    if (name.length === 0) return null;
    return { name };
  }
  if (!raw || typeof raw !== 'object') return null;
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  const description = typeof raw.description === 'string' ? raw.description.trim() : '';
  if (name.length === 0 && description.length === 0) return null;
  const out: Annotation = {};
  if (name.length > 0) (out as { name?: string }).name = name;
  if (description.length > 0) (out as { description?: string }).description = description;
  return out;
}

function loadFromStorage(projectKey: string): Record<string, Annotation> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(storageKey(projectKey));
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const out: Record<string, Annotation> = {};
      for (const [k, v] of Object.entries(parsed)) {
        const norm = normalizeAnnotation(v as StoredAnnotation);
        if (norm) out[k] = norm;
      }
      return out;
    }
  } catch {
    // ignore - corrupt localStorage doesn't break the app
  }
  return {};
}

function saveToStorage(projectKey: string, map: Record<string, Annotation>): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(storageKey(projectKey), JSON.stringify(map));
  } catch {
    // best-effort
  }
}

interface AnnotationsStoreState {
  /** Active project namespace. Set via setProjectKey() when a project
   *  opens. When empty/_default, uses the global namespace. */
  readonly projectKey: string;
  /** WP-C3 - active session ID for the open project. null when no
   *  project is open. When set, mutations are mirrored to the
   *  /api/projects/<sessionId>/annotations side-car (debounced). */
  readonly sessionId: string | null;
  /** kind:id → user annotation (name and/or description). */
  readonly map: Readonly<Record<string, Annotation>>;
  setProjectKey: (key: string) => void;
  /** WP-C3 - bind the active session so mutations sync to the project
   *  side-car. Also triggers an immediate fetch + merge of the side-car
   *  (disk values fill in keys the local store doesn't have; local
   *  values win on conflict so in-flight edits aren't clobbered). Pass
   *  null when the project closes. */
  setSession: (sessionId: string | null) => Promise<void>;
  /** Set a user-chosen name. Pass empty string to clear the name (the
   *  description, if any, is preserved). */
  setAnnotation: (kind: EntityKind, id: string, name: string) => void;
  /** Set a user-chosen description. Pass empty string to clear the
   *  description (the name, if any, is preserved). */
  setAnnotationDescription: (kind: EntityKind, id: string, description: string) => void;
  clearAnnotation: (kind: EntityKind, id: string) => void;
  /** Convenience getter for the name only - returns null when no
   *  annotation OR the annotation has no name. Maintained as
   *  `string | null` for backward compatibility with displayName. */
  getAnnotation: (kind: EntityKind, id: string) => string | null;
  /** Returns the full rich annotation. Use when you need both name + description. */
  getFullAnnotation: (kind: EntityKind, id: string) => Annotation | null;
}

// Side-car debounce timer + injectable fetch (tests replace this).
let sidecarPushTimer: ReturnType<typeof setTimeout> | null = null;
let sidecarPushPending: (() => void) | null = null;
let sidecarFetch: typeof fetch =
  typeof fetch !== 'undefined' ? fetch.bind(globalThis) : ((async () => {
    throw new Error('fetch not available');
  }) as unknown as typeof fetch);
export function _setSidecarFetchForTests(fn: typeof fetch): void {
  sidecarFetch = fn;
}

/** Schedule a debounced PUT of the current store map to the side-car.
 *  Coalesces rapid-fire mutations (typing in a rename field) into one
 *  network roundtrip. Silent on errors - the local store is the truth;
 *  the side-car catches up on the next successful PUT. */
function schedulePushSideCar(getState: () => AnnotationsStoreState): void {
  if (sidecarPushTimer) clearTimeout(sidecarPushTimer);
  const fire = (): void => {
    sidecarPushTimer = null;
    sidecarPushPending = null;
    const { sessionId, map } = getState();
    if (!sessionId) return;
    void sidecarFetch(`/api/projects/${encodeURIComponent(sessionId)}/annotations`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ annotations: map }),
    }).catch(() => {
      // intentional: local store is authoritative; we retry on the next mutation.
    });
  };
  sidecarPushPending = fire;
  sidecarPushTimer = setTimeout(fire, SIDECAR_PUT_DEBOUNCE_MS);
}

/** Test-only: fire the pending side-car PUT immediately (skipping the
 *  debounce). Returns true if a push was pending, false otherwise. */
export function _flushSideCarPushForTests(): boolean {
  if (sidecarPushTimer) {
    clearTimeout(sidecarPushTimer);
    sidecarPushTimer = null;
  }
  if (sidecarPushPending) {
    const fn = sidecarPushPending;
    sidecarPushPending = null;
    fn();
    return true;
  }
  return false;
}

export const useAnnotationsStore = create<AnnotationsStoreState>((set, get) => ({
  projectKey: DEFAULT_PROJECT_KEY,
  sessionId: null,
  map: loadFromStorage(DEFAULT_PROJECT_KEY),
  setProjectKey(key) {
    const normalized = (key || '').trim() || DEFAULT_PROJECT_KEY;
    if (normalized === get().projectKey) return;
    set({ projectKey: normalized, map: loadFromStorage(normalized) });
  },
  async setSession(sessionId) {
    const prevSession = get().sessionId;
    set({ sessionId });
    if (!sessionId || sessionId === prevSession) return;
    // Fetch the side-car. Merge into local map: side-car fills in
    // missing keys; local values win on conflict (in-flight edits
    // haven't been pushed yet, so they're newer than the disk copy).
    try {
      const res = await sidecarFetch(
        `/api/projects/${encodeURIComponent(sessionId)}/annotations`,
        { method: 'GET', headers: { accept: 'application/json' } },
      );
      if (!res.ok) return;
      const body = (await res.json()) as {
        annotations?: Record<string, { name?: string; description?: string }>;
      };
      const remote = body.annotations ?? {};
      const s = get();
      const merged: Record<string, Annotation> = { ...s.map };
      for (const [k, v] of Object.entries(remote)) {
        if (!merged[k]) {
          const norm = normalizeAnnotation(v as StoredAnnotation);
          if (norm) merged[k] = norm;
        }
      }
      // Persist the merged view back to localStorage so refreshing the
      // page still has the side-car-sourced annotations even when offline.
      saveToStorage(s.projectKey, merged);
      set({ map: merged });
    } catch {
      // ignore - local store is the truth
    }
  },
  setAnnotation(kind, id, name) {
    const trimmed = name.trim();
    const s = get();
    const next = { ...s.map };
    const key = makeKey(kind, id);
    const existing = next[key];
    const description = existing?.description;
    const merged: Annotation = {};
    if (trimmed.length > 0) (merged as { name?: string }).name = trimmed;
    if (description && description.length > 0) {
      (merged as { description?: string }).description = description;
    }
    if (!merged.name && !merged.description) {
      delete next[key];
    } else {
      next[key] = merged;
    }
    saveToStorage(s.projectKey, next);
    set({ map: next });
    schedulePushSideCar(get);
  },
  setAnnotationDescription(kind, id, description) {
    const trimmed = description.trim();
    const s = get();
    const next = { ...s.map };
    const key = makeKey(kind, id);
    const existing = next[key];
    const name = existing?.name;
    const merged: Annotation = {};
    if (name && name.length > 0) (merged as { name?: string }).name = name;
    if (trimmed.length > 0) (merged as { description?: string }).description = trimmed;
    if (!merged.name && !merged.description) {
      delete next[key];
    } else {
      next[key] = merged;
    }
    saveToStorage(s.projectKey, next);
    set({ map: next });
    schedulePushSideCar(get);
  },
  clearAnnotation(kind, id) {
    const s = get();
    const next = { ...s.map };
    delete next[makeKey(kind, id)];
    saveToStorage(s.projectKey, next);
    set({ map: next });
    schedulePushSideCar(get);
  },
  getAnnotation(kind, id) {
    return get().map[makeKey(kind, id)]?.name ?? null;
  },
  getFullAnnotation(kind, id) {
    return get().map[makeKey(kind, id)] ?? null;
  },
}));

/** Non-reactive helper for use inside displayName / other utilities
 *  that aren't React components. Returns just the name for backward
 *  compatibility. */
export function lookupAnnotation(
  kind: EntityKind,
  id: string,
): string | null {
  return useAnnotationsStore.getState().getAnnotation(kind, id);
}

/** Non-reactive helper that returns the description (or null when
 *  unset). Used by inspectors that want to surface the user's prose
 *  alongside the auto-resolved data. */
export function lookupAnnotationDescription(
  kind: EntityKind,
  id: string,
): string | null {
  return useAnnotationsStore.getState().getFullAnnotation(kind, id)?.description ?? null;
}

/** Heuristic projectKey derivation: hash of project root + ROM
 *  identity. Keeps the same project landing on the same namespace
 *  across reopens. */
export function deriveProjectKey(args: {
  readonly projectRoot?: string;
  readonly displayName?: string;
}): string {
  const base = `${args.projectRoot ?? ''}|${args.displayName ?? ''}`;
  if (!base.trim() || base === '|') return DEFAULT_PROJECT_KEY;
  // Cheap stable hash (FNV-1a). 32-bit hex output is plenty of
  // separation between projects.
  let h = 0x811c9dc5;
  for (let i = 0; i < base.length; i++) {
    h ^= base.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return `p${h.toString(16)}`;
}
