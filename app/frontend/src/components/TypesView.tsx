import { useEffect, useMemo, useState } from 'react';
import type { ProjectManifest, TypeMatchupEntry } from '@rom-editor/shared';
import { editBinaryRomTypeMatchup, ProjectApiError } from '../api';
import { pushToast, useProjectStore } from '../state';
import { useEditFormKeyboard } from '../lib/useEditFormKeyboard';
import './SpeciesView.css';

/**
 * Phase N.4 - Type matchup workspace.
 *
 * Renders the full type-effectiveness chart as a sortable list of
 * attacker → defender → effectiveness rows. Each row is clickable to
 * expand into an effectiveness dropdown (No effect / Resisted / Normal /
 * Super-effective) + Save. Writes via /binary-rom-edit/type-matchup.
 *
 * Effectiveness encoding follows the Gen-3 convention: 0 / 5 / 10 / 20
 * for no-effect / ½× / 1× / 2×.
 */

const EFFECTIVENESS_OPTIONS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 0, label: '0 - No effect (0×)' },
  { value: 5, label: '5 - Resisted (½×)' },
  { value: 10, label: '10 - Normal (1×)' },
  { value: 20, label: '20 - Super-effective (2×)' },
];

interface TypesViewProps {
  readonly manifest: ProjectManifest;
}

export function TypesView({ manifest }: TypesViewProps): JSX.Element {
  const matchups = manifest.typeMatchups ?? [];
  const typeNames = manifest.typeNames ?? [];
  const typeNameById = useMemo(() => {
    const m = new Map<number, string>();
    for (const t of typeNames) m.set(t.typeIndex, t.name);
    return m;
  }, [typeNames]);
  const [filter, setFilter] = useState('');
  const filtered = useMemo(() => {
    if (!filter.trim()) return matchups;
    const q = filter.toLowerCase();
    return matchups.filter((m) => {
      const atk = (m.attackerTypeName ?? typeNameById.get(m.attackerType) ?? String(m.attackerType)).toLowerCase();
      const def = (m.defenderTypeName ?? typeNameById.get(m.defenderType) ?? String(m.defenderType)).toLowerCase();
      return atk.includes(q) || def.includes(q);
    });
  }, [matchups, filter, typeNameById]);

  if (matchups.length === 0) {
    return (
      <div className="species-view species-view--empty">
        <h2>No type chart data</h2>
        <p>The type_chart_system detector didn't lift any matchups.</p>
      </div>
    );
  }

  return (
    <div className="view">
      <h1 className="view__title">Type matchups</h1>
      <p className="view__subtitle">
        {matchups.length} matchups detected. Edit any row's effectiveness
        to rebalance the type chart in place. Adding new (atk, def) pairs
        needs relocation - queued.
      </p>
      <input
        type="search"
        placeholder="Filter by type name (FIRE / WATER / GRASS / …)"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        spellCheck={false}
        style={{
          width: '100%',
          maxWidth: 480,
          height: 30,
          padding: '0 10px',
          marginBottom: 12,
          fontFamily: 'var(--font-mono)',
          fontSize: 12,
          background: 'var(--color-bg-elevated)',
          border: '1px solid var(--color-border)',
          borderRadius: 4,
          color: 'var(--color-text)',
        }}
        data-testid="types-view-filter"
      />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {filtered.map((m) => (
          <MatchupRow key={m.id} matchup={m} typeNameById={typeNameById} />
        ))}
      </div>
    </div>
  );
}

function MatchupRow({
  matchup,
  typeNameById,
}: {
  matchup: TypeMatchupEntry;
  typeNameById: Map<number, string>;
}): JSX.Element {
  const sessionId = useProjectStore((s) =>
    s.load.kind === 'loaded' ? s.load.data.session.id : null,
  );
  const scanCurrent = useProjectStore((s) => s.scanCurrentProject);
  const [effectiveness, setEffectiveness] = useState(matchup.effectiveness);
  const [state, setState] = useState<
    | { kind: 'idle' }
    | { kind: 'saving' }
    | { kind: 'saved' }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' });
  useEffect(() => {
    setEffectiveness(matchup.effectiveness);
    setState({ kind: 'idle' });
  }, [matchup.entryFileOffset, matchup.effectiveness]);

  const atkName =
    matchup.attackerTypeName ?? typeNameById.get(matchup.attackerType) ?? `Type ${matchup.attackerType}`;
  const defName =
    matchup.defenderTypeName ?? typeNameById.get(matchup.defenderType) ?? `Type ${matchup.defenderType}`;
  const canEdit = typeof matchup.entryFileOffset === 'number';
  const dirty = effectiveness !== matchup.effectiveness;

  async function save(): Promise<void> {
    if (!sessionId || !canEdit || !dirty || matchup.entryFileOffset === undefined) return;
    setState({ kind: 'saving' });
    try {
      await editBinaryRomTypeMatchup(sessionId, {
        entryFileOffset: matchup.entryFileOffset,
        fields: { effectiveness },
      });
      setState({ kind: 'saved' });
      pushToast('success', `${atkName} vs ${defName} saved`);
      await scanCurrent();
    } catch (e) {
      const message =
        e instanceof ProjectApiError
          ? `${e.code}: ${e.message}`
          : e instanceof Error
            ? e.message
            : String(e);
      setState({ kind: 'error', message });
      pushToast('error', `Matchup save failed - ${message}`);
    }
  }
  // Phase O.30 - Enter saves, Esc reverts.
  const onKeyDownEdit = useEditFormKeyboard({
    canSave: dirty && canEdit && sessionId !== null && state.kind !== 'saving',
    save,
    cancel: () => {
      setEffectiveness(matchup.effectiveness);
      setState({ kind: 'idle' });
    },
    isSaving: state.kind === 'saving',
  });
  return (
    <div
      onKeyDown={onKeyDownEdit}
      style={{
        display: 'grid',
        gridTemplateColumns: '140px 140px 200px auto auto',
        gap: 8,
        alignItems: 'center',
        padding: '4px 8px',
        background: 'var(--color-bg-elevated)',
        border: '1px solid var(--color-border)',
        borderRadius: 4,
        fontSize: 12,
      }}
    >
      <span>{atkName}</span>
      <span style={{ color: 'var(--color-text-muted)' }}>→ {defName}</span>
      <select
        value={effectiveness}
        onChange={(e) => setEffectiveness(Number.parseInt(e.target.value, 10))}
        disabled={!canEdit}
        style={{
          height: 24,
          padding: '0 6px',
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          background: 'var(--color-bg)',
          border: '1px solid var(--color-border)',
          borderRadius: 3,
          color: 'var(--color-text)',
        }}
      >
        {EFFECTIVENESS_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
        {!EFFECTIVENESS_OPTIONS.some((o) => o.value === effectiveness) && (
          <option value={effectiveness}>{`${effectiveness} - Hack-specific`}</option>
        )}
      </select>
      <button
        type="button"
        className="btn btn--primary"
        disabled={!dirty || !canEdit || state.kind === 'saving' || !sessionId}
        onClick={() => void save()}
        style={{ height: 24, fontSize: 10, padding: '0 10px' }}
      >
        {state.kind === 'saving' ? 'Saving…' : 'Save'}
      </button>
      {state.kind === 'saved' && !dirty && (
        <span className="species-editor__ok" style={{ fontSize: 10 }}>Saved</span>
      )}
      {state.kind === 'error' && (
        <span className="species-editor__err" style={{ fontSize: 10 }}>{state.message}</span>
      )}
    </div>
  );
}
