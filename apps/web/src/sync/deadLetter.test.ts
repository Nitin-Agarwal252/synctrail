import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { SyncTrailDb, type OutboxOp } from '../db';
import {
  SyncEngine,
  SyncPushError,
  UNKNOWN_RECORD_MAX_ATTEMPTS,
  type SyncTransport,
  type PullResponse,
} from './engine';
import { ConnectivityManager } from './connectivity';
import {
  type Op,
  type ApplyResult,
  applyOp,
  createServerState,
  hlc,
  type ServerState,
} from '@synctrail/shared';

const online = () =>
  new ConnectivityManager({
    getNavigatorOnLine: () => true,
    fetchFn: async () => ({ ok: true, json: async () => ({ ok: true }) }) as unknown as Response,
  });

function h(i: number): string {
  return hlc.format({ wall: 1_000_000 + i, counter: 0, node: 'devA' });
}

function createOp(i: number, recordId = `rec_${i}`): OutboxOp {
  return {
    opId: `op_c_${i}`,
    deviceId: 'devA',
    userId: 'Meera',
    recordId,
    type: 'create',
    fields: { name: `Family ${i}` },
    baseHlc: null,
    hlc: h(i),
  };
}

function setOp(i: number, recordId: string, field = 'phone'): OutboxOp {
  return {
    opId: `op_s_${i}`,
    deviceId: 'devA',
    userId: 'Meera',
    recordId,
    type: 'set',
    field,
    value: `v${i}`,
    baseHlc: null,
    hlc: h(i),
  };
}

/** Fake server: real shared applyOp, plus an optional per-op validator like the real server. */
function fakeServer(state: ServerState, validate?: (op: Op) => string | null) {
  let seq = 0;
  const calls: number[] = [];
  const transport: SyncTransport = {
    async push(_d, _u, ops) {
      calls.push(ops.length);
      const results: ApplyResult[] = ops.map((op) => {
        const bad = validate?.(op);
        if (bad) return { opId: op.opId, status: 'rejected', reason: `invalid-op: ${bad}` };
        return applyOp(state, op);
      });
      seq++;
      return { results, seq };
    },
    async pull(): Promise<PullResponse> {
      return {
        records: Object.values(state.records).map((r) => ({ ...r, seq })),
        conflicts: [],
        seq,
      };
    },
  };
  return { transport, calls };
}

describe('R1 dead-letter: per-op push results', () => {
  let db: SyncTrailDb;
  let state: ServerState;

  beforeEach(() => {
    db = new SyncTrailDb(`dl_${Math.random().toString(36).slice(2)}`);
    state = createServerState();
  });

  it('rejected(unknown-record) is kept in the outbox, then dead-lettered after 5 attempts', async () => {
    await db.outbox.add(setOp(1, 'rec_missing'));
    const { transport } = fakeServer(state);
    const engine = new SyncEngine({ db, transport, connectivity: online() });

    for (let attempt = 1; attempt < UNKNOWN_RECORD_MAX_ATTEMPTS; attempt++) {
      await engine.pushAll();
      const kept = await db.outbox.toArray();
      expect(kept).toHaveLength(1);
      expect(kept[0].pushAttempts).toBe(attempt);
      expect(kept[0].lastRejectReason).toBe('unknown-record');
      expect(await db.deadOps.count()).toBe(0);
    }

    await engine.pushAll();
    expect(await db.outbox.count()).toBe(0);
    const dead = await db.deadOps.toArray();
    expect(dead).toHaveLength(1);
    expect(dead[0]).toMatchObject({
      opId: 'op_s_1',
      recordId: 'rec_missing',
      reason: 'unknown-record',
      attempts: UNKNOWN_RECORD_MAX_ATTEMPTS,
    });
    expect(dead[0].op.value).toBe('v1');
  });

  it('rejected(unknown-record) is dead-lettered once a pull confirms the record is absent', async () => {
    await db.outbox.add(setOp(1, 'rec_missing'));
    const { transport } = fakeServer(state);
    const engine = new SyncEngine({ db, transport, connectivity: online() });

    await engine.pushAll();
    expect(await db.outbox.count()).toBe(1);

    await engine.pull();
    await engine.sweepUnknownAfterPull();
    expect(await db.outbox.count()).toBe(0);
    expect((await db.deadOps.toArray()).map((d) => d.reason)).toEqual(['unknown-record']);
  });

  it('rejected(unknown-record) for a record the client had synced (server reset) is dead-lettered at once', async () => {
    const { transport } = fakeServer(state);
    const engine = new SyncEngine({ db, transport, connectivity: online() });
    await db.outbox.add(createOp(1, 'rec_synced'));
    await engine.pushAll();
    await engine.pull();
    expect(await db.snapshot.get('rec_synced')).toBeDefined();

    // Server wiped (POST /api/dev/reset); the client still holds the old snapshot.
    const wiped = createServerState();
    const after = fakeServer(wiped);
    const engine2 = new SyncEngine({ db, transport: after.transport, connectivity: online() });
    await db.outbox.add(setOp(2, 'rec_synced'));
    await engine2.pushAll();

    expect(await db.outbox.count()).toBe(0);
    const dead = await db.deadOps.toArray();
    expect(dead.map((d) => [d.opId, d.reason])).toEqual([['op_s_2', 'unknown-record']]);
  });

  it('an unknown-record op whose create is still queued stays queued (no false dead-letter)', async () => {
    await db.outbox.add(setOp(1, 'rec_later'));
    const { transport } = fakeServer(state);
    const engine = new SyncEngine({ db, transport, connectivity: online() });
    await engine.pushAll();
    await db.outbox.add(createOp(2, 'rec_later'));
    await engine.pull();
    await engine.sweepUnknownAfterPull();
    expect(await db.deadOps.count()).toBe(0);
    expect(await db.outbox.count()).toBe(2);
  });

  it('rejected(invalid-op) is dead-lettered immediately with the server reason', async () => {
    await db.outbox.add(createOp(1));
    await db.outbox.add(setOp(2, 'rec_1', 'evil'));
    await db.outbox.add(setOp(3, 'rec_1', 'phone'));
    const { transport } = fakeServer(state, (op) =>
      op.field === 'evil' ? 'field' : null
    );
    const engine = new SyncEngine({ db, transport, connectivity: online() });

    const removed = await engine.pushAll();

    expect(removed).toBe(3);
    expect(await db.outbox.count()).toBe(0);
    const dead = await db.deadOps.toArray();
    expect(dead.map((d) => [d.opId, d.reason, d.attempts])).toEqual([
      ['op_s_2', 'invalid-op: field', 0],
    ]);
    expect(state.records.rec_1.fields.phone.value).toBe('v3');
    expect(engine.getPushOutcomes()).toEqual({ accepted: 2, conflicted: 0, deadLettered: 1 });
  });

  it('conflict results leave the outbox (held server-side as a Conflict)', async () => {
    await db.outbox.add(createOp(1));
    await db.outbox.add({ ...setOp(2, 'rec_1'), baseHlc: null });
    await db.outbox.add({ ...setOp(3, 'rec_1'), opId: 'op_s_3b', baseHlc: null });
    const { transport } = fakeServer(state);
    const engine = new SyncEngine({ db, transport, connectivity: online() });
    await engine.pushAll();
    expect(await db.outbox.count()).toBe(0);
    expect(state.conflicts).toHaveLength(1);
    expect(engine.getPushOutcomes()).toEqual({ accepted: 2, conflicted: 1, deadLettered: 0 });
  });

  it('a whole-batch 400 caused by one poison op does not block the 49 good ops', async () => {
    for (let i = 0; i < 50; i++) await db.outbox.add(createOp(i));
    const poisonId = 'op_c_17';
    await db.outbox.where('opId').equals(poisonId).modify({ fields: { name: { bad: true } } as never });

    const calls: number[] = [];
    const transport: SyncTransport = {
      async push(_d, _u, ops) {
        calls.push(ops.length);
        if (ops.some((o) => o.opId === poisonId)) {
          throw new SyncPushError(400, 'Invalid push body', { error: 'Invalid push body' });
        }
        return { results: ops.map((op) => applyOp(state, op)), seq: 1 };
      },
      async pull() {
        return { records: [], conflicts: [], seq: 1 };
      },
    };
    const engine = new SyncEngine({ db, transport, connectivity: online() });

    const removed = await engine.pushAll();

    expect(removed).toBe(50);
    expect(calls).toEqual([50, ...Array(50).fill(1)]);
    expect(Object.keys(state.records)).toHaveLength(49);
    expect(await db.outbox.count()).toBe(0);
    const dead = await db.deadOps.toArray();
    expect(dead.map((d) => [d.opId, d.reason])).toEqual([[poisonId, 'Invalid push body']]);

    // The outbox is not blocked: a later op flows through in one normal batch.
    await db.outbox.add(createOp(99));
    calls.length = 0;
    await engine.pushAll();
    expect(calls).toEqual([1]);
    expect(await db.outbox.count()).toBe(0);
  });

  it('a transient 429 is retried later, never dead-lettered', async () => {
    await db.outbox.add(createOp(1));
    const transport: SyncTransport = {
      async push() {
        throw new SyncPushError(429, 'Too many requests');
      },
      async pull() {
        return { records: [], conflicts: [], seq: 0 };
      },
    };
    const engine = new SyncEngine({ db, transport, connectivity: online() });
    await expect(engine.pushAll()).rejects.toThrow('Too many requests');
    expect(await db.outbox.count()).toBe(1);
    expect(await db.deadOps.count()).toBe(0);
  });

  it('Retry moves a dead op back to the outbox; Discard deletes it only when asked', async () => {
    await db.outbox.add(setOp(1, 'rec_x', 'evil'));
    const { transport } = fakeServer(state, (op) => (op.field === 'evil' ? 'field' : null));
    const connectivity = new ConnectivityManager({ getNavigatorOnLine: () => false });
    const engine = new SyncEngine({ db, transport, connectivity });
    await engine.pushAll();
    expect(await db.deadOps.count()).toBe(1);

    await engine.retryDeadOp('op_s_1');
    expect(await db.deadOps.count()).toBe(0);
    const back = await db.outbox.toArray();
    expect(back.map((o) => [o.opId, o.pushAttempts])).toEqual([['op_s_1', 0]]);

    await engine.pushAll();
    expect(await db.deadOps.count()).toBe(1);
    await engine.discardDeadOp('op_s_1');
    expect(await db.deadOps.count()).toBe(0);
    expect(await db.outbox.count()).toBe(0);
  });
});

/** Deterministic PRNG so a failing seed can be replayed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Outcome = 'accepted' | 'conflicted' | 'invalid' | 'unknown' | 'none';

describe('R1 accounting invariant (randomized result statuses)', () => {
  it('submitted = accepted + conflicted + still-queued + dead-lettered, for every seed', async () => {
    const SEEDS = 40;
    for (let seed = 1; seed <= SEEDS; seed++) {
      const rand = mulberry32(seed);
      const db = new SyncTrailDb(`acct_${seed}_${Math.random().toString(36).slice(2)}`);
      const submitted = 20 + Math.floor(rand() * 80);
      for (let i = 0; i < submitted; i++) {
        await db.outbox.add(rand() < 0.5 ? createOp(i) : setOp(i, `rec_${i % 7}`));
      }

      const lastOutcome = new Map<string, Outcome>();
      const transport: SyncTransport = {
        async push(_d, _u, ops) {
          const roll = rand();
          if (roll < 0.08) throw new Error('network dropped');
          if (roll < 0.14) throw new SyncPushError(500, 'server error');
          if (roll < 0.2 && ops.length > 1) throw new SyncPushError(400, 'Invalid push body');
          const results: ApplyResult[] = [];
          for (const op of ops) {
            const r = rand();
            if (r < 0.03) break; // truncated response: remaining ops get no result
            let res: ApplyResult;
            if (r < 0.35) res = { opId: op.opId, status: 'applied' };
            else if (r < 0.45) res = { opId: op.opId, status: 'noop' };
            else if (r < 0.55) res = { opId: op.opId, status: 'duplicate' };
            else if (r < 0.7) res = { opId: op.opId, status: 'conflict', conflictId: `c_${op.opId}` };
            else if (r < 0.85) res = { opId: op.opId, status: 'rejected', reason: 'unknown-record' };
            else if (r < 0.95) res = { opId: op.opId, status: 'rejected', reason: 'invalid-op: hlc' };
            else res = { opId: op.opId, status: 'rejected', reason: 'missing-field' };
            const outcome: Outcome =
              res.status === 'conflict'
                ? 'conflicted'
                : res.status === 'rejected'
                  ? res.reason === 'unknown-record'
                    ? 'unknown'
                    : 'invalid'
                  : 'accepted';
            lastOutcome.set(op.opId, outcome);
            results.push(res);
          }
          return { results, seq: 1 };
        },
        async pull() {
          return { records: [], conflicts: [], seq: 1 };
        },
      };
      const engine = new SyncEngine({ db, transport, connectivity: online(), batchSize: 1 + Math.floor(rand() * 50) });

      const rounds = 1 + Math.floor(rand() * 8);
      for (let r = 0; r < rounds; r++) {
        await engine.pushAll().catch(() => undefined);
        if (rand() < 0.3) await engine.sweepUnknownAfterPull();
      }

      const queued = new Set((await db.outbox.toArray()).map((o) => o.opId));
      const dead = new Set((await db.deadOps.toArray()).map((d) => d.opId));
      const { accepted, conflicted, deadLettered } = engine.getPushOutcomes();
      const ctx = `seed ${seed}`;

      expect(submitted, ctx).toBe(accepted + conflicted + queued.size + dead.size);
      expect(deadLettered, ctx).toBe(dead.size);
      for (const id of queued) expect(dead.has(id), `${ctx} ${id} in both`).toBe(false);

      // Cross-check against what the fake server actually answered.
      let expAccepted = 0;
      let expConflicted = 0;
      for (const [opId, outcome] of lastOutcome) {
        if (outcome === 'accepted') {
          expAccepted++;
          expect(queued.has(opId) || dead.has(opId), `${ctx} accepted ${opId} lingering`).toBe(false);
        } else if (outcome === 'conflicted') {
          expConflicted++;
          expect(queued.has(opId) || dead.has(opId), `${ctx} conflicted ${opId} lingering`).toBe(false);
        } else if (outcome === 'invalid') {
          expect(dead.has(opId), `${ctx} invalid ${opId} not dead-lettered`).toBe(true);
        } else if (outcome === 'unknown') {
          expect(queued.has(opId) || dead.has(opId), `${ctx} unknown ${opId} lost`).toBe(true);
        }
      }
      expect(accepted, ctx).toBe(expAccepted);
      expect(conflicted, ctx).toBe(expConflicted);
      db.close();
    }
  });
});
