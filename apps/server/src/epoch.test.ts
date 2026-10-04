import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from './app';
import { createDatabase } from './db';
import { SyncRepo } from './repo';
import { hlc } from '@synctrail/shared';

const SEED_IDS = Array.from({ length: 12 }, (_, i) => `h_${String(i + 1).padStart(2, '0')}`);

describe('R2 reset epoch', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp({ logger: false, dbPath: ':memory:', autoSeedIfEmpty: true });
  });

  afterEach(async () => {
    await app.close();
  });

  async function getJson(url: string) {
    const res = await app.inject({ method: 'GET', url });
    return { status: res.statusCode, body: JSON.parse(res.body) };
  }

  async function pushGhost(): Promise<void> {
    const op = {
      opId: 'op_ghost_1',
      deviceId: 'dev_a',
      userId: 'Meera',
      recordId: 'rec_ghost',
      type: 'create',
      fields: { name: 'Ghost family' },
      baseHlc: null,
      hlc: hlc.format({ wall: 1_800_000_000_000, counter: 0, node: 'dev_a' }),
    };
    const res = await app.inject({
      method: 'POST',
      url: '/api/sync/push',
      payload: { deviceId: 'dev_a', userId: 'Meera', ops: [op] },
    });
    expect(JSON.parse(res.body).results[0].status).toBe('applied');
  }

  async function reset() {
    const res = await app.inject({ method: 'POST', url: '/api/dev/reset' });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.body) as { seq: number; epoch: string };
  }

  it('health and pull both return the same epoch; pull says reset:false', async () => {
    const health = await getJson('/api/health');
    const pull = await getJson('/api/sync/pull?since=0');
    expect(health.body.epoch).toMatch(/^[0-9a-f-]{36}$/);
    expect(pull.body.epoch).toBe(health.body.epoch);
    expect(pull.body.reset).toBe(false);
  });

  it('reset regenerates the epoch and keeps seq monotonic', async () => {
    await pushGhost();
    const before = await getJson('/api/health');
    const after = await reset();
    expect(after.epoch).not.toBe(before.body.epoch);
    expect(after.seq).toBeGreaterThan(before.body.seq);
    expect((await getJson('/api/health')).body.epoch).toBe(after.epoch);
  });

  it('a pull with the old epoch gets full state with reset:true and no ghosts', async () => {
    await pushGhost();
    const old = await getJson('/api/sync/pull?since=0');
    expect(old.body.records.map((r: { id: string }) => r.id)).toContain('rec_ghost');
    const after = await reset();

    const pull = await getJson(`/api/sync/pull?since=${old.body.seq}&epoch=${old.body.epoch}`);
    expect(pull.body.reset).toBe(true);
    expect(pull.body.epoch).toBe(after.epoch);
    expect(pull.body.seq).toBe(after.seq);
    expect(pull.body.records.map((r: { id: string }) => r.id).sort()).toEqual(SEED_IDS);
  });

  it('a pull with the current epoch is incremental', async () => {
    const after = await reset();
    const pull = await getJson(`/api/sync/pull?since=${after.seq}&epoch=${after.epoch}`);
    expect(pull.body.reset).toBe(false);
    expect(pull.body.records).toEqual([]);
    expect(pull.body.seq).toBe(after.seq);
  });

  it('rejects a malformed epoch parameter', async () => {
    const res = await getJson('/api/sync/pull?since=0&epoch=bad%20epoch');
    expect(res.status).toBe(400);
  });
});

describe('R2 epoch storage', () => {
  it('a fresh DB gets an epoch that survives reopening; another DB gets a different one', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synctrail-epoch-'));
    try {
      const file = path.join(dir, 'a.db');
      const db1 = createDatabase(file);
      const epoch1 = new SyncRepo(db1).getEpoch();
      db1.close();
      const db2 = createDatabase(file);
      expect(new SyncRepo(db2).getEpoch()).toBe(epoch1);
      db2.close();
      const other = createDatabase(path.join(dir, 'b.db'));
      expect(new SyncRepo(other).getEpoch()).not.toBe(epoch1);
      other.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
