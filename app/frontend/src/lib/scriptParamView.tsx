import type { ProjectManifest } from '@rom-editor/shared';
import { displayName } from './displayName';

interface ScriptParamValueProps {
  readonly value: unknown;
  readonly manifest: ProjectManifest;
  readonly showInternalIds: boolean;
  readonly nestKey?: string;
}

/**
 * Render a script-step parameter in plain English instead of via
 * `JSON.stringify`. The previous render path showed object literals like
 * `{textId: "binary_text_dialogue_0x1a8d0", duration: 30}` which leaks
 * both raw synthetic ids and JSON syntax to the operator.
 *
 * Resolution rules:
 *   - **String**: pass through `displayName()`. If the string is a known
 *     synthetic id (`species_25`, `flag_0x800`, `binary_map_1_4`, etc.)
 *     it becomes the resolved name; otherwise it renders as-is.
 *   - **Number**: render the numeric literal. Numbers can't be
 *     resolved without knowing the key context (e.g. is `5` a flag id
 *     or a level?) so we trust the caller's key to communicate that.
 *   - **Boolean**: render "Yes"/"No".
 *   - **Object**: render as a `<dl>` of key/value pairs, recursing.
 *   - **Array**: render as a comma-separated inline list, recursing.
 *   - **null / undefined**: render an em-dash.
 *
 * Used by EventsView's SelectedStepInspector, TemplatesView's
 * materialization preview, and TimelineView's mutation payload renderer.
 */
export function ScriptParamValue({
  value,
  manifest,
  showInternalIds,
  nestKey,
}: ScriptParamValueProps) {
  if (value === null || value === undefined) {
    return <span className="script-param-value script-param-value--null"> - </span>;
  }
  if (typeof value === 'boolean') {
    return <span className="script-param-value">{value ? 'Yes' : 'No'}</span>;
  }
  if (typeof value === 'string') {
    return (
      <span className="script-param-value">{displayName(manifest, value, showInternalIds)}</span>
    );
  }
  if (typeof value === 'number') {
    return <span className="script-param-value">{value}</span>;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return <span className="script-param-value script-param-value--null">(empty)</span>;
    }
    return (
      <span className="script-param-value">
        [
        {value.map((v, i) => (
          <span key={i}>
            {i > 0 && ', '}
            <ScriptParamValue
              value={v}
              manifest={manifest}
              showInternalIds={showInternalIds}
              nestKey={`${nestKey ?? ''}[${i}]`}
            />
          </span>
        ))}
        ]
      </span>
    );
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) {
      return <span className="script-param-value script-param-value--null">(empty)</span>;
    }
    return (
      <dl className="script-param-value script-param-value--object">
        {entries.map(([k, v]) => (
          <span key={k} style={{ display: 'contents' }}>
            <dt>{k}</dt>
            <dd>
              <ScriptParamValue
                value={v}
                manifest={manifest}
                showInternalIds={showInternalIds}
                nestKey={`${nestKey ?? ''}.${k}`}
              />
            </dd>
          </span>
        ))}
      </dl>
    );
  }
  // Fallthrough for unexpected types (functions, symbols, etc.) - should
  // never occur in script-step params but render something honest.
  return <span className="script-param-value">{String(value)}</span>;
}
