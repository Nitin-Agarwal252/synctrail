import { useState } from 'react';
import { AlertTriangle, CheckCircle, ArrowLeft, Edit3, ShieldAlert } from 'lucide-react';
import { ClientConflict } from '../db';
import { hlc } from '@synctrail/shared';

interface ConflictInboxProps {
  conflicts: ClientConflict[];
  currentUserId: string;
  onResolve: (
    conflictId: string,
    choice: 'mine' | 'theirs' | 'custom',
    value?: unknown
  ) => Promise<void>;
  onBackToRecords: () => void;
}

function formatHlcTime(hlcStr: string | null | undefined): string {
  if (!hlcStr) return 'Original';
  try {
    const parsed = hlc.parse(hlcStr);
    if (parsed.wall > 0) {
      const d = new Date(parsed.wall);
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    }
  } catch {
    // Ignore parse error
  }
  return 'Original';
}

export const ConflictInbox = ({
  conflicts,
  currentUserId: _currentUserId,
  onResolve,
  onBackToRecords,
}: ConflictInboxProps) => {
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [resolvedIds, setResolvedIds] = useState<Set<string>>(new Set());
  const [manualEditId, setManualEditId] = useState<string | null>(null);
  const [manualValue, setManualValue] = useState<string>('');

  const handleResolveAction = async (
    conflictId: string,
    choice: 'mine' | 'theirs' | 'custom',
    value?: unknown
  ) => {
    try {
      setResolvingId(conflictId);
      await onResolve(conflictId, choice, value);
      setResolvedIds((prev) => new Set(prev).add(conflictId));
      setManualEditId(null);
    } finally {
      setResolvingId(null);
    }
  };

  const activeConflicts = conflicts.filter((c) => !resolvedIds.has(c.id));

  return (
    <div className="conflict-inbox-container" data-testid="conflict-inbox-screen">
      {/* Header */}
      <div className="inbox-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <button
            className="btn btn-secondary btn-back"
            onClick={onBackToRecords}
            data-testid="back-to-records"
            title="Back to records"
          >
            <ArrowLeft size={16} aria-hidden="true" />
            <span>Records</span>
          </button>
          <h2 style={{ fontSize: '20px', fontWeight: 600 }}>Conflict inbox</h2>
        </div>
        <div className="inbox-meta-badge">
          {activeConflicts.length > 0 ? (
            <span className="badge badge-conflict" data-testid="inbox-count-badge">
              <AlertTriangle size={14} aria-hidden="true" />
              <span>{activeConflicts.length} need a decision</span>
            </span>
          ) : (
            <span className="badge badge-synced">
              <CheckCircle size={14} aria-hidden="true" />
              <span>All resolved</span>
            </span>
          )}
        </div>
      </div>

      {/* Empty State */}
      {activeConflicts.length === 0 ? (
        <div className="empty-state" data-testid="conflict-inbox-empty">
          <div className="empty-state-icon">
            <CheckCircle size={40} style={{ color: 'var(--success)' }} />
          </div>
          <h3 className="empty-state-title">No conflicts</h3>
          <p className="empty-state-body">
            When two people change the same thing, it shows up here.
          </p>
          <button className="btn btn-primary" onClick={onBackToRecords} style={{ marginTop: '16px' }}>
            Back to households
          </button>
        </div>
      ) : (
        <div className="conflict-cards-list">
          {activeConflicts.map((conflict) => {
            const shortId = conflict.recordId.replace(/^rec_/, '').slice(0, 4);
            const isResolving = resolvingId === conflict.id;
            const isEditing = manualEditId === conflict.id;

            // 1. Field-level conflict card
            if (conflict.kind === 'field') {
              const fieldName = conflict.field || 'field';
              const ancestorTime = formatHlcTime(conflict.mine.baseHlc);
              const mineTime = formatHlcTime(conflict.mine.hlc);
              const theirsTime = formatHlcTime(conflict.theirs.hlc);
              const ancestorVal = conflict.baseValue !== undefined ? String(conflict.baseValue) : '(None)';
              const mineVal = String(conflict.mine.value ?? '');
              const theirsVal = String(conflict.theirs.value ?? '');

              return (
                <div
                  key={conflict.id}
                  className="card conflict-card"
                  data-testid={`conflict-card-${conflict.id}`}
                >
                  <div className="conflict-card-header">
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <AlertTriangle size={18} style={{ color: 'var(--danger)' }} />
                      <h3 style={{ fontSize: '16px', fontWeight: 600 }}>
                        Household #{shortId} · {fieldName}
                      </h3>
                    </div>
                  </div>

                  {/* 3-way column group */}
                  <div className="three-way-grid" role="group" aria-label="Conflict versions">
                    {/* Common ancestor */}
                    <div className="three-way-col" data-testid="col-ancestor">
                      <div className="col-header">Common ancestor</div>
                      <div className="col-value">{ancestorVal}</div>
                      <div className="col-meta">{ancestorTime}</div>
                    </div>

                    {/* Yours */}
                    <div className="three-way-col" data-testid="col-mine">
                      <div className="col-header">Yours · {conflict.mine.userId}</div>
                      <div className="col-value highlight-yours">{mineVal}</div>
                      <div className="col-meta">{mineTime}</div>
                    </div>

                    {/* Theirs */}
                    <div className="three-way-col" data-testid="col-theirs">
                      <div className="col-header">Theirs · {conflict.theirs.userId}</div>
                      <div className="col-value highlight-theirs">{theirsVal}</div>
                      <div className="col-meta">{theirsTime}</div>
                    </div>
                  </div>

                  {/* Manual Edit Input Area */}
                  {isEditing && (
                    <div className="manual-edit-panel" data-testid="manual-edit-panel">
                      <label className="form-label" htmlFor={`custom-val-${conflict.id}`}>
                        Custom resolution value:
                      </label>
                      {fieldName === 'status' ? (
                        <select
                          id={`custom-val-${conflict.id}`}
                          className="form-control"
                          value={manualValue}
                          onChange={(e) => setManualValue(e.target.value)}
                          data-testid="manual-edit-select"
                        >
                          <option value="new">new</option>
                          <option value="follow-up">follow-up</option>
                          <option value="completed">completed</option>
                        </select>
                      ) : (
                        <input
                          id={`custom-val-${conflict.id}`}
                          type="text"
                          className="form-control"
                          value={manualValue}
                          onChange={(e) => setManualValue(e.target.value)}
                          data-testid="manual-edit-input"
                          autoFocus
                        />
                      )}
                      <div style={{ display: 'flex', gap: '8px', marginTop: '10px' }}>
                        <button
                          className="btn btn-primary"
                          disabled={isResolving}
                          onClick={() => handleResolveAction(conflict.id, 'custom', manualValue)}
                          data-testid="resolve-save-custom"
                        >
                          Save resolution
                        </button>
                        <button
                          className="btn btn-secondary"
                          onClick={() => setManualEditId(null)}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Actions */}
                  {!isEditing && (
                    <div className="conflict-card-actions">
                      <button
                        className="btn btn-secondary"
                        disabled={isResolving}
                        onClick={() => handleResolveAction(conflict.id, 'mine')}
                        data-testid="resolve-keep-mine"
                      >
                        Keep mine
                      </button>
                      <button
                        className="btn btn-secondary"
                        disabled={isResolving}
                        onClick={() => handleResolveAction(conflict.id, 'theirs')}
                        data-testid="resolve-keep-theirs"
                      >
                        Keep theirs
                      </button>
                      <button
                        className="btn btn-secondary"
                        disabled={isResolving}
                        onClick={() => {
                          setManualEditId(conflict.id);
                          setManualValue(theirsVal);
                        }}
                        data-testid="resolve-edit-manually"
                      >
                        <Edit3 size={14} aria-hidden="true" style={{ marginRight: '4px' }} />
                        <span>Edit manually</span>
                      </button>
                    </div>
                  )}
                </div>
              );
            }

            // 2. Edit-vs-delete or delete-vs-edit conflict card
            const isDeleteVsEdit = conflict.kind === 'delete-vs-edit';
            const headline = isDeleteVsEdit
              ? `You deleted it, ${conflict.theirs.userId} edited it`
              : `${conflict.theirs.userId} deleted it, you edited it`;

            // For delete-vs-edit: choice 'theirs' keeps the edit (Restore); choice 'mine' keeps the delete (Delete anyway)
            // For edit-vs-delete: choice 'mine' keeps the edit (Restore); choice 'theirs' keeps the delete (Delete anyway)
            const restoreChoice = isDeleteVsEdit ? 'theirs' : 'mine';
            const deleteAnywayChoice = isDeleteVsEdit ? 'mine' : 'theirs';

            return (
              <div
                key={conflict.id}
                className="card conflict-card"
                data-testid={`conflict-card-${conflict.id}`}
              >
                <div className="conflict-card-header">
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <ShieldAlert size={18} style={{ color: 'var(--danger)' }} />
                    <h3 style={{ fontSize: '16px', fontWeight: 600 }}>
                      Household #{shortId} · {headline}
                    </h3>
                  </div>
                </div>

                <p style={{ color: 'var(--text-muted)', fontSize: '14px', marginBottom: '16px' }}>
                  A field edit and a record deletion occurred concurrently. Choose whether to restore
                  the household with all edits preserved, or delete it anyway.
                </p>

                <div className="conflict-card-actions">
                  <button
                    className="btn btn-primary"
                    disabled={isResolving}
                    onClick={() => handleResolveAction(conflict.id, restoreChoice)}
                    data-testid="resolve-restore"
                  >
                    Restore
                  </button>
                  <button
                    className="btn btn-danger"
                    disabled={isResolving}
                    onClick={() => handleResolveAction(conflict.id, deleteAnywayChoice)}
                    data-testid="resolve-delete-anyway"
                  >
                    Delete anyway
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
