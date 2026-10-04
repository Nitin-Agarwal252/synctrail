import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { SyncTrailDb, type SnapshotRecord } from '../db';
import { SyncEngine, SERVER_RESET_NOTICE_KEY, type SyncTransport, type PullResponse } from './engine';
import { ConnectivityManager } from './connectivity';
import type { TabLock } from './tabLock';
import { hlc } from '@synctrail/shared';

const online = () =>
  new ConnectivityManager({
    getNavigatorOnLine: () => true,
    fetchFn: async () => ({ ok: true, json: async () => ({ ok: true }) }) as unknown as Response,
  });

const leaderLock = (): TabLock => ({
  async requestLock(onAcquired) {
    void onAcquired();
  },
  release() {},
  isLeader: () => true,
});

function rec(id: string, seq: number, name: string, wall = 1_000_000 + seq): SnapshotRecord {
  const v = hlc.format({ wall, counter: 0, node: 'srv' });
  return {
    id,
    fields: { name: { value: name, hlc: v, opId: `op_${id}_${seq}`, deviceId: 'srv', userId: 'Meera' } },
    deleted: false,
    deletedHlc: null,
    deletedBy: null,
    version: v,
    seq,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Mulberry32: deterministic PRNG so failures reproduce. */
function prng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('R2 pull robustness', () => {
  let db: SyncTrailDb;

  beforeEach(() => {
    db = new SyncTrailDb(`pull_${Math.random().toString(36).slice(2)}`);
  });

  it('concurrent pulls run one at a time; a stale response never moves the cursor back or overwrites newer data', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const responses: PullResponse[] = [
      { records: [rec('r1', 10, 'new')], conflicts: [], seq: 10 },
      { records: [rec('r1', 5, 'old')], conflicts: [], seq: 5 },
    ];
    const transport: SyncTransport = {
      async push() {
        return { results: [], seq: 0 };
      },
      async pull() {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        const res = responses.shift()!;
        await sleep(res.seq === 10 ? 30 : 1);
        inFlight--;
        return res;
      },
    };
    const engine = new SyncEngine({ db, transport, connectivity: online() });

    const first = engine.pull();
    const hint = engine.safePull();
    await first;
    expect(await db.getMeta('cursor')).toBe('10');
    await hint;

    expect(maxInFlight).toBe(1);
    expect(await db.getMeta('cursor')).toBe('10');
    expect((await db.snapshot.get('r1'))?.fields.name.value).toBe('new');
  });

  it('randomized: with random seqs and delays the observed cursor is monotonic', async () => {
    for (let seed = 1; seed <= 25; seed++) {
      const rand = prng(seed);
      const local = new SyncTrailDb(`pullrand_${seed}_${Math.random().toString(36).slice(2)}`);
      const transport: SyncTransport = {
        async push() {
          return { results: [], seq: 0 };
        },
        async pull() {
          const seq = Math.floor(rand() * 100);
          await sleep(Math.floor(rand() * 5));
          return { records: [rec('r1', seq, `v${seq}`)], conflicts: [], seq };
        },
      };
      const engine = new SyncEngine({ db: local, transport, connectivity: online() });
      const observed: number[] = [];
      const pulls = Array.from({ length: 8 }, () =>
        engine.pull().then(async () => observed.push(Number(await local.getMeta('cursor'))))
      );
      await Promise.all(pulls);
      for (let i = 1; i < observed.length; i++) {
        expect(observed[i], `seed ${seed}`).toBeGreaterThanOrEqual(observed[i - 1]);
      }
      const snap = await local.snapshot.get('r1');
      expect(snap?.seq, `seed ${seed}`).toBe(Math.max(...observed));
      local.close();
    }
  });

  it('reset:true wipes snapshot, conflicts and cursor, keeps the outbox, and raises the notice', async () => {
    await db.snapshot.bulkPut([rec('ghost_1', 40, 'Ghost'), rec('h_01', 41, 'Rao')]);
    await db.conflicts.put({
      id: 'c_ghost',
      recordId: 'ghost_1',
      kind: 'field',
      field: 'name',
      status: 'open',
      seq: 42,
    } as never);
    await db.setMeta('cursor', '50');
    await db.setMeta('epoch', 'e1');
    await db.outbox.add({
      opId: 'op_pending',
      deviceId: 'devA',
      userId: 'Meera',
      recordId: 'ghost_1',
      type: 'set',
      field: 'phone',
      value: '1',
      baseHlc: null,
      hlc: hlc.format({ wall: 2_000_000, counter: 0, node: 'devA' }),
    });
    const sent: { since: number; epoch?: string }[] = [];
    const transport: SyncTransport = {
      async push() {
        return { results: [], seq: 0 };
      },
      async pull(since, epoch) {
        sent.push({ since, epoch });
        return { records: [rec('h_01', 61, 'Rao'), rec('h_02', 62, 'Sharma')], conflicts: [], seq: 62, epoch: 'e2', reset: true };
      },
    };
    const engine = new SyncEngine({ db, transport, connectivity: online() });

    await engine.pull();

    expect(sent).toEqual([{ since: 50, epoch: 'e1' }]);
    expect((await db.snapshot.toArray()).map((r) => r.id).sort()).toEqual(['h_01', 'h_02']);
    expect(await db.conflicts.count()).toBe(0);
    expect((await db.outbox.toArray()).map((o) => o.opId)).toEqual(['op_pending']);
    expect(await db.getMeta('cursor')).toBe('62');
    expect(await db.getMeta('epoch')).toBe('e2');
    expect(await db.getMeta(SERVER_RESET_NOTICE_KEY)).toBe('1');

    await engine.dismissServerResetNotice();
    expect(await db.getMeta(SERVER_RESET_NOTICE_KEY)).toBeNull();
  });

  it('a new epoch without reset:true refetches full state and treats it as a reset', async () => {
    await db.snapshot.put(rec('ghost_1', 40, 'Ghost'));
    await db.setMeta('cursor', '50');
    await db.setMeta('epoch', 'e1');
    const sent: number[] = [];
    const transport: SyncTransport = {
      async push() {
        return { results: [], seq: 0 };
      },
      async pull(since) {
        sent.push(since);
        return since === 0
          ? { records: [rec('h_01', 3, 'Rao')], conflicts: [], seq: 3, epoch: 'e2' }
          : { records: [], conflicts: [], seq: 3, epoch: 'e2' };
      },
    };
    const engine = new SyncEngine({ db, transport, connectivity: online() });

    await engine.pull();

    expect(sent).toEqual([50, 0]);
    expect((await db.snapshot.toArray()).map((r) => r.id)).toEqual(['h_01']);
    expect(await db.getMeta('cursor')).toBe('3');
    expect(await db.getMeta('epoch')).toBe('e2');
  });

  it('calls hlc.receive after a pull and persists meta.hlc', async () => {
    const future = Date.now() + 3_600_000;
    const transport: SyncTransport = {
      async push() {
        return { results: [], seq: 0 };
      },
      async pull() {
        return { records: [rec('r1', 1, 'x', future)], conflicts: [], seq: 1 };
      },
    };
    const engine = new SyncEngine({ db, transport, connectivity: online() });

    await engine.pull();

    const stored = await db.getMeta('hlc');
    expect(stored).not.toBeNull();
    expect(hlc.parse(stored!).wall).toBe(future);
    const { deviceId } = await db.initMeta();
    expect(hlc.compare(await db.tickClock(deviceId), rec('r1', 1, 'x', future).version)).toBeGreaterThan(0);
  });

  it('a failing hint pull is caught, and the safety pull keeps running while leader', async () => {
    let hint: (() => void) | null = null;
    let pulls = 0;
    const transport: SyncTransport = {
      async push() {
        return { results: [], seq: 0 };
      },
      async pull() {
        pulls++;
        if (pulls === 2) throw new Error('network down');
        return { records: [], conflicts: [], seq: 0 };
      },
      connectWs(onHint) {
        hint = () => onHint(1);
        return () => {};
      },
    };
    const engine = new SyncEngine({
      db,
      transport,
      connectivity: online(),
      tabLock: leaderLock(),
      safetyPullMs: 25,
    });

    engine.start();
    await sleep(20);
    expect(hint).not.toBeNull();
    hint!();
    await sleep(150);
    engine.stop();

    expect(pulls).toBeGreaterThanOrEqual(4);
    await sleep(1100);
  });
});
