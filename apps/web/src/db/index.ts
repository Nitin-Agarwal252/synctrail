import Dexie, { Table } from 'dexie';
import {
  type Op,
  type RecordState,
  type Conflict,
  type FieldValue,
  hlc,
  seenOf,
  applyOptimistic,
} from '@synctrail/shared';

export interface SnapshotRecord extends RecordState {
  seq: number;
}

export interface OutboxOp extends Op {
  n?: number;
  /** Successful HTTP responses that returned rejected:unknown-record. */
  pushAttempts?: number;
  lastRejectReason?: string;
}

export interface DeadOp {
  n?: number;
  opId: string;
  recordId: string;
  reason: string;
  op: Op;
  deadLetteredAt: number;
  attempts: number;
}

export interface ClientConflict extends Conflict {
  seq?: number;
}

export interface OpLogEntry {
  n?: number;
  opId: string;
  recordId: string;
  type: Op['type'];
  hlc: string;
  timestamp: number;
}

export interface MetaEntry {
  key: string;
  value: string;
}

export class SyncTrailDb extends Dexie {
  snapshot!: Table<SnapshotRecord, string>;
  outbox!: Table<OutboxOp, number>;
  conflicts!: Table<ClientConflict, string>;
  opLog!: Table<OpLogEntry, number>;
  meta!: Table<MetaEntry, string>;
  deadOps!: Table<DeadOp, number>;

  constructor(dbName = 'synctrail_db') {
    super(dbName);

    // Schema per docs/04_DATA_MODEL_AND_SYNC_PROTOCOL.md
    this.version(1).stores({
      snapshot: 'id, seq',
      outbox: '++n, opId, recordId',
      conflicts: 'id, recordId, status',
      opLog: '++n, opId',
      meta: 'key',
    });

    // R1: dead-letter table. Existing outbox rows are preserved (additive upgrade).
    this.version(2).stores({
      snapshot: 'id, seq',
      outbox: '++n, opId, recordId',
      conflicts: 'id, recordId, status',
      opLog: '++n, opId',
      meta: 'key',
      deadOps: '++n, opId, recordId',
    });
  }

  toWireOp(row: OutboxOp): Op {
    return {
      opId: row.opId,
      deviceId: row.deviceId,
      userId: row.userId,
      recordId: row.recordId,
      type: row.type,
      fields: row.fields,
      field: row.field,
      value: row.value,
      baseHlc: row.baseHlc,
      seen: row.seen,
      hlc: row.hlc,
    };
  }

  async getMeta(key: string): Promise<string | null> {
    const entry = await this.meta.get(key);
    return entry ? entry.value : null;
  }

  async setMeta(key: string, value: string): Promise<void> {
    await this.meta.put({ key, value });
  }

  async initMeta(): Promise<{ deviceId: string; userId: string }> {
    let deviceId = await this.getMeta('deviceId');
    if (!deviceId) {
      deviceId = `dev_${crypto.randomUUID().slice(0, 8)}`;
      await this.setMeta('deviceId', deviceId);
    }

    let userId = await this.getMeta('userId');
    if (!userId) {
      userId = 'Meera';
      await this.setMeta('userId', userId);
    }

    return { deviceId, userId };
  }

  async tickClock(deviceId: string): Promise<string> {
    const curHlc = await this.getMeta('hlc');
    const nextHlc = hlc.tick(curHlc, deviceId, Date.now());
    await this.setMeta('hlc', nextHlc);
    return nextHlc;
  }

  async createHousehold(
    fields: {
      name: string;
      phone: string;
      address: string;
      status: 'new' | 'follow-up' | 'completed';
      notes: string;
    },
    activeUserId?: string
  ): Promise<string> {
    const meta = await this.initMeta();
    const deviceId = meta.deviceId;
    const userId = activeUserId || meta.userId;
    const recordId = `rec_${crypto.randomUUID()}`;
    const opId = `op_${crypto.randomUUID()}`;

    await this.transaction('rw', [this.outbox, this.opLog, this.meta], async () => {
      const opHlc = await this.tickClock(deviceId);
      const op: OutboxOp = {
        opId,
        deviceId,
        userId,
        recordId,
        type: 'create',
        fields: {
          name: fields.name.trim(),
          phone: fields.phone.trim(),
          address: fields.address.trim(),
          status: fields.status,
          notes: fields.notes.trim(),
        },
        baseHlc: null,
        hlc: opHlc,
      };

      await this.outbox.add(op);
      await this.opLog.add({
        opId,
        recordId,
        type: 'create',
        hlc: opHlc,
        timestamp: Date.now(),
      });
    });

    return recordId;
  }

  async updateField(
    recordId: string,
    field: string,
    value: FieldValue,
    activeUserId?: string
  ): Promise<void> {
    const meta = await this.initMeta();
    const deviceId = meta.deviceId;
    const userId = activeUserId || meta.userId;
    const currentView = await this.deriveViewForRecord(recordId);
    const baseHlc = currentView?.fields[field]?.hlc ?? null;

    // If identical value, don't queue useless duplicate
    if (currentView?.fields[field]?.value === value) {
      return;
    }

    const opId = `op_${crypto.randomUUID()}`;

    await this.transaction('rw', [this.outbox, this.opLog, this.meta], async () => {
      const opHlc = await this.tickClock(deviceId);
      const op: OutboxOp = {
        opId,
        deviceId,
        userId,
        recordId,
        type: 'set',
        field,
        value,
        baseHlc,
        hlc: opHlc,
      };

      await this.outbox.add(op);
      await this.opLog.add({
        opId,
        recordId,
        type: 'set',
        hlc: opHlc,
        timestamp: Date.now(),
      });
    });
  }

  async deleteHousehold(recordId: string, activeUserId?: string): Promise<void> {
    const meta = await this.initMeta();
    const deviceId = meta.deviceId;
    const userId = activeUserId || meta.userId;
    const currentView = await this.deriveViewForRecord(recordId);
    if (!currentView || currentView.deleted) {
      return;
    }

    const seen = seenOf(currentView);
    const opId = `op_${crypto.randomUUID()}`;

    await this.transaction('rw', [this.outbox, this.opLog, this.meta], async () => {
      const opHlc = await this.tickClock(deviceId);
      const op: OutboxOp = {
        opId,
        deviceId,
        userId,
        recordId,
        type: 'delete',
        seen,
        baseHlc: null,
        hlc: opHlc,
      };

      await this.outbox.add(op);
      await this.opLog.add({
        opId,
        recordId,
        type: 'delete',
        hlc: opHlc,
        timestamp: Date.now(),
      });
    });
  }

  async restoreHousehold(recordId: string, activeUserId?: string): Promise<void> {
    const meta = await this.initMeta();
    const deviceId = meta.deviceId;
    const userId = activeUserId || meta.userId;
    const opId = `op_${crypto.randomUUID()}`;

    await this.transaction('rw', [this.outbox, this.opLog, this.meta], async () => {
      const opHlc = await this.tickClock(deviceId);
      const op: OutboxOp = {
        opId,
        deviceId,
        userId,
        recordId,
        type: 'restore',
        baseHlc: null,
        hlc: opHlc,
      };

      await this.outbox.add(op);
      await this.opLog.add({
        opId,
        recordId,
        type: 'restore',
        hlc: opHlc,
        timestamp: Date.now(),
      });
    });
  }

  async deriveViewForRecord(recordId: string): Promise<RecordState | undefined> {
    const snapshot = await this.snapshot.get(recordId);
    let state: RecordState | undefined = snapshot
      ? {
          id: snapshot.id,
          fields: snapshot.fields,
          deleted: snapshot.deleted,
          deletedHlc: snapshot.deletedHlc,
          deletedBy: snapshot.deletedBy,
          version: snapshot.version,
        }
      : undefined;

    const ops = await this.outbox.where('recordId').equals(recordId).sortBy('n');
    for (const op of ops) {
      state = applyOptimistic(state, op);
    }

    return state;
  }

  async deriveAllViews(): Promise<Record<string, RecordState>> {
    const snapshots = await this.snapshot.toArray();
    const views: Record<string, RecordState> = {};

    for (const s of snapshots) {
      views[s.id] = {
        id: s.id,
        fields: s.fields,
        deleted: s.deleted,
        deletedHlc: s.deletedHlc,
        deletedBy: s.deletedBy,
        version: s.version,
      };
    }

    const ops = await this.outbox.orderBy('n').toArray();
    for (const op of ops) {
      views[op.recordId] = applyOptimistic(views[op.recordId], op) as RecordState;
    }

    return views;
  }
}

export const db = new SyncTrailDb();
