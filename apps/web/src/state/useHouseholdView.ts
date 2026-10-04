import { useState, useEffect } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, OutboxOp, ClientConflict } from '../db';
import { RecordState, applyOptimistic, FieldValue } from '@synctrail/shared';
import { syncEngine, SyncState, SERVER_RESET_NOTICE_KEY } from '../sync/engine';
import { connectivity } from '../sync/connectivity';

export interface DerivedRecord {
  id: string;
  state: RecordState;
  hasOutbox: boolean;
  hasConflict: boolean;
  fieldBadges: Record<string, 'pending' | 'synced' | 'conflict' | 'local-only'>;
  recordBadge: 'pending' | 'synced' | 'conflict' | 'local-only';
  pendingOpCount: number;
}

export function useHouseholdView() {
  const [userId, setUserId] = useState<string>('Meera');
  const [deviceId, setDeviceId] = useState<string>('');
  const [syncState, setSyncState] = useState<SyncState>(
    connectivity.isOnline() ? 'synced' : 'offline'
  );
  const [retryCountdown, setRetryCountdown] = useState<number>(0);

  useEffect(() => {
    db.initMeta().then((meta) => {
      setUserId(meta.userId);
      setDeviceId(meta.deviceId);
    });

    connectivity.start();
    syncEngine.start();

    const unsubState = syncEngine.onStateChange((state, secs) => {
      setSyncState(state);
      setRetryCountdown(secs);
    });

    return () => {
      unsubState();
    };
  }, []);

  const metaData = useLiveQuery(async () => {
    const lastSynced = await db.getMeta('lastSyncedAt');
    const resetNotice = await db.getMeta(SERVER_RESET_NOTICE_KEY);
    return { lastSynced, serverResetUnsynced: resetNotice === null ? null : Number(resetNotice) };
  }, []);

  const data = useLiveQuery(async () => {
    const snapshots = await db.snapshot.toArray();
    const outboxOps = await db.outbox.orderBy('n').toArray();
    const conflicts = await db.conflicts.toArray();
    const opLog = await db.opLog.orderBy('n').toArray();
    const deadOps = await db.deadOps.orderBy('n').toArray();

    // Map snapshots
    const recordMap = new Map<string, RecordState>();
    const snapshotIds = new Set<string>();

    for (const s of snapshots) {
      snapshotIds.add(s.id);
      recordMap.set(s.id, {
        id: s.id,
        fields: { ...s.fields },
        deleted: s.deleted,
        deletedHlc: s.deletedHlc,
        deletedBy: s.deletedBy,
        version: s.version,
      });
    }

    // Track per-record and per-field outbox modifications
    const outboxByRecord = new Map<string, OutboxOp[]>();
    const modifiedFieldsByRecord = new Map<string, Set<string>>();

    for (const op of outboxOps) {
      const list = outboxByRecord.get(op.recordId) || [];
      list.push(op);
      outboxByRecord.set(op.recordId, list);

      if (op.type === 'set' && op.field) {
        const fields = modifiedFieldsByRecord.get(op.recordId) || new Set<string>();
        fields.add(op.field);
        modifiedFieldsByRecord.set(op.recordId, fields);
      } else if (op.type === 'create' && op.fields) {
        const fields = modifiedFieldsByRecord.get(op.recordId) || new Set<string>();
        for (const k of Object.keys(op.fields)) {
          fields.add(k);
        }
        modifiedFieldsByRecord.set(op.recordId, fields);
      }

      // Apply optimistic update
      const current = recordMap.get(op.recordId);
      const updated = applyOptimistic(current, op);
      if (updated) {
        recordMap.set(op.recordId, updated);
      }
    }

    // Filter only open conflicts
    const openConflicts = conflicts.filter((c) => c.status === 'open');

    // Map conflicts by record
    const conflictsByRecord = new Map<string, ClientConflict[]>();
    for (const c of openConflicts) {
      const list = conflictsByRecord.get(c.recordId) || [];
      list.push(c);
      conflictsByRecord.set(c.recordId, list);
    }

    // Build derived record items
    const records: DerivedRecord[] = [];
    for (const [id, state] of recordMap.entries()) {
      const recordOutbox = outboxByRecord.get(id) || [];
      const recordConflicts = conflictsByRecord.get(id) || [];
      const modifiedFields = modifiedFieldsByRecord.get(id) || new Set<string>();
      const isLocalOnly = !snapshotIds.has(id);

      const fieldBadges: Record<string, 'pending' | 'synced' | 'conflict' | 'local-only'> = {};
      for (const fieldName of Object.keys(state.fields)) {
        const hasFieldConflict = recordConflicts.some(
          (c) =>
            c.field === fieldName ||
            ((c.kind === 'edit-vs-delete' || c.kind === 'delete-vs-edit') &&
              (c.field === fieldName || !c.field))
        );
        if (hasFieldConflict) {
          fieldBadges[fieldName] = 'conflict';
        } else if (modifiedFields.has(fieldName)) {
          fieldBadges[fieldName] = 'pending';
        } else if (isLocalOnly) {
          fieldBadges[fieldName] = 'pending'; // Everything local shows pending until synced
        } else {
          fieldBadges[fieldName] = 'synced';
        }
      }

      let recordBadge: 'pending' | 'synced' | 'conflict' | 'local-only' = 'synced';
      if (recordConflicts.length > 0) {
        recordBadge = 'conflict';
      } else if (recordOutbox.length > 0 || isLocalOnly) {
        recordBadge = 'pending';
      }

      records.push({
        id,
        state,
        hasOutbox: recordOutbox.length > 0,
        hasConflict: recordConflicts.length > 0,
        fieldBadges,
        recordBadge,
        pendingOpCount: recordOutbox.length,
      });
    }

    // Sort by version / most recently updated
    records.sort((a, b) => b.state.version.localeCompare(a.state.version));

    return {
      records,
      outboxOps,
      conflicts: openConflicts,
      allConflicts: conflicts,
      opLog,
      outboxCount: outboxOps.length,
      conflictCount: openConflicts.length,
      deadOps,
      deadCount: deadOps.length,
    };
  }, []);

  const switchUser = async (newUserId: string) => {
    await db.setMeta('userId', newUserId);
    setUserId(newUserId);
  };

  const triggerSync = async () => {
    await syncEngine.triggerSync();
  };

  const resolveConflict = async (
    conflictId: string,
    choice: 'mine' | 'theirs' | 'custom',
    value?: unknown
  ) => {
    await syncEngine.resolveConflict(conflictId, choice, value as FieldValue, userId);
  };

  const previewSync = async () => {
    return await syncEngine.preview();
  };

  const retryDeadOp = async (opId: string) => {
    await syncEngine.retryDeadOp(opId);
  };

  const discardDeadOp = async (opId: string) => {
    await syncEngine.discardDeadOp(opId);
  };

  const dismissServerReset = async () => {
    await syncEngine.dismissServerResetNotice();
  };

  return {
    records: data?.records ?? [],
    outboxOps: data?.outboxOps ?? [],
    conflicts: data?.conflicts ?? [],
    allConflicts: data?.allConflicts ?? [],
    opLog: data?.opLog ?? [],
    outboxCount: data?.outboxCount ?? 0,
    conflictCount: data?.conflictCount ?? 0,
    deadOps: data?.deadOps ?? [],
    deadCount: data?.deadCount ?? 0,
    userId,
    deviceId,
    syncState,
    retryCountdown,
    lastSyncedAt: metaData?.lastSynced ?? null,
    serverResetUnsynced: metaData?.serverResetUnsynced ?? null,
    dismissServerReset,
    switchUser,
    triggerSync,
    resolveConflict,
    previewSync,
    retryDeadOp,
    discardDeadOp,
  };
}
