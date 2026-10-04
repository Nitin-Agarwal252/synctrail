# Deploying SyncTrail

SyncTrail runs as **one Node process**: Fastify serves the API (`/api/*`), the WebSocket hint channel
(`/ws`) and the built PWA (`apps/web/dist`) when `SERVE_STATIC=1`. Data lives in one SQLite file.

**Status:** not deployed yet. There is no public URL until one is created and `npm run test:smoke`
passes against it.

## Build and run

```bash
npm ci
npm run start:prod          # build, then SERVE_STATIC=1 node apps/server/dist/index.js (cross-platform via cross-env)
```

Or with Docker (the image serves on port 8080):

```bash
docker build -t synctrail .
docker run -p 8080:8080 -v synctrail-data:/data synctrail
```

Node: the server build bundles `@synctrail/shared` (`esbuild --bundle`, only npm dependencies are
external), so `apps/server/dist/index.js` never loads `.ts` files at runtime. Node 22 is what is tested.

### Render (free)

`render.yaml` is a Render Blueprint for one free Docker web service. In Render: **New → Blueprint**,
pick this GitHub repo, **Apply**. Render builds the `Dockerfile` and serves it at
`https://<service>.onrender.com` (HTTPS and wss included). Free-tier limits: the service sleeps after
15 minutes idle (the first request then takes about a minute) and has no persistent disk, so data is
reseeded on every restart (the ephemeral demo option below).

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3001` (`8080` in Docker) | Listen port |
| `HOST` | `0.0.0.0` | Listen address |
| `SERVE_STATIC` | unset (`1` in Docker) | `1` serves the web build. If the build folder is missing the server **fails at startup** |
| `WEB_DIST` | `apps/web/dist` (resolved as `../../web/dist` from the server bundle) | Override the web build folder |
| `DB_PATH` | `synctrail.db` (`/data/synctrail.db` in Docker) | SQLite file |
| `NODE_ENV` | unset (`production` in Docker) | `production` disables `POST /api/dev/reset` unless `ALLOW_RESET=1` |
| `ALLOW_RESET` | unset | `1` re-enables the reset endpoint. **Demos only**: anyone who can reach the URL can wipe the data |

## Requirements for a real deployment

- **HTTPS.** Service workers and the PWA install need a secure origin. Terminate TLS at the platform
  (Render, Fly.io, Railway, a reverse proxy) and forward to `PORT`.
- **wss.** The client opens `wss://<host>/ws` when the page is served over `https:` (`ws://` otherwise),
  on the same host as the page. The proxy must allow WebSocket upgrades on `/ws`. If it does not, sync
  still works through the heartbeat, the 30 s safety pull and user-triggered syncs, only without live hints.
- **One instance.** SQLite and the in-process WebSocket broadcaster do not support more than one replica.
- **Storage — pick one:**
  - *Persistent:* mount a volume at the `DB_PATH` folder (`/data` in Docker). Data survives restarts and redeploys.
  - *Ephemeral demo:* no volume. An empty database is seeded with the 12 demo households on boot, and a
    new reset epoch is created, so devices that synced with an earlier instance are told the server was
    reset and their unsynced changes are kept for review (see `docs/04_DATA_MODEL_AND_SYNC_PROTOCOL.md`).
- **Health check:** `GET /api/health` returns `200 {"ok":true,"seq":…,"epoch":…}`.

## Verify a deployment

```bash
BASE_URL=https://<your-host> npm run test:smoke
```

The smoke test (`smoke/smoke.spec.ts`) checks `/api/health`, that `/api/nope` is a JSON 404, that the
app shell loads, opens a WebSocket on `/ws`, reaches "Synced" and shows records. Set `SMOKE_SCREENSHOT=<file>`
to save a screenshot.
