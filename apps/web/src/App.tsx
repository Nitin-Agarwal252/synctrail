import { useState, useEffect } from 'react';
import { db } from './db';
import { useHouseholdView } from './state/useHouseholdView';
import { AppHeader } from './components/AppHeader';
import { OfflineBanner } from './components/OfflineBanner';
import { RecordsList } from './components/RecordsList';
import { RecordDetail } from './components/RecordDetail';
import { NewHouseholdModal } from './components/NewHouseholdModal';
import { Toast } from './components/Toast';
import { ConflictInbox } from './components/ConflictInbox';
import { SyncPreviewModal } from './components/SyncPreviewModal';
import { DeadLetterBanner } from './components/DeadLetterBanner';
import { ServerResetNotice } from './components/ServerResetNotice';
import { DashboardPage } from './pages/DashboardPage';
import { ChaosPage } from './pages/ChaosPage';

type Route = 'records' | 'conflicts' | 'dashboard' | 'chaos';

function getHashRoute(): Route {
  const hash = window.location.hash.replace('#/', '');
  if (hash === 'conflicts') return 'conflicts';
  if (hash === 'dashboard') return 'dashboard';
  if (hash === 'chaos') return 'chaos';
  return 'records';
}

export function App() {
  const {
    records,
    outboxOps,
    outboxCount,
    conflicts,
    conflictCount,
    deadOps,
    userId,
    syncState,
    retryCountdown,
    lastSyncedAt,
    serverResetUnsynced,
    dismissServerReset,
    switchUser,
    triggerSync,
    resolveConflict,
    previewSync,
    retryDeadOp,
    discardDeadOp,
  } = useHouseholdView();

  const [route, setRoute] = useState<Route>(getHashRoute());
  const [selectedRecordId, setSelectedRecordId] = useState<string | null>(null);
  const [isNewModalOpen, setIsNewModalOpen] = useState(false);
  const [isSyncPreviewOpen, setIsSyncPreviewOpen] = useState(false);
  const [toast, setToast] = useState<{
    id: string;
    message: string;
    actionText?: string;
    onAction?: () => void;
  } | null>(null);

  // Responsive state for screen width
  const [isDesktop, setIsDesktop] = useState<boolean>(
    typeof window !== 'undefined' ? window.innerWidth >= 1024 : true
  );

  useEffect(() => {
    const handleResize = () => setIsDesktop(window.innerWidth >= 1024);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Hash-based routing: sync hash → state and state → hash
  useEffect(() => {
    const onHashChange = () => setRoute(getHashRoute());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const navigate = (r: Route) => {
    window.location.hash = r === 'records' ? '/' : `/${r}`;
    setRoute(r);
  };

  // The AppHeader only shows tabs for Records and Conflicts; Dashboard/Chaos are in a menu
  const activeTab: 'records' | 'conflicts' =
    route === 'conflicts' ? 'conflicts' : 'records';

  const onSelectTab = (tab: 'records' | 'conflicts') => {
    navigate(tab);
  };

  const selectedRecord = records.find((r) => r.id === selectedRecordId) || null;

  const handleCreateHousehold = async (fields: {
    name: string;
    phone: string;
    address: string;
    status: 'new' | 'follow-up' | 'completed';
    notes: string;
  }) => {
    const id = await db.createHousehold(fields, userId);
    triggerSync().catch(() => {});
    return id;
  };

  const handleUpdateField = async (recordId: string, field: string, value: string) => {
    await db.updateField(recordId, field, value, userId);
    triggerSync().catch(() => {});
  };

  const handleDeleteHousehold = async (recordId: string) => {
    await db.deleteHousehold(recordId, userId);
    triggerSync().catch(() => {});
    setToast({
      id: `toast_${Date.now()}`,
      message: 'Household deleted. Undo',
      actionText: 'Undo',
      onAction: async () => {
        await db.restoreHousehold(recordId, userId);
        triggerSync().catch(() => {});
      },
    });
  };

  const handleRestoreHousehold = async (recordId: string) => {
    await db.restoreHousehold(recordId, userId);
    triggerSync().catch(() => {});
  };

  return (
    <div className="app-container">
      {/* Skip to main content — keyboard / screen-reader nav */}
      <a href="#main-content" className="skip-link">Skip to main content</a>

      {/* Top Bar Shell */}
      <AppHeader
        outboxCount={outboxCount}
        conflictCount={conflictCount}
        currentUserId={userId}
        syncState={syncState}
        retryCountdown={retryCountdown}
        lastSyncedAt={lastSyncedAt}
        activeTab={activeTab}
        onSelectTab={onSelectTab}
        onSwitchUser={switchUser}
        onTriggerSync={triggerSync}
        onOpenSyncPreview={() => setIsSyncPreviewOpen(true)}
        onNavigate={navigate}
        activeRoute={route}
      />

      {/* Offline Banner */}
      <OfflineBanner />

      <ServerResetNotice
        unsynced={serverResetUnsynced}
        onDismiss={() => {
          dismissServerReset().catch(() => {});
        }}
      />

      <DeadLetterBanner
        deadOps={deadOps}
        onRetry={(opId) => {
          retryDeadOp(opId).catch(() => {});
        }}
        onDiscard={(opId) => {
          discardDeadOp(opId).catch(() => {});
        }}
      />

      {/* Main Content Layout */}
      <main className="main-layout" id="main-content" tabIndex={-1}>
        {route === 'dashboard' && <DashboardPage />}

        {route === 'chaos' && <ChaosPage />}

        {route === 'conflicts' && (
          <ConflictInbox
            conflicts={conflicts}
            currentUserId={userId}
            onResolve={resolveConflict}
            onBackToRecords={() => navigate('records')}
          />
        )}

        {route === 'records' && (
          <>
            {(!selectedRecordId || isDesktop) && (
              <RecordsList
                records={records}
                selectedRecordId={selectedRecordId}
                onSelectRecord={(id) => setSelectedRecordId(id)}
                onOpenNewModal={() => setIsNewModalOpen(true)}
                onRestoreRecord={handleRestoreHousehold}
              />
            )}

            {(selectedRecordId || isDesktop) && (
              <RecordDetail
                record={selectedRecord}
                outboxOps={outboxOps}
                currentUserId={userId}
                onBack={() => setSelectedRecordId(null)}
                onUpdateField={handleUpdateField}
                onDeleteHousehold={handleDeleteHousehold}
                onRestoreHousehold={handleRestoreHousehold}
                onReviewConflict={(_recordId, _fieldName) => {
                  navigate('conflicts');
                }}
              />
            )}
          </>
        )}
      </main>

      {/* New Household Modal */}
      <NewHouseholdModal
        isOpen={isNewModalOpen}
        onClose={() => setIsNewModalOpen(false)}
        onCreate={handleCreateHousehold}
        onCreated={(newId) => setSelectedRecordId(newId)}
      />

      {/* Sync Preview Modal */}
      <SyncPreviewModal
        isOpen={isSyncPreviewOpen}
        isOnline={syncState !== 'offline'}
        onClose={() => setIsSyncPreviewOpen(false)}
        onTriggerSync={triggerSync}
        onPreview={previewSync}
      />

      {/* Undo Toast */}
      {toast && (
        <Toast
          key={toast.id}
          message={toast.message}
          actionText={toast.actionText}
          onAction={toast.onAction}
          onDismiss={() => setToast(null)}
          durationMs={8000}
        />
      )}
    </div>
  );
}

export default App;
