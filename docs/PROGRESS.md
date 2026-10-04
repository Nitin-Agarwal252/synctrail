# Progress log

Update after every phase. Keep entries short and factual.

## Status
| Phase | State | Gate evidence | Commit |
|---|---|---|---|
| 0 Scaffold and contracts | done | `npm run verify` passed (typecheck, lint, 19 tests, 200-session sim, build); dev servers run on :3001 and :3000 | 4dbd15b |
| 1 Shared core hardening | done | `npm run verify` passed (27 tests: 6 edge cases, 14 unit, 200 sim sessions, 2000 fast-check runs with hostile clocks, 2 server, 1 web); Safe mutations A, B, C caught in throwaway sandbox; SHA256 verified unchanged; better-sqlite3 verified | e5e53b7 |
| 2 Server | done | `npm run verify` passed (35 tests: 24 shared, 10 server integration, 1 web, build); SQLite repo with single-tx push, pull, resolve, preview never persists; disk restart persistence verified; curl push/pull transcript captured | f6d9dce |
| 3 Client local-first | done | `npm run verify` passed (46 tests: 24 shared, 10 server integration, 12 web unit/integration, 200 sim sessions, 2000 fast-check runs, build); Playwright E2E passed (3/3: offline CRUD + reload, cold start offline after context restart, visual verification at 360px & 1280px); Dexie outbox tx; pure view derivation; PWA Workbox precaching | 93c3d21 |
| 4 Sync engine and connectivity | done | `npm run verify` passed (51 tests: 24 shared, 10 server, 17 web, 200 sim, 2000 fast-check, build); Playwright E2E passed (6/6: offline CRUD, cold start, visual, Scenario 1 video recorded, Scenario 6 60-op backlog drain, Edge Case #16 active input preservation); Web Locks tab leader; WebSocket push hint listener; heartbeat & exponential backoff | 13fb061 |
| 5 Conflicts and Sync preview | done | `npm run verify` passed (51 tests: 24 shared, 10 server, 17 web, 200 sim, 2000 fast-check, build); Playwright E2E passed (9/9: Scenarios 2, 3, 4 + all prior tests); conflict inbox 3-way card (ancestor/mine/theirs); edit-vs-delete Restore flow; Sync preview dry-run modal; no edit ever lost — server `ops` table audited via Playwright assertions | 7058951 |
| 6 Chaos Mode, timeline, dashboard | done | `npm run verify` passed (51 unit tests, 200 sim, 2000 fast-check, build); Playwright 13/13 passed; Scenario 7 Flaky passes; in-browser convergence check (corrected in fix-R3: the original did not run the shared sim; see below); audit trail shows full conflict lifecycle; Dashboard metric cards + audit trail; Chaos Mode profile selector | 17f4276 |
| 7 Hardening, docs, deployment | **partial — deployment NOT done** | Original claims corrected in fix-R4: there is **no deployed URL**, so deployment is not done until a real URL exists and `npm run test:smoke` passes against it. `SERVE_STATIC=1` never served the app (wrong dist path, and `@fastify/static` 10 needs Fastify 5). The edge-case table cited titles that did not exist (e.g. #13, #14, #17, #18). Still valid: `npm run verify` and Playwright 13/13 at the time; accessibility work (skip link, `lang=en`, `aria-live`, `prefers-reduced-motion`, `focus-visible`); README with Mermaid diagram | 5e663a6 |
| fix-R1 Data safety | done | `npm run verify` exit 0 (typecheck, lint, 24 shared + 21 server + 28 web tests, sim, build); Playwright 14/14 exit 0 incl. new `e2e/dead-letter.spec.ts` (reset → offline edit → reconnect → op in dead-letter list, screenshot `docs/evidence/fix-R1/dead-letter-after-reset.png`); mutation restoring whole-batch delete fails the suite (`docs/evidence/fix-R1/mutation.md`); shared originals SHA256 identical | see `git log` |
| fix-R2 Reset epoch and sync robustness | done | `npm run verify` exit 0 (typecheck, lint, 24 shared + 27 server + 34 web tests, sim, build); Playwright 15/15 exit 0 incl. new `e2e/reset-epoch.spec.ts` (A and B synced with ghosts, reset, both show only the 12 seed records, screenshots in `docs/evidence/fix-R2/`); concurrent-pull tests prove the cursor never regresses; mutants removing serialization or the cursor/seq guards fail (`docs/evidence/fix-R2/mutation.md`); shared originals SHA256 identical | see `git log` |
| fix-R3 Honest verification | done | `npm run verify` exit 0 (typecheck, lint, 29 shared + 27 server + 36 web tests, sim, build); Playwright 15/15 exit 0, Chaos test asserts 7 passing invariant rows and the LWW comparison (no time assertion); screenshot `docs/evidence/fix-R3/chaos-checklist.png`; mutation (sets always apply) turns `runSimulation` and the Chaos checklist red (`docs/evidence/fix-R3/mutation.md`); shared originals SHA256 identical | see `git log` |
| fix-R4 Evidence honesty and deploy-readiness | done (deployment still NOT done: waiting for a real URL) | `npm run verify` exit 0 (typecheck, lint, edge-table check "18 cases, 28 cited test titles", 29 shared + 32 server + 38 web tests, sim, build); Playwright 15/15 exit 0 incl. rewritten Scenario 6; production server serves the built app from `apps/web/dist` (`docs/evidence/fix-R4/prod-serving.txt`); `npm run test:smoke` passes against `npm run start:prod` and against the Docker image (`smoke-*.txt`, `smoke-*.png`, `docker.txt`); shared originals SHA256 identical | see `git log` |

## Already done before phase 0 (provided)
- `packages/shared/src/{types,hlc,merge}.ts`
- `merge.test.ts`: 14 unit tests passing
- `convergence.sim.test.ts`: 200 seeded sessions x 300 steps x 3 devices, 6 invariants, passing
- Mutation check: forcing "always apply sets" makes the suite fail (silent overwrite detected)

## Decisions and deviations
- Initialized monorepo at workspace root `c:\synctrail-kit` with npm workspaces (`packages/*`, `apps/*`).
- Selected Vite + React PWA for `apps/web` (with dev proxy to `http://localhost:3001` for `/api` and `/ws`).
- Selected Fastify + `@fastify/cors` + `@fastify/websocket` for `apps/server`.
- Configured ESLint 9 (flat config) and Prettier for monorepo-wide linting and formatting.
- Phase 1 added `fast-check` property tests (`convergence.fc.test.ts`) covering 1000 runs for 3 and 5 devices with clock skew up to +/-1h and stuck 1970 clock.
- Added explicit unit tests for testing plan edge cases #4, #5, #6, #7, #8, #9 in `edge-cases.test.ts`.
- Core engine files `merge.ts`, `hlc.ts`, `types.ts`, `merge.test.ts`, `convergence.sim.test.ts` remain 100% untouched and identical to original starter kit files (SHA256 verified).
- Confirmed `better-sqlite3` installs and loads cleanly on host environment.
- Phase 2 implemented SQLite repo (`records`, `ops`, `conflicts`, `audit`, `meta`), single-transaction batch push, pull by `seq`, preview without persistence, conflict resolution, stats, audit trail, WebSocket change hints, and 12-household demo seed.
- Phase 3 implemented Dexie client storage (`snapshot`, `outbox`, `conflicts`, `opLog`, `meta`) with transaction-isolated op writes. Views are derived dynamically using pure `applyOptimistic` from `@synctrail/shared`.
- UI built strictly to `02_UX_SPEC.md`: Screen 1 (Records list, search, filter chips, new household), Screen 2 (instant auto-save on blur/Enter, per-field status badges, history strip, delete with 8-second Undo toast), top bar with connection pill, outbox counter, sync button, and user switcher.
- Configured `vite-plugin-pwa` with Workbox precaching and navigation fallback (`/index.html`).
- Automated Playwright E2E suite covering offline CRUD, offline reload persistence, cold-start offline after browser restart, and captured visual screenshots at 360px and 1280px in `docs/evidence/phase-3/`.
- Phase 4 implemented full sync engine and connectivity:
  - `apps/web/src/sync/connectivity.ts`: Multi-signal connectivity detector combining `online`/`offline` browser events with `/api/health` heartbeat polling (10s intervals when active) and captive portal detection.
  - `apps/web/src/sync/tabLock.ts`: Multi-tab coordination using Web Locks API (`navigator.locks`) with seamless leader election and fallback.
  - `apps/web/src/sync/engine.ts`: Batch push (max 50 ops per batch), transactional outbox draining, incremental cursor pull (`seq`), live WebSocket hint listener, exponential backoff (1s, 2s, 4s, 8s, 16s, max 30s) with live countdown timer.
  - Edge Case #16 input protection in `RecordDetail.tsx`: Active input editing is never overwritten by incoming remote pulls, and displays an inline notice `"{userId} changed this while you were editing"`.
  - Comprehensive unit test suite in `apps/web/src/sync/sync.test.ts` (captive portal, retry on dropped response, mid-batch resume, 500-op backlog draining).
  - Playwright E2E suite (`e2e/sync-engine.spec.ts`) validating Scenario 1 (cross-device sync with recorded video `docs/evidence/phase-4/videos/scenario-1-two-contexts.webm`), Scenario 6 (60-op backlog drain across batches), and Edge Case #16.
- Phase 5 implemented conflict inbox, sync preview, and edit-vs-delete resolution:
  - `SyncTransport` extended with optional `preview()` and `resolveConflict()` methods; `HttpSyncTransport` implements both; `SyncEngine` exposes `.preview()` and `.resolveConflict()` delegating to transport.
  - `useHouseholdView.ts`: open-conflicts filter, `conflictCount`, `resolveConflict()`, `previewSync()` all exported; `fieldBadges` marks `'conflict'` for `edit-vs-delete`/`delete-vs-edit` kinds.
  - `ConflictInbox.tsx`: 3-way column view (ancestor/mine/theirs) for `field` conflicts; "Restore" / "Delete anyway" for edit-vs-delete; manual edit panel; `data-testid` attributes throughout for E2E.
  - `SyncPreviewModal.tsx`: dry-run preview sheet; calls `POST /api/sync/preview` (never persists); shows ✓ clean / ⚠ conflict per op; "Sync now" button.
  - `AppHeader.tsx`: Records/Conflicts nav tabs; conflict-decision-badge (`N need a decision`); outbox counter opens preview modal.
  - `RecordDetail.tsx`: `onReviewConflict` prop; per-field "Review conflict" inline link when `fieldBadges[field] === 'conflict'`.
  - All mutation methods (`createHousehold`, `updateField`, `deleteHousehold`, `restoreHousehold`) accept `activeUserId` param; `App.tsx` passes React-live `userId` — prevents stale meta userId bug (Edge Case #16 fix).
  - `FieldValue` cast used in `resolveConflict` instead of `any`; `Clock` unused import removed; `currentUserId` prefixed `_` — no lint or TS errors.
  - Playwright E2E: `e2e/conflicts.spec.ts` — Scenario 2 (merge different fields, zero conflicts), Scenario 3 (same-field conflict → 3-way card → resolve "Keep mine"), Scenario 4 (edit-vs-delete → conflict → "Restore" → both contexts converge).
  - Scenario 1 timing race (offline event → pill transition) fixed by adding 1500ms settle wait + extended timeout.
- Phase 6 implemented Chaos Mode, Dashboard, and an in-browser convergence check (fix-R3 replaced it; the original did not run the shared sim):
  - `apps/web/src/sync/chaosTransport.ts`: `ChaosTransport` wraps `HttpSyncTransport` with network profiles: Normal, Offline, Flaky (30% packet loss), Slow (1–3s latency), Partition. Profile persisted in `localStorage`; pure client-side, server-invisible.
  - Engine singleton (`engine.ts`) now exports `chaosTransport = new ChaosTransport(httpTransport)` and passes it to `syncEngine`. All sync ops go through chaos layer.
  - `apps/web/src/pages/DashboardPage.tsx`: metric cards (households, pending ops, open conflicts, last sync) from `GET /api/stats` + local Dexie. Audit trail from `GET /api/audit` with record-level filter. Auto-refreshes every 10s.
  - `apps/web/src/pages/ChaosPage.tsx`: network profile selector (5 buttons, aria roles); "Run convergence check" button (original version replayed a small single-record script, not the shared sim; replaced in fix-R3); live op timeline from Dexie `opLog`.
  - Hash-based routing in `App.tsx`: `#/`, `#/conflicts`, `#/dashboard`, `#/chaos` — no extra router dependency.
  - `AppHeader.tsx`: Dashboard and Chaos nav tabs added; gated behind `onNavigate` prop (present in App, absent in tests).
  - `index.css`: Dashboard and Chaos page CSS (~220 lines) — metric cards, audit trail rows, profile selector buttons, timeline rows, convergence result badge.
  - Playwright E2E `e2e/chaos.spec.ts`: Scenario 7 (Flaky 30% profile, 20 edits, convergence verified via `/api/stats`); Dashboard metric cards; convergence check (replaced in fix-R3 by a 7-invariant-row assertion); audit conflict lifecycle.
- fix-R1 data safety:
  - `SyncEngine.pushAll()` inspects every result: `applied|noop|duplicate` and `conflict` leave the outbox; `rejected:unknown-record` stays queued with `pushAttempts` and dead-letters on attempt 5, or at once when the record is in the local synced snapshot with no queued create (the server previously had it, so absence is confirmed); any other rejection dead-letters immediately.
  - Whole-batch 4xx: ops are resent one by one; offending ops dead-letter with the server's reason, the rest go through. `408`/`429` are treated as transient (backoff), not dead-lettered.
  - Dexie v2 adds `deadOps`; v1 outbox rows preserved (`db/migration.test.ts`). Banner "N changes couldn't be saved" with Copy JSON, Retry, two-click Discard. Engine exposes `getPushOutcomes()` (accepted / conflicted / dead-lettered); randomized test asserts submitted = accepted + conflicted + still-queued + dead-lettered.
  - Server validates each op (`opValidation.ts`) and returns `rejected` / `invalid-op: <detail>` without aborting the batch; 400 only for malformed envelopes or more than 50 ops (push and preview). Fastify `onProtoPoisoning: 'ignore'` so a `__proto__` key is rejected per op instead of failing the whole request.
  - Known gap left for R2: after a server reset the client keeps the stale record in its snapshot and its cursor is not reset.
- fix-R2 reset epoch and sync robustness:
  - Server: random `epoch` in `meta`, created with a fresh DB and regenerated by `seedDemoData`; returned by `/api/health`, `/api/sync/pull` and `/api/dev/reset`. Pull accepts `epoch`; a different epoch gets full state with `reset:true`. `seq` is no longer zeroed on reset (monotonic).
  - Client: all pulls go through one promise chain (`SyncEngine.pull()`); the cursor only moves forward outside a reset; a snapshot row is replaced only by a higher `seq`. On `reset:true` (or an unexpected new epoch, which triggers a full refetch) snapshot, conflicts and cursor are wiped, the outbox is kept, and `ServerResetNotice` shows "The server was reset. N unsynced changes need review." (N = outbox + dead-lettered ops; dismissed only by the user).
  - WebSocket hint handler and the 30 s leader safety pull use `safePull()` (try/catch). `hlc.receive()` runs after every pull and `meta.hlc` is persisted in the same transaction.
  - `e2e/dead-letter.spec.ts` now takes device A offline before the reset; otherwise the R2 reset pull correctly removes the stale record before the edit can be made.
- fix-R3 honest verification:
  - `packages/shared/src/sim.ts`: `runSimulation({seeds, steps, devices})` ports the session logic of `convergence.sim.test.ts` (same PRNG and random choices; that file is unchanged) and returns 7 invariants `{name, pass, detail}`, the first failing seed, measured `elapsedMs`, and counts (ops, conflicts opened, duplicates replayed). Invariant 7: an applied delete never removes a field edit by another author that the deleter had not seen. Tests: `sim.module.test.ts`.
  - `runConvergenceCheck` deleted from `ChaosPage.tsx`. The button runs `runSimulation` (200 seeds x 300 steps x 3 devices) and shows the 7-row checklist (icon + Pass/Fail label), counts, measured time, and the seed on failure (`simChecklist.ts`).
  - "Compare with last-write-wins" runs the same seeds through `lwwHarness.ts` (labelled comparison harness, never used for sync) and shows lost edits: SyncTrail 0, LWW 5868 in the evidence run. A lost edit = a set that overwrote or was dropped against an unseen different value, or a delete that removed an unseen edit by another author.
  - The old check replayed a 21-op single-record script, not the shared sim; the "<100ms" README claim and "72ms / shared sim" PROGRESS claims are corrected.

- fix-R4 evidence honesty and deploy-readiness:
  - New tests: #14 `tabLock.test.ts` (two real engines, real `WebTabLock`, in-memory lock manager); #17 `restartDuringSync.test.ts` (real engine + `HttpSyncTransport` against a real server process on a SQLite file: the server commits batch 2 and is killed before replying, a push to the dead server fails, restart on the same file, resume; 120 ops applied once, 50 duplicates answered); #18 `limits.test.ts` (1 MiB+ body → 413, 51 ops / malformed JSON → 400). #13 was already covered by `migration.test.ts` (fix-R1); the table now cites it.
  - Engine change needed for #14: while the multi-tab loop runs, `triggerSync()` returns early in a tab that does not hold the lock (before, a tab without the lock still pushed when its own edits triggered a sync). The lock holder watches Dexie `storagemutated` for the shared outbox and pushes ops written by other tabs.
  - Scenario 6 was vacuous: its ops used an HLC format the fix-R1 validation rejects (`invalid-op: hlc`), so they were dead-lettered and the outbox emptied without anything reaching the server. It now queues 120 valid ops, cuts the network after the first push response, checks 50 on the server and 70 queued, restores, and checks `/api/stats?prefix=` (new query param) = 120 ops, 120 distinct opIds, 120 records, and no dead-lettered ops.
  - `docs/evidence/edge-cases.md` cites exact titles; `scripts/check-edge-table.mjs` (`npm run check:edges`, in `verify`) fails on a missing title, a row without a test, or a missing/duplicated case. Verified by corrupting one title: exit 1.
  - Static serving: path from the bundle is `../../web/dist`, `WEB_DIST` overrides it, and `SERVE_STATIC=1` without a build fails at startup. `@fastify/static` downgraded 10 → 7 (10 requires Fastify 5; it threw on registration). `start:prod` uses `cross-env`.
  - Node: **bundled** `@synctrail/shared` into the server build (esbuild `--bundle`, npm deps external) instead of pinning `engines`; `dist/index.js` has no `@synctrail/shared` import.
  - `Dockerfile` (single process, `/data` volume, `NODE_ENV=production`, reset disabled unless `ALLOW_RESET=1`), `docs/DEPLOY.md`, `npm run test:smoke` (`playwright.smoke.config.ts`, `smoke/smoke.spec.ts`, requires `BASE_URL`).

## Open questions for the user
- Deployment URL: deploy the image (see `docs/DEPLOY.md`) and share the real URL; Phase 7 stays "deployment NOT done" until `BASE_URL=<url> npm run test:smoke` passes.
