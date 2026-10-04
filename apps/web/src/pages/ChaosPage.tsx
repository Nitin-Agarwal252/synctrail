import { useState, useEffect } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db';
import { chaosTransport } from '../sync/engine';
import { type NetworkProfile } from '../sync/chaosTransport';
import {
  runSimulation,
  compareWithLastWriteWins,
  type LwwComparison,
  type SimulationResult,
} from '@synctrail/shared';
import { checklistRows, checklistSummary } from './simChecklist';
import { Wifi, WifiOff, Zap, Clock3, GitBranch, Play, CheckCircle2, XCircle } from 'lucide-react';

const PROFILES: { id: NetworkProfile; label: string; description: string }[] = [
  { id: 'normal',    label: 'Normal',    description: 'Full connectivity, no interference' },
  { id: 'offline',   label: 'Offline',   description: 'All requests blocked (client-side only)' },
  { id: 'flaky',     label: 'Flaky 30%', description: '30% packet loss — retries exercise backoff' },
  { id: 'slow',      label: 'Slow',      description: '1–3 s latency per request' },
  { id: 'partition', label: 'Partition', description: 'Offline until manually released' },
];

function profileIcon(id: NetworkProfile) {
  switch (id) {
    case 'normal':    return <Wifi size={16} aria-hidden="true" />;
    case 'offline':   return <WifiOff size={16} aria-hidden="true" />;
    case 'flaky':     return <Zap size={16} aria-hidden="true" />;
    case 'slow':      return <Clock3 size={16} aria-hidden="true" />;
    case 'partition': return <GitBranch size={16} aria-hidden="true" />;
  }
}

const SIM = { seeds: 200, steps: 300, devices: 3 };

/** Lets React paint the "running" state before the synchronous simulation blocks the tab. */
function afterPaint(fn: () => void): void {
  setTimeout(fn, 10);
}

export function ChaosPage() {
  const [activeProfile, setActiveProfile] = useState<NetworkProfile>(chaosTransport.getProfile());
  const [simResult, setSimResult] = useState<SimulationResult | null>(null);
  const [lwwResult, setLwwResult] = useState<LwwComparison | null>(null);
  const [running, setRunning] = useState<'sim' | 'lww' | null>(null);

  useEffect(() => {
    return chaosTransport.onProfileChange((p: NetworkProfile) => setActiveProfile(p));
  }, []);

  const handleSetProfile = (p: NetworkProfile) => {
    chaosTransport.setProfile(p);
  };

  const handleRunConvergence = () => {
    setRunning('sim');
    setSimResult(null);
    afterPaint(() => {
      setSimResult(runSimulation(SIM));
      setRunning(null);
    });
  };

  const handleCompareLww = () => {
    setRunning('lww');
    setLwwResult(null);
    afterPaint(() => {
      setLwwResult(compareWithLastWriteWins(SIM));
      setRunning(null);
    });
  };

  // Live op timeline from Dexie
  const opLog = useLiveQuery(async () => {
    const entries = await db.opLog.orderBy('n').reverse().limit(100).toArray();
    return entries;
  }, []);

  const outbox = useLiveQuery(async () => {
    return db.outbox.orderBy('n').reverse().limit(50).toArray();
  }, []);

  const outboxIds = new Set(outbox?.map((o) => o.opId) ?? []);

  return (
    <div className="chaos-page" data-testid="chaos-page">
      {/* Header */}
      <div className="chaos-header">
        <h2 className="chaos-title">Chaos Mode</h2>
        <span className="badge badge-pending" style={{ fontSize: '11px' }}>
          For judges
        </span>
      </div>
      <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginBottom: '24px' }}>
        Simulate hostile network conditions on this device. The server and other browser contexts are
        unaffected. Changes you make while offline queue in the outbox and sync when you restore
        connectivity.
      </p>

      {/* Network Profile Selector */}
      <div className="chaos-section">
        <h3 className="chaos-section-title">Network profile</h3>
        <div
          className="profile-selector"
          role="radiogroup"
          aria-label="Network profile"
          data-testid="profile-selector"
        >
          {PROFILES.map((p) => (
            <button
              key={p.id}
              className={`profile-btn ${activeProfile === p.id ? 'profile-btn-active' : ''}`}
              onClick={() => handleSetProfile(p.id)}
              role="radio"
              aria-checked={activeProfile === p.id}
              data-testid={`profile-btn-${p.id}`}
              title={p.description}
            >
              {profileIcon(p.id)}
              <span>{p.label}</span>
            </button>
          ))}
        </div>
        <p className="profile-description">
          {PROFILES.find((p) => p.id === activeProfile)?.description}
        </p>
      </div>

      {/* Convergence Check */}
      <div className="chaos-section">
        <h3 className="chaos-section-title">Convergence check</h3>
        <p style={{ fontSize: '13px', color: 'var(--text-muted)', marginBottom: '12px' }}>
          Runs {SIM.seeds} seeded sessions ({SIM.steps} steps, {SIM.devices} devices each) of{' '}
          <code>runSimulation</code> from <code>packages/shared/src/sim.ts</code> in this tab, against the
          real shared merge, and checks 7 invariants. The time shown is measured.
        </p>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
          <button
            className="btn btn-primary"
            onClick={handleRunConvergence}
            disabled={running !== null}
            data-testid="run-convergence-btn"
          >
            <Play size={14} aria-hidden="true" />
            <span>{running === 'sim' ? 'Running…' : 'Run convergence check'}</span>
          </button>
          <button
            className="btn btn-secondary"
            onClick={handleCompareLww}
            disabled={running !== null}
            data-testid="compare-lww-btn"
          >
            <span>{running === 'lww' ? 'Comparing…' : 'Compare with last-write-wins'}</span>
          </button>
        </div>
        {simResult && <SimChecklist result={simResult} />}
        {lwwResult && <LwwPanel result={lwwResult} />}
      </div>

      {/* Live Op Timeline */}
      <div className="chaos-section">
        <h3 className="chaos-section-title">
          Live op timeline{' '}
          <span style={{ fontSize: '12px', fontWeight: 400, color: 'var(--text-muted)' }}>
            (last 100, most recent first)
          </span>
        </h3>

        {(!opLog || opLog.length === 0) ? (
          <div className="empty-state" data-testid="timeline-empty" style={{ padding: '24px' }}>
            <p className="empty-state-body">No ops yet. Create or edit a household to see the timeline.</p>
          </div>
        ) : (
          <div className="timeline-list" data-testid="timeline-list">
            {opLog?.map((entry) => {
              const isPending = outboxIds.has(entry.opId);
              const shortId = entry.recordId.replace(/^rec_/, '').slice(0, 6);
              const d = new Date(entry.timestamp);
              const timeLabel = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;

              return (
                <div
                  key={entry.opId}
                  className={`timeline-row ${isPending ? 'timeline-row-pending' : 'timeline-row-synced'}`}
                  data-testid={`timeline-op-${entry.opId}`}
                >
                  <span className="timeline-time">{timeLabel}</span>
                  <span className={`timeline-badge ${isPending ? 'badge badge-pending' : 'badge badge-synced'}`}>
                    {isPending ? '⏱ queued' : '✓ synced'}
                  </span>
                  <span className="timeline-type">{entry.type}</span>
                  <span className="timeline-record" title={entry.recordId}>#{shortId}</span>
                  <span className="timeline-opid" title={entry.opId}>
                    {entry.opId.slice(0, 20)}…
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function SimChecklist({ result }: { result: SimulationResult }) {
  const summary = checklistSummary(result);
  return (
    <div className="sim-checklist" data-testid="sim-checklist">
      <div
        className={`convergence-result ${summary.tone === 'pass' ? 'convergence-pass' : 'convergence-fail'}`}
        data-testid="convergence-result"
        aria-live="polite"
      >
        {summary.tone === 'pass' ? <CheckCircle2 size={16} aria-hidden="true" /> : <XCircle size={16} aria-hidden="true" />}
        <span>{summary.text}</span>
      </div>
      <ul className="invariant-list">
        {checklistRows(result).map((row) => (
          <li
            key={row.name}
            className={`invariant-row ${row.pass ? 'invariant-pass' : 'invariant-fail'}`}
            data-testid="invariant-row"
            data-pass={String(row.pass)}
          >
            {row.pass ? <CheckCircle2 size={14} aria-hidden="true" /> : <XCircle size={14} aria-hidden="true" />}
            <span className="invariant-label">{row.label}</span>
            <span className="invariant-name">{row.name}</span>
            <span className="invariant-detail">{row.detail}</span>
          </li>
        ))}
      </ul>
      <p className="sim-counts" data-testid="sim-counts">
        {result.counts.ops} ops · {result.counts.conflictsOpened} conflicts opened ·{' '}
        {result.counts.duplicatesReplayed} duplicates replayed
      </p>
    </div>
  );
}

function LwwPanel({ result }: { result: LwwComparison }) {
  return (
    <div className="lww-compare" data-testid="lww-compare">
      <h4 className="lww-title">Comparison harness: naive last-write-wins (never used by SyncTrail)</h4>
      <p className="lww-note">
        The same {result.sessions} seeded sessions, applied by SyncTrail&apos;s merge and by a naive
        newest-timestamp-wins function. A lost edit is a change that was overwritten, dropped or deleted
        without its author or the other author ever seeing it. Measured {Math.round(result.elapsedMs)} ms.
      </p>
      <ul className="lww-list">
        <li data-testid="lww-synctrail">
          SyncTrail: <strong data-testid="lww-synctrail-lost">{result.syncTrail.lostEdits}</strong> lost edits of{' '}
          {result.syncTrail.ops} ops
        </li>
        <li data-testid="lww-naive">
          Last-write-wins: <strong data-testid="lww-naive-lost">{result.lastWriteWins.lostEdits}</strong> lost edits of{' '}
          {result.lastWriteWins.ops} ops
        </li>
      </ul>
    </div>
  );
}
