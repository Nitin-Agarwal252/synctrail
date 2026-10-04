import { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import type { DeadOp } from '../db';

function describeOp(d: DeadOp): string {
  const { op } = d;
  if (op.type === 'set') return `set ${op.field ?? '?'} = ${JSON.stringify(op.value ?? null)}`;
  if (op.type === 'create') return `create "${String(op.fields?.name ?? '')}"`;
  return op.type;
}

interface DeadLetterBannerProps {
  deadOps: DeadOp[];
  onRetry: (opId: string) => void;
  onDiscard: (opId: string) => void;
}

export const DeadLetterBanner: React.FC<DeadLetterBannerProps> = ({
  deadOps,
  onRetry,
  onDiscard,
}) => {
  const [open, setOpen] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  if (deadOps.length === 0) {
    return null;
  }

  const n = deadOps.length;
  const label = n === 1 ? "1 change couldn't be saved" : `${n} changes couldn't be saved`;

  const copyJson = async (op: DeadOp) => {
    const text = JSON.stringify(op.op, null, 2);
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Fallback for environments without clipboard permission
      window.prompt('Copy op JSON', text);
    }
    setCopiedId(op.opId);
  };

  return (
    <div>
      <button
        type="button"
        className="dead-letter-banner"
        role="status"
        aria-live="polite"
        data-testid="dead-letter-banner"
        onClick={() => setOpen((v) => !v)}
      >
        <AlertTriangle size={16} aria-hidden="true" />
        <span>{label}</span>
      </button>

      {open && (
        <ul className="dead-letter-list" data-testid="dead-letter-list">
          {deadOps.map((d) => (
            <li
              key={d.opId}
              className="dead-letter-item"
              data-testid={`dead-letter-item-${d.opId}`}
            >
              <div className="dead-letter-item-meta">
                <strong data-testid={`dead-letter-op-${d.opId}`}>{describeOp(d)}</strong>
                <span> · record {d.recordId}</span>
                <span className="dead-letter-reason" data-testid={`dead-letter-reason-${d.opId}`}>
                  {d.reason}
                </span>
              </div>
              <div className="dead-letter-item-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  data-testid={`dead-letter-copy-${d.opId}`}
                  onClick={() => copyJson(d)}
                >
                  {copiedId === d.opId ? 'Copied' : 'Copy JSON'}
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  data-testid={`dead-letter-retry-${d.opId}`}
                  onClick={() => onRetry(d.opId)}
                >
                  Retry
                </button>
                {confirmId === d.opId ? (
                  <button
                    type="button"
                    className="btn btn-danger"
                    data-testid={`dead-letter-confirm-discard-${d.opId}`}
                    onClick={() => {
                      setConfirmId(null);
                      onDiscard(d.opId);
                    }}
                  >
                    Discard permanently
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn btn-danger"
                    data-testid={`dead-letter-discard-${d.opId}`}
                    onClick={() => setConfirmId(d.opId)}
                  >
                    Discard
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
