import { useState, useEffect, useRef, type KeyboardEvent } from 'react';
import { ArrowLeft, Trash2, RotateCcw, AlertTriangle } from 'lucide-react';
import { DerivedRecord } from '../state/useHouseholdView';
import { OutboxOp } from '../db';
import { Badge } from './Badge';
import { hlc } from '@synctrail/shared';

interface RecordDetailProps {
  record: DerivedRecord | null;
  outboxOps: OutboxOp[];
  currentUserId?: string;
  onBack: () => void;
  onUpdateField: (recordId: string, field: string, value: string) => Promise<void>;
  onDeleteHousehold: (recordId: string) => Promise<void>;
  onRestoreHousehold: (recordId: string) => Promise<void>;
  onReviewConflict?: (recordId: string, fieldName: string) => void;
}

export const RecordDetail = ({
  record,
  outboxOps,
  currentUserId,
  onBack,
  onUpdateField,
  onDeleteHousehold,
  onRestoreHousehold,
  onReviewConflict,
}: RecordDetailProps) => {
  // Local form state for instant blur/enter saving
  const [draftName, setDraftName] = useState('');
  const [draftPhone, setDraftPhone] = useState('');
  const [draftAddress, setDraftAddress] = useState('');
  const [draftNotes, setDraftNotes] = useState('');

  // Track focused field to protect user typing from remote overwrite
  const [focusedField, setFocusedField] = useState<string | null>(null);
  const [remoteNotices, setRemoteNotices] = useState<Record<string, string>>({});
  const lastSeenHlcRef = useRef<Record<string, string>>({});

  // Sync draft state with record while preserving focused field
  useEffect(() => {
    if (!record) return;

    const fields = record.state.fields;
    const newNotices: Record<string, string> = { ...remoteNotices };

    // Check each field
    (['name', 'phone', 'address', 'notes'] as const).forEach((fieldName) => {
      const field = fields[fieldName];
      const prevHlc = lastSeenHlcRef.current[fieldName];

      if (prevHlc && field && field.hlc !== prevHlc) {
        // Remote change arrived
        if (focusedField === fieldName && field.userId !== currentUserId) {
          newNotices[fieldName] = `${field.userId} changed this while you were editing`;
        }
      }

      if (field) {
        lastSeenHlcRef.current[fieldName] = field.hlc;
      }
    });

    setRemoteNotices(newNotices);

    // Only update draft value if user is not currently focusing/editing it
    if (focusedField !== 'name') {
      setDraftName(String(fields.name?.value ?? ''));
    }
    if (focusedField !== 'phone') {
      setDraftPhone(String(fields.phone?.value ?? ''));
    }
    if (focusedField !== 'address') {
      setDraftAddress(String(fields.address?.value ?? ''));
    }
    if (focusedField !== 'notes') {
      setDraftNotes(String(fields.notes?.value ?? ''));
    }
  }, [record, focusedField, currentUserId]);

  if (!record) {
    return (
      <div className="pane-detail" style={{ justifyContent: 'center', alignItems: 'center' }}>
        <p style={{ color: 'var(--text-muted)' }}>Select a household to view details</p>
      </div>
    );
  }

  const shortId = record.id.replace(/^rec_/, '').slice(0, 4);
  const statusValue = String(record.state.fields.status?.value ?? 'new');

  // Handle saving field on blur or Enter
  const handleSaveField = async (fieldName: string, draftValue: string) => {
    setFocusedField(null);
    const currentValue = String(record.state.fields[fieldName]?.value ?? '');
    if (draftValue !== currentValue) {
      await onUpdateField(record.id, fieldName, draftValue);
    }
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      (e.target as HTMLElement).blur();
    }
  };

  // Find outbox ops for this record for the history strip
  const recordOps = outboxOps.filter((op) => op.recordId === record.id);

  return (
    <div className="pane-detail" data-testid="record-detail-screen">
      {/* Detail Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: '20px',
          gap: '8px',
        }}
      >
        <button
          className="btn btn-secondary btn-back"
          onClick={onBack}
          data-testid="back-to-households"
          title="Back to households"
        >
          <ArrowLeft size={16} aria-hidden="true" />
          <span>Back to households</span>
        </button>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <h2 style={{ fontSize: '18px', fontWeight: 600 }}>Household #{shortId}</h2>
          {record.pendingOpCount > 0 && (
            <span className="badge badge-pending" data-testid="record-pending-badge">
              {record.pendingOpCount} changes pending
            </span>
          )}
        </div>
      </div>

      {record.state.deleted ? (
        <div
          style={{
            padding: '24px',
            background: 'var(--danger-bg)',
            border: '1px solid var(--danger-border)',
            borderRadius: 'var(--radius-lg)',
            marginBottom: '20px',
            textAlign: 'center',
          }}
        >
          <h3 style={{ color: 'var(--danger)', marginBottom: '8px' }}>This household is deleted</h3>
          <p style={{ color: 'var(--text-muted)', marginBottom: '16px' }}>
            Deleted on this device. You can restore it anytime.
          </p>
          <button
            className="btn btn-secondary"
            onClick={() => onRestoreHousehold(record.id)}
            data-testid="restore-household-btn"
          >
            <RotateCcw size={16} aria-hidden="true" />
            <span>Restore household</span>
          </button>
        </div>
      ) : (
        <div>
          {/* Name Field */}
          <div className="form-group">
            <div className="form-label-row">
              <label className="form-label" htmlFor="field-name">Name</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <Badge
                  status={record.fieldBadges.name || 'synced'}
                  data-testid="badge-field-name"
                />
                {record.fieldBadges.name === 'conflict' && onReviewConflict && (
                  <button
                    className="btn-review-conflict"
                    onClick={() => onReviewConflict(record.id, 'name')}
                    data-testid="review-conflict-name"
                  >
                    Review conflict
                  </button>
                )}
              </div>
            </div>
            <input
              id="field-name"
              type="text"
              className="form-control"
              value={draftName}
              onFocus={() => setFocusedField('name')}
              onChange={(e) => setDraftName(e.target.value)}
              onBlur={() => handleSaveField('name', draftName)}
              onKeyDown={handleKeyDown}
              data-testid="detail-name-input"
            />
            {remoteNotices.name && (
              <div className="remote-change-note" data-testid="remote-change-note">
                <AlertTriangle size={14} aria-hidden="true" />
                <span>{remoteNotices.name}</span>
              </div>
            )}
          </div>

          {/* Phone Field */}
          <div className="form-group">
            <div className="form-label-row">
              <label className="form-label" htmlFor="field-phone">Phone</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <Badge
                  status={record.fieldBadges.phone || 'synced'}
                  data-testid="badge-field-phone"
                />
                {record.fieldBadges.phone === 'conflict' && onReviewConflict && (
                  <button
                    className="btn-review-conflict"
                    onClick={() => onReviewConflict(record.id, 'phone')}
                    data-testid="review-conflict-phone"
                  >
                    Review conflict
                  </button>
                )}
              </div>
            </div>
            <input
              id="field-phone"
              type="tel"
              className="form-control"
              value={draftPhone}
              onFocus={() => setFocusedField('phone')}
              onChange={(e) => setDraftPhone(e.target.value)}
              onBlur={() => handleSaveField('phone', draftPhone)}
              onKeyDown={handleKeyDown}
              data-testid="detail-phone-input"
            />
            {remoteNotices.phone && (
              <div className="remote-change-note" data-testid="remote-change-note">
                <AlertTriangle size={14} aria-hidden="true" />
                <span>{remoteNotices.phone}</span>
              </div>
            )}
          </div>

          {/* Status Field */}
          <div className="form-group">
            <div className="form-label-row">
              <label className="form-label" htmlFor="field-status">Status</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <Badge
                  status={record.fieldBadges.status || 'synced'}
                  data-testid="badge-field-status"
                />
                {record.fieldBadges.status === 'conflict' && onReviewConflict && (
                  <button
                    className="btn-review-conflict"
                    onClick={() => onReviewConflict(record.id, 'status')}
                    data-testid="review-conflict-status"
                  >
                    Review conflict
                  </button>
                )}
              </div>
            </div>
            <select
              id="field-status"
              className="form-control"
              value={statusValue}
              onChange={(e) => onUpdateField(record.id, 'status', e.target.value)}
              data-testid="detail-status-select"
            >
              <option value="new">new</option>
              <option value="follow-up">follow-up</option>
              <option value="completed">completed</option>
            </select>
          </div>

          {/* Notes Field */}
          <div className="form-group">
            <div className="form-label-row">
              <label className="form-label" htmlFor="field-notes">Notes</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <Badge
                  status={record.fieldBadges.notes || 'synced'}
                  data-testid="badge-field-notes"
                />
                {record.fieldBadges.notes === 'conflict' && onReviewConflict && (
                  <button
                    className="btn-review-conflict"
                    onClick={() => onReviewConflict(record.id, 'notes')}
                    data-testid="review-conflict-notes"
                  >
                    Review conflict
                  </button>
                )}
              </div>
            </div>
            <textarea
              id="field-notes"
              className="form-control"
              rows={3}
              value={draftNotes}
              onFocus={() => setFocusedField('notes')}
              onChange={(e) => setDraftNotes(e.target.value)}
              onBlur={() => handleSaveField('notes', draftNotes)}
              data-testid="detail-notes-input"
            />
            {remoteNotices.notes && (
              <div className="remote-change-note" data-testid="remote-change-note">
                <AlertTriangle size={14} aria-hidden="true" />
                <span>{remoteNotices.notes}</span>
              </div>
            )}
          </div>

          {/* Address Field */}
          <div className="form-group">
            <div className="form-label-row">
              <label className="form-label" htmlFor="field-address">Address</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <Badge
                  status={record.fieldBadges.address || 'synced'}
                  data-testid="badge-field-address"
                />
                {record.fieldBadges.address === 'conflict' && onReviewConflict && (
                  <button
                    className="btn-review-conflict"
                    onClick={() => onReviewConflict(record.id, 'address')}
                    data-testid="review-conflict-address"
                  >
                    Review conflict
                  </button>
                )}
              </div>
            </div>
            <input
              id="field-address"
              type="text"
              className="form-control"
              value={draftAddress}
              onFocus={() => setFocusedField('address')}
              onChange={(e) => setDraftAddress(e.target.value)}
              onBlur={() => handleSaveField('address', draftAddress)}
              onKeyDown={handleKeyDown}
              data-testid="detail-address-input"
            />
            {remoteNotices.address && (
              <div className="remote-change-note" data-testid="remote-change-note">
                <AlertTriangle size={14} aria-hidden="true" />
                <span>{remoteNotices.address}</span>
              </div>
            )}
          </div>

          {/* Delete Household Button */}
          <div style={{ marginTop: '24px', display: 'flex', justifyContent: 'flex-end' }}>
            <button
              className="btn btn-danger"
              onClick={() => onDeleteHousehold(record.id)}
              data-testid="delete-household-btn"
            >
              <Trash2 size={16} aria-hidden="true" />
              <span>Delete household</span>
            </button>
          </div>
        </div>
      )}

      {/* History Strip */}
      <div className="history-section" data-testid="history-strip">
        <h3 className="history-title">History</h3>
        {recordOps.map((op) => {
          const date = new Date();
          const timeStr = `${String(date.getHours()).padStart(2, '0')}:${String(
            date.getMinutes()
          ).padStart(2, '0')}`;
          let desc = '';
          if (op.type === 'create') {
            desc = `Created by ${op.userId} (pending)`;
          } else if (op.type === 'set') {
            desc = `${op.userId} set ${op.field} → ${op.value} (pending)`;
          } else if (op.type === 'delete') {
            desc = `Deleted by ${op.userId} (pending)`;
          } else if (op.type === 'restore') {
            desc = `Restored by ${op.userId} (pending)`;
          }

          return (
            <div key={op.opId} className="history-item">
              <span style={{ fontWeight: 500 }}>{timeStr}</span> {desc}
            </div>
          );
        })}

        {/* Synced field changes */}
        {Object.entries(record.state.fields).map(([fieldName, fieldState]) => {
          if (!fieldState || !fieldState.userId) return null;
          let timeStr = 'synced';
          try {
            const parsed = hlc.parse(fieldState.hlc);
            if (parsed.wall > 0) {
              const d = new Date(parsed.wall);
              timeStr = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(
                2,
                '0'
              )}`;
            }
          } catch {
            // Ignore parse error
          }

          return (
            <div key={`field_${fieldName}_${fieldState.hlc}`} className="history-item">
              <span style={{ fontWeight: 500 }}>{timeStr}</span> {fieldState.userId} set {fieldName} →{' '}
              {String(fieldState.value)} (synced)
            </div>
          );
        })}
      </div>
    </div>
  );
};
