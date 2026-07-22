import { useEffect, useRef, useState } from 'react';
import { EditorShell } from './components/EditorShell';
import { ToastContainer } from './components/Toast';
import {
  CommandPalette,
  useCommandPaletteShortcut,
} from './components/CommandPalette';
import { fetchHealth, type BackendStatus } from './api';
import { useProjectStore, useViewStore } from './state';
import { deriveProjectKey, useAnnotationsStore } from './lib/annotations';
import { useSavedSearchesStore } from './lib/savedSearches';

export function App() {
  const [status, setStatus] = useState<BackendStatus>({ state: 'connecting' });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const health = await fetchHealth();
        if (!cancelled) {
          setStatus({ state: 'connected', service: health.service, version: health.version });
        }
      } catch (err) {
        if (!cancelled) {
          setStatus({
            state: 'disconnected',
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useAnnotationsProjectBinding();
  useAtlasOnLoadRouting();
  useCommandPaletteShortcut();

  return (
    <>
      <EditorShell backendStatus={status} />
      <CommandPalette />
      <ToastContainer />
    </>
  );
}

// The Real Game Editor Push - when a project transitions to loaded
// (open from disk OR opened-from-file), route the user out of any
// ROM-loader / project-form view and onto the World atlas. Honors a
// per-load-instance latch so the user can still manually navigate to
// 'project' (via the Open ROM titlebar button) AFTER the initial
// landing without being yanked back to maps every time the scan state
// updates.
//
// Tests covering Project-view UI in isolation can opt out by setting
// globalThis.__SUPPRESS_ATLAS_AUTO_ROUTE__ = true in their beforeEach.
function useAtlasOnLoadRouting(): void {
  const load = useProjectStore((s) => s.load);
  const setView = useViewStore((s) => s.setView);
  const lastLoadedSessionRef = useRef<string | null>(null);
  useEffect(() => {
    if (
      typeof globalThis !== 'undefined' &&
      (globalThis as { __SUPPRESS_ATLAS_AUTO_ROUTE__?: boolean })
        .__SUPPRESS_ATLAS_AUTO_ROUTE__
    ) {
      return;
    }
    if (load.kind !== 'loaded') {
      lastLoadedSessionRef.current = null;
      return;
    }
    const sessionId = load.data.session.id;
    if (lastLoadedSessionRef.current === sessionId) return;
    lastLoadedSessionRef.current = sessionId;
    setView('maps');
  }, [load, setView]);
}

// Phase Q.6 follow-up + X.3 follow-up - every time the project changes
// (open / close / reopen), derive a stable project key from the identity
// + root path and switch BOTH the annotations namespace AND the saved-
// searches namespace to it. Opening FireRed and opening Unbound see
// disjoint annotation + saved-search sets.
function useAnnotationsProjectBinding(): void {
  const load = useProjectStore((s) => s.load);
  const setAnnotationsKey = useAnnotationsStore((s) => s.setProjectKey);
  const setAnnotationsSession = useAnnotationsStore((s) => s.setSession);
  const setSavedSearchesKey = useSavedSearchesStore((s) => s.setProjectKey);
  useEffect(() => {
    const key =
      load.kind === 'loaded'
        ? deriveProjectKey({
            projectRoot: load.data.session.projectRoot,
            displayName: load.data.identity.displayName,
          })
        : '_default';
    setAnnotationsKey(key);
    setSavedSearchesKey(key);
    // WP-C3 - also bind the active session so mutations sync to the
    // project's .editor/annotations.json side-car. This triggers a
    // fetch + merge of any disk-persisted annotations a teammate /
    // earlier session left behind.
    void setAnnotationsSession(
      load.kind === 'loaded' ? load.data.session.id : null,
    );
  }, [load, setAnnotationsKey, setAnnotationsSession, setSavedSearchesKey]);
}
