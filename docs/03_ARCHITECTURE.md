# 03 · Architecture

## Diagram
```
┌──────────────────────────── Browser (PWA) ────────────────────────────┐
│  UI (React)                                                            │
│   └─ useRecords() / useSyncStatus()  ← live queries over Dexie         │
│  Local store (Dexie / IndexedDB)                                       │
│   ├─ snapshot      last server state per record                        │
│   ├─ outbox        pending ops, ordered                                │
│   ├─ meta          deviceId, userId, hlc, cursor, lastSyncedAt         │
│   └─ view          = snapshot + outbox applied via applyOptimistic()   │
│  Sync engine                                                           │
│   ├─ connectivity  events + heartbeat GET /api/health                  │
│   ├─ push          POST /api/sync/push (batch, resumable)              │
│   ├─ pull          GET  /api/sync/pull?since=cursor                    │
│   └─ transport     fetch wrapper (Chaos Mode lives here)               │
│  Service worker (Workbox): app shell + static assets, precached        │
└───────────────┬───────────────────────────────┬────────────────────────┘
                │ HTTPS                         │ WebSocket (change hints)
┌───────────────▼───────────────────────────────▼────────────────────────┐
│ Server (Node, Fastify, ws)                                              │
│  routes → service → shared merge engine (applyOp, resolveConflict, …)   │
│  repo (SQLite): records, ops, conflicts, audit, meta(seq)               │
└─────────────────────────────────────────────────────────────────────────┘
packages/shared: types, hlc, merge (pure). Imported by BOTH sides.
```

## Repository layout
```
synctrail/
├─ AGENTS.md  README.md  package.json  tsconfig.base.json
├─ docs/                      (these specs)
├─ antigravity/KICKOFF_PROMPT.md
├─ packages/shared/           types.ts hlc.ts merge.ts + tests (provided)
├─ apps/server/               src/{index,app,routes,repo,ws}.ts + tests
└─ apps/web/                  src/{ui,state,sync,db,pwa}/ + e2e/
```

## Data flow
**Local edit:** UI → build `Op` (fresh `opId`, `hlc = tick`, `baseHlc` from the current view) → one Dexie transaction writes the op to `outbox` → `view` recomputed → UI updates. No network involved.

**Sync cycle** (triggered by: reconnect, manual Sync, outbox change while online, WebSocket hint, 30 s timer):
1. If not online (heartbeat failed), stop.
2. `push`: send outbox ops in order, in batches of up to 50. For each result: `applied | noop | duplicate` → remove from outbox; `conflict` → remove from outbox (it now lives on the server as a Conflict); `rejected: unknown-record` → keep and retry after earlier ops land.
3. `pull`: fetch records and conflicts with `seq > cursor`, write to `snapshot`, advance `cursor`, `receive()` the max HLC into the local clock.
4. Recompute `view`. Update status badges.
5. On any failure: keep the outbox untouched, back off, retry. Because ops are idempotent, resending a batch whose response was lost is always safe.

**Live updates:** after each applied change the server broadcasts `{type:"changed", seq}` over WebSocket. Clients treat it as a hint to pull. WebSocket loss never affects correctness.

## Key decisions (record the reasons in the README)
| Decision | Why |
|---|---|
| Op log, not state overwrite | Makes retries idempotent and every change auditable |
| Field-level, equality-based merge (`cur.hlc === baseHlc`) | Sound regardless of clocks or arrival order; different fields merge automatically |
| HLC for ordering display and causality, not for correctness | Wrong phone clocks cannot corrupt results |
| Shared pure merge module | One implementation, testable in isolation and in randomized simulation |
| Server is the judge, client is optimistic | Clients show local intent instantly; the server decides applied vs conflict |
| Conflicts stored as data | Never blocks sync; resolution is itself an audited operation |
| Heartbeat + events for connectivity | `navigator.onLine` reports captive portals as online |
| Chaos in the client transport | Lets judges break the network per device without server changes |
| SQLite on the server | Zero-config and deployable. Repo interface allows swapping to Postgres |

## Service worker strategy
- Precache the app shell and built assets (Workbox `precacheAndRoute`).
- Navigation requests: network-first with fallback to cached shell, so a cold start offline opens the app.
- `/api/*` is never cached by the service worker. Data offline comes from IndexedDB.
- Register the SW in production builds; document how to test with DevTools offline and with a full browser restart.

## Failure handling matrix
| Failure | Behavior |
|---|---|
| Offline during edit | Edit stored in outbox, badge Pending |
| Response lost after server applied | Retry sends same `opId`, server returns `duplicate`, op leaves outbox |
| Connection drops mid-batch | Remaining ops stay queued; next cycle resumes |
| Server restart | Heartbeat fails, backoff, resume |
| Create not yet delivered when a set arrives | Server returns `rejected: unknown-record` without marking seen; client retries after the create |
| IndexedDB schema upgrade with non-empty outbox | Dexie version migration preserves the outbox (tested) |
| Two tabs open | `BroadcastChannel` plus a Dexie lock so only one tab runs the sync loop |

## Deployment
Single Node service serving the built web app and API, SQLite file on a persistent volume (or accept ephemeral reset and re-seed on boot for the demo). HTTPS is required for service workers. Provide `npm run build && npm start`.
