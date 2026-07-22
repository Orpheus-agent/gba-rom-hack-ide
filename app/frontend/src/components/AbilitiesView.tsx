import { useEffect, useMemo, useState } from 'react';
import type { AbilityEntry, ProjectManifest } from '@rom-editor/shared';
import { editBinaryRomDialogueString, ProjectApiError } from '../api';
import { pushToast, useProjectStore } from '../state';
import { useEditFormKeyboard } from '../lib/useEditFormKeyboard';
import './SpeciesView.css';

/**
 * Phase M.4 - Abilities workspace.
 *
 * Each ability has a 13-byte name slot in the gAbilityNames table; the
 * sourceTableOffset on AbilityEntry points at it. The dialogue-string
 * route writes Gen-3-encoded text into a terminator-bounded span, so
 * editing an ability's name is the same as editing a msgbox string.
 *
 * Description text is at a parallel pointer table (gAbilityDescriptions)
 * not yet surfaced by the lifter - that's queued for a future iter.
 */

interface AbilitiesViewProps {
  readonly manifest: ProjectManifest;
}

export function AbilitiesView({ manifest }: AbilitiesViewProps): JSX.Element {
  const abilities = manifest.abilities ?? [];
  const [filter, setFilter] = useState('');
  const [selectedIdx, setSelectedIdx] = useState<number | null>(
    abilities.length > 0 ? 0 : null,
  );
  const filtered = useMemo(() => {
    if (!filter.trim()) return abilities;
    const q = filter.toLowerCase();
    return abilities.filter(
      (a) => a.name.toLowerCase().includes(q) || String(a.abilityIndex).includes(q),
    );
  }, [abilities, filter]);
  const selected =
    selectedIdx !== null && selectedIdx >= 0 && selectedIdx < abilities.length
      ? abilities[selectedIdx]!
      : null;

  if (abilities.length === 0) {
    return (
      <div className="species-view species-view--empty">
        <h2>No abilities data</h2>
        <p>The abilities_system detector didn't lift any abilities.</p>
      </div>
    );
  }

  return (
    <div className="species-view">
      <aside className="species-view__list">
        <input
          type="search"
          className="species-view__filter"
          placeholder="Filter by name / index…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          data-testid="abilities-view-filter"
          spellCheck={false}
        />
        <ul>
          {filtered.map((a) => {
            const realIdx = abilities.indexOf(a);
            return (
              <li key={a.id}>
                <button
                  type="button"
                  className={`species-view__item${realIdx === selectedIdx ? ' species-view__item--selected' : ''}`}
                  data-testid={`abilities-view-item-${a.id}`}
                  onClick={() => setSelectedIdx(realIdx)}
                >
                  <span className="species-view__item-idx">#{a.abilityIndex}</span>
                  <span className="species-view__item-name">{a.name}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </aside>
      <section className="species-view__detail">
        {selected ? <AbilityEditor ability={selected} /> : <p>Pick an ability to edit.</p>}
      </section>
    </div>
  );
}

function AbilityEditor({ ability }: { ability: AbilityEntry }): JSX.Element {
  const sessionId = useProjectStore((s) =>
    s.load.kind === 'loaded' ? s.load.data.session.id : null,
  );
  const scanCurrent = useProjectStore((s) => s.scanCurrentProject);
  const [name, setName] = useState(ability.name);
  const [state, setState] = useState<
    | { kind: 'idle' }
    | { kind: 'saving' }
    | { kind: 'saved' }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' });
  useEffect(() => {
    setName(ability.name);
    setState({ kind: 'idle' });
  }, [ability.id, ability.name]);

  const dirty = name !== ability.name;
  // Gen-3 ability name slot is 13 bytes (12 chars + 0xFF terminator).
  const valid = name.length <= 12;
  const canSave = dirty && valid && sessionId !== null;

  async function save(): Promise<void> {
    if (!sessionId || !canSave) return;
    setState({ kind: 'saving' });
    try {
      // Phase N.5 - write to the per-entry name slot, not the table
      // start. Older manifests without nameSlotOffset fall back to
      // the table-start offset (only correct for entry 0 - re-scan to
      // pick up the per-entry offsets).
      await editBinaryRomDialogueString(sessionId, {
        stringFileOffset: ability.nameSlotOffset ?? ability.sourceTableOffset,
        newText: name,
      });
      setState({ kind: 'saved' });
      pushToast('success', `Ability renamed to "${name}"`);
      await scanCurrent();
    } catch (e) {
      const message =
        e instanceof ProjectApiError
          ? `${e.code}: ${e.message}`
          : e instanceof Error
            ? e.message
            : String(e);
      setState({ kind: 'error', message });
      pushToast('error', `Ability rename failed - ${message}`);
    }
  }

  // Phase O.30 - Enter saves, Esc reverts name input.
  const onKeyDownEdit = useEditFormKeyboard({
    canSave: canSave && state.kind !== 'saving',
    save,
    cancel: () => {
      setName(ability.name);
      setState({ kind: 'idle' });
    },
    isSaving: state.kind === 'saving',
  });

  return (
    <div className="species-editor" onKeyDown={onKeyDownEdit}>
      <header>
        <h2>
          #{ability.abilityIndex} {ability.name}
        </h2>
        <p>Ability name (up to 12 characters)</p>
      </header>
      <fieldset>
        <legend>Name</legend>
        <div className="species-field-grid">
          <label className="species-field">
            <span>Ability name (≤12 chars)</span>
            <input
              type="text"
              maxLength={12}
              value={name}
              data-testid="abilities-name-input"
              onChange={(e) => setName(e.target.value)}
            />
          </label>
        </div>
      </fieldset>
      <div className="species-editor__actions">
        <button
          type="button"
          className="btn btn--primary"
          data-testid="abilities-save"
          disabled={!canSave || state.kind === 'saving'}
          onClick={() => void save()}
        >
          {state.kind === 'saving' ? 'Saving…' : 'Save name'}
        </button>
        {state.kind === 'saved' && !dirty && (
          <span className="species-editor__ok">Saved · name slot patched</span>
        )}
        {state.kind === 'error' && (
          <span className="species-editor__err">{state.message}</span>
        )}
      </div>
      <p style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 8 }}>
        Description text lives at a parallel pointer table
        (gAbilityDescriptions). That isn't surfaced by the lifter yet - 
        queued for a follow-up so descriptions are editable here too.
      </p>
    </div>
  );
}
