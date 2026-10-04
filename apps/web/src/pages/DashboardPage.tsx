import { useState, useEffect } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db';
import { Users, Clock, AlertTriangle, CheckCircle, RefreshCw, Activity } from 'lucide-react';
import type { AuditEntry } from '@synctrail/shared';

interface ServerStats {
  records: number;
  ops: number;
  openConflicts: number;
  lastSeq: number;
}

interface AuditResponse {
  entries: AuditEntry[];
}

function formatHlcTime(hlcStr: string): string {
  try {
    // HLC format: ISO-timestamp-counter-deviceId
    // The date part is the first 24 characters
    const isoDate = hlcStr.slice(0, 24);
    const d = new Date(isoDate);
    if (!isNaN(d.getTime())) {
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
    }
  } catch {
    // Ignore parse errors
  }
  return hlcStr.slice(0, 20);
}

function auditKindLabel(kind: AuditEntry['kind']): string {
  switch (kind) {
    case 'op-applied':    return 'Op applied';
    case 'op-noop':       return 'No-op (duplicate or identical)';
    case 'conflict-opened':  return 'Conflict opened';
    case 'conflict-resolved': return 'Conflict resolved';
    default:              return kind;
  }
}

function auditKindIcon(kind: AuditEntry['kind']): string {
  switch (kind) {
    case 'op-applied':    return '✓';
    case 'op-noop':       return '≡';
    case 'conflict-opened':  return '⚠';
    case 'conflict-resolved': return '✔';
    default:              return '·';
  }
}

export function DashboardPage() {
  const [stats, setStats] = useState<ServerStats | null>(null);
  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([]);
  const [filterRecordId, setFilterRecordId] = useState('');
  const [loading, setLoading] = useState(true);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  // Local stats from Dexie (offline-capable)
  const localData = useLiveQuery(async () => {
    const [outboxCount, conflictCount] = await Promise.all([
      db.outbox.count(),
      db.conflicts.where('status').equals('open').count(),
    ]);
    const lastSyncedAt = await db.getMeta('lastSyncedAt');
    return { outboxCount, conflictCount, lastSyncedAt };
  }, []);

  const fetchServerData = async () => {
    setLoading(true);
    try {
      const [statsRes, auditRes] = await Promise.all([
        fetch('/api/stats'),
        fetch(`/api/audit?limit=100${filterRecordId ? `&recordId=${encodeURIComponent(filterRecordId)}` : ''}`),
      ]);
      if (statsRes.ok) {
        setStats(await statsRes.json());
      }
      if (auditRes.ok) {
        const data: AuditResponse = await auditRes.json();
        setAuditEntries(data.entries);
      }
    } catch {
      // Offline — show local data only
    } finally {
      setLoading(false);
      setLastRefresh(new Date());
    }
  };

  useEffect(() => {
    fetchServerData();
    // Auto-refresh every 10s
    const interval = setInterval(fetchServerData, 10000);
    return () => clearInterval(interval);
  }, [filterRecordId]); // fetchServerData is stable within the effect closure

  const localSynced = localData?.lastSyncedAt
    ? (() => {
        const d = new Date(localData.lastSyncedAt);
        return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      })()
    : 'Never';

  return (
    <div className="dashboard-page" data-testid="dashboard-page">
      {/* Header */}
      <div className="dashboard-header">
        <h2 className="dashboard-title">Dashboard</h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          {lastRefresh && (
            <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
              Refreshed {String(lastRefresh.getHours()).padStart(2, '0')}:{String(lastRefresh.getMinutes()).padStart(2, '0')}:{String(lastRefresh.getSeconds()).padStart(2, '0')}
            </span>
          )}
          <button
            className="btn btn-secondary"
            onClick={fetchServerData}
            disabled={loading}
            data-testid="dashboard-refresh-btn"
            style={{ minHeight: '32px', padding: '4px 10px', fontSize: '13px' }}
          >
            {loading ? (
              <RefreshCw size={14} className="spin-icon" aria-hidden="true" />
            ) : (
              <RefreshCw size={14} aria-hidden="true" />
            )}
            <span>Refresh</span>
          </button>
        </div>
      </div>

      {/* Metric Cards */}
      <div className="dashboard-metrics" role="list">
        <div className="metric-card" role="listitem" data-testid="metric-households">
          <div className="metric-icon">
            <Users size={22} aria-hidden="true" />
          </div>
          <div className="metric-body">
            <div className="metric-value">
              {stats ? stats.records : '—'}
            </div>
            <div className="metric-label">Households on server</div>
            {stats && (
              <div className="metric-sub">seq: {stats.lastSeq}</div>
            )}
          </div>
        </div>

        <div className="metric-card" role="listitem" data-testid="metric-pending">
          <div className="metric-icon" style={{ color: 'var(--warning)' }}>
            <Clock size={22} aria-hidden="true" />
          </div>
          <div className="metric-body">
            <div className="metric-value">{localData?.outboxCount ?? '—'}</div>
            <div className="metric-label">Pending ops (this device)</div>
            {stats && (
              <div className="metric-sub">{stats.ops} total ops on server</div>
            )}
          </div>
        </div>

        <div className="metric-card" role="listitem" data-testid="metric-conflicts">
          <div
            className="metric-icon"
            style={{
              color:
                (localData?.conflictCount ?? 0) > 0 ? 'var(--danger)' : 'var(--success)',
            }}
          >
            <AlertTriangle size={22} aria-hidden="true" />
          </div>
          <div className="metric-body">
            <div className="metric-value">{localData?.conflictCount ?? '—'}</div>
            <div className="metric-label">Open conflicts</div>
            {stats && stats.openConflicts > 0 && (
              <div className="metric-sub">{stats.openConflicts} on server</div>
            )}
          </div>
        </div>

        <div className="metric-card" role="listitem" data-testid="metric-last-sync">
          <div className="metric-icon" style={{ color: 'var(--success)' }}>
            <CheckCircle size={22} aria-hidden="true" />
          </div>
          <div className="metric-body">
            <div className="metric-value">{localSynced}</div>
            <div className="metric-label">Last synced</div>
            {stats && (
              <div className="metric-sub">Server seq: {stats.lastSeq}</div>
            )}
          </div>
        </div>
      </div>

      {/* Audit Trail */}
      <div className="dashboard-section">
        <div className="dashboard-section-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Activity size={16} aria-hidden="true" />
            <h3 className="dashboard-section-title">Audit trail</h3>
          </div>
          <input
            type="text"
            className="form-control"
            placeholder="Filter by record ID…"
            value={filterRecordId}
            onChange={(e) => setFilterRecordId(e.target.value)}
            style={{ maxWidth: '240px', minHeight: '32px', padding: '4px 10px', fontSize: '13px' }}
            data-testid="audit-filter-input"
          />
        </div>

        {auditEntries.length === 0 ? (
          <div className="empty-state" data-testid="audit-empty">
            <div className="empty-state-icon">
              <Activity size={32} style={{ color: 'var(--text-muted)' }} />
            </div>
            <h3 className="empty-state-title">No audit entries yet</h3>
            <p className="empty-state-body">
              {loading ? 'Loading…' : 'Sync some changes to see the audit trail.'}
            </p>
          </div>
        ) : (
          <div className="audit-list" data-testid="audit-list">
            {auditEntries.slice().reverse().map((entry, idx) => (
              <div
                key={`${entry.at}-${idx}`}
                className={`audit-row audit-kind-${entry.kind}`}
                data-testid={`audit-row-${entry.kind}`}
              >
                <span className="audit-icon" aria-hidden="true">
                  {auditKindIcon(entry.kind)}
                </span>
                <span className="audit-time">{formatHlcTime(entry.at)}</span>
                <span className="audit-user">{entry.userId}</span>
                <span className="audit-kind">{auditKindLabel(entry.kind)}</span>
                <span className="audit-record" title={entry.recordId}>
                  #{entry.recordId.replace(/^rec_/, '').slice(0, 6)}
                </span>
                {entry.detail && (
                  <span className="audit-detail">{entry.detail}</span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
