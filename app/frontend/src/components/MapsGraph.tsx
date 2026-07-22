import { useMemo } from 'react';
import ReactFlow, { Background, Controls, MiniMap, MarkerType } from 'reactflow';
import type { Edge, Node } from 'reactflow';
import 'reactflow/dist/style.css';
import type { MapGroup, MapNode as MapNodeData, ProjectManifest, Warp } from '@rom-editor/shared';
import { displayName } from '../lib/displayName';
import { useUiPreferencesStore } from '../state';
import './MapsGraph.css';

export const GROUP_ORDER: ReadonlyArray<MapGroup> = [
  'town',
  'route',
  'interior',
  'cave',
  'dungeon',
  'special',
  'unknown',
];

export const GROUP_COLORS: Readonly<Record<MapGroup, string>> = {
  town: '#50c878',
  route: '#4a9eff',
  interior: '#b46aff',
  cave: '#c98a3d',
  dungeon: '#a83d3d',
  special: '#f0b429',
  unknown: '#7c8088',
};

function computeLayout(maps: ReadonlyArray<MapNodeData>): Record<string, { x: number; y: number }> {
  const groups: Record<MapGroup, MapNodeData[]> = {
    town: [],
    route: [],
    interior: [],
    cave: [],
    dungeon: [],
    special: [],
    unknown: [],
  };
  for (const m of maps) groups[m.group].push(m);
  const positions: Record<string, { x: number; y: number }> = {};
  let y = 0;
  for (const g of GROUP_ORDER) {
    const ms = groups[g];
    if (ms.length === 0) continue;
    ms.forEach((m, i) => {
      positions[m.id] = { x: i * 220, y };
    });
    y += 160;
  }
  return positions;
}

function buildNodes(
  manifest: ProjectManifest,
  maps: ReadonlyArray<MapNodeData>,
  positions: Record<string, { x: number; y: number }>,
  selectedId: string | null,
  highlightedIds: ReadonlySet<string>,
  showInternalIds: boolean,
): Node[] {
  return maps.map((m) => ({
    id: m.id,
    position: positions[m.id] ?? { x: 0, y: 0 },
    data: {
      // Phase G-RC4: pipe through displayName so MAPSEC names (and
      // synthetic fallbacks) replace raw `map.name` whatever the
      // backend wrote.
      label: displayName(manifest, m.id, showInternalIds),
      group: m.group,
      mapId: m.id,
      selected: m.id === selectedId,
      highlighted: highlightedIds.has(m.id),
      dimmed: highlightedIds.size > 0 && !highlightedIds.has(m.id),
    },
    type: 'mapNode',
  }));
}

function buildEdges(warps: ReadonlyArray<Warp>): Edge[] {
  return warps.map((w) => ({
    id: w.id,
    source: w.fromMapId,
    target: w.toMapId,
    type: 'default',
    markerEnd: { type: MarkerType.ArrowClosed, color: '#4a9eff' },
    style: { stroke: '#4a9eff', strokeWidth: 1.5 },
    data: { warp: w },
  }));
}

interface MapNodeComponentProps {
  readonly data: {
    label: string;
    group: MapGroup;
    mapId: string;
    selected: boolean;
    highlighted: boolean;
    dimmed: boolean;
  };
}

function MapNodeRenderer({ data }: MapNodeComponentProps) {
  const classes = [
    'map-node',
    `map-node--${data.group}`,
    data.selected ? 'map-node--selected' : '',
    data.highlighted ? 'map-node--highlighted' : '',
    data.dimmed ? 'map-node--dimmed' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <div
      className={classes}
      style={{ borderColor: GROUP_COLORS[data.group] }}
      data-testid={`map-node-${data.mapId}`}
    >
      <div className="map-node__kind" style={{ color: GROUP_COLORS[data.group] }}>
        {data.group}
      </div>
      <div className="map-node__label">{data.label}</div>
    </div>
  );
}

const NODE_TYPES = { mapNode: MapNodeRenderer };

interface MapsGraphProps {
  readonly manifest: ProjectManifest;
  readonly selectedId: string | null;
  readonly onSelect: (id: string | null) => void;
  readonly highlightedIds?: ReadonlySet<string>;
  readonly onEditMap?: (mapId: string) => void;
}

export function MapsGraph({
  manifest,
  selectedId,
  onSelect,
  highlightedIds,
  onEditMap,
}: MapsGraphProps) {
  const setSelectedId = onSelect;
  const showInternalIds = useUiPreferencesStore((s) => s.showInternalIds);
  const highlighted = highlightedIds ?? new Set<string>();
  const positions = useMemo(() => computeLayout(manifest.maps), [manifest.maps]);
  const nodes = useMemo(
    () => buildNodes(manifest, manifest.maps, positions, selectedId, highlighted, showInternalIds),
    [manifest, positions, selectedId, highlighted, showInternalIds],
  );
  const edges = useMemo(() => buildEdges(manifest.warps), [manifest.warps]);
  const selected = selectedId ? manifest.maps.find((m) => m.id === selectedId) ?? null : null;

  const incoming = selected
    ? manifest.warps.filter((w) => w.toMapId === selected.id)
    : [];
  const outgoing = selected
    ? manifest.warps.filter((w) => w.fromMapId === selected.id)
    : [];

  return (
    <div className="maps-graph" data-testid="maps-graph">
      <div className="maps-graph__canvas">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          onNodeClick={(_, node) => setSelectedId(node.id)}
          onEdgeClick={(_, edge) => setSelectedId(edge.source)}
          onPaneClick={() => setSelectedId(null)}
          fitView
          minZoom={0.2}
          maxZoom={2}
          proOptions={{ hideAttribution: true }}
        >
          <Background />
          <Controls />
          <MiniMap pannable zoomable />
        </ReactFlow>
      </div>
      <aside className="maps-graph__inspector" data-testid="maps-graph-inspector">
        {selected ? (
          <MapInspector
            map={{
              ...selected,
              // Phase G-RC4: ensure inspector header also reflects the
              // resolved display name (otherwise selecting a node could
              // re-show "Map ?.N" even when the node label is correct).
              name: displayName(manifest, selected.id, showInternalIds),
            }}
            incoming={incoming}
            outgoing={outgoing}
            onNavigate={(mapId) => setSelectedId(mapId)}
            onEdit={onEditMap ? () => onEditMap(selected.id) : undefined}
            showInternalIds={showInternalIds}
          />
        ) : (
          <div className="maps-graph__inspector-empty">
            <h3>Map inspector</h3>
            <p>Click a node to see its metadata, warps, and outbound destinations.</p>
            <ul>
              <li><strong>{manifest.maps.length}</strong> maps indexed</li>
              <li><strong>{manifest.warps.length}</strong> warps</li>
              <li><strong>{manifest.triggers.length}</strong> triggers</li>
              <li><strong>{manifest.objectEvents.length}</strong> object events</li>
            </ul>
          </div>
        )}
      </aside>
    </div>
  );
}

interface MapInspectorProps {
  readonly map: MapNodeData;
  readonly incoming: ReadonlyArray<Warp>;
  readonly outgoing: ReadonlyArray<Warp>;
  readonly onNavigate: (mapId: string) => void;
  readonly onEdit?: () => void;
  readonly showInternalIds: boolean;
}

function MapInspector({
  map,
  incoming,
  outgoing,
  onNavigate,
  onEdit,
  showInternalIds,
}: MapInspectorProps) {
  return (
    <div className="map-inspector">
      <div className="map-inspector__header">
        <span
          className="map-inspector__kind"
          style={{ color: GROUP_COLORS[map.group] }}
        >
          {map.group}
        </span>
        <h2 className="map-inspector__name" data-testid="map-inspector-name">
          {map.name}
        </h2>
        {/* Phase I.1 - internal id is power-user debug only; hidden by default
            so binary-ROM maps don't leak `binary_map_X_Y` to operators. */}
        {showInternalIds && <div className="map-inspector__id">{map.id}</div>}
        {onEdit && (
          <button
            type="button"
            className="btn btn--primary"
            data-testid="map-inspector-edit"
            onClick={onEdit}
            style={{ marginTop: 8 }}
          >
            Edit this map →
          </button>
        )}
      </div>
      <dl className="map-inspector__fields">
        <dt>Music</dt>
        <dd>{map.musicId ?? ' - '}</dd>
        <dt>Tilesets</dt>
        <dd>{map.tilesetIds.length}</dd>
        <dt>Warps</dt>
        <dd>{map.warpIds.length}</dd>
        <dt>Object events</dt>
        <dd>{map.objectEventIds.length}</dd>
        <dt>Encounter tables</dt>
        <dd>{map.encounterTableIds.length}</dd>
      </dl>
      <section className="map-inspector__warps">
        <h3>Outgoing warps ({outgoing.length})</h3>
        {outgoing.length === 0 ? (
          <p className="map-inspector__empty">None</p>
        ) : (
          <ul>
            {outgoing.map((w) => (
              <li key={w.id}>
                <button
                  type="button"
                  className="map-inspector__warp-btn"
                  data-testid={`outgoing-warp-${w.id}`}
                  onClick={() => onNavigate(w.toMapId)}
                >
                  → {w.toMapId} <span className="map-inspector__warp-coord">@ {w.toCoord.x},{w.toCoord.y}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="map-inspector__warps">
        <h3>Incoming warps ({incoming.length})</h3>
        {incoming.length === 0 ? (
          <p className="map-inspector__empty">None</p>
        ) : (
          <ul>
            {incoming.map((w) => (
              <li key={w.id}>
                <button
                  type="button"
                  className="map-inspector__warp-btn"
                  data-testid={`incoming-warp-${w.id}`}
                  onClick={() => onNavigate(w.fromMapId)}
                >
                  ← {w.fromMapId} <span className="map-inspector__warp-coord">@ {w.fromCoord.x},{w.fromCoord.y}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
