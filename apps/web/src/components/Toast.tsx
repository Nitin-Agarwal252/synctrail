import { useEffect } from 'react';

interface ToastProps {
  message: string;
  actionText?: string;
  onAction?: () => void;
  onDismiss: () => void;
  durationMs?: number;
}

export const Toast: React.FC<ToastProps> = ({
  message,
  actionText,
  onAction,
  onDismiss,
  durationMs = 8000,
}) => {
  useEffect(() => {
    const timer = setTimeout(() => {
      onDismiss();
    }, durationMs);

    return () => clearTimeout(timer);
  }, [durationMs, onDismiss]);

  return (
    <div className="toast-container" role="status" aria-live="polite">
      <div className="toast" data-testid="toast">
        <span>{message}</span>
        {actionText && onAction && (
          <button
            onClick={() => {
              onAction();
              onDismiss();
            }}
            data-testid="toast-action"
          >
            {actionText}
          </button>
        )}
      </div>
    </div>
  );
};
