import { useMemo, useState } from 'react';
import type { MapGroup, MapNode, ProjectManifest } from '@rom-editor/shared';
import { GROUP_COLORS, GROUP_ORDER } from './MapsGraph';
import { displayName, lookupMapGroup } from '../lib/displayName';
import { useUiPreferencesStore } from '../state';
import './MapsBrowser.css';

interface MapsBrowserProps {
  readonly manifest: ProjectManifest;
  readonly selectedId: string | null;
  readonly onSelect: (id: string) => void;
  readonly highlightedIds?: ReadonlySet<string>;
}

export function MapsBrowser({
  manifest,
  selectedId,
  onSelect,
  highlightedIds,
}: MapsBrowserProps) {
  const showInternalIds = useUiPreferencesStore((s) => s.showInternalIds);
  // Phase G-RC4 (semantic-world plan §G.4): resolve every map name via
  // `displayName()` so synthetic `Map ?.N` rendering is replaced with
  // either the MAPSEC area name (cross-ref 18) or a friendly fallback
  // ("Unnamed area #N"). Without this pass the browser was showing
  // raw `map.name` strings even when the toggle was off.
  const grouped = useMemo(() => {
    const out: Record<MapGroup, MapNode[]> = {
      town: [],
      route: [],
      interior: [],
      cave: [],
      dungeon: [],
      special: [],
      unknown: [],
    };
    // Phase 6.5 - bucket by `lookupMapGroup`, not by `m.group` directly.
    // The lookup applies the vanilla-truth overlay when the project's
    // identity is overlaySafe, falling through to the scanner's
    // byte-derived group otherwise. This is what un-buckets the
    // "Routes in Caves" misclassification on modernized CFRU+DPE ROMs.
    for (const m of manifest.maps) out[lookupMapGroup(manifest, m.id)].push(m);
    for (const g of GROUP_ORDER) {
      out[g].sort((a, b) =>
        displayName(manifest, a.id, false).localeCompare(displayName(manifest, b.id, false)),
      );
    }
    return out;
  }, [manifest, manifest.maps]);

  const [collapsed, setCollapsed] = useState<ReadonlySet<MapGroup>>(() => new Set());

  function toggle(g: MapGroup): void {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(g)) next.delete(g);
      else next.add(g);
      return next;
    });
  }

  return (
    <aside className="maps-browser" data-testid="maps-browser" aria-label="Map region tree">
      {GROUP_ORDER.map((g) => {
        const items = grouped[g];
        if (items.length === 0) return null;
        const isCollapsed = collapsed.has(g);
        return (
          <div key={g} className="maps-browser__group">
            <button
              type="button"
              className="maps-browser__group-header"
              data-testid={`maps-browser-group-${g}`}
              onClick={() => toggle(g)}
              aria-expanded={!isCollapsed}
            >
              <span
                className="maps-browser__group-marker"
                style={{ color: GROUP_COLORS[g] }}
                aria-hidden="true"
              >
                {isCollapsed ? '▸' : '▾'}
              </span>
              <span className="maps-browser__group-label">{g}</span>
              <span className="maps-browser__group-count">{items.length}</span>
            </button>
            {!isCollapsed && (
              <ul className="maps-browser__items">
                {items.map((m) => {
                  const isSelected = m.id === selectedId;
                  const isHighlighted = highlightedIds?.has(m.id) ?? false;
                  const classes = [
                    'maps-browser__item',
                    isSelected ? 'maps-browser__item--selected' : '',
                    isHighlighted ? 'maps-browser__item--highlighted' : '',
                  ]
                    .filter(Boolean)
                    .join(' ');
                  return (
                    <li key={m.id}>
                      <button
                        type="button"
                        className={classes}
                        data-testid={`maps-browser-item-${m.id}`}
                        onClick={() => onSelect(m.id)}
                      >
                        {displayName(manifest, m.id, showInternalIds)}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        );
      })}
    </aside>
  );
}
