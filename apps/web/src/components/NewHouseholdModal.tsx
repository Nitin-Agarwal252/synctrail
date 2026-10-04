import { useState, type FormEvent } from 'react';
import { X } from 'lucide-react';

interface NewHouseholdModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (fields: {
    name: string;
    phone: string;
    address: string;
    status: 'new' | 'follow-up' | 'completed';
    notes: string;
  }) => Promise<string>;
  onCreated: (recordId: string) => void;
}

export const NewHouseholdModal: React.FC<NewHouseholdModalProps> = ({
  isOpen,
  onClose,
  onCreate,
  onCreated,
}) => {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');
  const [status, setStatus] = useState<'new' | 'follow-up' | 'completed'>('new');
  const [notes, setNotes] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  if (!isOpen) return null;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !phone.trim() || isSubmitting) return;

    setIsSubmitting(true);
    try {
      const recordId = await onCreate({
        name,
        phone,
        address,
        status,
        notes,
      });
      setName('');
      setPhone('');
      setAddress('');
      setStatus('new');
      setNotes('');
      onCreated(recordId);
      onClose();
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 id="modal-title" className="modal-title">New household</h2>
          <button
            onClick={onClose}
            className="btn btn-secondary"
            style={{ minHeight: '36px', padding: '6px' }}
            aria-label="Close dialog"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label className="form-label" htmlFor="modal-name">Name *</label>
            <input
              id="modal-name"
              type="text"
              className="form-control"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Rao family"
              required
              autoFocus
              data-testid="new-household-name"
            />
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="modal-phone">Phone *</label>
            <input
              id="modal-phone"
              type="tel"
              className="form-control"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="e.g. 98300 11122"
              required
              data-testid="new-household-phone"
            />
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="modal-status">Status</label>
            <select
              id="modal-status"
              className="form-control"
              value={status}
              onChange={(e) => setStatus(e.target.value as 'new' | 'follow-up' | 'completed')}
              data-testid="new-household-status"
            >
              <option value="new">new</option>
              <option value="follow-up">follow-up</option>
              <option value="completed">completed</option>
            </select>
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="modal-address">Address</label>
            <input
              id="modal-address"
              type="text"
              className="form-control"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="e.g. 14 North Cross Road"
              data-testid="new-household-address"
            />
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="modal-notes">Notes</label>
            <textarea
              id="modal-notes"
              className="form-control"
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="e.g. Needs second visit, child under 5"
              data-testid="new-household-notes"
            />
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '20px' }}>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={onClose}
              disabled={isSubmitting}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={isSubmitting || !name.trim() || !phone.trim()}
              data-testid="save-new-household"
            >
              {isSubmitting ? 'Saving…' : 'Add household'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
