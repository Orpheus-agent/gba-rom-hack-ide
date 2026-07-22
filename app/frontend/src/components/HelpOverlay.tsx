import { useEffect, useMemo } from 'react';
import { useViewStore } from '../state';
import { getHelpEntry, type HelpEntry } from '../lib/helpContent';
import './HelpOverlay.css';

interface HelpOverlayProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onSelectView?: (view: HelpEntry['view']) => void;
}

export function HelpOverlay({ open, onClose, onSelectView }: HelpOverlayProps) {
  const activeView = useViewStore((s) => s.activeView);
  const entry = useMemo(() => (open ? getHelpEntry(activeView) : null), [open, activeView]);

  // Close on Escape while open.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open || !entry) return null;

  return (
    <div
      className="help-overlay-backdrop"
      role="presentation"
      onClick={onClose}
      data-testid="help-overlay-backdrop"
    >
      <aside
        className="help-overlay"
        role="dialog"
        aria-modal="true"
        aria-labelledby="help-overlay-title"
        data-testid="help-overlay"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="help-overlay__header">
          <div>
            <div className="help-overlay__chip">Explain this screen</div>
            <h2 id="help-overlay-title" className="help-overlay__title">
              {entry.title}
            </h2>
          </div>
          <button
            type="button"
            className="help-overlay__close"
            onClick={onClose}
            aria-label="Close help"
            data-testid="help-overlay-close"
          >
            ×
          </button>
        </header>
        <section className="help-overlay__summary" data-testid="help-overlay-summary">
          {entry.summary}
        </section>
        <section className="help-overlay__section">
          <h3 className="help-overlay__heading">Tips</h3>
          <ul className="help-overlay__list">
            {entry.tips.map((tip, i) => (
              <li key={i} data-testid={`help-overlay-tip-${i}`}>
                {tip}
              </li>
            ))}
          </ul>
        </section>
        {entry.shortcuts && entry.shortcuts.length > 0 && (
          <section className="help-overlay__section" data-testid="help-overlay-shortcuts">
            <h3 className="help-overlay__heading">Keyboard shortcuts</h3>
            <ul className="help-overlay__shortcuts">
              {entry.shortcuts.map((s, i) => (
                <li key={i}>
                  <kbd>{s.keys}</kbd>
                  <span>{s.description}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
        {entry.relatedViews && entry.relatedViews.length > 0 && (
          <section className="help-overlay__section" data-testid="help-overlay-related">
            <h3 className="help-overlay__heading">Related views</h3>
            <ul className="help-overlay__related">
              {entry.relatedViews.map((v) => (
                <li key={v}>
                  <button
                    type="button"
                    onClick={() => {
                      onSelectView?.(v);
                    }}
                    data-testid={`help-overlay-related-${v}`}
                  >
                    {getHelpEntry(v).title}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
        <footer className="help-overlay__footer">
          Press <kbd>?</kbd> anywhere to reopen this drawer; <kbd>Esc</kbd> closes it.
        </footer>
      </aside>
    </div>
  );
}
