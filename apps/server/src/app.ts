import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import staticPlugin from '@fastify/static';
import { createDatabase, DatabaseInstance } from './db';
import { SyncRepo } from './repo';
import { WsBroadcaster } from './ws';
import { registerRoutes } from './routes';
import { existsSync } from 'fs';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';

export interface AppOptions {
  logger?: boolean;
  dbPath?: string;
  autoSeedIfEmpty?: boolean;
}

export interface AppContext {
  app: FastifyInstance;
  db: DatabaseInstance;
  repo: SyncRepo;
  broadcaster: WsBroadcaster;
}

export async function buildApp(opts: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? false,
    // A `__proto__` key must reject only the op that carries it, not the whole
    // batch. opValidation.ts rejects it per op; JSON.parse never pollutes prototypes.
    onProtoPoisoning: 'ignore',
  });

  await app.register(cors, {
    origin: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  });

  await app.register(websocket);

  const db = createDatabase(opts.dbPath ?? (process.env.DB_PATH || 'synctrail.db'));
  const repo = new SyncRepo(db);
  const broadcaster = new WsBroadcaster();

  // If autoSeedIfEmpty is enabled or database has 0 records, seed initial demo households
  if (opts.autoSeedIfEmpty || repo.getStats().records === 0) {
    repo.seedDemoData();
  }

  registerRoutes(app, repo, broadcaster);

  // Production single-process mode: serve the Vite web build.
  // Enabled only when SERVE_STATIC=1 and apps/web/dist exists.
  if (process.env.SERVE_STATIC === '1') {
    // __dirname equivalent in ESM
    const __dirname = fileURLToPath(new URL('.', import.meta.url));
    // When built, index.js is in dist/ and web dist is at ../../apps/web/dist relative to source
    const webDist = resolve(join(__dirname, '../../../web/dist'));
    const webDistAlt = resolve(join(__dirname, '../../apps/web/dist'));
    const staticRoot = existsSync(webDist) ? webDist : existsSync(webDistAlt) ? webDistAlt : null;

    if (staticRoot) {
      await app.register(staticPlugin, {
        root: staticRoot,
        prefix: '/',
        wildcard: false,
      });
      // SPA fallback — all unmatched non-/api routes serve index.html
      app.setNotFoundHandler((_request, reply) => {
        if (_request.url.startsWith('/api') || _request.url.startsWith('/ws')) {
          return reply.code(404).send({ error: 'Not found' });
        }
        return reply.sendFile('index.html', staticRoot);
      });
    }
  }

  // Decorate app for testing and inspection
  app.decorate('db', db);
  app.decorate('repo', repo);
  app.decorate('broadcaster', broadcaster);

  app.addHook('onClose', (_instance, done) => {
    try {
      db.close();
    } catch {
      // ignore
    }
    done();
  });

  return app;
}
