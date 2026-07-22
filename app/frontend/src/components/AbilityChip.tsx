/**
 * Phase 4.3E - Ability chip.
 *
 * Small chip that surfaces a species's ability name. Two-color
 * palette: regular abilities use a neutral teal; "hidden" abilities
 * (in CFRU's hidden-ability slot) use a slightly deeper magenta.
 *
 * Resolves the ability name via manifest.abilities. Falls back to
 * "Ability #N" when the lifter hasn't populated the manifest.
 */

import type { ProjectManifest } from '@rom-editor/shared';
import './AbilityChip.css';

export interface AbilityChipProps {
  readonly abilityId: number;
  readonly manifest: ProjectManifest;
  /** True for the hidden-ability slot - renders in a different color. */
  readonly hidden?: boolean;
  readonly compact?: boolean;
  readonly testIdPrefix?: string;
}

export function AbilityChip({
  abilityId,
  manifest,
  hidden = false,
  compact = false,
  testIdPrefix,
}: AbilityChipProps): JSX.Element | null {
  // Skip ability id 0 (NONE) - rendering an empty "Ability 0" chip is noise.
  if (abilityId === 0) return null;

  const entry = manifest.abilities?.find((a) => a.abilityIndex === abilityId);
  const label = entry?.name ?? `Ability #${String(abilityId)}`;
  return (
    <span
      className={
        'ability-chip' +
        (hidden ? ' ability-chip--hidden' : '') +
        (compact ? ' ability-chip--compact' : '')
      }
      title={hidden ? `Hidden ability: ${label}` : `Ability: ${label}`}
      data-testid={testIdPrefix ? `${testIdPrefix}-${String(abilityId)}` : `ability-chip-${String(abilityId)}`}
    >
      {hidden && '✨ '}
      {label}
    </span>
  );
}
