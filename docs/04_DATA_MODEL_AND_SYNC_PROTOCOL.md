# 04 · Data model and sync protocol

The authoritative types are in `packages/shared/src/types.ts`. The authoritative merge behavior is `packages/shared/src/merge.ts`. This document describes how they are stored and transported.

## Domain fields
`Household` fields: `name`, `phone`, `address`, `status` (`new` | `follow-up` | `completed`), `notes`. All stored as `FieldValue` (`string | number | boolean | null`). Record ids are client-generated UUIDs (no `:` character).

## Ops (the unit of change)
```ts
Op {
  opId, deviceId, userId, recordId,
  type: 'create' | 'set' | 'delete' | 'restore',
  fields?  (create), field?, value? (set),
  baseHlc  (set: HLC of the field version the author saw; else null),
  seen?    (delete: field → HLC snapshot of the author's view),
  hlc
}
```
Client rules when building ops:
- `set`: `baseHlc = view.fields[field]?.hlc ?? null`.
- `delete`: `seen = seenOf(viewRecord)`.
- `hlc = tick(meta.hlc, deviceId, Date.now())`, then persist `meta.hlc`.
- After every pull: `meta.hlc = receive(meta.hlc, maxVersionSeen, deviceId, Date.now())`.

## Merge rules (server, via `applyOp`)
| Incoming op | Condition | Result |
|---|---|---|
| any | `opId` already seen | `duplicate` (no change) |
| set / delete / restore | record unknown | `rejected: unknown-record` (not marked seen; retry later) |
| create | record exists | `noop` |
| create | new | `applied` |
| set | record deleted | `conflict (edit-vs-delete)` |
| set | same device has an open conflict on this field with `mine.hlc === baseHlc` | `conflict` (folded into that conflict) |
| set | `cur.value === value` | `noop` |
| set | field absent, or `cur.hlc === baseHlc` | `applied` |
| set | otherwise | `conflict (field)` |
| delete | already deleted | `noop` |
| delete | another author changed any field not matching `seen` | `conflict (delete-vs-edit)` |
| delete | otherwise | `applied` (tombstone) |
| restore | not deleted | `noop` |
| restore | deleted | `applied` |

Resolution (`resolveConflict`): `mine` applies the held op; `theirs` keeps the server state; `custom` writes a new value (field and edit-vs-delete only). `edit-vs-delete` + `mine` or `custom` restores the record and writes the field. A resolution is recorded in the op log and the audit trail. Resolving twice is refused.

## Server schema (SQLite)
```sql
CREATE TABLE records (
  id TEXT PRIMARY KEY, fields_json TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,
  deleted_hlc TEXT, deleted_by_json TEXT, version TEXT NOT NULL, seq INTEGER NOT NULL
);
CREATE TABLE ops (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, op_id TEXT NOT NULL UNIQUE, record_id TEXT NOT NULL,
  device_id TEXT NOT NULL, user_id TEXT NOT NULL, op_json TEXT NOT NULL, status TEXT NOT NULL
);
CREATE TABLE conflicts (
  id TEXT PRIMARY KEY, record_id TEXT NOT NULL, json TEXT NOT NULL, status TEXT NOT NULL, seq INTEGER NOT NULL
);
CREATE TABLE audit (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, kind TEXT NOT NULL,
  record_id TEXT NOT NULL, user_id TEXT NOT NULL, op_id TEXT, conflict_id TEXT, detail TEXT
);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);  -- 'seq' global counter
```
Implementation note: load affected records into an in-memory `ServerState`, call the shared functions, then persist the diff, all inside one SQLite transaction per push batch. A global `seq` increments on every change to a record or conflict and is stamped on the row, which is what `pull` filters on.

## Client schema (Dexie)
```ts
db.version(1).stores({
  snapshot: 'id, seq',          // RecordState + seq (last server state)
  outbox:   '++n, opId, recordId',  // pending Op, ordered by n
  conflicts:'id, recordId, status', // mirrored from server pulls
  opLog:    '++n, opId',        // local timeline for the Chaos view (capped at 500)
  meta:     'key'               // deviceId, userId, hlc, cursor, epoch, lastSyncedAt, serverResetNotice, chaosProfile
});
db.version(2).stores({
  // additive: existing outbox rows are preserved
  deadOps: '++n, opId, recordId', // unsaved ops; discard is a user action only
});
```
`view` is derived: start from `snapshot`, apply `outbox` ops in order with `applyOptimistic`. Never persist `view`.

## HTTP API (JSON)
All times are HLC strings. All bodies are validated (zod or equivalent); invalid input returns `400` with `{error}`.

| Method and path | Request | Response |
|---|---|---|
| `GET /api/health` (also `HEAD`) | — | `200 {ok:true, seq, epoch}` (used by the heartbeat, must be tiny and uncached) |
| `POST /api/sync/push` | `{deviceId, userId, ops: Op[]}` (max 50) | `{results: ApplyResult[], seq}` in the same order as `ops` |
| `POST /api/sync/preview` | `{ops: Op[]}` | `{results: ApplyResult[]}`; never persists |
| `GET /api/sync/pull?since=<seq>&epoch=<id>` | — | `{records: (RecordState & {seq})[], conflicts: Conflict[], seq, epoch, reset}`. If `epoch` is given and differs from the server's, the server answers with full state (`since=0`) and `reset:true` |
| `POST /api/conflicts/:id/resolve` | `{choice, value?, userId, deviceId, opId, hlc}` | `{ok, reason?}` |
| `GET /api/audit?recordId=&limit=` | — | `{entries: AuditEntry[]}` |
| `GET /api/stats` | — | `{records, openConflicts, ops, lastSeq}` for the dashboard |
| `POST /api/dev/reset` | — | reseeds demo data and generates a new `epoch`; `seq` keeps increasing (disabled when `NODE_ENV=production` unless `ALLOW_RESET=1`) |
| `WS /ws` | server → client `{type:"changed", seq}` | hint only |

Push semantics: ops are processed **in order**. The response never short-circuits; every op gets a result. A `rejected` op does not stop later ops, but because clients keep ops ordered, it only happens when a create has not landed.

HTTP **400** is reserved for a **malformed envelope** (missing `deviceId`/`userId`, `ops` not an array, more than 50 ops). Individual ops are validated separately and must not abort the batch. An illegal op returns `{status:'rejected', reason:'invalid-op: <detail>'}` in its result slot; later ops still run.

Per-op validation (push and preview):
- HLC (`hlc`, and `baseHlc`/`seen` values when present) matches `/^\d{15}:\d{5}:[^:\s]+$/`
- ids (`opId`, `deviceId`, `userId`, `recordId`) match `/^[A-Za-z0-9_-]{1,64}$/`
- field names from the allowlist `name | phone | address | status | notes`
- `status` values `new | follow-up | completed`
- `set` requires `value`
- reject the key `__proto__` on the op, `fields`, or `seen` (`invalid-op: __proto__`, per op; Fastify `onProtoPoisoning` is set to `ignore` so the JSON parser does not 400 the whole batch first)
- max **50** ops for both push and preview (envelope 400 if exceeded)

### Client outbox after push
The client inspects **every** `results[i]` and never deletes a whole batch because HTTP succeeded.

| Result | Outbox |
|---|---|
| `applied` / `noop` / `duplicate` | remove |
| `conflict` | remove (the server holds a `Conflict`) |
| `rejected` with `unknown-record` | **keep**; increment attempts. After **5** attempts, or after a pull confirms the record is absent (or a local snapshot is stale vs the server), move to `deadOps` |
| any other `rejected` reason (including `invalid-op: …`) | move to `deadOps` immediately |

Whole-batch **4xx**: do not retry the batch forever. Resend ops **one by one**. Offending ops go to `deadOps` with the server's reason; the rest go through. Exceptions: `408` and `429` describe timing, not content, so they are retried with backoff like network errors and `5xx`.

Discard from the dead-letter is a **user action only** (two clicks: Discard, then Discard permanently). Retry moves the op back to the end of the outbox with attempts reset. Nothing is deleted silently.

Invariant: `submitted = accepted + conflicted + still-queued + dead-lettered`.

Client Dexie v2 adds `deadOps: '++n, opId, recordId'` without dropping the existing outbox.

## Sync status state machine (client, per record)
```
local-only ──(op queued)──▶ pending ──(push started)──▶ syncing ──▶ synced
                               ▲                          │
                               └──(failure, retry)────────┤
                                                          ├──▶ conflict (server returned conflict)
                                                          └──▶ failed (retrying, shown after 3 failed attempts)
```
`conflict` clears when the pull shows the conflict as resolved. A record is `pending` if any outbox op references it.

## Conflict display data
For a `field` conflict the UI needs: `baseValue` (ancestor), `mine.value` and `mine.userId` and `mine.hlc`, `theirs.value` and `theirs.userId` and `theirs.hlc`. The wall-clock time shown is the first segment of the HLC (`parse(h).wall`). Label it as the author's device time.

## Seed data
12 households, 3 users (Meera, Dev, Arjun), 2 devices per demo (two browser profiles). `POST /api/dev/reset` restores this state for repeatable demos.

## Reset epoch and pull rules

- The server stores a random `epoch` in `meta`. It is created with a fresh database and regenerated by `seedDemoData` (reset). `seq` is never reset, so it stays monotonic across resets.
- The client sends its stored `epoch` on every pull. On `reset:true` (or a response epoch that differs from the stored one, which triggers a full refetch) it clears `snapshot`, `conflicts` and `cursor`, loads the full state, keeps the outbox (the R1 rules then apply to each op), and shows "The server was reset. N unsynced changes need review." N = outbox ops + dead-lettered ops at that moment. The notice stays until the user dismisses it.
- All pulls (sync loop, WebSocket hint, safety timer, after resolve) go through one promise chain: never two at once.
- The cursor never moves backwards outside a reset. A snapshot record is replaced only by a row with a higher `seq`.
- The WebSocket hint handler catches its own errors. The tab leader runs a safety pull every 30 s while online.
- After each pull: `meta.hlc = receive(meta.hlc, maxVersionSeen, deviceId, Date.now())`, in the same transaction.
