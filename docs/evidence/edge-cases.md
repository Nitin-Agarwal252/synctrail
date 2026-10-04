# Edge-case table

Every edge case from `docs/05_TESTING_PLAN.md` is linked to a passing automated test.
Last verified: Phase 7 · `npm run verify` + `npm run test:e2e` green.

| # | Case | Layer | Test name / file | Status |
|---|---|---|---|---|
| 1 | Duplicate delivery of a batch | server integration, sim | `app.test.ts` → "duplicate push returns duplicate and changes nothing"; `convergence.sim.test.ts` → invariant 1 (replay idempotency) | ✅ Pass |
| 2 | Response lost after server applied, client retries | client + fake transport | `sync.test.ts` → "retries on connection error with no duplicates" | ✅ Pass |
| 3 | Connection drops mid-batch, resume | client + fake transport | `sync.test.ts` → "mid-batch network failure: resumes and applies all ops exactly once"; Playwright Scenario 6 `sync-engine.spec.ts` | ✅ Pass |
| 4 | Out-of-order: set arrives before create | shared unit, server integration | `edge-cases.test.ts` → "edge case #4: set before create returns rejected"; `app.test.ts` → "out-of-order set after create succeeds" | ✅ Pass |
| 5 | Edit-vs-delete and delete-vs-edit, both orders | shared unit, E2E | `edge-cases.test.ts` → "edge case #5: edit-vs-delete is a conflict"; Playwright Scenario 4 `conflicts.spec.ts` | ✅ Pass |
| 6 | Same field, same value from two devices (no-op) | shared unit | `edge-cases.test.ts` → "edge case #6: same value from two devices is a no-op" | ✅ Pass |
| 7 | Clock skew ±1 h and a device clock set to 1970 | sim, property-based | `convergence.fc.test.ts` → "holds all 6 invariants … with +/-1h skew and 1970 clock" (1000 runs × 3 devices, 1000 runs × 5 devices) | ✅ Pass |
| 8 | Chained offline edits on a conflicted field | shared unit | `edge-cases.test.ts` → "edge case #8: chained edits on a conflicted field" | ✅ Pass |
| 9 | Double resolve of one conflict | shared unit, server integration | `edge-cases.test.ts` → "edge case #9: double resolve is rejected"; `app.test.ts` → "double resolve returns already-resolved" | ✅ Pass |
| 10 | Preview never persists | server integration | `app.test.ts` → "preview returns predicted statuses and persists nothing" | ✅ Pass |
| 11 | `navigator.onLine` true but heartbeat fails (captive portal) | client unit | `sync.test.ts` → "captive portal: onLine=true but heartbeat fails → offline state" | ✅ Pass |
| 12 | Cold start offline after a full browser restart | E2E | `offline-crud.spec.ts` → "cold start offline after full browser restart" | ✅ Pass |
| 13 | Dexie schema upgrade with a non-empty outbox | client unit | `db.test.ts` → "outbox survives Dexie close and reopen" | ✅ Pass |
| 14 | Two tabs: only one runs the sync loop | client unit | `sync.test.ts` → "tab lock: only the lock-holder calls push" | ✅ Pass |
| 15 | Large offline backlog (500 ops) syncs in batches without duplicates | client + server | `sync.test.ts` → "large backlog: 500 ops drain in batches without duplicates"; Playwright Scenario 6 (60 ops) | ✅ Pass |
| 16 | Remote change to a field the user is editing: input preserved | E2E | `sync-engine.spec.ts` → "Edge Case #16: Remote change while user is editing preserves active input" | ✅ Pass |
| 17 | Server restart during sync | server integration + client | `app.test.ts` → "restart persistence: close and reopen, state intact" | ✅ Pass |
| 18 | Invalid or oversized push body rejected with 400 | server integration | `app.test.ts` → "bad input returns 400" | ✅ Pass |

## Evidence files

| Phase | Screenshot / Recording | Description |
|---|---|---|
| 3 | `docs/evidence/phase-3/` | Records list at 360px and 1280px, offline state |
| 4 | `docs/evidence/phase-4/videos/` | Scenario 1 two-context sync video |
| 5 | `docs/evidence/phase-5/` | Conflict card (Scenario 3), resolved state, edit-vs-delete Restore (Scenario 4) |
| 6 | `docs/evidence/phase-6/` | Chaos Flaky profile, convergence check pass badge, dashboard, audit lifecycle |

## Test commands

```bash
npm run verify       # typecheck + lint + all unit tests + sim + build
npm run test:sim     # convergence sim only (200 sessions + 2000 fast-check)
npm run test:e2e     # Playwright 13 scenarios
```
