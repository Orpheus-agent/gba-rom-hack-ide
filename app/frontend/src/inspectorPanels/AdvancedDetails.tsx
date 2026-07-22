import type { ReactNode } from 'react';

/** Collapsible disclosure for technical / engine-internal fields that
 *  should not pollute the default inspector view. Hex offsets, raw
 *  internal IDs, file-byte positions, struct addresses, palette tag
 *  hashes - they all live here. Closed by default; advanced users
 *  expand on demand. */
export function AdvancedDetails({
  children,
  label = 'Technical details',
  testId,
}: {
  readonly children: ReactNode;
  readonly label?: string;
  readonly testId?: string;
}): JSX.Element {
  return (
    <details className="entity-inspector__advanced" data-testid={testId}>
      <summary className="entity-inspector__advanced-summary">{label}</summary>
      <div className="entity-inspector__advanced-body">{children}</div>
    </details>
  );
}

/** Single key/value row in the AdvancedDetails body. Renders the value
 *  in a monospace font with a dim label, suitable for the offsets
 *  / IDs / engine values that AdvancedDetails contains. */
export function AdvancedField({
  label,
  value,
  mono = true,
}: {
  readonly label: string;
  readonly value: ReactNode;
  readonly mono?: boolean;
}): JSX.Element {
  return (
    <div className="entity-inspector__advanced-row">
      <span className="entity-inspector__advanced-row-label">{label}</span>
      <span
        className={
          mono
            ? 'entity-inspector__advanced-row-value entity-inspector__advanced-row-value--mono'
            : 'entity-inspector__advanced-row-value'
        }
      >
        {value}
      </span>
    </div>
  );
}

/** Render a 32-bit byte offset / ROM address as the hex string operators
 *  recognize (e.g. `0x16582f`). Negative or NaN values render as ` - `. */
export function formatHex(value: number | null | undefined, padTo = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return ' - ';
  const hex = value.toString(16);
  const padded = padTo > 0 ? hex.padStart(padTo, '0') : hex;
  return `0x${padded}`;
}
