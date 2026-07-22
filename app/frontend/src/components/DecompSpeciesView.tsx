import { useEffect, useMemo, useState } from 'react';
import {
  getDecompSpeciesList,
  getDecompSpecies,
  editDecompSpecies,
  type DecompSpeciesListItem,
  type DecompSpeciesDetail,
  type DecompSpeciesEnums,
  type DecompSpeciesEdit,
} from '../api';
import { useProjectStore } from '../state';

/** Strip a constant prefix and Title-Case the rest: TYPE_MEDIUM_SLOW → "Medium Slow". */
function pretty(constName: string, prefix: string): string {
  return constName
    .replace(prefix, '')
    .toLowerCase()
    .replace(/(^|_)(\w)/g, (_a, _b, c: string) => (_b ? ' ' : '') + c.toUpperCase())
    .trim();
}

function Select({
  value,
  options,
  prefix,
  onChange,
}: {
  value: string;
  options: string[];
  prefix: string;
  onChange: (v: string) => void;
}): JSX.Element {
  // Ensure the current value is selectable even if missing from the enum list.
  const opts = options.includes(value) ? options : [value, ...options];
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} style={SELECT_STYLE}>
      {opts.map((o) => (
        <option key={o} value={o}>
          {pretty(o, prefix)}
        </option>
      ))}
    </select>
  );
}

const STATS: Array<[keyof DecompSpeciesDetail, string]> = [
  ['baseHP', 'HP'],
  ['baseAttack', 'Attack'],
  ['baseDefense', 'Defense'],
  ['baseSpAttack', 'Sp. Atk'],
  ['baseSpDefense', 'Sp. Def'],
  ['baseSpeed', 'Speed'],
];

export function DecompSpeciesView(): JSX.Element {
  const sessionId = useProjectStore((s) =>
    s.load.kind === 'loaded' ? s.load.data.session.id : null,
  );
  const [list, setList] = useState<DecompSpeciesListItem[] | null>(null);
  const [filter, setFilter] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<DecompSpeciesDetail | null>(null);
  const [enums, setEnums] = useState<DecompSpeciesEnums | null>(null);
  const [save, setSave] = useState<'idle' | 'saving' | 'saved' | { err: string }>('idle');
  const [loadErr, setLoadErr] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionId) return;
    getDecompSpeciesList(sessionId)
      .then((l) => {
        setList(l);
        if (l.length > 0) setSelectedId((cur) => cur ?? l[0]!.id);
      })
      .catch((e) => setLoadErr(e instanceof Error ? e.message : String(e)));
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId || !selectedId) return;
    setSave('idle');
    getDecompSpecies(sessionId, selectedId)
      .then(({ detail: d, enums: en }) => {
        setDetail(d);
        setEnums(en);
      })
      .catch((e) => setLoadErr(e instanceof Error ? e.message : String(e)));
  }, [sessionId, selectedId]);

  const filtered = useMemo(() => {
    const all = list ?? [];
    const q = filter.trim().toLowerCase();
    if (!q) return all;
    return all.filter((s) => s.name.toLowerCase().includes(q) || s.id.toLowerCase().includes(q));
  }, [list, filter]);

  if (!sessionId) return <div style={{ padding: 16 }}>Open a project first.</div>;
  if (loadErr) return <div style={{ padding: 16, color: '#e25555' }}>Couldn't load species: {loadErr}</div>;
  if (!list) return <div style={{ padding: 16 }}>Loading species…</div>;

  const set = <K extends keyof DecompSpeciesDetail>(k: K, v: DecompSpeciesDetail[K]): void =>
    setDetail((d) => (d ? { ...d, [k]: v } : d));

  const doSave = async (): Promise<void> => {
    if (!detail) return;
    setSave('saving');
    const edit: DecompSpeciesEdit = {
      baseHP: detail.baseHP,
      baseAttack: detail.baseAttack,
      baseDefense: detail.baseDefense,
      baseSpeed: detail.baseSpeed,
      baseSpAttack: detail.baseSpAttack,
      baseSpDefense: detail.baseSpDefense,
      type1: detail.type1,
      type2: detail.type2,
      abilities: detail.abilities,
      eggGroup1: detail.eggGroup1,
      eggGroup2: detail.eggGroup2,
      catchRate: detail.catchRate,
      eggCycles: detail.eggCycles,
      height: detail.height,
      weight: detail.weight,
      growthRate: detail.growthRate,
      bodyColor: detail.bodyColor,
      friendship: detail.friendship,
      speciesName: detail.speciesName,
      categoryName: detail.categoryName,
      description: detail.description,
    };
    try {
      await editDecompSpecies(sessionId, detail.id, edit);
      setSave('saved');
    } catch (e) {
      setSave({ err: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 0 }} data-testid="decomp-species-view">
      <aside style={{ width: 240, borderRight: '1px solid var(--border-subtle,#2a2a2a)', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <input
          type="search"
          placeholder={`Filter ${list.length} species…`}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={{ margin: 8, padding: 6 }}
          spellCheck={false}
        />
        <ul style={{ overflow: 'auto', listStyle: 'none', margin: 0, padding: 0, flex: 1 }}>
          {filtered.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => setSelectedId(s.id)}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  width: '100%',
                  padding: '6px 10px',
                  border: 'none',
                  background: s.id === selectedId ? 'var(--surface-raised,#2d3138)' : 'transparent',
                  color: 'inherit',
                  cursor: 'pointer',
                  textAlign: 'left',
                }}
              >
                <span>{s.name}</span>
                <span style={{ opacity: 0.5, fontSize: 11 }}>{s.bst}</span>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <section style={{ flex: 1, overflow: 'auto', padding: 16, minHeight: 0 }}>
        {!detail || !enums ? (
          <div>Select a Pokémon.</div>
        ) : (
          <div style={{ maxWidth: 560, display: 'flex', flexDirection: 'column', gap: 14 }}>
            <h2 style={{ margin: 0 }}>{detail.name}</h2>

            <fieldset style={FIELDSET}>
              <legend>Base stats</legend>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
                {STATS.map(([k, label]) => (
                  <label key={k} style={LABEL}>
                    {label}
                    <input
                      type="number"
                      min={1}
                      max={255}
                      value={detail[k] as number}
                      onChange={(e) => set(k, (Number.parseInt(e.target.value, 10) || 0) as never)}
                    />
                  </label>
                ))}
              </div>
            </fieldset>

            <fieldset style={FIELDSET}>
              <legend>Types & abilities</legend>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <label style={LABEL}>Type 1<Select value={detail.type1} options={enums.types} prefix="TYPE_" onChange={(v) => set('type1', v)} /></label>
                <label style={LABEL}>Type 2<Select value={detail.type2} options={enums.types} prefix="TYPE_" onChange={(v) => set('type2', v)} /></label>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
                {([0, 1, 2] as const).map((i) => (
                  <label key={i} style={LABEL}>
                    {i === 2 ? 'Hidden ability' : `Ability ${i + 1}`}
                    <Select
                      value={detail.abilities[i]}
                      options={enums.abilities}
                      prefix="ABILITY_"
                      onChange={(v) => {
                        const a = [...detail.abilities] as [string, string, string];
                        a[i] = v;
                        set('abilities', a);
                      }}
                    />
                  </label>
                ))}
              </div>
            </fieldset>

            <fieldset style={FIELDSET}>
              <legend>Breeding & growth</legend>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <label style={LABEL}>Egg group 1<Select value={detail.eggGroup1} options={enums.eggGroups} prefix="EGG_GROUP_" onChange={(v) => set('eggGroup1', v)} /></label>
                <label style={LABEL}>Egg group 2<Select value={detail.eggGroup2} options={enums.eggGroups} prefix="EGG_GROUP_" onChange={(v) => set('eggGroup2', v)} /></label>
                <label style={LABEL}>Growth rate<Select value={detail.growthRate} options={enums.growthRates} prefix="GROWTH_" onChange={(v) => set('growthRate', v)} /></label>
                <label style={LABEL}>Body color<Select value={detail.bodyColor} options={enums.bodyColors} prefix="BODY_COLOR_" onChange={(v) => set('bodyColor', v)} /></label>
                <label style={LABEL}>Catch rate<input type="number" min={0} max={255} value={detail.catchRate} onChange={(e) => set('catchRate', Number.parseInt(e.target.value, 10) || 0)} /></label>
                <label style={LABEL}>Egg cycles<input type="number" min={0} value={detail.eggCycles} onChange={(e) => set('eggCycles', Number.parseInt(e.target.value, 10) || 0)} /></label>
              </div>
            </fieldset>

            <fieldset style={FIELDSET}>
              <legend>Pokédex</legend>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <label style={LABEL}>Name<input value={detail.speciesName} spellCheck={false} onChange={(e) => set('speciesName', e.target.value)} /></label>
                <label style={LABEL}>Category<input value={detail.categoryName} spellCheck={false} onChange={(e) => set('categoryName', e.target.value)} /></label>
                <label style={LABEL}>Height (dm)<input type="number" value={detail.height} onChange={(e) => set('height', Number.parseInt(e.target.value, 10) || 0)} /></label>
                <label style={LABEL}>Weight (hg)<input type="number" value={detail.weight} onChange={(e) => set('weight', Number.parseInt(e.target.value, 10) || 0)} /></label>
              </div>
              <label style={{ ...LABEL, width: '100%', marginTop: 8 }}>
                Dex entry
                <textarea value={detail.description} spellCheck={false} rows={4} onChange={(e) => set('description', e.target.value)} style={{ width: '100%', resize: 'vertical' }} />
              </label>
            </fieldset>

            <div style={{ fontSize: 11, opacity: 0.55 }}>
              Evolutions / learnsets / gender ratio are read-only here (coming in later editors): <code>{detail.evolutions || ' - '}</code>
            </div>

            <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
              <button type="button" onClick={() => void doSave()} disabled={save === 'saving'} style={SAVE_BTN}>
                {save === 'saving' ? 'Saving…' : 'Save'}
              </button>
              {save === 'saved' && <span style={{ color: '#3fb950' }}>Saved to {detail.sourceRel}. Build &amp; Play to see it.</span>}
              {typeof save === 'object' && <span style={{ color: '#e25555' }}>{save.err}</span>}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

const SELECT_STYLE = { padding: 4, minWidth: 120 } as const;
const FIELDSET = { border: '1px solid var(--border-subtle,#2a2a2a)', borderRadius: 6, padding: 10 } as const;
const LABEL = { display: 'flex', flexDirection: 'column', gap: 3, fontSize: 12 } as const;
const SAVE_BTN = { padding: '6px 18px', background: '#2e7d32', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer' } as const;
