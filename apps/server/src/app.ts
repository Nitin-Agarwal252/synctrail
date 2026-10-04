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

/** Fastify's default, made explicit: larger push bodies get 413. */
export const BODY_LIMIT_BYTES = 1024 * 1024;

/**
 * SERVE_STATIC=1 serves the Vite build. From apps/server/dist (or src) the build is ../../web/dist;
 * WEB_DIST overrides it. A missing build is a startup error, not a silent API-only server.
 */
function resolveWebDist(): string | null {
  if (process.env.SERVE_STATIC !== '1') return null;
  const here = fileURLToPath(new URL('.', import.meta.url));
  const root = resolve(process.env.WEB_DIST ?? join(here, '../../web/dist'));
  if (!existsSync(join(root, 'index.html'))) {
    throw new Error(`SERVE_STATIC=1 but no web build at ${root}. Run \`npm run build\` or set WEB_DIST.`);
  }
  return root;
}

async function registerStatic(app: FastifyInstance, root: string): Promise<void> {
  await app.register(staticPlugin, { root, prefix: '/', wildcard: false });
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api') || request.url.startsWith('/ws')) {
      return reply.code(404).send({ error: 'Not found' });
    }
    return reply.sendFile('index.html', root);
  });
}

export async function buildApp(opts: AppOptions = {}): Promise<FastifyInstance> {
  const webDist = resolveWebDist();
  const app = Fastify({
    logger: opts.logger ?? false,
    bodyLimit: BODY_LIMIT_BYTES,
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

  if (webDist) await registerStatic(app, webDist);

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
