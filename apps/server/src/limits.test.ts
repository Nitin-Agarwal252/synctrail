import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { hlc } from '@synctrail/shared';
import { buildApp, BODY_LIMIT_BYTES } from './app';

function createOp(i: number, extra: Record<string, unknown> = {}) {
  return {
    opId: `lim_op_${i}`,
    deviceId: 'dev_L',
    userId: 'Meera',
    recordId: `lim_rec_${i}`,
    type: 'create',
    fields: { name: `Limit ${i}` },
    baseHlc: null,
    hlc: hlc.format({ wall: 1_700_000_000_000 + i, counter: 0, node: 'dev_L' }),
    ...extra,
  };
}

describe('Push body limits (edge case #18)', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp({ dbPath: ':memory:' });
  });

  afterEach(async () => {
    await app.close();
  });

  it('an oversized push body returns 413 and persists nothing', async () => {
    const before = await app.inject({ method: 'GET', url: '/api/stats' });
    const huge = 'x'.repeat(BODY_LIMIT_BYTES + 1);
    const payload = JSON.stringify({ deviceId: 'dev_L', userId: 'Meera', ops: [createOp(1, { fields: { notes: huge } })] });
    const res = await app.inject({
      method: 'POST',
      url: '/api/sync/push',
      headers: { 'content-type': 'application/json' },
      payload,
    });
    expect(res.statusCode).toBe(413);
    const after = await app.inject({ method: 'GET', url: '/api/stats' });
    expect(after.json().ops).toBe(before.json().ops);
  });

  it('51 ops (over the batch limit) and a malformed JSON body each return 400', async () => {
    const tooMany = await app.inject({
      method: 'POST',
      url: '/api/sync/push',
      payload: { deviceId: 'dev_L', userId: 'Meera', ops: Array.from({ length: 51 }, (_, i) => createOp(i)) },
    });
    expect(tooMany.statusCode).toBe(400);

    const malformed = await app.inject({
      method: 'POST',
      url: '/api/sync/push',
      headers: { 'content-type': 'application/json' },
      payload: '{"deviceId":"dev_L","ops":[',
    });
    expect(malformed.statusCode).toBe(400);
  });

  it('GET /api/stats?prefix= counts ops, distinct opIds and records by id prefix; a bad prefix is 400', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/sync/push',
      payload: { deviceId: 'dev_L', userId: 'Meera', ops: [createOp(1), createOp(2), createOp(1)] },
    });
    const res = await app.inject({ method: 'GET', url: '/api/stats?prefix=lim_' });
    expect(res.statusCode).toBe(200);
    expect(res.json().prefix).toEqual({ value: 'lim_', ops: 2, distinctOpIds: 2, records: 2 });

    const bad = await app.inject({ method: 'GET', url: '/api/stats?prefix=a%25b' });
    expect(bad.statusCode).toBe(400);
  });
});
