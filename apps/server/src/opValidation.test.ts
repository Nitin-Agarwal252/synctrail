import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from './app';
import { DatabaseInstance } from './db';
import { hlc, type ApplyResult } from '@synctrail/shared';

type RawOp = Record<string, unknown>;

const H = (i: number) => hlc.format({ wall: 1_000_000 + i, counter: 0, node: 'dev_A' });

function validCreate(i: number): RawOp {
  return {
    opId: `op_ok_${i}`,
    deviceId: 'dev_A',
    userId: 'Meera',
    recordId: `rec_ok_${i}`,
    type: 'create',
    fields: { name: `Family ${i}`, status: 'new' },
    baseHlc: null,
    hlc: H(i),
  };
}

function validSet(i: number, recordId: string): RawOp {
  return {
    opId: `op_set_${i}`,
    deviceId: 'dev_A',
    userId: 'Meera',
    recordId,
    type: 'set',
    field: 'phone',
    value: '555',
    baseHlc: null,
    hlc: H(i),
  };
}

describe('R1 server per-op validation (push and preview)', () => {
  let app: FastifyInstance;
  let db: DatabaseInstance;

  beforeEach(async () => {
    app = await buildApp({ logger: false, dbPath: ':memory:', autoSeedIfEmpty: true });
    db = (app as unknown as { db: DatabaseInstance }).db;
  });

  afterEach(async () => {
    await app.close();
  });

  const opsRowCount = () => (db.prepare('SELECT COUNT(*) AS n FROM ops').get() as { n: number }).n;

  async function pushRaw(body: string) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sync/push',
      headers: { 'content-type': 'application/json' },
      payload: body,
    });
    return { status: res.statusCode, body: res.json() as { results: ApplyResult[]; error?: string } };
  }

  let goodSeq = 900;

  /** Push [bad, good] and assert bad is rejected with `reason`, good still applied. */
  async function expectRejectedAlone(bad: RawOp, reason: string) {
    const good = validCreate(++goodSeq);
    const before = opsRowCount();
    const { status, body } = await pushRaw(
      JSON.stringify({ deviceId: 'dev_A', userId: 'Meera', ops: [bad, good] })
    );
    expect(status).toBe(200);
    expect(body.results).toHaveLength(2);
    expect(body.results[0]).toMatchObject({ status: 'rejected', reason });
    expect(body.results[1]).toMatchObject({ opId: good.opId, status: 'applied' });
    expect(opsRowCount()).toBe(before + 1);
  }

  it('rejects an HLC that does not match /^\\d{15}:\\d{5}:[^:\\s]+$/', async () => {
    await expectRejectedAlone({ ...validCreate(1), hlc: 'hlc_1' }, 'invalid-op: hlc');
    await expectRejectedAlone({ ...validCreate(2), hlc: '1000:0:dev_A' }, 'invalid-op: hlc');
    await expectRejectedAlone({ ...validCreate(3), hlc: `${H(3)}:extra` }, 'invalid-op: hlc');
    await expectRejectedAlone({ ...validSet(4, 'rec_x'), baseHlc: 'yesterday' }, 'invalid-op: hlc');
  });

  it('rejects field names outside the allowlist (name, phone, address, status, notes)', async () => {
    await expectRejectedAlone({ ...validSet(1, 'rec_x'), field: 'isAdmin' }, 'invalid-op: field');
    await expectRejectedAlone(
      { ...validCreate(2), fields: { name: 'X', salary: 10 } },
      'invalid-op: field'
    );
  });

  it('rejects status values other than new | follow-up | completed', async () => {
    await expectRejectedAlone(
      { ...validCreate(1), fields: { name: 'X', status: 'archived' } },
      'invalid-op: status'
    );
    await expectRejectedAlone(
      { ...validSet(2, 'rec_x'), field: 'status', value: 'done' },
      'invalid-op: status'
    );
  });

  it('rejects a set without value', async () => {
    const noValue = validSet(1, 'rec_x');
    delete noValue.value;
    await expectRejectedAlone(noValue, 'invalid-op: missing-value');
  });

  it('rejects ids that do not match /^[A-Za-z0-9_-]{1,64}$/', async () => {
    await expectRejectedAlone({ ...validCreate(1), opId: 'op with space' }, 'invalid-op: id');
    await expectRejectedAlone({ ...validCreate(2), recordId: 'r'.repeat(65) }, 'invalid-op: id');
    await expectRejectedAlone({ ...validCreate(3), deviceId: '' }, 'invalid-op: id');
    await expectRejectedAlone({ ...validCreate(4), userId: '../etc' }, 'invalid-op: id');
  });

  it('accepts a 64-char id (boundary)', async () => {
    const { body } = await pushRaw(
      JSON.stringify({ deviceId: 'dev_A', userId: 'Meera', ops: [{ ...validCreate(1), recordId: 'r'.repeat(64) }] })
    );
    expect(body.results[0].status).toBe('applied');
  });

  it('rejects the key __proto__ on the op, in fields, and in seen (per op, not the batch)', async () => {
    const good = JSON.stringify(validCreate(900));
    const cases = [
      `{"opId":"op_p1","deviceId":"dev_A","userId":"Meera","recordId":"rec_p1","type":"create","fields":{"name":"x"},"baseHlc":null,"hlc":"${H(1)}","__proto__":{"admin":true}}`,
      `{"opId":"op_p2","deviceId":"dev_A","userId":"Meera","recordId":"rec_p2","type":"create","fields":{"name":"x","__proto__":{"admin":true}},"baseHlc":null,"hlc":"${H(2)}"}`,
      `{"opId":"op_p3","deviceId":"dev_A","userId":"Meera","recordId":"rec_p3","type":"delete","seen":{"__proto__":"${H(0)}"},"baseHlc":null,"hlc":"${H(3)}"}`,
    ];
    for (const bad of cases) {
      const before = opsRowCount();
      const { status, body } = await pushRaw(
        `{"deviceId":"dev_A","userId":"Meera","ops":[${bad},${good}]}`
      );
      expect(status).toBe(200);
      expect(body.results[0]).toMatchObject({ status: 'rejected', reason: 'invalid-op: __proto__' });
      expect(body.results[1].status).toMatch(/applied|duplicate/);
      expect(opsRowCount()).toBeLessThanOrEqual(before + 1);
    }
    expect(({} as Record<string, unknown>).admin).toBeUndefined();
  });

  it('keeps result order and runs later ops when an invalid op sits in the middle', async () => {
    const ops = [validCreate(1), { ...validSet(2, 'rec_ok_1'), field: 'evil' }, validSet(3, 'rec_ok_1')];
    const { status, body } = await pushRaw(JSON.stringify({ deviceId: 'dev_A', userId: 'Meera', ops }));
    expect(status).toBe(200);
    expect(body.results.map((r) => [r.opId, r.status])).toEqual([
      ['op_ok_1', 'applied'],
      ['op_set_2', 'rejected'],
      ['op_set_3', 'applied'],
    ]);
  });

  it('push: 50 ops accepted, 51 ops is an envelope 400', async () => {
    const fifty = Array.from({ length: 50 }, (_, i) => validCreate(i));
    expect((await pushRaw(JSON.stringify({ deviceId: 'dev_A', userId: 'Meera', ops: fifty }))).status).toBe(200);
    const fiftyOne = Array.from({ length: 51 }, (_, i) => validCreate(100 + i));
    const res = await pushRaw(JSON.stringify({ deviceId: 'dev_A', userId: 'Meera', ops: fiftyOne }));
    expect(res.status).toBe(400);
  });

  it('preview: 51 ops is an envelope 400; invalid ops are rejected per op; nothing persists', async () => {
    const fiftyOne = Array.from({ length: 51 }, (_, i) => validCreate(i));
    const tooMany = await app.inject({ method: 'POST', url: '/api/sync/preview', payload: { ops: fiftyOne } });
    expect(tooMany.statusCode).toBe(400);

    const before = opsRowCount();
    const res = await app.inject({
      method: 'POST',
      url: '/api/sync/preview',
      payload: { ops: [{ ...validCreate(1), hlc: 'bad' }, validCreate(2)] },
    });
    expect(res.statusCode).toBe(200);
    const results = (res.json() as { results: ApplyResult[] }).results;
    expect(results[0]).toMatchObject({ status: 'rejected', reason: 'invalid-op: hlc' });
    expect(results[1].status).toBe('applied');
    expect(opsRowCount()).toBe(before);
  });

  it('keeps 400 for malformed envelopes only', async () => {
    expect((await pushRaw(JSON.stringify({ userId: 'Meera', ops: [] }))).status).toBe(400);
    expect((await pushRaw(JSON.stringify({ deviceId: 'dev_A', userId: 'Meera', ops: 'x' }))).status).toBe(400);
    expect((await pushRaw('{not json')).status).toBe(400);
    const mixed = await pushRaw(JSON.stringify({ deviceId: 'dev_A', userId: 'Meera', ops: [42, null, validCreate(1)] }));
    expect(mixed.status).toBe(200);
    expect(mixed.body.results.map((r) => r.status)).toEqual(['rejected', 'rejected', 'applied']);
  });
});
