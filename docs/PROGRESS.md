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
| 6 Chaos Mode, timeline, dashboard | done | `npm run verify` passed (51 unit tests, 200 sim, 2000 fast-check, build); Playwright 13/13 passed; Scenario 7 Flaky passes; convergence check 200 seeds in 72ms (gate: <10s); audit trail shows full conflict lifecycle; Dashboard metric cards + audit trail; Chaos Mode profile selector | 17f4276 |
| 7 Hardening, docs, deployment | done | `npm run verify` exit 0 (51 unit, 200 sim, 2000 fc, build); Playwright 13/13 exit 0; accessibility: skip link, `lang=en`, `aria-live`, `prefers-reduced-motion`, `focus-visible` rings; README final with Mermaid diagram + all 5 success criteria; edge-case table all 18 rows linked to passing tests; static-serve mode via `SERVE_STATIC=1`; server health `/api/health` 200 verified from built `dist/`; `--primary` CSS var fixed | 5e663a6 |
| fix-R1 Data safety | done | `npm run verify` exit 0 (typecheck, lint, 24 shared + 21 server + 28 web tests, sim, build); Playwright 14/14 exit 0 incl. new `e2e/dead-letter.spec.ts` (reset → offline edit → reconnect → op in dead-letter list, screenshot `docs/evidence/fix-R1/dead-letter-after-reset.png`); mutation restoring whole-batch delete fails the suite (`docs/evidence/fix-R1/mutation.md`); shared originals SHA256 identical | see `git log` |

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
- Phase 6 implemented Chaos Mode, Dashboard, and in-browser convergence check:
  - `apps/web/src/sync/chaosTransport.ts`: `ChaosTransport` wraps `HttpSyncTransport` with network profiles: Normal, Offline, Flaky (30% packet loss), Slow (1–3s latency), Partition. Profile persisted in `localStorage`; pure client-side, server-invisible.
  - Engine singleton (`engine.ts`) now exports `chaosTransport = new ChaosTransport(httpTransport)` and passes it to `syncEngine`. All sync ops go through chaos layer.
  - `apps/web/src/pages/DashboardPage.tsx`: metric cards (households, pending ops, open conflicts, last sync) from `GET /api/stats` + local Dexie. Audit trail from `GET /api/audit` with record-level filter. Auto-refreshes every 10s.
  - `apps/web/src/pages/ChaosPage.tsx`: network profile selector (5 buttons, aria roles); "Run convergence check" button runs 200 seeded sessions of the shared sim in-browser (72ms wall clock); live op timeline from Dexie `opLog`.
  - Hash-based routing in `App.tsx`: `#/`, `#/conflicts`, `#/dashboard`, `#/chaos` — no extra router dependency.
  - `AppHeader.tsx`: Dashboard and Chaos nav tabs added; gated behind `onNavigate` prop (present in App, absent in tests).
  - `index.css`: Dashboard and Chaos page CSS (~220 lines) — metric cards, audit trail rows, profile selector buttons, timeline rows, convergence result badge.
  - Playwright E2E `e2e/chaos.spec.ts`: Scenario 7 (Flaky 30% profile, 20 edits, convergence verified via `/api/stats`); Dashboard metric cards; convergence check 200 seeds (72ms); audit conflict lifecycle.
- fix-R1 data safety:
  - `SyncEngine.pushAll()` inspects every result: `applied|noop|duplicate` and `conflict` leave the outbox; `rejected:unknown-record` stays queued with `pushAttempts` and dead-letters on attempt 5, or at once when the record is in the local synced snapshot with no queued create (the server previously had it, so absence is confirmed); any other rejection dead-letters immediately.
  - Whole-batch 4xx: ops are resent one by one; offending ops dead-letter with the server's reason, the rest go through. `408`/`429` are treated as transient (backoff), not dead-lettered.
  - Dexie v2 adds `deadOps`; v1 outbox rows preserved (`db/migration.test.ts`). Banner "N changes couldn't be saved" with Copy JSON, Retry, two-click Discard. Engine exposes `getPushOutcomes()` (accepted / conflicted / dead-lettered); randomized test asserts submitted = accepted + conflicted + still-queued + dead-lettered.
  - Server validates each op (`opValidation.ts`) and returns `rejected` / `invalid-op: <detail>` without aborting the batch; 400 only for malformed envelopes or more than 50 ops (push and preview). Fastify `onProtoPoisoning: 'ignore'` so a `__proto__` key is rejected per op instead of failing the whole request.
  - Known gap left for R2: after a server reset the client keeps the stale record in its snapshot and its cursor is not reset.

## Open questions for the user
(none)
