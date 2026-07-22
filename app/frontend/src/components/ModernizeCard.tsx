import { useCallback, useState } from 'react';
import { modernizeRom, ProjectApiError } from '../api';
import { AttributionPanel } from './AttributionPanel';
import './ModernizeCard.css';

interface ModernizeCardProps {
  readonly sessionId: string;
  /** Called after the modernize POST returns successfully. The
   *  caller (MainPanel) re-scans the project, which makes the card
   *  unmount because `identity.upgradeOffer` flips. */
  readonly onSuccess: () => void | Promise<void>;
}

type Stage =
  | { readonly kind: 'idle' }
  | { readonly kind: 'confirming' }
  | { readonly kind: 'upgrading' }
  | { readonly kind: 'success'; readonly cfruVersion: string }
  | { readonly kind: 'error'; readonly code: string; readonly message: string };

const PLAIN_ENGLISH_ERRORS: Record<string, string> = {
  rom_hash_mismatch:
    "Modernize only works on the original Pokémon FireRed (version 1.0, USA). Your ROM doesn't match - please open a clean copy. A 'clean' ROM is one you haven't applied any patches to yet.",
  already_modernized: 'This ROM has already been modernized. No changes were made.',
  patch_artifact_missing:
    "The upgrade files aren't installed with this build of the editor. Reinstall or rebuild from source.",
  patch_verification_failed:
    'The upgrade file is corrupted. Reinstall the editor or rebuild the bundle from a fresh CFRU clone.',
  apply_failed: "Couldn't apply the upgrade - see details below.",
  write_failed: "Couldn't write the upgraded ROM to disk - see details below.",
};

/** What CFRU adds - surfaced in the "What this adds" collapsible
 *  panel. Lifted verbatim (in plain English, no jargon) from CFRU's
 *  README Features list, condensed to the highest-impact bullets. */
const FEATURE_BULLETS: ReadonlyArray<string> = [
  'Battle engine through Generation 8 - new abilities, moves, items, and AI.',
  '800+ Pokémon available, including the Fairy type.',
  'Mega Evolution, Z-Moves, and Primal Reversion.',
  'Day/night/seasons system.',
  'Updated TM/HM, repel, daycare, and field-move systems.',
  'Expanded text, PC boxes, and party tools.',
];

/** Modernize-and-Ship slice 6 - the "Modernize" call-to-action that
 *  surfaces inside the IdentityCard when the editor detects a vanilla
 *  FRLG ROM. Plain English everywhere user-visible; no "BPS" / "CFRU"
 *  surfaced in the primary flow (those live in the AttributionPanel
 *  reached via the "Who made this upgrade?" secondary link). */
export function ModernizeCard({ sessionId, onSuccess }: ModernizeCardProps) {
  const [stage, setStage] = useState<Stage>({ kind: 'idle' });

  const beginConfirm = useCallback(() => setStage({ kind: 'confirming' }), []);
  const cancel = useCallback(() => setStage({ kind: 'idle' }), []);

  const runModernize = useCallback(async () => {
    setStage({ kind: 'upgrading' });
    try {
      const result = await modernizeRom(sessionId);
      setStage({ kind: 'success', cfruVersion: result.cfruVersion });
      await onSuccess();
    } catch (e) {
      if (e instanceof ProjectApiError) {
        // Backend codes come through as "code: message" - strip the
        // prefix when present and use the plain-English mapping above.
        const match = e.message.match(/^([a-z_]+):\s*(.*)$/);
        const code = match ? match[1]! : e.code;
        const detail = match ? match[2]! : e.message;
        setStage({
          kind: 'error',
          code,
          message: PLAIN_ENGLISH_ERRORS[code] ?? detail,
        });
      } else {
        setStage({
          kind: 'error',
          code: 'unknown',
          message: e instanceof Error ? e.message : 'Something went wrong.',
        });
      }
    }
  }, [sessionId, onSuccess]);

  if (stage.kind === 'success') {
    return (
      <div className="modernize-card modernize-card--success" data-testid="modernize-card-success">
        <p>
          Done. Your ROM is now upgraded. You can edit anything - Pokémon
          stats, abilities, dialogue, maps - and the editor will save a
          sharable patch when you're ready.
        </p>
      </div>
    );
  }

  return (
    <div className="modernize-card" data-testid="modernize-card">
      <h2 className="modernize-card__title">Modernize this Pokémon FireRed ROM</h2>
      <p className="modernize-card__body">
        This is the original Pokémon FireRed. The editor can apply a
        one-time upgrade that adds modern features - Generations 2
        through 8 Pokémon, abilities, items, moves, the Fairy type,
        expanded text, mega evolution, Z-moves, and 600+ more battle
        mechanics. Once upgraded, you can keep editing the same ROM,
        and your finished hack will be a patch you can share - your
        friends apply it to their own copy of FireRed.
      </p>
      <details className="modernize-card__details">
        <summary>What this adds</summary>
        <ul className="modernize-card__feature-list">
          {FEATURE_BULLETS.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      </details>
      <AttributionPanel sessionId={sessionId} variant="inline" />

      {stage.kind === 'idle' && (
        <div className="modernize-card__actions">
          <button
            type="button"
            className="modernize-card__primary"
            onClick={beginConfirm}
            data-testid="modernize-card-button"
          >
            Modernize
          </button>
        </div>
      )}

      {stage.kind === 'confirming' && (
        <div
          className="modernize-card__confirm"
          role="dialog"
          aria-labelledby="modernize-confirm-title"
          data-testid="modernize-card-confirm"
        >
          <h3 id="modernize-confirm-title">Upgrade your FireRed ROM?</h3>
          <p>
            This will rewrite your ROM file in place to add modern
            features. The editor saves a backup of the original first - 
            you can undo this from the History panel if you change your
            mind.
          </p>
          <div className="modernize-card__actions">
            <button
              type="button"
              className="modernize-card__primary"
              onClick={runModernize}
              data-testid="modernize-card-confirm-button"
            >
              Upgrade
            </button>
            <button
              type="button"
              className="modernize-card__secondary"
              onClick={cancel}
              data-testid="modernize-card-cancel-button"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {stage.kind === 'upgrading' && (
        <div className="modernize-card__progress" data-testid="modernize-card-progress">
          <span className="modernize-card__spinner" aria-hidden="true" />
          <span>Upgrading your ROM…</span>
        </div>
      )}

      {stage.kind === 'error' && (
        <div
          className="modernize-card__error"
          role="alert"
          data-testid="modernize-card-error"
        >
          <p>{stage.message}</p>
          <div className="modernize-card__actions">
            <button
              type="button"
              className="modernize-card__secondary"
              onClick={() => setStage({ kind: 'idle' })}
            >
              Try again
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
