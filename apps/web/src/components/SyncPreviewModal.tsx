import { useState, useEffect } from 'react';
import { Check, AlertTriangle, X, RefreshCw } from 'lucide-react';
import { type ApplyResult, type Op } from '@synctrail/shared';

interface SyncPreviewModalProps {
  isOpen: boolean;
  isOnline: boolean;
  onClose: () => void;
  onTriggerSync: () => Promise<void>;
  onPreview: () => Promise<{ results: ApplyResult[]; ops: Op[] }>;
}

export const SyncPreviewModal = ({
  isOpen,
  isOnline,
  onClose,
  onTriggerSync,
  onPreview,
}: SyncPreviewModalProps) => {
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [previewItems, setPreviewItems] = useState<
    { op: Op; result?: ApplyResult }[]
  >([]);

  useEffect(() => {
    if (!isOpen) return;

    let mounted = true;
    setLoading(true);

    onPreview()
      .then(({ results, ops }) => {
        if (!mounted) return;
        const resultMap = new Map(results.map((r) => [r.opId, r]));
        const items = ops.map((op) => ({
          op,
          result: resultMap.get(op.opId),
        }));
        setPreviewItems(items);
      })
      .catch(() => {
        if (!mounted) return;
        setPreviewItems([]);
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, [isOpen, onPreview]);

  if (!isOpen) return null;

  const totalChanges = previewItems.length;
  const conflictCount = previewItems.filter(
    (item) => item.result?.status === 'conflict'
  ).length;
  const allClean = totalChanges > 0 && conflictCount === 0;

  const handleSyncNow = async () => {
    setSyncing(true);
    try {
      await onTriggerSync();
      onClose();
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div
      className="modal-overlay"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="preview-title"
      data-testid="sync-preview-modal"
    >
      <div
        className="modal-card sync-preview-sheet"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: '520px' }}
      >
        {/* Header */}
        <div className="modal-header">
          <div>
            <h2 id="preview-title" style={{ fontSize: '18px', fontWeight: 600 }}>
              {allClean
                ? `All ${totalChanges} changes merge cleanly`
                : `Ready to sync ${totalChanges} changes`}
            </h2>
            {!isOnline && (
              <p style={{ color: 'var(--warning)', fontSize: '13px', marginTop: '4px' }}>
                You're offline. Changes will sync automatically when you reconnect.
              </p>
            )}
          </div>
          <button
            className="btn btn-secondary"
            onClick={onClose}
            aria-label="Close sync preview"
            style={{ padding: '6px', minHeight: 'auto' }}
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        {/* Content */}
        <div className="modal-body" style={{ maxHeight: '380px', overflowY: 'auto' }}>
          {loading ? (
            <div style={{ textAlign: 'center', padding: '32px', color: 'var(--text-muted)' }}>
              <RefreshCw size={24} className="spin-icon" style={{ marginBottom: '8px' }} />
              <p>Analyzing pending changes against server…</p>
            </div>
          ) : totalChanges === 0 ? (
            <div style={{ textAlign: 'center', padding: '32px', color: 'var(--text-muted)' }}>
              <Check size={28} style={{ color: 'var(--success)', marginBottom: '8px' }} />
              <p>No pending changes waiting to sync.</p>
            </div>
          ) : (
            <div className="preview-items-list" data-testid="preview-items-list">
              {previewItems.map(({ op, result }) => {
                const shortId = op.recordId.replace(/^rec_/, '').slice(0, 4);
                const isConflict = result?.status === 'conflict';
                const fieldName =
                  op.field || (op.type === 'create' ? 'Record' : op.type);

                let label = '';
                if (isConflict) {
                  if (op.type === 'delete') {
                    label = `You deleted it, but another user edited it`;
                  } else if (result?.reason === 'edit-vs-delete') {
                    label = `Deleted on server while you were editing`;
                  } else {
                    label = `Conflicts with remote change`;
                  }
                } else {
                  label = 'Merges cleanly';
                }

                return (
                  <div
                    key={op.opId}
                    className={`preview-item ${isConflict ? 'preview-item-conflict' : 'preview-item-clean'}`}
                    data-testid={`preview-item-${op.opId}`}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      {isConflict ? (
                        <AlertTriangle
                          size={16}
                          style={{ color: 'var(--danger)', flexShrink: 0 }}
                          aria-hidden="true"
                        />
                      ) : (
                        <Check
                          size={16}
                          style={{ color: 'var(--success)', flexShrink: 0 }}
                          aria-hidden="true"
                        />
                      )}
                      <div>
                        <span style={{ fontWeight: 600 }}>
                          {fieldName} on #{shortId}
                        </span>
                        <span style={{ color: 'var(--text-muted)', marginLeft: '8px' }}>
                          {label}
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          className="modal-footer"
          style={{
            flexDirection: 'column',
            alignItems: 'stretch',
            gap: '8px',
            borderTop: '1px solid var(--border)',
            paddingTop: '16px',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
            <button className="btn btn-secondary" onClick={onClose}>
              Close
            </button>
            <button
              className="btn btn-primary"
              disabled={loading || syncing || totalChanges === 0 || !isOnline}
              onClick={handleSyncNow}
              data-testid="sync-now-btn"
            >
              {syncing ? (
                <>
                  <RefreshCw size={14} className="spin-icon" aria-hidden="true" />
                  <span>Syncing…</span>
                </>
              ) : (
                <span>Sync now</span>
              )}
            </button>
          </div>
          <p
            style={{
              fontSize: '12px',
              color: 'var(--text-muted)',
              textAlign: 'center',
              margin: 0,
            }}
          >
            Conflicts will wait in your inbox. Nothing is overwritten.
          </p>
        </div>
      </div>
    </div>
  );
};
