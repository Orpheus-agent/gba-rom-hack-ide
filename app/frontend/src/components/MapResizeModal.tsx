import { useEffect, useState } from 'react';
import type { MapNode } from '@rom-editor/shared';
import { editBinaryRomMapDimensions, ProjectApiError } from '../api';
import { pushToast, useProjectStore } from '../state';
import './MapResizeModal.css';

const MAP_MAX_DIMENSION = 256;

interface MapResizeModalProps {
  readonly map: MapNode;
  readonly onClose: () => void;
}

export function MapResizeModal({ map, onClose }: MapResizeModalProps): JSX.Element | null {
  const sessionId = useProjectStore((s) =>
    s.load.kind === 'loaded' ? s.load.data.session.id : null,
  );
  const scanCurrent = useProjectStore((s) => s.scanCurrentProject);

  const layoutFileOffset =
    typeof map.metadata['binaryRomLayoutOffset'] === 'number'
      ? (map.metadata['binaryRomLayoutOffset'] as number)
      : -1;
  const currentWidth =
    typeof map.metadata['binaryRomMapWidth'] === 'number'
      ? (map.metadata['binaryRomMapWidth'] as number)
      : map.dimensions.width;
  const currentHeight =
    typeof map.metadata['binaryRomMapHeight'] === 'number'
      ? (map.metadata['binaryRomMapHeight'] as number)
      : map.dimensions.height;

  const [width, setWidth] = useState(currentWidth);
  const [height, setHeight] = useState(currentHeight);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (layoutFileOffset <= 0) {
    return (
      <div className="map-resize-modal__backdrop" onClick={onClose}>
        <div
          className="map-resize-modal"
          role="dialog"
          aria-label="Resize map"
          onClick={(e) => e.stopPropagation()}
          data-testid="map-resize-modal"
        >
          <h2 className="map-resize-modal__title">Resize map</h2>
          <p className="map-resize-modal__body">
            This map's layout offset isn't in the scanned metadata, so it
            can't be resized in this session. Re-scan the project and try
            again.
          </p>
          <button
            type="button"
            className="btn btn--secondary"
            onClick={onClose}
            data-testid="map-resize-modal-close"
          >
            Close
          </button>
        </div>
      </div>
    );
  }

  const dirty = width !== currentWidth || height !== currentHeight;
  const valid =
    width >= 1 &&
    height >= 1 &&
    width <= MAP_MAX_DIMENSION &&
    height <= MAP_MAX_DIMENSION;
  const isGrow = width * height > currentWidth * currentHeight;
  const canSave = dirty && valid && sessionId !== null && !saving;

  async function save(): Promise<void> {
    if (!sessionId) return;
    setSaving(true);
    try {
      await editBinaryRomMapDimensions(sessionId, {
        layoutFileOffset,
        currentWidth,
        currentHeight,
        newWidth: width,
        newHeight: height,
      });
      pushToast(
        'success',
        `Map resized to ${width} × ${height}${isGrow ? ' (buffer relocated)' : ''}`,
      );
      await scanCurrent();
      onClose();
    } catch (err) {
      const msg =
        err instanceof ProjectApiError
          ? `${err.code}: ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err);
      pushToast('error', `Resize failed: ${msg}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="map-resize-modal__backdrop" onClick={onClose}>
      <div
        className="map-resize-modal"
        role="dialog"
        aria-label="Resize map"
        onClick={(e) => e.stopPropagation()}
        data-testid="map-resize-modal"
      >
        <h2 className="map-resize-modal__title">Resize map</h2>
        <p className="map-resize-modal__sub">
          Currently {currentWidth} × {currentHeight} tiles.
          {isGrow && dirty && ' Growing will allocate a new buffer in free ROM space.'}
        </p>

        <div className="map-resize-modal__fields">
          <label className="map-resize-modal__field">
            <span>Width</span>
            <input
              type="number"
              min={1}
              max={MAP_MAX_DIMENSION}
              value={width}
              data-testid="map-resize-modal-width"
              onChange={(e) => {
                const n = Number.parseInt(e.target.value, 10);
                if (Number.isFinite(n)) setWidth(Math.max(1, Math.min(MAP_MAX_DIMENSION, n)));
              }}
            />
          </label>
          <label className="map-resize-modal__field">
            <span>Height</span>
            <input
              type="number"
              min={1}
              max={MAP_MAX_DIMENSION}
              value={height}
              data-testid="map-resize-modal-height"
              onChange={(e) => {
                const n = Number.parseInt(e.target.value, 10);
                if (Number.isFinite(n)) setHeight(Math.max(1, Math.min(MAP_MAX_DIMENSION, n)));
              }}
            />
          </label>
        </div>

        <div className="map-resize-modal__actions">
          <button
            type="button"
            className="btn btn--primary"
            disabled={!canSave}
            onClick={save}
            data-testid="map-resize-modal-apply"
          >
            {saving ? 'Resizing…' : 'Apply'}
          </button>
          <button
            type="button"
            className="btn btn--secondary"
            onClick={onClose}
            disabled={saving}
            data-testid="map-resize-modal-cancel"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
