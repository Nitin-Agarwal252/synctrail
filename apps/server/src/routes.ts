import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { SyncRepo } from './repo';
import { WsBroadcaster } from './ws';
import { WebSocket } from 'ws';
import { classifyOps } from './opValidation';
import type { ApplyResult, Op } from '@synctrail/shared';

const EPOCH_RE = /^[A-Za-z0-9-]{1,64}$/;

const FieldValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const PushEnvelopeSchema = z.object({
  deviceId: z.string().min(1),
  userId: z.string().min(1),
  ops: z.array(z.unknown()).max(50),
});

const PreviewEnvelopeSchema = z.object({
  ops: z.array(z.unknown()).max(50),
});

const ResolveBodySchema = z.object({
  choice: z.enum(['mine', 'theirs', 'custom']),
  value: FieldValueSchema.optional(),
  userId: z.string().min(1),
  deviceId: z.string().min(1),
  opId: z.string().min(1),
  hlc: z.string().min(1),
});

function mergeClassifiedResults(
  classified: { op: Op | null; preResult?: ApplyResult }[],
  applied: ApplyResult[],
): ApplyResult[] {
  let k = 0;
  return classified.map((c) => {
    if (c.preResult) return c.preResult;
    return applied[k++];
  });
}

export function registerRoutes(
  app: FastifyInstance,
  repo: SyncRepo,
  broadcaster: WsBroadcaster,
) {
  // 1. Health endpoint (GET and HEAD): tiny, uncached
  app.route({
    method: ['GET', 'HEAD'],
    url: '/api/health',
    handler: async (_request, reply) => {
      reply.header('Cache-Control', 'no-store, no-cache, must-revalidate');
      return reply.code(200).send({ ok: true, seq: repo.getSeq(), epoch: repo.getEpoch() });
    },
  });

  // 2. Push endpoint (POST /api/sync/push)
  // 400 only for a malformed envelope. Each op is validated separately.
  app.post('/api/sync/push', async (request, reply) => {
    const parseRes = PushEnvelopeSchema.safeParse(request.body);
    if (!parseRes.success) {
      return reply.code(400).send({ error: 'Invalid push body', details: parseRes.error.issues });
    }

    const { deviceId, userId, ops } = parseRes.data;
    const classified = classifyOps(ops);
    const validOps = classified.flatMap((c) => (c.op ? [c.op] : []));
    const applied =
      validOps.length > 0
        ? repo.executePush(deviceId, userId, validOps)
        : { results: [] as ApplyResult[], seq: repo.getSeq(), changed: false };
    const results = mergeClassifiedResults(classified, applied.results);

    if (applied.changed) {
      broadcaster.broadcast({ type: 'changed', seq: applied.seq });
    }

    return reply.code(200).send({ results, seq: applied.seq });
  });

  // 3. Preview endpoint (POST /api/sync/preview) - NEVER persists
  app.post('/api/sync/preview', async (request, reply) => {
    const parseRes = PreviewEnvelopeSchema.safeParse(request.body);
    if (!parseRes.success) {
      return reply.code(400).send({ error: 'Invalid preview body', details: parseRes.error.issues });
    }

    const classified = classifyOps(parseRes.data.ops);
    const validOps = classified.flatMap((c) => (c.op ? [c.op] : []));
    const applied = validOps.length > 0 ? repo.executePreview(validOps) : { results: [] as ApplyResult[] };
    const results = mergeClassifiedResults(classified, applied.results);

    return reply.code(200).send({ results });
  });

  // 4. Pull endpoint (GET /api/sync/pull?since=<seq>&epoch=<id>)
  app.get('/api/sync/pull', async (request, reply) => {
    const query = request.query as { since?: string; epoch?: string };
    const sinceSeq = query.since ? Number(query.since) : 0;
    if (isNaN(sinceSeq) || sinceSeq < 0) {
      return reply.code(400).send({ error: 'Invalid since parameter' });
    }
    if (query.epoch !== undefined && !EPOCH_RE.test(query.epoch)) {
      return reply.code(400).send({ error: 'Invalid epoch parameter' });
    }

    const pullData = repo.pullForClient(sinceSeq, query.epoch);
    return reply.code(200).send(pullData);
  });

  // 5. Conflict resolve endpoint (POST /api/conflicts/:id/resolve)
  app.post('/api/conflicts/:id/resolve', async (request, reply) => {
    const params = request.params as { id: string };
    if (!params.id) {
      return reply.code(400).send({ error: 'Missing conflict id' });
    }

    const parseRes = ResolveBodySchema.safeParse(request.body);
    if (!parseRes.success) {
      return reply.code(400).send({ error: 'Invalid resolve body', details: parseRes.error.issues });
    }

    const { choice, value, userId, deviceId, opId, hlc } = parseRes.data;
    const choiceObj = choice === 'custom' ? { choice: 'custom' as const, value: value ?? null } : { choice };
    const resolverObj = { userId, deviceId, opId, hlc };

    const res = repo.resolve(params.id, choiceObj, resolverObj);
    if (!res.ok) {
      const statusCode = res.reason === 'not-found' ? 404 : res.reason === 'already-resolved' ? 409 : 400;
      return reply.code(statusCode).send(res);
    }

    if (res.seq !== undefined) {
      broadcaster.broadcast({ type: 'changed', seq: res.seq });
    }

    return reply.code(200).send({ ok: true });
  });

  // 6. Audit endpoint (GET /api/audit?recordId=&limit=)
  app.get('/api/audit', async (request, reply) => {
    const query = request.query as { recordId?: string; limit?: string };
    const limit = query.limit ? Math.min(Number(query.limit) || 100, 500) : 100;
    const entries = repo.getAudit(query.recordId, limit);
    return reply.code(200).send({ entries });
  });

  // 7. Stats endpoint (GET /api/stats)
  app.get('/api/stats', async (_request, reply) => {
    const stats = repo.getStats();
    return reply.code(200).send(stats);
  });

  // 8. Dev reset endpoint (POST /api/dev/reset)
  app.post('/api/dev/reset', async (_request, reply) => {
    const isProd = process.env.NODE_ENV === 'production';
    const allowReset = process.env.ALLOW_RESET === '1';
    if (isProd && !allowReset) {
      return reply.code(403).send({ error: 'Reset disabled in production' });
    }

    repo.seedDemoData();
    const seq = repo.getSeq();
    broadcaster.broadcast({ type: 'changed', seq });

    return reply.code(200).send({ ok: true, seeded: 12, seq, epoch: repo.getEpoch() });
  });

  // 9. WebSocket endpoint (/ws)
  app.get('/ws', { websocket: true }, (connection) => {
    const rawConn = connection as unknown as { socket?: WebSocket };
    const socket = (rawConn.socket ?? connection) as WebSocket;
    broadcaster.addClient(socket);
    socket.send(JSON.stringify({ type: 'connected', seq: repo.getSeq() }));
  });
}
