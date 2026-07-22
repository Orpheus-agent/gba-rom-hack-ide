import { useMemo } from 'react';
import ReactFlow, { Background, Controls, MarkerType } from 'reactflow';
import type { Edge, Node } from 'reactflow';
import type { ProjectManifest } from '@rom-editor/shared';
import {
  traceDialogueNarrative,
  type NarrativeNode,
  type NarrativeTrace,
} from '../lib/dialogueTrace';
import { displayName } from '../lib/displayName';
import { useUiPreferencesStore } from '../state';
import './DialogueNarrativeGraph.css';

interface DialogueNarrativeGraphProps {
  readonly manifest: ProjectManifest;
  readonly dialogueId: string;
  readonly maxDepth?: number;
}

const NODE_W = 240;
const NODE_H_GAP = 130;
const COL_W_GAP = 320;
const Y_PAD = 24;

interface DialogueNodeData {
  readonly node: NarrativeNode;
  readonly resolvedLabel: string;
}

function DialogueNarrativeNode({ data }: { data: DialogueNodeData }) {
  const n = data.node;
  const isUnknown = n.kind === 'unknown';
  return (
    <div
      className={`narrative-node${n.isRoot ? ' narrative-node--root' : ''}${isUnknown ? ' narrative-node--unknown' : ''}`}
      data-testid={`narrative-node-${n.id}`}
    >
      <div className="narrative-node__header">
        {n.isRoot && <span className="narrative-node__root-badge">selected</span>}
        {n.speakerName && <span className="narrative-node__speaker">{n.speakerName}</span>}
      </div>
      <div className="narrative-node__id">{data.resolvedLabel}</div>
      {n.preview ? (
        <div className="narrative-node__preview">{n.preview}</div>
      ) : (
        isUnknown && <div className="narrative-node__unknown">(not in dialogue index)</div>
      )}
    </div>
  );
}

const NODE_TYPES = { narrativeNode: DialogueNarrativeNode };

function layoutTrace(
  trace: NarrativeTrace,
  manifest: ProjectManifest,
  showInternalIds: boolean,
): {
  nodes: Node[];
  edges: Edge[];
} {
  // Layout: root in the leftmost column, each depth gets its own column. Within
  // a column nodes stack vertically by their order of first encounter.
  const columnsByDepth = new Map<number, NarrativeNode[]>();
  for (const n of trace.nodes) {
    const bucket = columnsByDepth.get(n.depth) ?? [];
    bucket.push(n);
    columnsByDepth.set(n.depth, bucket);
  }

  const nodes: Node[] = [];
  for (const [depth, bucket] of columnsByDepth) {
    bucket.forEach((n, rowIdx) => {
      nodes.push({
        id: n.id,
        position: { x: depth * COL_W_GAP, y: Y_PAD + rowIdx * NODE_H_GAP },
        type: 'narrativeNode',
        data: {
          node: n,
          resolvedLabel: displayName(manifest, n.id, showInternalIds),
        },
        style: { width: NODE_W },
        draggable: false,
      });
    });
  }

  const edges: Edge[] = trace.edges.map((e) => {
    const isBranch = e.kind === 'branch';
    const labelLines: string[] = [e.label];
    if (e.sideEffects.length > 0) labelLines.push(`(${e.sideEffects.join(' · ')})`);
    return {
      id: e.id,
      source: e.fromId,
      target: e.toId,
      label: labelLines.join('\n'),
      labelBgPadding: [4, 2],
      labelBgBorderRadius: 3,
      labelStyle: { fontSize: 10, fill: isBranch ? '#f0b429' : '#cfd2d6' },
      labelBgStyle: { fill: '#222628', fillOpacity: 0.85 },
      style: {
        stroke: isBranch ? '#f0b429' : '#7c8088',
        strokeWidth: isBranch ? 1.5 : 1,
        strokeDasharray: isBranch ? '4 3' : undefined,
      },
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color: isBranch ? '#f0b429' : '#7c8088',
      },
      animated: isBranch,
      data: { sideEffects: e.sideEffects },
    };
  });

  return { nodes, edges };
}

export function DialogueNarrativeGraph({
  manifest,
  dialogueId,
  maxDepth = 2,
}: DialogueNarrativeGraphProps) {
  const showInternalIds = useUiPreferencesStore((s) => s.showInternalIds);
  const trace = useMemo(
    () => traceDialogueNarrative(manifest, dialogueId, maxDepth),
    [manifest, dialogueId, maxDepth],
  );

  const { nodes, edges } = useMemo(
    () => layoutTrace(trace, manifest, showInternalIds),
    [trace, manifest, showInternalIds],
  );

  if (trace.callers.length === 0 && trace.edges.length === 0) {
    return (
      <div className="narrative-graph narrative-graph--empty" data-testid="narrative-graph-empty">
        <h3>No script calls this line</h3>
        <p>
          The script index doesn't show any <code>msgbox</code>/<code>message</code> step
          referencing <code>{dialogueId}</code>. It may be orphan text, used by an engine path
          this scanner doesn't trace, or referenced from a fork-specific macro not in
          the 43-macro registry.
        </p>
      </div>
    );
  }

  return (
    <div className="narrative-graph" data-testid="narrative-graph">
      <header className="narrative-graph__header">
        <h3 className="narrative-graph__title">Narrative graph</h3>
        <div className="narrative-graph__meta">
          <span className="narrative-graph__stat" data-testid="narrative-graph-callers-count">
            {trace.callers.length} caller{trace.callers.length === 1 ? '' : 's'}
          </span>
          <span className="narrative-graph__stat" data-testid="narrative-graph-nodes-count">
            {trace.nodes.length} node{trace.nodes.length === 1 ? '' : 's'}
          </span>
          <span className="narrative-graph__stat" data-testid="narrative-graph-edges-count">
            {trace.edges.length} edge{trace.edges.length === 1 ? '' : 's'}
          </span>
          {trace.truncated && (
            <span
              className="narrative-graph__stat narrative-graph__stat--truncated"
              data-testid="narrative-graph-truncated"
              title={`More reachable beyond depth ${maxDepth} - click a leaf node to re-anchor and expand from there.`}
            >
              truncated
            </span>
          )}
        </div>
      </header>
      <CallersList trace={trace} manifest={manifest} showInternalIds={showInternalIds} />
      <div className="narrative-graph__canvas">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          fitView
          minZoom={0.4}
          maxZoom={1.6}
          proOptions={{ hideAttribution: true }}
          nodesDraggable={false}
        >
          <Background />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
    </div>
  );
}

function CallersList({
  trace,
  manifest,
  showInternalIds,
}: {
  trace: NarrativeTrace;
  manifest: ProjectManifest;
  showInternalIds: boolean;
}) {
  if (trace.callers.length === 0) return null;
  return (
    <details className="narrative-graph__callers" data-testid="narrative-graph-callers">
      <summary>Called from {trace.callers.length} script step{trace.callers.length === 1 ? '' : 's'}</summary>
      <ul className="narrative-graph__callers-list">
        {trace.callers.map((c) => (
          <li key={c.scriptStepId} className="narrative-graph__caller-row">
            <span className="narrative-graph__caller-id">
              {displayName(manifest, c.scriptStepId, showInternalIds)}
            </span>
            {c.triggerId && (
              <span className="narrative-graph__caller-meta">
                {c.triggerKind} · {c.mapId ? displayName(manifest, c.mapId, showInternalIds) : 'global'}
              </span>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}
