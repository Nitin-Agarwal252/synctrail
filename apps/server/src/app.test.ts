import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from './app';
import { DatabaseInstance } from './db';
import { SyncRepo } from './repo';
import { hlc, type Op } from '@synctrail/shared';
import fs from 'node:fs';
import path from 'node:path';

describe('Server Integration Tests (Fastify inject)', () => {
  let app: FastifyInstance;
  let db: DatabaseInstance;
  let repo: SyncRepo;

  beforeEach(async () => {
    app = await buildApp({ logger: false, dbPath: ':memory:', autoSeedIfEmpty: true });
    db = (app as unknown as { db: DatabaseInstance }).db;
    repo = (app as unknown as { repo: SyncRepo }).repo;
  });

  afterEach(async () => {
    await app.close();
  });

  it('GET /api/health returns ok:true, seq, and no-cache header', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/health',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(typeof body.seq).toBe('number');
    expect(res.headers['cache-control']).toContain('no-store');
  });

  it('HEAD /api/health returns 200 without body', async () => {
    const res = await app.inject({
      method: 'HEAD',
      url: '/api/health',
    });
    expect(res.statusCode).toBe(200);
  });

  it('Push creates and sets; duplicate push returns duplicate and changes nothing', async () => {
    const t0 = hlc.format({ wall: 1000, counter: 0, node: 'dev_A' });
    const t1 = hlc.format({ wall: 1100, counter: 0, node: 'dev_A' });

    const createOp: Op = {
      opId: 'op_push_create_1',
      deviceId: 'dev_A',
      userId: 'user_Meera',
      recordId: 'rec_push_1',
      type: 'create',
      fields: { name: 'Hospital A', phone: '111', status: 'new' },
      baseHlc: null,
      hlc: t0,
    };

    // 1. Push create
    const resCreate = await app.inject({
      method: 'POST',
      url: '/api/sync/push',
      payload: { deviceId: 'dev_A', userId: 'user_Meera', ops: [createOp] },
    });
    expect(resCreate.statusCode).toBe(200);
    const bodyCreate = JSON.parse(resCreate.body);
    expect(bodyCreate.results[0].status).toBe('applied');

    // 2. Push set
    const setOp: Op = {
      opId: 'op_push_set_1',
      deviceId: 'dev_A',
      userId: 'user_Meera',
      recordId: 'rec_push_1',
      type: 'set',
      field: 'phone',
      value: '999',
      baseHlc: t0,
      hlc: t1,
    };

    const resSet = await app.inject({
      method: 'POST',
      url: '/api/sync/push',
      payload: { deviceId: 'dev_A', userId: 'user_Meera', ops: [setOp] },
    });
    expect(resSet.statusCode).toBe(200);
    const bodySet = JSON.parse(resSet.body);
    expect(bodySet.results[0].status).toBe('applied');

    // 3. Duplicate push: resending the exact same setOp
    const resDup = await app.inject({
      method: 'POST',
      url: '/api/sync/push',
      payload: { deviceId: 'dev_A', userId: 'user_Meera', ops: [setOp] },
    });
    expect(resDup.statusCode).toBe(200);
    const bodyDup = JSON.parse(resDup.body);
    expect(bodyDup.results[0].status).toBe('duplicate');

    // Verify pull shows updated state and no duplicate corruption
    const pullRes = await app.inject({
      method: 'GET',
      url: '/api/sync/pull?since=0',
    });
    const pullBody = JSON.parse(pullRes.body);
    const rec = pullBody.records.find((r: { id: string }) => r.id === 'rec_push_1');
    expect(rec).toBeDefined();
    expect(rec.fields.phone.value).toBe('999');
  });

  it('Out-of-order set returns rejected and succeeds after create', async () => {
    const t0 = hlc.format({ wall: 1000, counter: 0, node: 'dev_A' });
    const t1 = hlc.format({ wall: 1100, counter: 0, node: 'dev_B' });

    const setOp: Op = {
      opId: 'op_ooo_set',
      deviceId: 'dev_B',
      userId: 'user_Dev',
      recordId: 'rec_ooo_1',
      type: 'set',
      field: 'notes',
      value: 'urgent',
      baseHlc: t0,
      hlc: t1,
    };

    // 1. set arrives before create
    const resRejected = await app.inject({
      method: 'POST',
      url: '/api/sync/push',
      payload: { deviceId: 'dev_B', userId: 'user_Dev', ops: [setOp] },
    });
    expect(resRejected.statusCode).toBe(200);
    const bodyRejected = JSON.parse(resRejected.body);
    expect(bodyRejected.results[0].status).toBe('rejected');
    expect(bodyRejected.results[0].reason).toBe('unknown-record');

    // Verify opId is NOT marked seen
    const state = repo.loadServerState();
    expect(state.seenOps.has('op_ooo_set')).toBe(false);

    // 2. create arrives
    const createOp: Op = {
      opId: 'op_ooo_create',
      deviceId: 'dev_A',
      userId: 'user_Meera',
      recordId: 'rec_ooo_1',
      type: 'create',
      fields: { name: 'Health Post', notes: 'init' },
      baseHlc: null,
      hlc: t0,
    };

    const resCreate = await app.inject({
      method: 'POST',
      url: '/api/sync/push',
      payload: { deviceId: 'dev_A', userId: 'user_Meera', ops: [createOp] },
    });
    expect(resCreate.statusCode).toBe(200);
    expect(JSON.parse(resCreate.body).results[0].status).toBe('applied');

    // 3. Retry set op
    const resRetry = await app.inject({
      method: 'POST',
      url: '/api/sync/push',
      payload: { deviceId: 'dev_B', userId: 'user_Dev', ops: [setOp] },
    });
    expect(resRetry.statusCode).toBe(200);
    expect(JSON.parse(resRetry.body).results[0].status).toBe('applied');

    const stateFinal = repo.loadServerState();
    expect(stateFinal.records['rec_ooo_1'].fields.notes.value).toBe('urgent');
  });

  it('Concurrent field edit opens a conflict; resolve works; double resolve refused', async () => {
    const t0 = hlc.format({ wall: 1000, counter: 0, node: 'dev_init' });
    const tA = hlc.format({ wall: 1100, counter: 0, node: 'dev_A' });
    const tB = hlc.format({ wall: 1200, counter: 0, node: 'dev_B' });

    // Seed record
    await app.inject({
      method: 'POST',
      url: '/api/sync/push',
      payload: {
        deviceId: 'dev_init',
        userId: 'user_Arjun',
        ops: [
          {
            opId: 'op_c_init',
            deviceId: 'dev_init',
            userId: 'user_Arjun',
            recordId: 'rec_conflict_test',
            type: 'create',
            fields: { status: 'new' },
            baseHlc: null,
            hlc: t0,
          },
        ],
      },
    });

    // Edit A: Meera completes
    const resA = await app.inject({
      method: 'POST',
      url: '/api/sync/push',
      payload: {
        deviceId: 'dev_A',
        userId: 'user_Meera',
        ops: [
          {
            opId: 'op_c_A',
            deviceId: 'dev_A',
            userId: 'user_Meera',
            recordId: 'rec_conflict_test',
            type: 'set',
            field: 'status',
            value: 'completed',
            baseHlc: t0,
            hlc: tA,
          },
        ],
      },
    });
    expect(JSON.parse(resA.body).results[0].status).toBe('applied');

    // Edit B: Dev sets follow-up based on ancestor t0
    const resB = await app.inject({
      method: 'POST',
      url: '/api/sync/push',
      payload: {
        deviceId: 'dev_B',
        userId: 'user_Dev',
        ops: [
          {
            opId: 'op_c_B',
            deviceId: 'dev_B',
            userId: 'user_Dev',
            recordId: 'rec_conflict_test',
            type: 'set',
            field: 'status',
            value: 'follow-up',
            baseHlc: t0,
            hlc: tB,
          },
        ],
      },
    });
    const bodyB = JSON.parse(resB.body);
    expect(bodyB.results[0].status).toBe('conflict');
    const conflictId = bodyB.results[0].conflictId;
    expect(conflictId).toBeDefined();

    // Pull conflicts
    const pullRes = await app.inject({
      method: 'GET',
      url: '/api/sync/pull?since=0',
    });
    const pullBody = JSON.parse(pullRes.body);
    const conf = pullBody.conflicts.find((c: { id: string }) => c.id === conflictId);
    expect(conf).toBeDefined();
    expect(conf.baseValue).toBe('new');
    expect(conf.theirs.value).toBe('completed');
    expect(conf.mine.value).toBe('follow-up');

    // Resolve conflict with 'mine'
    const tRes = hlc.format({ wall: 1500, counter: 0, node: 'dev_admin' });
    const resResolve = await app.inject({
      method: 'POST',
      url: `/api/conflicts/${conflictId}/resolve`,
      payload: {
        choice: 'mine',
        userId: 'user_Arjun',
        deviceId: 'dev_admin',
        opId: 'res_op_1',
        hlc: tRes,
      },
    });
    expect(resResolve.statusCode).toBe(200);
    expect(JSON.parse(resResolve.body).ok).toBe(true);

    // Verify record holds resolved value
    const state = repo.loadServerState();
    expect(state.records['rec_conflict_test'].fields.status.value).toBe('follow-up');

    // Double resolve is refused
    const resDouble = await app.inject({
      method: 'POST',
      url: `/api/conflicts/${conflictId}/resolve`,
      payload: {
        choice: 'theirs',
        userId: 'user_Arjun',
        deviceId: 'dev_admin',
        opId: 'res_op_2',
        hlc: tRes,
      },
    });
    expect(resDouble.statusCode).toBe(409);
    expect(JSON.parse(resDouble.body).reason).toBe('already-resolved');
  });

  it('Preview returns predicted statuses and persists nothing (assert row counts)', async () => {
    // Assert row counts before preview
    const countRecordsBefore = (db.prepare('SELECT COUNT(*) as c FROM records').get() as { c: number }).c;
    const countOpsBefore = (db.prepare('SELECT COUNT(*) as c FROM ops').get() as { c: number }).c;
    const countConflictsBefore = (db.prepare('SELECT COUNT(*) as c FROM conflicts').get() as { c: number }).c;
    const countAuditBefore = (db.prepare('SELECT COUNT(*) as c FROM audit').get() as { c: number }).c;
    const seqBefore = repo.getSeq();

    // Target existing seeded record h_01
    const pullInitial = repo.pull(0);
    const recH01 = pullInitial.records.find((r) => r.id === 'h_01')!;
    const currentNameHlc = recH01.fields.name.hlc;

    const opsToPreview: Op[] = [
      // 1. Clean update to phone (different field with valid baseHlc)
      {
        opId: 'preview_clean_1',
        deviceId: 'dev_test',
        userId: 'user_test',
        recordId: 'h_01',
        type: 'set',
        field: 'phone',
        value: '99999-preview',
        baseHlc: recH01.fields.phone.hlc,
        hlc: hlc.format({ wall: 2000, counter: 0, node: 'dev_test' }),
      },
      // 2. Conflict: edit name with stale baseHlc
      {
        opId: 'preview_conflict_2',
        deviceId: 'dev_test',
        userId: 'user_test',
        recordId: 'h_01',
        type: 'set',
        field: 'name',
        value: 'Conflicted Name',
        baseHlc: hlc.format({ wall: 1, counter: 0, node: 'stale_node' }),
        hlc: hlc.format({ wall: 2010, counter: 0, node: 'dev_test' }),
      },
    ];

    const previewRes = await app.inject({
      method: 'POST',
      url: '/api/sync/preview',
      payload: { ops: opsToPreview },
    });

    expect(previewRes.statusCode).toBe(200);
    const previewBody = JSON.parse(previewRes.body);
    expect(previewBody.results).toHaveLength(2);
    expect(previewBody.results[0].status).toBe('applied');
    expect(previewBody.results[1].status).toBe('conflict');

    // Assert row counts and state after preview are 100% UNCHANGED
    const countRecordsAfter = (db.prepare('SELECT COUNT(*) as c FROM records').get() as { c: number }).c;
    const countOpsAfter = (db.prepare('SELECT COUNT(*) as c FROM ops').get() as { c: number }).c;
    const countConflictsAfter = (db.prepare('SELECT COUNT(*) as c FROM conflicts').get() as { c: number }).c;
    const countAuditAfter = (db.prepare('SELECT COUNT(*) as c FROM audit').get() as { c: number }).c;
    const seqAfter = repo.getSeq();

    expect(countRecordsAfter).toBe(countRecordsBefore);
    expect(countOpsAfter).toBe(countOpsBefore);
    expect(countConflictsAfter).toBe(countConflictsBefore);
    expect(countAuditAfter).toBe(countAuditBefore);
    expect(seqAfter).toBe(seqBefore);

    // Verify record fields on disk were not mutated
    const recCheck = repo.loadServerState().records['h_01'];
    expect(recCheck.fields.name.hlc).toBe(currentNameHlc);
    expect(recCheck.fields.phone.value).not.toBe('99999-preview');
  });

  it('Restart persistence: close and reopen the DB, state intact', async () => {
    const tempDbPath = path.join(process.cwd(), 'temp_test_persistence.db');
    if (fs.existsSync(tempDbPath)) fs.unlinkSync(tempDbPath);

    try {
      // 1. Start app with disk-backed database
      const app1 = await buildApp({ logger: false, dbPath: tempDbPath, autoSeedIfEmpty: true });
      const repo1 = (app1 as unknown as { repo: SyncRepo }).repo;

      // Add custom record
      const pushRes = await app1.inject({
        method: 'POST',
        url: '/api/sync/push',
        payload: {
          deviceId: 'dev_persist',
          userId: 'user_Meera',
          ops: [
            {
              opId: 'op_persist_1',
              deviceId: 'dev_persist',
              userId: 'user_Meera',
              recordId: 'rec_persist_test',
              type: 'create',
              fields: { name: 'Persistence Family', status: 'new' },
              baseHlc: null,
              hlc: hlc.format({ wall: 1000, counter: 0, node: 'dev_persist' }),
            },
          ],
        },
      });
      expect(pushRes.statusCode).toBe(200);

      const stats1 = repo1.getStats();
      const pull1 = repo1.pull(0);

      // Close app1 (simulating server shutdown)
      await app1.close();

      // 2. Reopen with same DB file (simulating server restart)
      const app2 = await buildApp({ logger: false, dbPath: tempDbPath, autoSeedIfEmpty: false });
      const repo2 = (app2 as unknown as { repo: SyncRepo }).repo;

      const stats2 = repo2.getStats();
      const pull2 = repo2.pull(0);

      expect(stats2.records).toBe(stats1.records);
      expect(stats2.ops).toBe(stats1.ops);
      expect(stats2.lastSeq).toBe(stats1.lastSeq);
      expect(pull2.records.length).toBe(pull1.records.length);

      const recReopened = pull2.records.find((r) => r.id === 'rec_persist_test');
      expect(recReopened).toBeDefined();
      expect(recReopened?.fields.name.value).toBe('Persistence Family');

      await app2.close();
    } finally {
      if (fs.existsSync(tempDbPath)) {
        fs.unlinkSync(tempDbPath);
      }
      const walFile = `${tempDbPath}-wal`;
      if (fs.existsSync(walFile)) fs.unlinkSync(walFile);
      const shmFile = `${tempDbPath}-shm`;
      if (fs.existsSync(shmFile)) fs.unlinkSync(shmFile);
    }
  });

  it('Bad input returns 400', async () => {
    // 1. Missing ops in push
    const res1 = await app.inject({
      method: 'POST',
      url: '/api/sync/push',
      payload: { deviceId: 'dev_A' },
    });
    expect(res1.statusCode).toBe(400);

    // 2. Ops exceeding max 50
    const opsTooMany: Op[] = Array.from({ length: 51 }, (_, i) => ({
      opId: `op_excess_${i}`,
      deviceId: 'dev_A',
      userId: 'u',
      recordId: 'r',
      type: 'create',
      baseHlc: null,
      hlc: hlc.format({ wall: 1000 + i, counter: 0, node: 'dev_A' }),
    }));
    const res2 = await app.inject({
      method: 'POST',
      url: '/api/sync/push',
      payload: { deviceId: 'dev_A', userId: 'u', ops: opsTooMany },
    });
    expect(res2.statusCode).toBe(400);

    // 3. Invalid preview payload
    const res3 = await app.inject({
      method: 'POST',
      url: '/api/sync/preview',
      payload: { ops: 'not-an-array' },
    });
    expect(res3.statusCode).toBe(400);

    // 4. Invalid pull since parameter
    const res4 = await app.inject({
      method: 'GET',
      url: '/api/sync/pull?since=-5',
    });
    expect(res4.statusCode).toBe(400);

    // 5. Invalid resolve choice
    const res5 = await app.inject({
      method: 'POST',
      url: '/api/conflicts/c_123/resolve',
      payload: {
        choice: 'invalid_choice',
        userId: 'u',
        deviceId: 'd',
        opId: 'op_r',
        hlc: 'hlc_1',
      },
    });
    expect(res5.statusCode).toBe(400);
  });

  it('Audit and Stats endpoints return accurate data', async () => {
    const statsRes = await app.inject({
      method: 'GET',
      url: '/api/stats',
    });
    expect(statsRes.statusCode).toBe(200);
    const stats = JSON.parse(statsRes.body);
    expect(stats.records).toBe(12); // initial 12 seed households
    expect(stats.ops).toBeGreaterThanOrEqual(12);

    const auditRes = await app.inject({
      method: 'GET',
      url: '/api/audit?limit=5',
    });
    expect(auditRes.statusCode).toBe(200);
    const auditBody = JSON.parse(auditRes.body);
    expect(auditBody.entries.length).toBeLessThanOrEqual(5);
  });

  it('POST /api/dev/reset resets and reseeds database with 12 households', async () => {
    // Add extra record
    await app.inject({
      method: 'POST',
      url: '/api/sync/push',
      payload: {
        deviceId: 'dev_test',
        userId: 'user_Meera',
        ops: [
          {
            opId: 'op_extra_1',
            deviceId: 'dev_test',
            userId: 'user_Meera',
            recordId: 'rec_extra',
            type: 'create',
            fields: { name: 'Temporary Household' },
            baseHlc: null,
            hlc: hlc.format({ wall: 1000, counter: 0, node: 'dev_test' }),
          },
        ],
      },
    });

    const statsBefore = repo.getStats();
    expect(statsBefore.records).toBe(13);

    // Call reset
    const resetRes = await app.inject({
      method: 'POST',
      url: '/api/dev/reset',
    });
    expect(resetRes.statusCode).toBe(200);
    const resetBody = JSON.parse(resetRes.body);
    expect(resetBody.ok).toBe(true);
    expect(resetBody.seeded).toBe(12);

    const statsAfter = repo.getStats();
    expect(statsAfter.records).toBe(12);
  });
});
