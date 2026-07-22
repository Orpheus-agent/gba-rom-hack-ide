import { useCallback, type KeyboardEvent } from 'react';

/**
 * Phase O.27 - keyboard ergonomics for inline editors.
 *
 * Wraps a form's save / cancel handlers in keyboard shortcuts:
 *   - Enter in any text/number input → save (when canSave)
 *   - Ctrl+Enter / Cmd+Enter in a textarea → save (plain Enter inserts a newline)
 *   - Escape anywhere → cancel
 *
 * Usage:
 *   const onKeyDown = useEditFormKeyboard({ canSave: dirty && valid, save, cancel });
 *   <div onKeyDown={onKeyDown}>{...inputs + buttons}</div>
 *
 * The handler reads e.target.tagName to decide whether Enter or
 * Ctrl+Enter should fire save. This means the wrapper element must
 * be the closest scope around the inputs - typically the form's
 * outer div.
 */
export interface UseEditFormKeyboardArgs {
  readonly canSave: boolean;
  readonly save: () => void | Promise<void>;
  /** Optional cancel handler. When omitted, Escape is a no-op. */
  readonly cancel?: () => void;
  /** When true, Enter/Ctrl+Enter are no-ops (prevents double-submit). */
  readonly isSaving?: boolean;
}

export function useEditFormKeyboard(
  args: UseEditFormKeyboardArgs,
): (e: KeyboardEvent<HTMLElement>) => void {
  const { canSave, save, cancel, isSaving } = args;
  return useCallback(
    (e: KeyboardEvent<HTMLElement>) => {
      // Escape - always cancel (regardless of canSave).
      if (e.key === 'Escape') {
        if (cancel) {
          e.preventDefault();
          cancel();
        }
        return;
      }
      // Enter - save.
      if (e.key === 'Enter') {
        const target = e.target as HTMLElement | null;
        const tag = target?.tagName ?? '';
        // Textarea: only Ctrl+Enter / Cmd+Enter (plain Enter = newline).
        if (tag === 'TEXTAREA' && !(e.ctrlKey || e.metaKey)) {
          return;
        }
        // Skip when modifiers like Shift+Enter or Alt+Enter are pressed
        // and we're NOT in a textarea - those are typically used for
        // multi-line or special-char input in some browsers.
        if (tag !== 'TEXTAREA' && e.shiftKey) {
          return;
        }
        // <select> Enter usually opens/picks an option - leave native.
        if (tag === 'SELECT') {
          return;
        }
        if (canSave && !isSaving) {
          e.preventDefault();
          void save();
        }
      }
    },
    [canSave, save, cancel, isSaving],
  );
}
