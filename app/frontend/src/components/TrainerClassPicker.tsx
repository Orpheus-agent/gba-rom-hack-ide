/**
 * Phase 4.3C - Trainer class picker.
 *
 * Autocompletes by class name (Youngster, Lass, Gym Leader, …) from
 * manifest.trainerClassNames. Currently a thin wrapper around the
 * generic EntityPicker - kept as its own component so we have a
 * stable insertion point for future class-specific UI (preview the
 * class's intro text, prize-money rate, etc.) without forcing the
 * upgrade across every EntityPicker caller.
 */

import { EntityPicker } from './EntityPicker';
import type { ProjectManifest } from '@rom-editor/shared';

export interface TrainerClassPickerProps {
  readonly manifest: ProjectManifest;
  readonly value: number;
  readonly onChange: (next: number) => void;
  readonly disabled?: boolean;
  readonly testIdPrefix?: string;
}

export function TrainerClassPicker({
  manifest,
  value,
  onChange,
  disabled = false,
  testIdPrefix,
}: TrainerClassPickerProps): JSX.Element {
  return (
    <EntityPicker
      kind="trainerClass"
      manifest={manifest}
      value={value}
      onChange={onChange}
      minId={0}
      maxId={255}
      testIdPrefix={testIdPrefix ?? 'trainer-class-picker'}
      disabled={disabled}
    />
  );
}
