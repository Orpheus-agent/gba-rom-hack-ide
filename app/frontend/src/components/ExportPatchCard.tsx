import { useCallback, useState } from 'react';
import {
  generatePatch,
  materializeSharePackage,
  pickFile,
  ProjectApiError,
} from '../api';
import './ExportPatchCard.css';

interface ExportPatchCardProps {
  readonly sessionId: string;
  /** Whether the project is CFRU-modernized. Drives the default patch
   *  format (BPS) and the README CFRU-attribution section. */
  readonly isCfru: boolean;
  /** Sensible default for the hack name (e.g. project folder name). */
  readonly defaultHackName: string;
}

type Stage =
  | { readonly kind: 'idle' }
  | { readonly kind: 'busy'; readonly step: string }
  | { readonly kind: 'success'; readonly outputDir: string }
  | { readonly kind: 'error'; readonly message: string };

/** Modernize-and-Ship slice 8 - "Save patch to disk" card. The user
 *  fills in a hack name + version + optional description, picks their
 *  vanilla FRLG ROM (the diff base), and the editor produces a patch
 *  file + a README the recipient applies to their own legally-owned
 *  copy of FireRed. */
export function ExportPatchCard({
  sessionId,
  isCfru,
  defaultHackName,
}: ExportPatchCardProps) {
  const [hackName, setHackName] = useState(defaultHackName);
  const [version, setVersion] = useState('1.0');
  const [author, setAuthor] = useState('');
  const [description, setDescription] = useState('');
  const [stage, setStage] = useState<Stage>({ kind: 'idle' });

  const sanitizedName = hackName.trim().replace(/[^A-Za-z0-9._-]+/g, '-');
  const patchFormat = isCfru ? 'bps' : 'ips';
  const patchExt = patchFormat;
  const folderName = `${sanitizedName}-${version.trim()}`;
  const patchPath = `share/${folderName}/${sanitizedName}-${version.trim()}.${patchExt}`;

  const onSubmit = useCallback(async () => {
    if (sanitizedName.length === 0) {
      setStage({ kind: 'error', message: 'Please enter a hack name.' });
      return;
    }
    try {
      setStage({ kind: 'busy', step: 'Choose your original FireRed ROM…' });
      const picked = await pickFile('rom-or-archive');
      if (!picked.path) {
        setStage({ kind: 'idle' });
        return;
      }
      const baseRomPath = picked.path;
      setStage({ kind: 'busy', step: 'Building the patch…' });
      const patchResult = await generatePatch(sessionId, {
        baseRomPath,
        // Defaults: the project's ROM is at the project root; the
        // backend's generatePatch resolves relative paths against the
        // project root. We use the standard '*.gba' pattern by passing
        // a known relative name. For simplicity here we let the
        // backend's discovery find it via this conventional name.
        // (The MainPanel currently surfaces only one .gba per project.)
        modifiedRomPath: 'firered.gba',
        outputPath: patchPath,
        patchFormat,
      });
      setStage({ kind: 'busy', step: 'Wrapping the patch with a README…' });
      const share = await materializeSharePackage(sessionId, {
        patchPath: patchResult.outputPath,
        baseRomPath,
        outputDir: `share/${folderName}`,
        meta: {
          modName: hackName.trim(),
          version: version.trim(),
          author: author.trim(),
          description: description.trim(),
        },
      });
      setStage({ kind: 'success', outputDir: share.outputDir });
    } catch (e) {
      const msg =
        e instanceof ProjectApiError
          ? e.message
          : e instanceof Error
            ? e.message
            : 'Something went wrong.';
      setStage({ kind: 'error', message: msg });
    }
  }, [sessionId, sanitizedName, hackName, version, author, description, patchPath, patchFormat]);

  if (stage.kind === 'success') {
    return (
      <div className="export-patch-card export-patch-card--success" data-testid="export-patch-success">
        <p>
          Done. Your patch is in <code>{stage.outputDir}</code>. Send the
          whole folder to your friends - it has the patch file and a
          plain-English README that walks them through applying it to
          their own copy of FireRed.
        </p>
        <button
          type="button"
          className="export-patch-card__secondary"
          onClick={() => setStage({ kind: 'idle' })}
        >
          Save another
        </button>
      </div>
    );
  }

  return (
    <div className="export-patch-card" data-testid="export-patch-card">
      <h2 className="export-patch-card__title">Share your hack as a patch</h2>
      <p className="export-patch-card__body">
        Make a patch file your friends can apply to their own copy of
        Pokémon FireRed. They'll need a clean copy of the original ROM
 - your patch is a list of changes, not the game itself.
      </p>
      <div className="export-patch-card__field">
        <label htmlFor="export-hack-name">Hack name</label>
        <input
          id="export-hack-name"
          type="text"
          value={hackName}
          onChange={(e) => setHackName(e.target.value)}
          disabled={stage.kind === 'busy'}
          data-testid="export-hack-name"
        />
      </div>
      <div className="export-patch-card__field">
        <label htmlFor="export-version">Version</label>
        <input
          id="export-version"
          type="text"
          value={version}
          onChange={(e) => setVersion(e.target.value)}
          disabled={stage.kind === 'busy'}
        />
      </div>
      <div className="export-patch-card__field">
        <label htmlFor="export-author">Your name (optional)</label>
        <input
          id="export-author"
          type="text"
          value={author}
          onChange={(e) => setAuthor(e.target.value)}
          disabled={stage.kind === 'busy'}
        />
      </div>
      <div className="export-patch-card__field">
        <label htmlFor="export-description">Short description (optional)</label>
        <textarea
          id="export-description"
          maxLength={280}
          rows={3}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          disabled={stage.kind === 'busy'}
        />
      </div>
      <div className="export-patch-card__actions">
        <button
          type="button"
          className="export-patch-card__primary"
          onClick={onSubmit}
          disabled={stage.kind === 'busy' || sanitizedName.length === 0}
          data-testid="export-patch-button"
        >
          Save patch to disk…
        </button>
      </div>
      {stage.kind === 'busy' && (
        <div className="export-patch-card__progress" data-testid="export-patch-progress">
          <span className="export-patch-card__spinner" aria-hidden="true" />
          <span>{stage.step}</span>
        </div>
      )}
      {stage.kind === 'error' && (
        <div className="export-patch-card__error" role="alert" data-testid="export-patch-error">
          {stage.message}
        </div>
      )}
    </div>
  );
}
