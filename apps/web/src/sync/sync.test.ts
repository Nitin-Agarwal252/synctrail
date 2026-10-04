import { describe, it, expect, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { SyncTrailDb } from '../db';
import { SyncEngine, SyncTransport, PullResponse } from './engine';
import { ConnectivityManager } from './connectivity';
import { type Op, type ApplyResult, applyOp, createServerState, ServerState } from '@synctrail/shared';

describe('Sync Engine & Connectivity (Phase 4)', () => {
  let db: SyncTrailDb;
  let serverState: ServerState;
  let serverSeq: number;

  beforeEach(() => {
    db = new SyncTrailDb(`test_sync_db_${Math.random().toString(36).slice(2)}`);
    serverState = createServerState();
    serverSeq = 0;
  });

  // Helper to create a working fake server transport using real shared applyOp
  function createRealTransport(overrides?: Partial<SyncTransport>): SyncTransport {
    const defaultTransport: SyncTransport = {
      async push(_deviceId: string, _userId: string, ops: Op[]) {
        const results: ApplyResult[] = [];
        for (const op of ops) {
          const res = applyOp(serverState, op);
          results.push(res);
          serverSeq++;
        }
        return { results, seq: serverSeq };
      },
      async pull(since: number): Promise<PullResponse> {
        const records = Object.values(serverState.records).map((r) => ({
          ...r,
          seq: serverSeq,
        }));
        return {
          records: since < serverSeq ? records : [],
          conflicts: [],
          seq: serverSeq,
        };
      },
    };

    return { ...defaultTransport, ...overrides };
  }

  it('captive-portal case: onLine true but heartbeat fails -> offline', async () => {
    // navigator.onLine is true, but heartbeat returns redirect or error (e.g. airport wifi login page)
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 302,
      json: () => Promise.resolve({}),
    } as unknown as Response);

    const connectivity = new ConnectivityManager({
      fetchFn: mockFetch,
      getNavigatorOnLine: () => true,
      heartbeatTimeoutMs: 500,
    });

    const isOnline = await connectivity.checkNow();
    expect(isOnline).toBe(false);
    expect(connectivity.isOnline()).toBe(false);
  });

  it('captive-portal case: onLine true and heartbeat succeeds -> online', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ ok: true, seq: 1 }),
    } as unknown as Response);

    const connectivity = new ConnectivityManager({
      fetchFn: mockFetch,
      getNavigatorOnLine: () => true,
      heartbeatTimeoutMs: 500,
    });

    const isOnline = await connectivity.checkNow();
    expect(isOnline).toBe(true);
    expect(connectivity.isOnline()).toBe(true);
  });

  it('response lost after server applied, client retries: no duplicates', async () => {
    // 1. Create a local household
    const recordId = await db.createHousehold({
      name: 'Rao family',
      phone: '98300 11122',
      address: '14 Cross Rd',
      status: 'new',
      notes: '',
    });

    expect(await db.outbox.count()).toBe(1);

    let pushAttempts = 0;
    const transport = createRealTransport({
      async push(_deviceId, _userId, ops) {
        pushAttempts++;
        if (pushAttempts === 1) {
          // Server receives and applies the op, but network drops before response reaches client!
          for (const op of ops) {
            applyOp(serverState, op);
            serverSeq++;
          }
          throw new Error('Network dropped before client received HTTP response');
        }

        // On retry, server handles duplicate opId idempotently (returns 'duplicate')
        const results: ApplyResult[] = [];
        for (const op of ops) {
          results.push(applyOp(serverState, op));
          serverSeq++;
        }
        return { results, seq: serverSeq };
      },
    });

    const connectivity = new ConnectivityManager({
      getNavigatorOnLine: () => true,
      fetchFn: vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ ok: true }),
      } as unknown as Response),
    });

    const engine = new SyncEngine({
      db,
      transport,
      connectivity,
      batchSize: 50,
    });

    // First push attempt fails with network error
    await expect(engine.pushAll()).rejects.toThrow('Network dropped');
    expect(pushAttempts).toBe(1);
    // Ops remain in outbox
    expect(await db.outbox.count()).toBe(1);

    // Second push attempt (retry)
    const pushed = await engine.pushAll();
    expect(pushAttempts).toBe(2);
    expect(pushed).toBe(1);

    // Outbox is now cleared
    expect(await db.outbox.count()).toBe(0);

    // Pull from server and verify single record with no duplication
    await engine.pull();
    const snapshot = await db.snapshot.get(recordId);
    expect(snapshot).toBeDefined();
    expect(snapshot?.fields.name?.value).toBe('Rao family');
  });

  it('drop mid-batch then resume: only remaining ops are sent', async () => {
    // Create 100 ops (2 batches of 50)
    for (let i = 0; i < 100; i++) {
      await db.outbox.add({
        opId: `op_${i}`,
        deviceId: 'dev_test',
        userId: 'Meera',
        recordId: `rec_${i}`,
        type: 'create',
        fields: { name: `Family ${i}` },
        baseHlc: null,
        hlc: `2026-10-04T00:00:00.000Z-0000-dev_test`,
      });
    }

    expect(await db.outbox.count()).toBe(100);

    let batchCount = 0;
    const transport = createRealTransport({
      async push(_deviceId, _userId, ops) {
        batchCount++;
        if (batchCount === 2) {
          // Batch 1 succeeded, but batch 2 drops
          throw new Error('Connection lost during batch 2');
        }
        const results = ops.map((op) => applyOp(serverState, op));
        serverSeq++;
        return { results, seq: serverSeq };
      },
    });

    const connectivity = new ConnectivityManager({
      getNavigatorOnLine: () => true,
      fetchFn: vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ ok: true }),
      } as unknown as Response),
    });

    const engine = new SyncEngine({
      db,
      transport,
      connectivity,
      batchSize: 50,
    });

    // Run first sync attempt: batch 1 succeeds, batch 2 throws
    await expect(engine.pushAll()).rejects.toThrow('Connection lost during batch 2');

    // First 50 ops were committed and removed from outbox! Exactly 50 remain.
    expect(await db.outbox.count()).toBe(50);

    // Now resume sync
    const pushedOnResume = await engine.pushAll();
    expect(pushedOnResume).toBe(50);
    expect(await db.outbox.count()).toBe(0);
  });

  it('500-op backlog syncs in batches of 50 without duplicates', async () => {
    // Generate 500 ops in outbox
    const opsCount = 500;
    const batchSize = 50;

    for (let i = 0; i < opsCount; i++) {
      await db.outbox.add({
        opId: `bulk_op_${i}`,
        deviceId: 'dev_test',
        userId: 'Meera',
        recordId: `bulk_rec_${i}`,
        type: 'create',
        fields: { name: `Household ${i}` },
        baseHlc: null,
        hlc: `2026-10-04T00:00:00.000Z-${String(i).padStart(4, '0')}-dev_test`,
      });
    }

    expect(await db.outbox.count()).toBe(500);

    const receivedBatches: number[] = [];
    const transport = createRealTransport({
      async push(_deviceId, _userId, ops) {
        receivedBatches.push(ops.length);
        const results = ops.map((op) => applyOp(serverState, op));
        serverSeq++;
        return { results, seq: serverSeq };
      },
    });

    const connectivity = new ConnectivityManager({
      getNavigatorOnLine: () => true,
      fetchFn: vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ ok: true }),
      } as unknown as Response),
    });

    const engine = new SyncEngine({
      db,
      transport,
      connectivity,
      batchSize,
    });

    const totalPushed = await engine.pushAll();

    expect(totalPushed).toBe(500);
    expect(receivedBatches).toHaveLength(10); // 500 / 50 = 10 batches
    expect(receivedBatches.every((len) => len === 50)).toBe(true);
    expect(await db.outbox.count()).toBe(0);

    // Verify all 500 records exist in server state
    expect(Object.keys(serverState.records)).toHaveLength(500);
  });
});
