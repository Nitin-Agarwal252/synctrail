import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from './app';

const INDEX_HTML = '<!doctype html><html><head><title>SyncTrail build</title></head><body></body></html>';

describe('Production static serving (SERVE_STATIC=1)', () => {
  const saved = { SERVE_STATIC: process.env.SERVE_STATIC, WEB_DIST: process.env.WEB_DIST };
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synctrail-web-'));
    fs.writeFileSync(path.join(dir, 'index.html'), INDEX_HTML);
    process.env.SERVE_STATIC = '1';
    process.env.WEB_DIST = dir;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('GET / returns index.html, deep links fall back to it, GET /api/nope returns a JSON 404', async () => {
    const app = await buildApp({ dbPath: ':memory:' });
    try {
      const root = await app.inject({ method: 'GET', url: '/' });
      expect(root.statusCode).toBe(200);
      expect(root.headers['content-type']).toContain('text/html');
      expect(root.body).toBe(INDEX_HTML);

      const deep = await app.inject({ method: 'GET', url: '/conflicts/anything' });
      expect(deep.statusCode).toBe(200);
      expect(deep.body).toBe(INDEX_HTML);

      const api = await app.inject({ method: 'GET', url: '/api/nope' });
      expect(api.statusCode).toBe(404);
      expect(api.headers['content-type']).toContain('application/json');
      expect(api.json()).toEqual({ error: 'Not found' });

      const health = await app.inject({ method: 'GET', url: '/api/health' });
      expect(health.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('fails at startup when SERVE_STATIC=1 and the web build folder is missing', async () => {
    process.env.WEB_DIST = path.join(dir, 'does-not-exist');
    await expect(buildApp({ dbPath: ':memory:' })).rejects.toThrow(/SERVE_STATIC=1 but no web build/);
  });
});
