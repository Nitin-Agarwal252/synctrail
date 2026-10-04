import { describe, it, expect, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hlc, type ApplyResult } from '@synctrail/shared';
import { SyncTrailDb, type OutboxOp } from '../db';
import { SyncEngine, HttpSyncTransport, type SyncTransport } from './engine';
import { ConnectivityManager } from './connectivity';

// Vitest runs each workspace from its own folder (apps/web); jsdom gives import.meta.url an http: scheme.
const ROOT = path.resolve(process.cwd(), '../..');
const SERVER_ENTRY = path.join(ROOT, 'apps/server/src/index.ts');
const PORT = 4100 + Math.floor(Math.random() * 800);
const BASE = `http://127.0.0.1:${PORT}`;
const BACKLOG = 120;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const online = () =>
  new ConnectivityManager({
    getNavigatorOnLine: () => true,
    fetchFn: async () => ({ ok: true, json: async () => ({ ok: true }) }) as unknown as Response,
  });

async function waitForHealth(): Promise<void> {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) return;
    } catch {
      // not listening yet
    }
    await sleep(100);
  }
  throw new Error('server did not start');
}

/** A real server process (the dev entry point, one node process via the tsx loader) on a real SQLite file. */
async function startServer(dbPath: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['--import', 'tsx', SERVER_ENTRY], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DB_PATH: dbPath, SERVE_STATIC: '0' },
    stdio: 'ignore',
  });
  await waitForHealth();
  return child;
}

async function killServer(child: ChildProcess | null): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
}

function backlog(prefix: string): OutboxOp[] {
  return Array.from({ length: BACKLOG }, (_, i) => ({
    opId: `${prefix}op_${i}`,
    deviceId: 'devR17',
    userId: 'Meera',
    recordId: `${prefix}rec_${i}`,
    type: 'create',
    fields: { name: `Restart ${i}` },
    baseHlc: null,
    hlc: hlc.format({ wall: 1_700_000_000_000 + i, counter: 0, node: 'devR17' }),
  }));
}

describe('Server restart during sync (edge case #17)', () => {
  let server: ChildProcess | null = null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synctrail-restart-'));
  const dbPath = path.join(dir, 'restart.db');

  afterEach(async () => {
    await killServer(server);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('push fails because the server dies mid-sync; restarted on the same DB file, the engine resumes and every op is applied exactly once', async () => {
    const prefix = `r17_${Date.now()}_`;
    server = await startServer(dbPath);
    const http = new HttpSyncTransport(BASE);
    const statuses: ApplyResult['status'][] = [];
    let pushes = 0;
    const transport: SyncTransport = {
      async push(deviceId, userId, ops) {
        pushes++;
        const res = await http.push(deviceId, userId, ops);
        statuses.push(...res.results.map((r) => r.status));
        if (pushes === 2) {
          // The server committed batch 2, then died before the client saw the response.
          await killServer(server);
          throw new TypeError('fetch failed: server closed the connection');
        }
        return res;
      },
      pull: (since, epoch) => http.pull(since, epoch),
    };
    const db = new SyncTrailDb(`restart_${Math.random().toString(36).slice(2)}`);
    await db.outbox.bulkAdd(backlog(prefix));
    const engine = new SyncEngine({ db, transport, connectivity: online() });

    await expect(engine.pushAll()).rejects.toThrow(/server closed/);
    expect(await db.outbox.count()).toBe(BACKLOG - 50);

    // While the server is down, a real request fails and nothing leaves the outbox.
    await expect(engine.pushAll()).rejects.toThrow();
    expect(await db.outbox.count()).toBe(BACKLOG - 50);

    server = await startServer(dbPath);
    await engine.pushAll();
    expect(await db.outbox.count()).toBe(0);
    expect(await db.deadOps.count()).toBe(0);

    const stats = await (await fetch(`${BASE}/api/stats?prefix=${prefix}`)).json();
    expect(stats.prefix).toEqual({ value: prefix, ops: BACKLOG, distinctOpIds: BACKLOG, records: BACKLOG });
    expect(statuses.filter((s) => s === 'applied')).toHaveLength(BACKLOG);
    expect(statuses.filter((s) => s === 'duplicate')).toHaveLength(50);
  }, 60000);
});
