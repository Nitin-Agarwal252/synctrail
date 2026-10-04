import { Info } from 'lucide-react';

interface ServerResetNoticeProps {
  unsynced: number | null;
  onDismiss: () => void;
}

export const ServerResetNotice: React.FC<ServerResetNoticeProps> = ({ unsynced, onDismiss }) => {
  if (unsynced === null) return null;
  const changes = unsynced === 1 ? '1 unsynced change needs' : `${unsynced} unsynced changes need`;
  return (
    <div className="server-reset-notice" role="status" aria-live="polite" data-testid="server-reset-notice">
      <Info size={16} aria-hidden="true" />
      <span>
        The server was reset. {changes} review.
      </span>
      <button type="button" className="btn btn-secondary" onClick={onDismiss} data-testid="server-reset-dismiss">
        Dismiss
      </button>
    </div>
  );
};
