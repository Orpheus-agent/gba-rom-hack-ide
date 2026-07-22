import { useToastStore, type ToastKind } from '../state';
import './Toast.css';

function iconFor(kind: ToastKind): string {
  switch (kind) {
    case 'success':
      return '✓';
    case 'error':
      return '✗';
    case 'info':
      return 'i';
  }
}

export function ToastContainer() {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);

  if (toasts.length === 0) return null;

  return (
    <div className="toast-container" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast--${t.kind}`} data-testid={`toast-${t.kind}`}>
          <span className={`toast__icon toast__icon--${t.kind}`} aria-hidden="true">
            {iconFor(t.kind)}
          </span>
          <span className="toast__message">{t.message}</span>
          <button
            type="button"
            className="toast__close"
            onClick={() => dismiss(t.id)}
            aria-label="Dismiss notification"
          >
            {'×'}
          </button>
        </div>
      ))}
    </div>
  );
}
