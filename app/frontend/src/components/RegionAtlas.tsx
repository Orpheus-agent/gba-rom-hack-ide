// The Real Game Editor Push - Region Atlas. The new home view: a
// PixiJS-rendered region map with maps positioned by their
// regionMapSection coords. Click any map → MapEditor opens. Double
// click on a structure → opens the first floor. Pan with drag, zoom
// with wheel.
//
// Replaces MapsGraph (ReactFlow) for the 'maps' view default state
// (when no specific map is being edited). MapEditor itself still
// mounts when useViewStore.editingMapId is set - that surface is
// untouched.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ProjectManifest } from '@rom-editor/shared';
import { renderRegionAtlasScene } from '../render/regionAtlasScene';
import { inferStructures } from '../lib/structures';
import { useSelection, useViewStore } from '../state';
import { prettifyMapGroup, prettifyMapName } from '../lib/displayName';
import {
  canShowStoryArc,
  inferStoryArcMarkers,
} from '../lib/storyArcInference';
import './RegionAtlas.css';

interface RegionAtlasProps {
  readonly manifest: ProjectManifest;
}

export function RegionAtlas({ manifest }: RegionAtlasProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const select = useSelection((s) => s.select);
  const current = useSelection((s) => s.current);
  const openMapInEditor = useViewStore((s) => s.openMapInEditor);
  const [showStoryArc, setShowStoryArc] = useState(false);

  const structures = useMemo(() => inferStructures(manifest), [manifest]);
  const storyArcSupported = useMemo(() => canShowStoryArc(manifest), [manifest]);
  const storyMarkers = useMemo(
    () => (showStoryArc && storyArcSupported ? inferStoryArcMarkers(manifest) : []),
    [manifest, showStoryArc, storyArcSupported],
  );
  const selectedMapId =
    current && (current.kind === 'map' || current.kind === 'structure')
      ? current.id
      : null;

  const onSelectMap = useCallback(
    (mapId: string) => {
      select({ kind: 'map', id: mapId });
    },
    [select],
  );
  const onOpenMap = useCallback(
    (mapId: string) => {
      openMapInEditor(mapId);
    },
    [openMapInEditor],
  );

  // Track the selected map metadata for the info bar.
  const selectedMap = useMemo(() => {
    if (!selectedMapId) return null;
    return manifest.maps.find((m) => m.id === selectedMapId) ?? null;
  }, [manifest.maps, selectedMapId]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let teardown: (() => void) | null = null;
    let cancelled = false;
    void (async () => {
      const t = await renderRegionAtlasScene(host, {
        manifest,
        structures,
        selectedMapId,
        onSelectMap,
        onOpenMap,
        storyMarkers,
      });
      if (cancelled) {
        t();
      } else {
        teardown = t;
      }
    })();
    return () => {
      cancelled = true;
      if (teardown) teardown();
    };
  }, [manifest, structures, selectedMapId, onSelectMap, onOpenMap, storyMarkers]);

  const regionName = useMemo(() => {
    const first = manifest.regionMapSections?.[0]?.name;
    if (first) return first;
    return manifest.identity?.baseGame ?? 'Region';
  }, [manifest]);

  return (
    <div className="region-atlas" data-testid="region-atlas">
      <header className="region-atlas__bar">
        <span className="region-atlas__title">
          World Atlas - {regionName}
        </span>
        <span className="region-atlas__hint">
          Click to select · Double-click to open · Drag to pan · Wheel to zoom
        </span>
        <button
          type="button"
          className="region-atlas__story-toggle"
          onClick={() => setShowStoryArc((v) => !v)}
          disabled={!storyArcSupported}
          aria-pressed={showStoryArc}
          data-testid="region-atlas-story-toggle"
          title={
            storyArcSupported
              ? 'Show gym, rival, and champion markers'
              : 'Story arc inference requires a vanilla FRLG ROM or annotated flag names (pattern: "Defeated Gym N - Name")'
          }
        >
          {showStoryArc ? '◆ Story arc on' : '◇ Show story arc'}
        </button>
      </header>
      <div className="region-atlas__canvas-host" ref={hostRef} data-testid="region-atlas-canvas" />
      {selectedMap && (
        <footer className="region-atlas__footer" data-testid="region-atlas-info">
          <strong>{prettifyMapName(selectedMap.name, selectedMap.id)}</strong>
          <span className="region-atlas__group-pill">{prettifyMapGroup(selectedMap.group)}</span>
          <button
            type="button"
            className="region-atlas__open-btn btn btn--primary"
            onClick={() => openMapInEditor(selectedMap.id)}
            data-testid="region-atlas-open-btn"
          >
            Edit this map →
          </button>
        </footer>
      )}
    </div>
  );
}
