import { useCallback, useState } from 'react';
import {
  armBreakpoint,
  clearHits,
  disarmBreakpoint,
  type Breakpoint,
  type BreakpointKind,
  type BreakpointState,
} from '../lib/previewBreakpoints';
import './BreakpointsPanel.css';

interface BreakpointsPanelProps {
  readonly state: BreakpointState;
  readonly onChange: (next: BreakpointState) => void;
}

const KIND_OPTIONS: ReadonlyArray<{ value: BreakpointKind; label: string }> = [
  { value: 'warp_taken', label: 'Warp taken' },
  { value: 'trigger_fire', label: 'Trigger fire' },
  { value: 'object_event_step', label: 'Object event step' },
  { value: 'dialogue_show', label: 'Dialogue show' },
];

export function BreakpointsPanel({ state, onChange }: BreakpointsPanelProps) {
  const [kind, setKind] = useState<BreakpointKind>('warp_taken');
  const [entityId, setEntityId] = useState('');

  const onArm = useCallback((): void => {
    const id = `bp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    onChange(
      armBreakpoint(state, {
        id,
        kind,
        entityId: entityId.trim() || null,
      }),
    );
    setEntityId('');
  }, [state, kind, entityId, onChange]);

  const onDisarm = useCallback(
    (id: string): void => {
      onChange(disarmBreakpoint(state, id));
    },
    [state, onChange],
  );

  const onClearHits = useCallback((): void => {
    onChange(clearHits(state));
  }, [state, onChange]);

  return (
    <section className="bp-panel" data-testid="bp-panel">
      <h4 className="bp-panel__heading">Event breakpoints</h4>
      <div className="bp-panel__arm-row">
        <select
          className="bp-panel__kind"
          value={kind}
          onChange={(e) => setKind(e.target.value as BreakpointKind)}
          data-testid="bp-panel-kind"
        >
          {KIND_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <input
          type="text"
          className="bp-panel__entity"
          value={entityId}
          onChange={(e) => setEntityId(e.target.value)}
          placeholder="(any entity id)"
          spellCheck={false}
          data-testid="bp-panel-entity"
        />
        <button
          type="button"
          className="bp-panel__arm-btn"
          onClick={onArm}
          data-testid="bp-panel-arm"
        >
          Arm
        </button>
      </div>

      {state.breakpoints.length > 0 && (
        <div className="bp-panel__list" data-testid="bp-panel-list">
          <div className="bp-panel__list-heading">Armed ({state.breakpoints.length})</div>
          <ul>
            {state.breakpoints.map((bp) => (
              <BreakpointRow key={bp.id} bp={bp} onDisarm={onDisarm} />
            ))}
          </ul>
        </div>
      )}

      {state.hits.length > 0 && (
        <div className="bp-panel__hits" data-testid="bp-panel-hits">
          <div className="bp-panel__list-heading bp-panel__list-heading--row">
            <span>Hits ({state.hits.length})</span>
            <button
              type="button"
              className="bp-panel__clear-btn"
              onClick={onClearHits}
              data-testid="bp-panel-clear-hits"
            >
              Clear
            </button>
          </div>
          <ul>
            {state.hits.map((h) => (
              <li key={h.sequence} className={`bp-panel__hit bp-panel__hit--${h.kind}`}>
                <span className="bp-panel__hit-kind">{h.kind.replace(/_/g, ' ')}</span>
                <span className="bp-panel__hit-tile">@ ({h.tile.x}, {h.tile.y})</span>
                <span className="bp-panel__hit-reason">{h.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function BreakpointRow({
  bp,
  onDisarm,
}: {
  bp: Breakpoint;
  onDisarm: (id: string) => void;
}) {
  return (
    <li className="bp-panel__row">
      <span className={`bp-panel__kind-badge bp-panel__kind-badge--${bp.kind}`}>
        {bp.kind.replace(/_/g, ' ')}
      </span>
      <span className="bp-panel__row-entity">
        {bp.entityId ? <code>{bp.entityId}</code> : <em>any</em>}
      </span>
      <button
        type="button"
        className="bp-panel__row-disarm"
        onClick={() => onDisarm(bp.id)}
        data-testid={`bp-disarm-${bp.id}`}
        title="Disarm this breakpoint"
      >
        ×
      </button>
    </li>
  );
}
