import { Check, WifiOff, Clock, ChevronDown, User, RefreshCw, AlertCircle, AlertTriangle, BarChart2, Zap } from 'lucide-react';
import { SyncState } from '../sync/engine';

type Route = 'records' | 'conflicts' | 'dashboard' | 'chaos';

interface AppHeaderProps {
  outboxCount: number;
  conflictCount: number;
  currentUserId: string;
  syncState: SyncState;
  retryCountdown: number;
  lastSyncedAt: string | null;
  activeTab: 'records' | 'conflicts';
  activeRoute?: Route;
  onSelectTab: (tab: 'records' | 'conflicts') => void;
  onNavigate?: (route: Route) => void;
  onSwitchUser: (userId: string) => void;
  onTriggerSync?: () => void;
  onOpenSyncPreview?: () => void;
}

export const AppHeader = ({
  outboxCount,
  conflictCount,
  currentUserId,
  syncState,
  retryCountdown,
  lastSyncedAt,
  activeTab,
  activeRoute,
  onSelectTab,
  onNavigate,
  onSwitchUser,
  onTriggerSync,
  onOpenSyncPreview,
}: AppHeaderProps) => {
  let formattedLastSynced = '';
  if (lastSyncedAt) {
    try {
      const d = new Date(lastSyncedAt);
      formattedLastSynced = `Last synced ${String(d.getHours()).padStart(2, '0')}:${String(
        d.getMinutes()
      ).padStart(2, '0')}`;
    } catch {
      // Ignore formatting error
    }
  }

  return (
    <header className="top-bar">
      <div className="top-bar-left">
        <h1 className="app-title">SyncTrail · Survey</h1>
        <nav className="top-nav-tabs" aria-label="Main Navigation">
          <button
            className={`nav-tab-btn ${activeTab === 'records' ? 'nav-tab-btn-active' : ''}`}
            onClick={() => onSelectTab('records')}
            data-testid="nav-tab-records"
          >
            Records
          </button>
          <button
            className={`nav-tab-btn ${activeTab === 'conflicts' ? 'nav-tab-btn-active' : ''}`}
            onClick={() => onSelectTab('conflicts')}
            data-testid="nav-tab-conflicts"
          >
            Conflicts {conflictCount > 0 ? `(${conflictCount})` : ''}
          </button>
          {onNavigate && (
            <>
              <button
                className={`nav-tab-btn ${activeRoute === 'dashboard' ? 'nav-tab-btn-active' : ''}`}
                onClick={() => onNavigate('dashboard')}
                data-testid="nav-tab-dashboard"
                title="Supervisor dashboard"
              >
                <BarChart2 size={13} aria-hidden="true" style={{ marginRight: '3px' }} />
                Dashboard
              </button>
              <button
                className={`nav-tab-btn ${activeRoute === 'chaos' ? 'nav-tab-btn-active' : ''}`}
                onClick={() => onNavigate('chaos')}
                data-testid="nav-tab-chaos"
                title="Chaos Mode (for judges)"
              >
                <Zap size={13} aria-hidden="true" style={{ marginRight: '3px' }} />
                Chaos
              </button>
            </>
          )}
        </nav>
        <div className="top-bar-indicators" role="status" aria-live="polite">
          {/* Connection / Sync Pill */}
          {syncState === 'synced' && (
            <span
              className="badge badge-synced"
              title={formattedLastSynced || 'Connected and synced'}
              data-testid="connection-pill"
            >
              <Check size={14} aria-hidden="true" />
              <span>Synced</span>
            </span>
          )}

          {syncState === 'syncing' && (
            <span
              className="badge badge-syncing"
              title="Syncing changes with server"
              data-testid="connection-pill"
            >
              <RefreshCw size={14} className="spin-icon" aria-hidden="true" />
              <span>Syncing…</span>
            </span>
          )}

          {syncState === 'offline' && (
            <span
              className="badge badge-pending"
              title="Offline: Changes are saved locally"
              data-testid="connection-pill"
            >
              <WifiOff size={14} aria-hidden="true" />
              <span>Offline · saved on this device</span>
            </span>
          )}

          {syncState === 'retrying' && (
            <span
              className="badge badge-conflict"
              title={`Connection failed. Retrying in ${retryCountdown}s`}
              data-testid="connection-pill"
            >
              <AlertCircle size={14} aria-hidden="true" />
              <span>Retrying in {retryCountdown}s</span>
            </span>
          )}

          {/* Outbox Counter */}
          {outboxCount > 0 && (
            <button
              className="badge badge-pending"
              onClick={onOpenSyncPreview || onTriggerSync}
              title={`${outboxCount} changes waiting to sync`}
              style={{ cursor: 'pointer', border: 'none' }}
              data-testid="outbox-counter"
            >
              <Clock size={14} aria-hidden="true" />
              <span>{outboxCount} waiting</span>
            </button>
          )}

          {/* Needs a decision Badge */}
          {conflictCount > 0 && (
            <button
              className="badge badge-conflict"
              onClick={() => onSelectTab('conflicts')}
              title={`${conflictCount} conflicts need a decision. Click to review.`}
              style={{ cursor: 'pointer', border: 'none' }}
              data-testid="conflict-decision-badge"
            >
              <AlertTriangle size={14} aria-hidden="true" />
              <span>{conflictCount} need a decision</span>
            </button>
          )}

          {/* Sync Button */}
          <button
            className="btn btn-secondary"
            style={{ minHeight: '32px', padding: '4px 10px', fontSize: '13px' }}
            onClick={onTriggerSync || onOpenSyncPreview}
            data-testid="sync-button"
            title="Trigger sync now"
          >
            <span>Sync</span>
            <ChevronDown size={14} aria-hidden="true" />
          </button>
        </div>
      </div>

      <div className="top-bar-right">
        {/* User Switcher */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <User size={16} aria-hidden="true" style={{ color: 'var(--text-muted)' }} />
          <select
            value={currentUserId}
            onChange={(e) => onSwitchUser(e.target.value)}
            className="form-control"
            style={{
              minHeight: '36px',
              padding: '4px 8px',
              fontSize: '13px',
              width: 'auto',
              fontWeight: 500,
            }}
            aria-label="Current field worker"
            data-testid="user-switcher"
          >
            <option value="Meera">Meera</option>
            <option value="Dev">Dev</option>
            <option value="Arjun">Arjun</option>
          </select>
        </div>
      </div>
    </header>
  );
};
