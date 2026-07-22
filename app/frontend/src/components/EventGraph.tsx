import { useMemo } from 'react';
import ReactFlow, { Background, Controls, MarkerType } from 'reactflow';
import type { Edge, Node } from 'reactflow';
import type {
  ProjectManifest,
  ScriptStep,
  ScriptStepKind,
  Trigger,
} from '@rom-editor/shared';
import './EventGraph.css';

export const STEP_KIND_COLORS: Readonly<Record<ScriptStepKind, string>> = {
  dialogue: '#4a9eff',
  set_flag: '#50c878',
  clear_flag: '#3da568',
  branch: '#f0b429',
  branch_on_var: '#b46aff',
  give_item: '#4ad1d1',
  start_battle: '#e25555',
  play_sound: '#b46aff',
  move_npc: '#e08a3d',
  fade_scene: '#7c8088',
  warp_player: '#d066c4',
  set_variable: '#9bd14a',
  randomize_branch: '#e36aa6',
  raw: '#7c8088',
};

interface StepNodeData {
  readonly step: ScriptStep;
  readonly selected: boolean;
}

function StepNode({ data }: { data: StepNodeData }) {
  const s = data.step;
  const color = STEP_KIND_COLORS[s.kind];
  const macro = String(s.params['macro'] ?? s.kind);
  const summary = summarizeParams(s);
  return (
    <div
      className={`event-node event-node--${s.kind}${data.selected ? ' event-node--selected' : ''}`}
      style={{ borderColor: color }}
      data-testid={`event-node-${s.id}`}
    >
      <div className="event-node__kind" style={{ color }}>
        {s.kind}
      </div>
      <div className="event-node__macro">{macro}</div>
      {summary && <div className="event-node__summary">{summary}</div>}
    </div>
  );
}

function summarizeParams(step: ScriptStep): string | null {
  const p = step.params;
  switch (step.kind) {
    case 'dialogue':
      return typeof p['text'] === 'string' ? (p['text'] as string) : null;
    case 'set_flag':
    case 'clear_flag':
      return typeof p['flag'] === 'string' ? (p['flag'] as string) : null;
    case 'set_variable':
      return typeof p['variable'] === 'string'
        ? `${p['variable']} ← ${typeof p['value'] === 'string' ? p['value'] : '?'}`
        : null;
    case 'branch':
      return typeof p['label'] === 'string' ? `→ ${p['label']}` : null;
    case 'give_item':
      return typeof p['item'] === 'string'
        ? `${p['item']} × ${typeof p['count'] === 'string' ? p['count'] : 1}`
        : null;
    case 'start_battle':
      return typeof p['trainerId'] === 'string' ? (p['trainerId'] as string) : null;
    case 'play_sound':
      return typeof p['soundId'] === 'string' ? (p['soundId'] as string) : null;
    case 'move_npc':
      return typeof p['objectId'] === 'string'
        ? `${p['objectId']} → ${typeof p['movementId'] === 'string' ? p['movementId'] : '?'}`
        : null;
    case 'warp_player':
      return typeof p['mapId'] === 'string' ? (p['mapId'] as string) : null;
    default:
      return null;
  }
}

const NODE_TYPES = { stepNode: StepNode };

interface EventGraphProps {
  readonly manifest: ProjectManifest;
  readonly trigger: Trigger;
  readonly selectedStepId: string | null;
  readonly onSelect: (stepId: string | null) => void;
}

const NODE_W = 220;
const NODE_H_GAP = 110;
const Y_PAD = 24;

export function EventGraph({
  manifest,
  trigger,
  selectedStepId,
  onSelect,
}: EventGraphProps) {
  // Build a step lookup so we can resolve branch targets within the manifest.
  const stepById = useMemo(() => {
    const m = new Map<string, ScriptStep>();
    for (const s of manifest.scriptSteps) m.set(s.id, s);
    return m;
  }, [manifest.scriptSteps]);

  // Determine label → first-step-id index so branches can resolve.
  const labelToFirstId = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of manifest.scriptSteps) {
      const hashIdx = s.id.lastIndexOf('#');
      if (hashIdx <= 0) continue;
      const label = s.id.slice(0, hashIdx);
      const idxStr = s.id.slice(hashIdx + 1);
      if (idxStr === '0' && !m.has(label)) m.set(label, s.id);
    }
    return m;
  }, [manifest.scriptSteps]);

  const ownSteps = useMemo(
    () =>
      trigger.scriptStepIds.map((id) => stepById.get(id)).filter((s): s is ScriptStep => !!s),
    [trigger.scriptStepIds, stepById],
  );

  const nodes = useMemo<Node[]>(() => {
    return ownSteps.map((step, i) => ({
      id: step.id,
      position: { x: 0, y: Y_PAD + i * NODE_H_GAP },
      type: 'stepNode',
      data: {
        step,
        selected: step.id === selectedStepId,
      },
      style: { width: NODE_W },
    }));
  }, [ownSteps, selectedStepId]);

  const edges = useMemo<Edge[]>(() => {
    const out: Edge[] = [];
    // Sequential edges between own steps.
    for (let i = 0; i < ownSteps.length - 1; i++) {
      const a = ownSteps[i]!;
      const b = ownSteps[i + 1]!;
      out.push({
        id: `seq-${a.id}-${b.id}`,
        source: a.id,
        target: b.id,
        style: { stroke: '#7c8088', strokeWidth: 1 },
        markerEnd: { type: MarkerType.ArrowClosed, color: '#7c8088' },
      });
    }
    // Branch edges within the trigger's own chain only (cross-block targets are
    // surfaced in the inspector to keep the canvas focused on this event).
    for (const step of ownSteps) {
      if (step.kind !== 'branch') continue;
      const label = step.params['label'];
      if (typeof label !== 'string') continue;
      const targetFirstId = labelToFirstId.get(label);
      if (!targetFirstId) continue;
      if (!ownSteps.find((s) => s.id === targetFirstId)) continue;
      out.push({
        id: `branch-${step.id}-${targetFirstId}`,
        source: step.id,
        target: targetFirstId,
        style: { stroke: STEP_KIND_COLORS.branch, strokeWidth: 1.5, strokeDasharray: '4 3' },
        markerEnd: { type: MarkerType.ArrowClosed, color: STEP_KIND_COLORS.branch },
        animated: true,
      });
    }
    return out;
  }, [ownSteps, labelToFirstId]);

  if (ownSteps.length === 0) {
    return (
      <div className="event-graph event-graph--empty" data-testid="event-graph-empty">
        <h3>No script steps</h3>
        <p>
          Trigger <strong>{trigger.name}</strong> has no resolved script steps yet. This typically
          means its referenced script label (<code>{trigger.name}</code>) doesn't exist in any
          parsed <code>scripts.inc</code> file, or the script body is empty.
        </p>
      </div>
    );
  }

  return (
    <div className="event-graph" data-testid="event-graph">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        onNodeClick={(_, node) => onSelect(node.id)}
        onPaneClick={() => onSelect(null)}
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
  );
}
