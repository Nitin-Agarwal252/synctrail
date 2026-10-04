import { Check, Clock, RefreshCw, AlertTriangle, AlertCircle } from 'lucide-react';

export type BadgeStatus = 'synced' | 'pending' | 'syncing' | 'conflict' | 'failed' | 'local-only';

interface BadgeProps {
  status: BadgeStatus;
  label?: string;
  tooltip?: string;
  className?: string;
}

export const Badge: React.FC<BadgeProps> = ({ status, label, tooltip, className = '' }) => {
  let icon = <Check size={14} aria-hidden="true" />;
  let defaultLabel = 'Synced';
  let badgeClass = 'badge-synced';

  switch (status) {
    case 'synced':
      icon = <Check size={14} aria-hidden="true" />;
      defaultLabel = 'Synced';
      badgeClass = 'badge-synced';
      break;
    case 'pending':
      icon = <Clock size={14} aria-hidden="true" />;
      defaultLabel = 'Pending';
      badgeClass = 'badge-pending';
      break;
    case 'syncing':
      icon = <RefreshCw size={14} className="spin-icon" aria-hidden="true" />;
      defaultLabel = 'Syncing…';
      badgeClass = 'badge-syncing';
      break;
    case 'conflict':
      icon = <AlertTriangle size={14} aria-hidden="true" />;
      defaultLabel = 'Conflict';
      badgeClass = 'badge-conflict';
      break;
    case 'failed':
      icon = <AlertCircle size={14} aria-hidden="true" />;
      defaultLabel = 'Failed';
      badgeClass = 'badge-failed';
      break;
    case 'local-only':
      icon = <Clock size={14} aria-hidden="true" />;
      defaultLabel = 'Local only';
      badgeClass = 'badge-local-only';
      break;
  }

  const displayText = label || defaultLabel;

  return (
    <span
      className={`badge ${badgeClass} ${className}`}
      title={tooltip}
      role="status"
      aria-label={displayText}
    >
      {icon}
      <span>{displayText}</span>
    </span>
  );
};
