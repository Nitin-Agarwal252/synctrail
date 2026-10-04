import { type Op, type ApplyResult, type Conflict, type RecordState, type FieldValue } from '@synctrail/shared';
import { SyncTrailDb, db as defaultDb, type OutboxOp } from '../db';
import { ConnectivityManager, connectivity as defaultConnectivity } from './connectivity';
import { TabLock, tabLock as defaultTabLock } from './tabLock';

export type SyncState = 'synced' | 'syncing' | 'offline' | 'retrying';

export interface PullResponse {
  records: (RecordState & { seq: number })[];
  conflicts: (Conflict & { seq?: number })[];
  seq: number;
}

export class SyncPushError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.name = 'SyncPushError';
    this.status = status;
    this.body = body;
  }
}

export function isClientPushError(err: unknown): err is SyncPushError {
  return err instanceof SyncPushError && err.status >= 400 && err.status < 500;
}

function clientPushErrorReason(err: unknown): string {
  if (err instanceof SyncPushError) {
    if (err.body && typeof err.body === 'object' && err.body !== null && 'error' in err.body) {
      const msg = (err.body as { error: unknown }).error;
      if (typeof msg === 'string' && msg.length > 0) return msg;
    }
    return err.message;
  }
  return 'http-4xx';
}

export const UNKNOWN_RECORD_MAX_ATTEMPTS = 5;

export type PushAccounting = {
  accepted: number;
  conflicted: number;
  queued: number;
  deadLettered: number;
};

export function accountingHolds(
  submitted: number,
  acc: PushAccounting
): boolean {
  return submitted === acc.accepted + acc.conflicted + acc.queued + acc.deadLettered;
}

export interface SyncTransport {
  push(
    deviceId: string,
    userId: string,
    ops: Op[]
  ): Promise<{ results: ApplyResult[]; seq: number }>;
  pull(since: number): Promise<PullResponse>;
  preview?(ops: Op[]): Promise<{ results: ApplyResult[] }>;
  resolveConflict?(
    conflictId: string,
    body: {
      choice: 'mine' | 'theirs' | 'custom';
      value?: FieldValue;
      userId: string;
      deviceId: string;
      opId: string;
      hlc: string;
    }
  ): Promise<{ ok: boolean }>;
  connectWs?(onHint: (seq: number) => void): () => void;
}

export class HttpSyncTransport implements SyncTransport {
  constructor(private baseUrl = '') {}

  async push(
    deviceId: string,
    userId: string,
    ops: Op[]
  ): Promise<{ results: ApplyResult[]; seq: number }> {
    const res = await fetch(`${this.baseUrl}/api/sync/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId, userId, ops }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new SyncPushError(
        res.status,
        typeof err.error === 'string' ? err.error : `Push failed with status ${res.status}`,
        err
      );
    }

    return await res.json();
  }

  async pull(since: number): Promise<PullResponse> {
    const res = await fetch(`${this.baseUrl}/api/sync/pull?since=${since}`, {
      method: 'GET',
      headers: { 'Cache-Control': 'no-cache' },
    });

    if (!res.ok) {
      throw new Error(`Pull failed with status ${res.status}`);
    }

    return await res.json();
  }

  async preview(ops: Op[]): Promise<{ results: ApplyResult[] }> {
    const res = await fetch(`${this.baseUrl}/api/sync/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ops }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || `Preview failed with status ${res.status}`);
    }

    return await res.json();
  }

  async resolveConflict(
    conflictId: string,
    body: {
      choice: 'mine' | 'theirs' | 'custom';
      value?: FieldValue;
      userId: string;
      deviceId: string;
      opId: string;
      hlc: string;
    }
  ): Promise<{ ok: boolean }> {
    const res = await fetch(`${this.baseUrl}/api/conflicts/${conflictId}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || `Resolve failed with status ${res.status}`);
    }

    return await res.json();
  }

  connectWs(onHint: (seq: number) => void): () => void {
    if (typeof window === 'undefined') return () => {};

    let ws: WebSocket | null = null;
    let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
    let isDisposed = false;

    const connect = () => {
      if (isDisposed) return;
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const url = `${protocol}//${window.location.host}/ws`;

      try {
        ws = new WebSocket(url);

        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            if (data && data.type === 'changed') {
              onHint(data.seq ?? 0);
            }
          } catch {
            // Ignore malformed WS message
          }
        };

        ws.onclose = () => {
          if (!isDisposed) {
            reconnectTimeout = setTimeout(connect, 3000);
          }
        };

        ws.onerror = () => {
          ws?.close();
        };
      } catch {
        if (!isDisposed) {
          reconnectTimeout = setTimeout(connect, 3000);
        }
      }
    };

    connect();

    return () => {
      isDisposed = true;
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      if (ws) ws.close();
    };
  }
}

export interface SyncEngineOptions {
  db?: SyncTrailDb;
  transport?: SyncTransport;
  connectivity?: ConnectivityManager;
  tabLock?: TabLock;
  batchSize?: number;
}

export class SyncEngine {
  private db: SyncTrailDb;
  private transport: SyncTransport;
  private connectivity: ConnectivityManager;
  private tabLock: TabLock;
  private batchSize: number;

  private state: SyncState = 'synced';
  private retryCountdown = 0;
  private retryAttempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private countdownInterval: ReturnType<typeof setInterval> | null = null;
  private stateListeners = new Set<(state: SyncState, retrySecs: number) => void>();

  private isRunningLoop = false;
  private isSyncing = false;
  private wsUnsubscribe: (() => void) | null = null;
  private connectivityUnsubscribe: (() => void) | null = null;

  constructor(options: SyncEngineOptions = {}) {
    this.db = options.db ?? defaultDb;
    this.transport = options.transport ?? new HttpSyncTransport();
    this.connectivity = options.connectivity ?? defaultConnectivity;
    this.tabLock = options.tabLock ?? defaultTabLock;
    this.batchSize = options.batchSize ?? 50;

    this.state = this.connectivity.isOnline() ? 'synced' : 'offline';
  }

  getState(): { state: SyncState; retryCountdown: number } {
    return { state: this.state, retryCountdown: this.retryCountdown };
  }

  onStateChange(listener: (state: SyncState, retrySecs: number) => void): () => void {
    this.listenersNotify(listener);
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  private listenersNotify(listener?: (state: SyncState, retrySecs: number) => void) {
    if (listener) {
      listener(this.state, this.retryCountdown);
    } else {
      for (const l of this.stateListeners) {
        l(this.state, this.retryCountdown);
      }
    }
  }

  private setState(state: SyncState, retrySecs = 0) {
    this.state = state;
    this.retryCountdown = retrySecs;
    this.listenersNotify();
  }

  start(): void {
    if (this.isRunningLoop) return;
    this.isRunningLoop = true;

    // Listen to network changes
    this.connectivityUnsubscribe = this.connectivity.onStatusChange((isOnline) => {
      if (!isOnline) {
        this.clearRetry();
        this.setState('offline');
      } else {
        if (this.state === 'offline') {
          this.setState('synced');
          this.triggerSync();
        }
      }
    });

    // Acquire Leader Lock for multi-tab coordination
    this.tabLock.requestLock(async () => {
      // Connect WebSocket for push hints
      if (this.transport.connectWs) {
        this.wsUnsubscribe = this.transport.connectWs(() => {
          this.pull();
        });
      }

      // Initial sync
      await this.triggerSync();

      // Keep running until leader is released
      await new Promise<void>((resolve) => {
        const checkActive = setInterval(() => {
          if (!this.isRunningLoop) {
            clearInterval(checkActive);
            resolve();
          }
        }, 1000);
      });
    });
  }

  stop(): void {
    this.isRunningLoop = false;
    this.clearRetry();
    this.tabLock.release();
    if (this.wsUnsubscribe) {
      this.wsUnsubscribe();
      this.wsUnsubscribe = null;
    }
    if (this.connectivityUnsubscribe) {
      this.connectivityUnsubscribe();
      this.connectivityUnsubscribe = null;
    }
  }

  private clearRetry() {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.countdownInterval) {
      clearInterval(this.countdownInterval);
      this.countdownInterval = null;
    }
    this.retryCountdown = 0;
  }

  private scheduleRetry() {
    this.clearRetry();
    this.retryAttempt++;
    // Exponential backoff: 1s, 2s, 4s, 8s, 16s, max 30s
    const delaySecs = Math.min(30, Math.pow(2, this.retryAttempt - 1));
    this.retryCountdown = delaySecs;
    this.setState('retrying', delaySecs);

    this.countdownInterval = setInterval(() => {
      if (this.retryCountdown > 1) {
        this.retryCountdown--;
        this.setState('retrying', this.retryCountdown);
      }
    }, 1000);

    this.retryTimer = setTimeout(async () => {
      this.clearRetry();
      await this.triggerSync();
    }, delaySecs * 1000);
  }

  async triggerSync(): Promise<void> {
    if (!this.connectivity.isOnline()) {
      this.setState('offline');
      return;
    }

    if (this.isSyncing) return;
    this.isSyncing = true;
    this.setState('syncing');

    try {
      // 1. Push pending local ops first
      await this.pushAll();

      // 2. Pull remote changes
      await this.pull();
      await this.sweepUnknownAfterPull();

      // Reset retry on success
      this.retryAttempt = 0;
      this.clearRetry();
      this.setState('synced');
    } catch {
      if (!this.connectivity.isOnline()) {
        this.setState('offline');
      } else {
        this.scheduleRetry();
      }
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * Pushes pending ops from the outbox in batches of max 50.
   * Inspects every per-op result. Never deletes a whole batch blindly.
   * Each outbox row is offered to the server at most once per call.
   */
  async pushAll(): Promise<number> {
    let removed = 0;
    const { deviceId, userId } = await this.db.initMeta();
    const considered = new Set<string>();

    while (true) {
      const pending = await this.db.outbox.orderBy('n').toArray();
      const batch = pending.filter((b) => !considered.has(b.opId)).slice(0, this.batchSize);
      if (batch.length === 0) break;

      for (const b of batch) considered.add(b.opId);
      const ops: Op[] = batch.map((b) => this.db.toWireOp(b));

      try {
        const res = await this.transport.push(deviceId, userId, ops);
        removed += await this.applyPushResults(batch, res.results);
      } catch (err) {
        if (isClientPushError(err) && batch.length > 1) {
          for (const item of batch) {
            try {
              const oneRes = await this.transport.push(deviceId, userId, [this.db.toWireOp(item)]);
              removed += await this.applyPushResults([item], oneRes.results);
            } catch (oneErr) {
              if (isClientPushError(oneErr)) {
                await this.moveToDeadLetter(item, clientPushErrorReason(oneErr));
                removed += 1;
              } else {
                throw oneErr;
              }
            }
          }
          continue;
        }
        if (isClientPushError(err) && batch.length === 1) {
          await this.moveToDeadLetter(batch[0], clientPushErrorReason(err));
          removed += 1;
          continue;
        }
        throw err;
      }
    }

    return removed;
  }

  /**
   * Apply per-op push results. Returns how many rows left the outbox
   * (accepted, conflicted, or dead-lettered).
   */
  async applyPushResults(batch: OutboxOp[], results: ApplyResult[]): Promise<number> {
    let removed = 0;
    for (let i = 0; i < batch.length; i++) {
      const item = batch[i];
      const result = results[i];
      if (!result) continue;

      const status = result.status;
      if (status === 'applied' || status === 'noop' || status === 'duplicate') {
        await this.db.outbox.where('opId').equals(item.opId).delete();
        removed += 1;
        continue;
      }
      if (status === 'conflict') {
        await this.db.outbox.where('opId').equals(item.opId).delete();
        removed += 1;
        continue;
      }
      if (status === 'rejected') {
        const reason = result.reason ?? 'rejected';
        if (reason === 'unknown-record') {
          const attempts = (item.pushAttempts ?? 0) + 1;
          const inSnapshot = await this.db.snapshot.get(item.recordId);
          const remaining = await this.db.outbox.toArray();
          const hasCreateQueued = remaining.some(
            (o) => o.recordId === item.recordId && o.type === 'create' && o.opId !== item.opId
          );
          // Local snapshot of a record the server no longer has (e.g. /api/dev/reset).
          const staleSnapshot = Boolean(inSnapshot) && !hasCreateQueued;
          if (attempts >= UNKNOWN_RECORD_MAX_ATTEMPTS || staleSnapshot) {
            await this.moveToDeadLetter(item, reason, attempts);
            removed += 1;
          } else {
            await this.db.outbox.where('opId').equals(item.opId).modify({
              pushAttempts: attempts,
              lastRejectReason: reason,
            });
            item.pushAttempts = attempts;
            item.lastRejectReason = reason;
          }
        } else {
          await this.moveToDeadLetter(item, reason, item.pushAttempts ?? 0);
          removed += 1;
        }
      }
    }
    return removed;
  }

  /**
   * After a pull: unknown-record ops whose record is still missing (and have no
   * queued create) move to the dead-letter. Nothing is deleted silently.
   */
  async sweepUnknownAfterPull(): Promise<void> {
    const outbox = await this.db.outbox.toArray();
    for (const item of outbox) {
      if (item.type === 'create') continue;
      if ((item.lastRejectReason ?? '') !== 'unknown-record' && (item.pushAttempts ?? 0) === 0) {
        continue;
      }
      const snap = await this.db.snapshot.get(item.recordId);
      const hasCreate = outbox.some((o) => o.recordId === item.recordId && o.type === 'create');
      if (!snap && !hasCreate) {
        await this.moveToDeadLetter(item, item.lastRejectReason ?? 'unknown-record', item.pushAttempts ?? 0);
      }
    }
  }

  async moveToDeadLetter(item: OutboxOp, reason: string, attempts?: number): Promise<void> {
    const op = this.db.toWireOp(item);
    await this.db.transaction('rw', [this.db.outbox, this.db.deadOps], async () => {
      await this.db.deadOps.add({
        opId: item.opId,
        recordId: item.recordId,
        reason,
        op,
        deadLetteredAt: Date.now(),
        attempts: attempts ?? item.pushAttempts ?? 0,
      });
      await this.db.outbox.where('opId').equals(item.opId).delete();
    });
  }

  async retryDeadOp(opId: string): Promise<void> {
    const row = await this.db.deadOps.where('opId').equals(opId).first();
    if (!row) return;
    await this.db.transaction('rw', [this.db.deadOps, this.db.outbox], async () => {
      await this.db.outbox.add({
        ...row.op,
        pushAttempts: 0,
        lastRejectReason: undefined,
      });
      await this.db.deadOps.where('opId').equals(opId).delete();
    });
    await this.triggerSync();
  }

  async discardDeadOp(opId: string): Promise<void> {
    await this.db.deadOps.where('opId').equals(opId).delete();
  }

  async collectAccounting(submitted: number): Promise<PushAccounting & { submitted: number; holds: boolean }> {
    const queued = await this.db.outbox.count();
    const deadLettered = await this.db.deadOps.count();
    const acceptedAndConflicted = Math.max(0, submitted - queued - deadLettered);
    const acc: PushAccounting = {
      accepted: acceptedAndConflicted,
      conflicted: 0,
      queued,
      deadLettered,
    };
    return { submitted, ...acc, holds: submitted === queued + deadLettered + acceptedAndConflicted };
  }

  /**
   * Pulls remote changes incrementally since cursor.
   */
  async pull(): Promise<PullResponse> {
    const cursorStr = await this.db.getMeta('cursor');
    const cursor = cursorStr ? Number(cursorStr) : 0;

    const res = await this.transport.pull(cursor);

    await this.db.transaction(
      'rw',
      [this.db.snapshot, this.db.conflicts, this.db.meta],
      async () => {
        // Upsert snapshot records
        for (const record of res.records) {
          await this.db.snapshot.put(record);
        }

        // Upsert conflicts
        for (const conflict of res.conflicts) {
          await this.db.conflicts.put(conflict);
        }

        // Update cursor and lastSyncedAt
        await this.db.setMeta('cursor', String(res.seq));
        await this.db.setMeta('lastSyncedAt', new Date().toISOString());
      }
    );

    return res;
  }

  /**
   * Dry run of pending outbox ops using POST /api/sync/preview. Never persists.
   */
  async preview(): Promise<{ results: ApplyResult[]; ops: Op[] }> {
    const batch = await this.db.outbox.orderBy('n').toArray();
    if (batch.length === 0) {
      return { results: [], ops: [] };
    }
    const ops: Op[] = batch.map((b) => ({
      opId: b.opId,
      deviceId: b.deviceId,
      userId: b.userId,
      recordId: b.recordId,
      type: b.type,
      fields: b.fields,
      field: b.field,
      value: b.value,
      baseHlc: b.baseHlc,
      seen: b.seen,
      hlc: b.hlc,
    }));

    if (this.transport.preview) {
      const res = await this.transport.preview(ops);
      return { results: res.results, ops };
    }
    return { results: [], ops };
  }

  /**
   * Resolves a conflict via POST /api/conflicts/:id/resolve.
   */
  async resolveConflict(
    conflictId: string,
    choice: 'mine' | 'theirs' | 'custom',
    value?: FieldValue,
    userId?: string
  ): Promise<void> {
    const meta = await this.db.initMeta();
    const effectiveUserId = userId || meta.userId;
    const opHlc = await this.db.tickClock(meta.deviceId);
    const opId = `op_resolve_${crypto.randomUUID()}`;

    if (this.transport.resolveConflict) {
      await this.transport.resolveConflict(conflictId, {
        choice,
        value,
        userId: effectiveUserId,
        deviceId: meta.deviceId,
        opId,
        hlc: opHlc,
      });

      // Update local conflict status in Dexie immediately so UI reflects it without delay
      await this.db.conflicts.update(conflictId, { status: 'resolved' });

      // Immediate pull to sync latest record snapshot and audit
      await this.pull();
    }
  }
}

import { ChaosTransport } from './chaosTransport';

export const httpTransport = new HttpSyncTransport();
export const chaosTransport = new ChaosTransport(httpTransport);
export const syncEngine = new SyncEngine({ transport: chaosTransport });
