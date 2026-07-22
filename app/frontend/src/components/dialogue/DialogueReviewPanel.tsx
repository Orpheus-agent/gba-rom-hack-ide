import { useMemo, useState } from 'react';
import type { DialogueNode, ProjectManifest } from '@rom-editor/shared';
import { displayName } from '../../lib/displayName';
import { useSelection, useUiPreferencesStore } from '../../state';
import './DialogueReviewPanel.css';

// WP8 - Dialogue Review Panel.
//
// A single global table of every dialogue line in the ROM, modelled on
// GB Studio's Dialogue Review screen. ROM hacking traditionally requires
// pointer-chasing across banks to find a string; this panel makes that a
// scan + filter + click-to-edit.
//
// Features:
//   * Filter as you type (matches speaker, text body, or id)
//   * Sort by speaker, length, or id
//   * Speaker filter (dropdown of every speaker that has dialogue)
//   * Row click → useSelection.select({ kind: 'dialogue', id }) →
//     DialogueInspector opens in the right rail, with its existing
//     inline edit form
//   * Virtual-scroll-friendly markup (single flat list, plain CSS),
//     ready for windowing if dialogue counts explode past ~5000
//
// Out of scope for v1:
//   * Search-and-replace across all dialogue (planned follow-up)
//   * Per-row inline edit (DialogueInspector already does this)
//   * Exporting to PBS / .po localization formats

type SortKey = 'speaker' | 'length' | 'id';

const SPEAKER_FILTER_ALL = '__all__';
const NO_SPEAKER = '__none__';

interface DialogueReviewPanelProps {
  readonly manifest: ProjectManifest;
}

export function DialogueReviewPanel({ manifest }: DialogueReviewPanelProps): JSX.Element {
  const select = useSelection((s) => s.select);
  const selectedRef = useSelection((s) => s.current);
  const showInternalIds = useUiPreferencesStore((s) => s.showInternalIds);
  const [filter, setFilter] = useState('');
  const [speakerFilter, setSpeakerFilter] = useState<string>(SPEAKER_FILTER_ALL);
  const [sortKey, setSortKey] = useState<SortKey>('id');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  const dialogue = manifest.dialogue;

  // Build the speaker dropdown options - every distinct, non-empty
  // speakerName plus an "(unnamed)" bucket.
  const speakers = useMemo<ReadonlyArray<{ value: string; label: string; count: number }>>(() => {
    const counts = new Map<string, number>();
    let unnamed = 0;
    for (const d of dialogue) {
      const speaker = (d.speakerName ?? '').trim();
      if (speaker.length === 0) {
        unnamed++;
        continue;
      }
      counts.set(speaker, (counts.get(speaker) ?? 0) + 1);
    }
    const out: { value: string; label: string; count: number }[] = [];
    if (unnamed > 0) {
      out.push({ value: NO_SPEAKER, label: '(unnamed speaker)', count: unnamed });
    }
    for (const [speaker, count] of counts) {
      out.push({ value: speaker, label: speaker, count });
    }
    out.sort((a, b) => b.count - a.count);
    return out;
  }, [dialogue]);

  const filtered = useMemo<ReadonlyArray<DialogueNode>>(() => {
    const q = filter.trim().toLowerCase();
    return dialogue.filter((d) => {
      if (speakerFilter !== SPEAKER_FILTER_ALL) {
        const s = (d.speakerName ?? '').trim();
        if (speakerFilter === NO_SPEAKER) {
          if (s.length > 0) return false;
        } else if (s !== speakerFilter) {
          return false;
        }
      }
      if (q.length === 0) return true;
      if (d.text.toLowerCase().includes(q)) return true;
      if ((d.speakerName ?? '').toLowerCase().includes(q)) return true;
      if (d.id.toLowerCase().includes(q)) return true;
      return false;
    });
  }, [dialogue, filter, speakerFilter]);

  const sorted = useMemo<ReadonlyArray<DialogueNode>>(() => {
    const copy = [...filtered];
    copy.sort((a, b) => {
      let cmp = 0;
      if (sortKey === 'speaker') {
        const sa = (a.speakerName ?? '').toLowerCase();
        const sb = (b.speakerName ?? '').toLowerCase();
        cmp = sa.localeCompare(sb);
      } else if (sortKey === 'length') {
        cmp = a.text.length - b.text.length;
      } else {
        cmp = a.id.localeCompare(b.id);
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return copy;
  }, [filtered, sortKey, sortDir]);

  const toggleSort = (key: SortKey): void => {
    if (sortKey === key) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  };

  if (dialogue.length === 0) {
    return (
      <div className="dialogue-review dialogue-review--empty" data-testid="dialogue-review-empty">
        <h2>No dialogue indexed</h2>
        <p>
          The scan didn't lift any dialogue lines from this project. Open a
          decomp tree with <code>data/scripts/**/*.inc</code> or a binary ROM
          and re-scan to populate this view.
        </p>
      </div>
    );
  }

  return (
    <div className="dialogue-review" data-testid="dialogue-review">
      <header className="dialogue-review__header">
        <h2 className="dialogue-review__title">All dialogue</h2>
        <p className="dialogue-review__subtitle" data-testid="dialogue-review-count">
          Showing {String(sorted.length)} of {String(dialogue.length)} line
          {dialogue.length === 1 ? '' : 's'}
        </p>
      </header>
      <div className="dialogue-review__controls">
        <input
          type="search"
          className="dialogue-review__filter"
          placeholder="Search by text, speaker, or id…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          spellCheck={false}
          data-testid="dialogue-review-filter"
        />
        <select
          className="dialogue-review__speaker-filter"
          value={speakerFilter}
          onChange={(e) => setSpeakerFilter(e.target.value)}
          aria-label="Filter by speaker"
          data-testid="dialogue-review-speaker-filter"
        >
          <option value={SPEAKER_FILTER_ALL}>All speakers ({dialogue.length})</option>
          {speakers.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label} ({String(s.count)})
            </option>
          ))}
        </select>
      </div>
      <table className="dialogue-review__table">
        <thead>
          <tr>
            <th>
              <SortButton
                active={sortKey === 'speaker'}
                direction={sortDir}
                onClick={() => toggleSort('speaker')}
                testId="dialogue-review-sort-speaker"
              >
                Speaker
              </SortButton>
            </th>
            <th>Text</th>
            <th className="dialogue-review__col-length">
              <SortButton
                active={sortKey === 'length'}
                direction={sortDir}
                onClick={() => toggleSort('length')}
                testId="dialogue-review-sort-length"
              >
                Length
              </SortButton>
            </th>
            <th className="dialogue-review__col-id">
              <SortButton
                active={sortKey === 'id'}
                direction={sortDir}
                onClick={() => toggleSort('id')}
                testId="dialogue-review-sort-id"
              >
                Reference
              </SortButton>
            </th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((d) => {
            const isSelected =
              selectedRef?.kind === 'dialogue' && selectedRef.id === d.id;
            return (
              <tr
                key={d.id}
                className={`dialogue-review__row${isSelected ? ' dialogue-review__row--selected' : ''}`}
                data-testid={`dialogue-review-row-${d.id}`}
                onClick={() => select({ kind: 'dialogue', id: d.id })}
              >
                <td className="dialogue-review__speaker" data-testid={`dialogue-review-speaker-${d.id}`}>
                  {d.speakerName ?? <em className="dialogue-review__unspecified">(unnamed)</em>}
                </td>
                <td className="dialogue-review__text" data-testid={`dialogue-review-text-${d.id}`}>
                  {d.text}
                </td>
                <td className="dialogue-review__col-length">{String(d.text.length)}</td>
                <td className="dialogue-review__col-id">
                  <code title={d.id}>
                    {displayName(manifest, d.id, showInternalIds)}
                  </code>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {sorted.length === 0 && filter.length > 0 && (
        <p className="dialogue-review__no-match" data-testid="dialogue-review-no-match">
          No matches for "{filter}". Try a different word or clear the filter.
        </p>
      )}
    </div>
  );
}

interface SortButtonProps {
  readonly active: boolean;
  readonly direction: 'asc' | 'desc';
  readonly onClick: () => void;
  readonly testId: string;
  readonly children: React.ReactNode;
}

function SortButton({
  active,
  direction,
  onClick,
  testId,
  children,
}: SortButtonProps): JSX.Element {
  return (
    <button
      type="button"
      className={`dialogue-review__sort-btn${active ? ' dialogue-review__sort-btn--active' : ''}`}
      onClick={onClick}
      data-testid={testId}
    >
      {children}
      {active && (
        <span className="dialogue-review__sort-arrow" aria-hidden="true">
          {direction === 'asc' ? '↑' : '↓'}
        </span>
      )}
    </button>
  );
}
