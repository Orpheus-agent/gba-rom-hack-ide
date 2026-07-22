import { useCallback, useEffect, useState } from 'react';
import { useProjectStore } from '../state';
import { ModernizeCard } from './ModernizeCard';
import './ModernizeButton.css';

/** Modernize-and-Ship slice 6 (UX hoist) - the titlebar button that
 *  surfaces the one-click CFRU upgrade. Renders nothing unless the
 *  loaded project's ProjectIdentity carries
 *  `upgradeOffer === 'vanilla-frlg-rev0'` (set by the detector when
 *  the ROM is the canonical vanilla FRLG USA rev 0 baseline).
 *
 *  Clicking opens an overlay containing the existing ModernizeCard
 *  flow (pitch → confirm → progress → success/error). On success the
 *  modal auto-dismisses and the project re-scans so the IdentityCard
 *  flips to 'FireRed (Modernized)' + the AttributionPanel + the
 *  ExportPatchCard light up.
 *
 *  Lives next to the "Open ROM" button in EditorShell's titlebar - 
 *  the most discoverable place for an action that's the user's
 *  first move on a vanilla ROM. */
export function ModernizeButton() {
  const load = useProjectStore((s) => s.load);
  const scanCurrent = useProjectStore((s) => s.scanCurrentProject);
  const [open, setOpen] = useState(false);

  const onOpen = useCallback(() => setOpen(true), []);
  const onClose = useCallback(() => setOpen(false), []);
  const onSuccess = useCallback(async () => {
    await scanCurrent();
    // Tiny pause so the user sees the in-card success message before
    // the modal disappears. 1.5s feels right - long enough to read,
    // short enough that nobody minds.
    setTimeout(() => setOpen(false), 1500);
  }, [scanCurrent]);

  // Esc closes the modal - standard modal contract.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (load.kind !== 'loaded') return null;
  if (load.data.identity.upgradeOffer !== 'vanilla-frlg-rev0') return null;

  const sessionId = load.data.session.id;

  return (
    <>
      <button
        type="button"
        className="modernize-button"
        onClick={onOpen}
        title="Add modern features to this Pokémon FireRed ROM"
        aria-label="Modernize this Pokémon FireRed ROM"
        data-testid="titlebar-modernize-button"
      >
        <span aria-hidden>✨</span>
        <span className="modernize-button__label">Modernize</span>
      </button>
      {open && (
        <div
          className="modernize-button__overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="modernize-modal-title"
          onClick={(e) => {
            // Click on the backdrop (not on the modal body) closes.
            if (e.target === e.currentTarget) setOpen(false);
          }}
          data-testid="modernize-modal"
        >
          <div className="modernize-button__modal">
            <button
              type="button"
              className="modernize-button__close"
              onClick={onClose}
              title="Close (Esc)"
              aria-label="Close"
              data-testid="modernize-modal-close"
            >
              ×
            </button>
            <h1 id="modernize-modal-title" className="modernize-button__modal-heading">
              Modernize
            </h1>
            <ModernizeCard sessionId={sessionId} onSuccess={onSuccess} />
          </div>
        </div>
      )}
    </>
  );
}
