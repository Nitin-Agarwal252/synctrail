import { useState, useMemo, type KeyboardEvent } from 'react';
import { Search, Plus, RotateCcw } from 'lucide-react';
import { DerivedRecord } from '../state/useHouseholdView';
import { Badge } from './Badge';

interface RecordsListProps {
  records: DerivedRecord[];
  selectedRecordId: string | null;
  onSelectRecord: (recordId: string) => void;
  onOpenNewModal: () => void;
  onRestoreRecord: (recordId: string) => void;
}

type FilterChip = 'all' | 'pending' | 'conflicts' | 'deleted';

export const RecordsList: React.FC<RecordsListProps> = ({
  records,
  selectedRecordId,
  onSelectRecord,
  onOpenNewModal,
  onRestoreRecord,
}) => {
  const [filter, setFilter] = useState<FilterChip>('all');
  const [searchQuery, setSearchQuery] = useState('');

  // Count metrics for chips
  const counts = useMemo(() => {
    let pending = 0;
    let conflicts = 0;
    let deleted = 0;

    for (const r of records) {
      if (r.state.deleted) {
        deleted++;
      } else {
        if (r.recordBadge === 'pending') pending++;
        if (r.recordBadge === 'conflict') conflicts++;
      }
    }

    return { pending, conflicts, deleted };
  }, [records]);

  // Filter & Search records
  const filteredRecords = useMemo(() => {
    return records.filter((r) => {
      // Deleted filtering
      if (filter === 'deleted') {
        if (!r.state.deleted) return false;
      } else {
        if (r.state.deleted) return false;
      }

      // Chip filtering
      if (filter === 'pending' && r.recordBadge !== 'pending') return false;
      if (filter === 'conflicts' && r.recordBadge !== 'conflict') return false;

      // Search query filtering (name, phone, address, notes)
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase().trim();
        const f = r.state.fields;
        const name = String(f.name?.value ?? '').toLowerCase();
        const phone = String(f.phone?.value ?? '').toLowerCase();
        const address = String(f.address?.value ?? '').toLowerCase();
        const notes = String(f.notes?.value ?? '').toLowerCase();
        const id = r.id.toLowerCase();

        return (
          name.includes(q) ||
          phone.includes(q) ||
          address.includes(q) ||
          notes.includes(q) ||
          id.includes(q)
        );
      }

      return true;
    });
  }, [records, filter, searchQuery]);

  return (
    <div className="pane-list" data-testid="records-list-screen">
      {/* Top Search & Actions */}
      <div style={{ display: 'flex', gap: '8px', marginBottom: '12px', alignItems: 'center' }}>
        <div style={{ position: 'relative', flex: 1 }}>
          <Search
            size={18}
            aria-hidden="true"
            style={{
              position: 'absolute',
              left: '12px',
              top: '50%',
              transform: 'translateY(-50%)',
              color: 'var(--text-muted)',
            }}
          />
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search households"
            aria-label="Search households"
            className="form-control"
            style={{ paddingLeft: '38px', minHeight: '40px' }}
            data-testid="search-input"
          />
        </div>
        <button
          className="btn btn-primary"
          onClick={onOpenNewModal}
          data-testid="new-household-btn"
          title="Add new household"
        >
          <Plus size={16} aria-hidden="true" />
          <span>New household</span>
        </button>
      </div>

      {/* Filter Chips */}
      <div className="chips-row" role="tablist" aria-label="Record filters">
        <button
          role="tab"
          aria-selected={filter === 'all'}
          className={`chip ${filter === 'all' ? 'active' : ''}`}
          onClick={() => setFilter('all')}
          data-testid="filter-all"
        >
          All
        </button>
        <button
          role="tab"
          aria-selected={filter === 'pending'}
          className={`chip ${filter === 'pending' ? 'active' : ''}`}
          onClick={() => setFilter('pending')}
          data-testid="filter-pending"
        >
          Pending {counts.pending > 0 ? `(${counts.pending})` : ''}
        </button>
        <button
          role="tab"
          aria-selected={filter === 'conflicts'}
          className={`chip ${filter === 'conflicts' ? 'active' : ''}`}
          onClick={() => setFilter('conflicts')}
          data-testid="filter-conflicts"
        >
          Conflicts {counts.conflicts > 0 ? `(${counts.conflicts})` : ''}
        </button>
        <button
          role="tab"
          aria-selected={filter === 'deleted'}
          className={`chip ${filter === 'deleted' ? 'active' : ''}`}
          onClick={() => setFilter('deleted')}
          data-testid="filter-deleted"
        >
          Deleted {counts.deleted > 0 ? `(${counts.deleted})` : ''}
        </button>
      </div>

      {/* Records Listing */}
      {filteredRecords.length === 0 ? (
        <div className="empty-state" data-testid="empty-state">
          <h2 className="empty-state-title">
            {records.length === 0
              ? 'Start your first household'
              : 'No matching households'}
          </h2>
          <p className="empty-state-desc">
            {records.length === 0
              ? 'Add a household. It saves on this device right away, even offline.'
              : 'Try adjusting your search terms or filters.'}
          </p>
          {records.length === 0 && (
            <button
              className="btn btn-primary"
              onClick={onOpenNewModal}
              data-testid="empty-state-new-btn"
            >
              <Plus size={16} aria-hidden="true" />
              <span>New household</span>
            </button>
          )}
        </div>
      ) : (
        <div role="feed" aria-label="Households list">
          {filteredRecords.map((r) => {
            const isSelected = r.id === selectedRecordId;
            const name = String(r.state.fields.name?.value ?? 'Untitled household');
            const phone = String(r.state.fields.phone?.value ?? '');
            const statusVal = String(r.state.fields.status?.value ?? 'new');
            const author = r.state.fields.name?.userId || 'You';
            const shortId = r.id.replace(/^rec_/, '').slice(0, 4);

            return (
              <div
                key={r.id}
                className={`household-card ${isSelected ? 'selected' : ''}`}
                onClick={() => onSelectRecord(r.id)}
                role="article"
                tabIndex={0}
                onKeyDown={(e: KeyboardEvent) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelectRecord(r.id);
                  }
                }}
                data-testid={`household-card-${r.id}`}
              >
                <div className="household-card-header">
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span className="household-card-title">
                      Household #{shortId} · {name}
                    </span>
                  </div>
                  <div>
                    {r.state.deleted ? (
                      <Badge status="conflict" label="Deleted on this device" />
                    ) : (
                      <Badge status={r.recordBadge} />
                    )}
                  </div>
                </div>

                <div className="household-card-body">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span className="household-card-meta">
                      {r.state.deleted
                        ? `Deleted by ${r.state.deletedBy?.userId || 'You'}`
                        : `${author} · status: ${statusVal} ${phone ? `· ${phone}` : ''}`}
                    </span>
                    {r.state.deleted && (
                      <button
                        className="btn btn-secondary"
                        style={{ minHeight: '32px', padding: '2px 8px', fontSize: '12px' }}
                        onClick={(e) => {
                          e.stopPropagation();
                          onRestoreRecord(r.id);
                        }}
                        data-testid={`restore-btn-${r.id}`}
                      >
                        <RotateCcw size={14} aria-hidden="true" />
                        <span>Restore</span>
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
