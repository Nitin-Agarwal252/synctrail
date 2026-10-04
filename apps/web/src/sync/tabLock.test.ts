import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import 'fake-indexeddb/auto';
import { SyncTrailDb } from '../db';
import { SyncEngine, type SyncTransport } from './engine';
import { ConnectivityManager } from './connectivity';
import { WebTabLock } from './tabLock';
import { applyOp, createServerState, hlc, type Op } from '@synctrail/shared';

/** Minimal in-memory stand-in for navigator.locks: one exclusive lock, FIFO waiters, abortable waits. */
class OneLockManager {
  private held = false;
  private waiters: (() => void)[] = [];

  async request(_name: string, options: { signal?: AbortSignal }, callback: () => Promise<void>): Promise<void> {
    if (this.held) await this.wait(options.signal);
    this.held = true;
    try {
      await callback();
    } finally {
      this.held = false;
      this.waiters.shift()?.();
    }
  }

  private wait(signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const grant = () => resolve();
      this.waiters.push(grant);
      signal?.addEventListener('abort', () => {
        this.waiters = this.waiters.filter((w) => w !== grant);
        reject(new DOMException('aborted', 'AbortError'));
      });
    });
  }
}

const online = () =>
  new ConnectivityManager({
    getNavigatorOnLine: () => true,
    fetchFn: async () => ({ ok: true, json: async () => ({ ok: true }) }) as unknown as Response,
  });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(check: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await sleep(20);
  }
}

function createOp(n: number): Op {
  return {
    opId: `tab_op_${n}`,
    deviceId: 'devTabs',
    userId: 'Meera',
    recordId: `tab_rec_${n}`,
    type: 'create',
    fields: { name: `Tab ${n}` },
    baseHlc: null,
    hlc: hlc.format({ wall: 1_700_000_000_000 + n, counter: 0, node: 'devTabs' }),
  };
}

describe('Two tabs, one Web Lock (edge case #14)', () => {
  const server = createServerState();

  function recordingTransport(pushed: string[]): SyncTransport {
    return {
      async push(_deviceId, _userId, ops) {
        pushed.push(...ops.map((o) => o.opId));
        return { results: ops.map((o) => applyOp(server, o)), seq: 0 };
      },
      async pull() {
        return { records: [], conflicts: [], seq: 0 };
      },
    };
  }

  beforeAll(() => {
    Object.defineProperty(navigator, 'locks', { value: new OneLockManager(), configurable: true });
  });

  afterAll(() => {
    Reflect.deleteProperty(navigator, 'locks');
  });

  it('only the lock holder pushes, it pushes edits made in the other tab, and the other tab takes over when it stops', async () => {
    const name = `tabs_${Math.random().toString(36).slice(2)}`;
    const dbA = new SyncTrailDb(name);
    const dbB = new SyncTrailDb(name);
    const pushedA: string[] = [];
    const pushedB: string[] = [];
    const lockA = new WebTabLock();
    const lockB = new WebTabLock();
    const tabA = new SyncEngine({ db: dbA, transport: recordingTransport(pushedA), connectivity: online(), tabLock: lockA });
    const tabB = new SyncEngine({ db: dbB, transport: recordingTransport(pushedB), connectivity: online(), tabLock: lockB });

    tabA.start();
    await sleep(50);
    tabB.start();
    await sleep(50);
    expect(lockA.isLeader()).toBe(true);
    expect(lockB.isLeader()).toBe(false);

    // An edit in tab B; the UI calls triggerSync after every edit.
    await dbB.outbox.add(createOp(1));
    await tabB.triggerSync();
    await waitFor(() => pushedA.includes('tab_op_1'), 2000);
    expect(pushedB).toEqual([]);

    tabA.stop();
    await waitFor(() => lockB.isLeader(), 3000);
    await dbB.outbox.add(createOp(2));
    await waitFor(() => pushedB.includes('tab_op_2'), 2000);

    expect(pushedA).toEqual(['tab_op_1']);
    expect(pushedB).toEqual(['tab_op_2']);
    expect(await dbA.outbox.count()).toBe(0);
    tabB.stop();
    await sleep(1100);
  });
});
